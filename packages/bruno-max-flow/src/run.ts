/**
 * The run — 001 §9, §11 and §12.
 *
 * Scheduling, propagation and iteration live here: which steps are eligible (§9.1), how many run
 * at once (§9.2), what a failure does to the steps below it (§11.2), and how a sub-flow's internals
 * join the result (§12). Everything a single step decides for itself is `step.ts`.
 */
import * as path from 'path';
import { randomUUID } from 'crypto';

import { createCapture, type AttemptRecord, type Capture } from './capture';
import { parseDataset } from './dataset';
import {
  FileRef,
  normalizeFlow,
  parseAssertion,
  parseDocument,
  type NormalizedFlow,
  type NormalizedStep
} from './document';
import { evaluateCondition, evaluationContext } from './expression';
import { createFileReader, FileAccessError, parseStructured } from './files';
import { interpolateScalar, interpolateValue, type Scope } from './interpolate';
import { materialize, MaterializationError, type AuthProfile, type Materialized } from './materialize';
import { SpecLoader } from './openapi';
import { runAttempt, retryDelay, sleepFor, wantsRetry, type ScriptRunner } from './step';
import type { RunOptions } from './types/options';
import type { Clock, FlowContext, Vars } from './types/ports';
import type {
  FlowEvent,
  IterationResult,
  RunResult,
  RunStatus,
  StepResult,
  StepStatus
} from './types/result';

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** §9.2's single run-wide budget: parallel steps, sub-flow internals and iterations all draw here. */
class Budget {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    }
  }
}

type RunState = {
  runId: string;
  flowContext: FlowContext;
  options: RunOptions;
  clock: Clock;
  specs: SpecLoader;
  budget: Budget;
  emit: (event: FlowEvent) => void;
  /** The environment tiers, flattened per §7.3's order. `--env-var` merges into `environment`. */
  environment: Vars;
  /** §11.3's whole-run budget, as a deadline on the injected clock. Absent unless asked for. */
  deadline?: number;
  /** When the run was stopped, so §11.3's cleanup window can be bounded from it. */
  stoppedAt?: number;
  cleanupGrace: number;
  stop: () => void;
  /** §14.5's artifact directory. Absent under `--no-capture`. */
  capture?: Capture;
  /** Only a flow with a `dataset:` nests its captures per iteration (§14.5). */
  nestIterations: boolean;
};

/**
 * An artifact write must never turn a passing flow red — the same argument §13.2 makes for a
 * throwing event consumer. `start()` is the exception and is not routed through here: it runs
 * before anything is dispatched, so a capture root that cannot be written is reported at once
 * rather than as a run that quietly produced no record of itself.
 */
const recordAttempt = async (state: RunState, record: AttemptRecord): Promise<string | undefined> => {
  if (!state.capture) return undefined;
  try {
    return await state.capture.attempt(record);
  } catch {
    return undefined;
  }
};

/**
 * §11.3. A run that has passed its budget enters **exactly** the cancellation path a signal takes —
 * that equivalence is the reason to have a budget at all. A run killed by the CI runner's own
 * timeout dies on `SIGKILL`: no cleanup runs, the exit code is the runner's, and the resources the
 * flow created are left behind.
 */
const stopped = (state: RunState): boolean => {
  if (state.flowContext.signal.aborted) return true;
  if (state.deadline !== undefined && state.clock.now() >= state.deadline) {
    state.stop();
    return true;
  }
  return false;
};

/**
 * The exception §11.3 carves out: steps whose `depends` accepts `cancelled` still run, so a flow
 * can clean up after an interrupted run. Deliberately bounded — only steps that *declared*
 * `cancelled` are eligible, and only inside `config.cleanupGrace`.
 */
const isCleanup = (step: NormalizedStep): boolean =>
  step.depends.entries.some((entry) => entry.status.includes('cancelled'));

const withinCleanupGrace = (state: RunState): boolean =>
  state.stoppedAt === undefined || state.clock.now() < state.stoppedAt + state.cleanupGrace;

type FlowRun = {
  flow: NormalizedFlow;
  /** '' at the top level, `auth/` inside a sub-flow — §13.2's namespaced ids. */
  prefix: string;
  params: Vars;
  row?: Vars;
  iteration: number;
  profiles: Record<string, AuthProfile>;
};

const terminal = new Set<StepStatus>(['success', 'failed', 'skipped', 'cancelled']);

/** §7.4's boundary: the collection or workspace root that owns the flows. */
const scopeRoot = (state: RunState): string =>
  state.options.scope.collectionRoot || state.options.scope.workspaceRoot;

const readText = async (state: RunState, file: string): Promise<string> =>
  (await state.options.ports.readFile(file, state.flowContext)).toString('utf8');

const loadFlow = async (state: RunState, file: string): Promise<NormalizedFlow> =>
  normalizeFlow(parseDocument(await readText(state, file)), file);

const scriptRunner = (state: RunState): ScriptRunner => (source, args) =>
  state.options.ports.runScript(source, args, state.flowContext);

/**
 * §11.2. A step referencing an output that was never produced is skipped rather than failed, and
 * only that skip reason is what `failOnUnresolved` acts on.
 */
const skip = (step: NormalizedStep, prefix: string, reason: StepResult['reason']): StepResult => ({
  id: `${prefix}${step.id}`,
  kind: step.kind,
  status: 'skipped',
  reason,
  attempts: 0,
  durationMs: 0,
  assertions: [],
  outputs: {}
});

const dependenciesSatisfied = (step: NormalizedStep, outcomes: Map<string, StepResult>): boolean => {
  const { mode, entries } = step.depends;
  if (entries.length === 0) return true;

  const met = entries.map((entry) => {
    const parent = outcomes.get(entry.on);
    return Boolean(parent && entry.status.includes(parent.status));
  });

  // `any` waits for every listed parent to reach a terminal outcome, then requires at least one to
  // be satisfied — firing on the first success would make it a race (§9.1).
  return mode === 'any' ? met.some(Boolean) : met.every(Boolean);
};

const executeFlow = async (
  state: RunState,
  run: FlowRun
): Promise<{ results: StepResult[]; exports: Vars; verdictFailed: boolean }> => {
  const { flow, prefix } = run;
  const results: StepResult[] = [];
  const outcomes = new Map<string, StepResult>();
  const stepState: Record<string, Record<string, unknown>> = {};
  const slots: Record<string, unknown> = {};
  const runScript = scriptRunner(state);
  let resolvedVars: Vars = {};
  let verdictFailed = false;

  const specs = await Promise.all(
    Object.values(flow.apis).map(async (binding) => [binding.alias, await state.specs.load(binding.source, flow.file)] as const)
  );
  const indexed = Object.fromEntries(specs);

  const scopeFor = (): Scope => ({
    vars: { ...state.environment, ...resolvedVars },
    namespaces: {
      steps: stepState,
      row: run.row || {},
      params: run.params,
      shared: slots,
      flow: { runId: state.runId, name: flow.meta.name, iteration: run.iteration },
      process: { env: state.options.variables.processEnv || {} }
    }
  });

  const readFile = createFileReader(
    state.options.ports.readFile,
    { ...state.flowContext, flow: flow.file },
    scopeRoot(state)
  );

  // §7.4: a `!file` var is parsed at flow start, so `{{catalog.items[0].sku}}` navigates the
  // structure exactly as it would a structured output.
  const loadFileVars = async (node: unknown): Promise<unknown> => {
    if (node instanceof FileRef) {
      const source = interpolateScalar(node.path, scopeFor());
      return parseStructured(source, (await readFile(source)).toString('utf8'));
    }
    if (Array.isArray(node)) return Promise.all(node.map(loadFileVars));
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      const entries = await Promise.all(
        Object.entries(node as Record<string, unknown>).map(async ([key, value]) => [key, await loadFileVars(value)])
      );
      return Object.fromEntries(entries);
    }
    return node;
  };

  // §7.3: flow vars are evaluated once before any step runs, and once per iteration — which is
  // what makes a generated identity stable across the steps that read it and distinct per row.
  resolvedVars = interpolateValue(await loadFileVars(flow.vars), scopeFor()).value as Vars;

  const profiles: Record<string, AuthProfile> = {
    ...run.profiles,
    ...Object.fromEntries(
      Object.entries(flow.authProfiles).map(([name, fields]) => [name, { fields, scope: scopeFor }])
    )
  };

  const record = (step: NormalizedStep, result: StepResult) => {
    if (result.reason === 'unresolved-dependency' && step.flags.failOnUnresolved) verdictFailed = true;
    outcomes.set(step.id, result);
    results.push(result);
    state.emit({ type: 'step:end', id: result.id, index: run.iteration, result });
  };

  /** §8.3's built-in metadata, alongside the step's declared outputs under the same id. */
  const publish = (step: NormalizedStep, result: StepResult, httpStatus?: number) => {
    stepState[step.id] = {
      ...result.outputs,
      status: httpStatus,
      ok: result.status === 'success',
      skipped: result.status === 'skipped',
      duration: result.durationMs
    };
    for (const { slot, output } of step.shared) {
      if (result.outputs[output] !== undefined) slots[slot] = result.outputs[output];
    }
  };

  const executeOperation = async (step: NormalizedStep): Promise<{ result: StepResult; httpStatus?: number }> => {
    const startedAt = state.clock.now();
    const binding = step.operation ? flow.apis[step.operation.alias] : undefined;
    const spec = step.operation ? indexed[step.operation.alias] : undefined;
    const resolved = spec?.operations.get(step.operation?.operationId || '');

    if (!resolved) {
      throw new MaterializationError('unknown-operation', `${step.id}: ${step.operation?.operationId} is not in ${binding?.source}`);
    }

    let materialized: Materialized;
    try {
      materialized = await materialize(step, binding, resolved, profiles, flow.config, scopeFor(), readFile);
    } catch (cause) {
      // A fixture that could not be read fails the step with a reason rather than crashing the run
      // (§14.6). Everything else materialization refuses is a shape `bru flow validate` reports
      // before a run — reaching here means nobody validated, and the request is still never sent.
      if (!(cause instanceof FileAccessError) && !(cause instanceof MaterializationError)) throw cause;
      return {
        result: {
          ...skip(step, prefix, undefined),
          status: 'failed',
          reason: cause instanceof FileAccessError ? 'file-read-failed' : 'invalid-request',
          attempts: 0
        }
      };
    }
    if (materialized.unresolved.length) return { result: skip(step, prefix, 'unresolved-dependency') };

    const jar = { id: `${state.runId}:${run.iteration}` };
    const stepId = `${prefix}${step.id}`;
    let attemptsRun = 0;
    let capturePath: string | undefined;

    // Each attempt is captured separately (§14.5) and announces itself (§13.2), so the two live
    // here rather than in the dispatch closure — a poll that reported only its first attempt would
    // be indistinguishable from a hang, which is 002 §8.2's `attempt n/m` case.
    const attemptOnce = async () => {
      attemptsRun += 1;
      const attempt = attemptsRun;
      const attemptStartedAt = state.clock.now();
      state.emit({ type: 'step:attempt', id: stepId, index: run.iteration, attempt, status: 'sent', durationMs: 0 });

      const outcome = await runAttempt({
        step,
        resolved,
        materialized,
        scope: scopeFor(),
        runScript,
        dispatch: () =>
          state.options.ports.executeRequest(materialized.request, {
            ...state.flowContext,
            stepId,
            iteration: run.iteration,
            attempt,
            cookieJar: jar,
            timeoutMs: step.timeout,
            signal: state.flowContext.signal
          })
      });

      capturePath = await recordAttempt(state, {
        stepId,
        iteration: state.nestIterations ? run.iteration : undefined,
        attempt,
        startedAt: new Date(attemptStartedAt).toISOString(),
        durationMs: state.clock.now() - attemptStartedAt,
        // A step that failed `validateRequest` never dispatched, so there is no request to record
        // as sent (§10.1); §11.2's transport error has the opposite shape and no response.
        request: outcome.reason === 'invalid-request' ? undefined : materialized.request,
        response: outcome.response,
        assertions: outcome.assertions,
        validation: outcome.validation && Object.keys(outcome.validation).length ? outcome.validation : undefined
      }) || capturePath;

      return outcome;
    };

    let outcome = await attemptOnce();
    while (
      attemptsRun < step.retry.maxAttempts
      && (await wantsRetry(step.retry, outcome, attemptsRun, evaluationContext(scopeFor()), runScript))
    ) {
      await sleepFor(state.clock, retryDelay(step.retry, attemptsRun), state.flowContext.signal);
      outcome = await attemptOnce();
    }

    // `maxAttempts` is a hard cap that always applies: a step exhausts its retries when the
    // predicate is still asking to retry at the cap (§11.1).
    const exhausted
      = attemptsRun >= step.retry.maxAttempts
        && step.retry.maxAttempts > 1
        && (await wantsRetry(step.retry, outcome, attemptsRun, evaluationContext(scopeFor()), runScript));

    const reason = exhausted ? 'retries-exhausted' : outcome.reason;

    return {
      httpStatus: outcome.response?.status,
      result: {
        id: stepId,
        kind: 'operation',
        status: reason ? 'failed' : 'success',
        reason,
        attempts: attemptsRun,
        durationMs: state.clock.now() - startedAt,
        assertions: outcome.assertions,
        validation: outcome.validation && Object.keys(outcome.validation).length ? outcome.validation : undefined,
        outputs: outcome.outputs,
        capturePath
      }
    };
  };

  const executeSubflow = async (step: NormalizedStep): Promise<StepResult[]> => {
    const startedAt = state.clock.now();
    const target = path.resolve(path.dirname(flow.file), step.uses as string);
    const child = await loadFlow(state, target);

    const args = interpolateValue(step.args, scopeFor()).value as Vars;
    const params: Vars = Object.fromEntries(
      Object.entries(child.params).map(([name, declared]) => [
        name,
        args[name] === undefined ? declared.default : args[name]
      ])
    );

    const inner = await executeFlow(state, {
      flow: child,
      prefix: `${prefix}${step.id}/`,
      params: interpolateValue(params, scopeFor()).value as Vars,
      iteration: run.iteration,
      profiles
    });

    if (inner.verdictFailed) verdictFailed = true;
    const failed = inner.results.some((result) => result.status === 'failed');

    // A failed step inside a sub-flow fails the invoking `uses:` step, which then propagates by
    // the normal §11.2 rules. Its `attempts` is always 1, since §12.4 bars `retry:` there.
    return [
      {
        id: `${prefix}${step.id}`,
        kind: 'subflow',
        status: failed ? 'failed' : 'success',
        reason: failed ? 'subflow-failed' : undefined,
        attempts: 1,
        durationMs: state.clock.now() - startedAt,
        assertions: [],
        outputs: inner.exports
      },
      ...inner.results
    ];
  };

  const execute = async (step: NormalizedStep): Promise<void> => {
    state.emit({
      type: 'step:start',
      id: `${prefix}${step.id}`,
      index: run.iteration,
      operation: step.operation ? `${step.operation.alias}#${step.operation.operationId}` : undefined
    });

    if (stopped(state) && !(isCleanup(step) && withinCleanupGrace(state))) {
      // An unattended CI run has nobody to send a second interrupt, so an unbounded cleanup phase
      // would hang exactly where hanging is worst (§11.3).
      record(step, skip(step, prefix, 'run-cancelled'));
      return;
    }

    if (step.when.length) {
      try {
        const eligible = await evaluateCondition(
          step.when,
          evaluationContext(scopeFor()),
          scopeFor(),
          (source) => runScript(source, [evaluationContext(scopeFor())]),
          parseAssertion
        );
        if (!eligible) {
          record(step, skip(step, prefix, 'condition-false'));
          return;
        }
      } catch {
        // A throwing condition fails the step rather than skipping it: "this errored" is not
        // "this was false", and a skip would be a false statement about why (§8.2).
        record(step, {
          id: `${prefix}${step.id}`,
          kind: step.kind,
          status: 'failed',
          reason: 'script-error',
          attempts: 1,
          durationMs: 0,
          assertions: [],
          outputs: {}
        });
        return;
      }
    }

    // A `uses:` step does not draw from the budget while its internals run: its internals draw
    // from the same run-wide pool (§9.2), and a container holding a slot too would deadlock a
    // sub-flow at `concurrency: 1` — the setting §9.2 recommends for debugging.
    const produced
      = step.kind === 'subflow'
        ? { steps: await executeSubflow(step), httpStatus: undefined }
        : await state.budget.run(async () => {
            const { result, httpStatus } = await executeOperation(step);
            return { steps: [result], httpStatus };
          });

    const [own, ...internals] = produced.steps;
    record(step, own);
    results.push(...internals);
    publish(step, own, produced.httpStatus);
  };

  const pending = new Set(flow.steps.map((step) => step.id));
  const running = new Map<string, Promise<void>>();

  while (pending.size) {
    const ready = flow.steps.filter(
      (step) =>
        pending.has(step.id)
        && !running.has(step.id)
        && step.depends.entries.every((entry) => {
          const parent = outcomes.get(entry.on);
          return Boolean(parent && terminal.has(parent.status));
        })
    );

    let progressed = false;
    for (const step of ready) {
      pending.delete(step.id);
      progressed = true;
      if (!dependenciesSatisfied(step, outcomes)) {
        record(step, skip(step, prefix, 'unmet-dependency'));
        continue;
      }
      running.set(
        step.id,
        execute(step).finally(() => running.delete(step.id))
      );
    }

    // A pass that resolved a step without launching one — a branch of skips — has made progress,
    // and the steps below it become ready on the next pass.
    if (running.size === 0 && progressed) continue;

    if (running.size === 0) {
      // Nothing is ready and nothing is in flight: whatever is left depends on a step that never
      // reached a terminal outcome, which validation catches as a cycle before a run gets here.
      for (const id of pending) {
        const step = flow.steps.find((entry) => entry.id === id) as NormalizedStep;
        record(step, skip(step, prefix, 'unmet-dependency'));
      }
      break;
    }

    await Promise.race([...running.values()]);
  }

  await Promise.all([...running.values()]);

  const exports: Vars = {};
  for (const [name, reference] of Object.entries(flow.exports)) {
    const value = interpolateValue(`{{${reference}}}`, scopeFor()).value;
    if (value !== undefined) exports[name] = value;
  }

  return { results, exports, verdictFailed };
};

/**
 * §11.2. A failed step fails the flow with no exemption flag; a skip is not itself a failure, with
 * the single exception `failOnUnresolved` names — and the flag changes the verdict, never the
 * step's outcome or the schedule.
 */
const iterationStatus = (results: StepResult[], verdictFailed: boolean, cancelled: boolean): RunStatus => {
  if (cancelled) return 'cancelled';
  if (verdictFailed || results.some((result) => result.status === 'failed')) return 'failed';
  return 'passed';
};

export const runFlow = async (options: RunOptions): Promise<RunResult> => {
  const runId = randomUUID();
  // The host's signal and the budget's are folded into one, because §11.3 requires the timeout and
  // the interrupt to take the identical path — everything downstream sees a single signal.
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', () => controller.abort());

  const signal = controller.signal;
  const flowContext: FlowContext = { runId, flow: options.entry, scope: options.scope, signal };

  const state: RunState = {
    runId,
    flowContext,
    options,
    clock: options.ports.clock || REAL_CLOCK,
    specs: new SpecLoader(options.ports.readSpec, flowContext),
    budget: new Budget(options.overrides?.concurrency || 5),
    emit: (event) => {
      // A throwing consumer never fails the run: a host bug in rendering must not turn a passing
      // flow red (§13.2).
      try {
        options.onEvent?.(event);
      } catch {
        /* observational only */
      }
    },
    environment: {
      ...options.variables.globalEnvironment,
      ...options.variables.collectionVars,
      ...options.variables.environment,
      ...options.variables.envVarOverrides
    },
    cleanupGrace: 30000,
    nestIterations: false,
    stop: () => {
      if (state.stoppedAt === undefined) state.stoppedAt = state.clock.now();
      controller.abort();
    }
  };

  signal.addEventListener('abort', () => {
    if (state.stoppedAt === undefined) state.stoppedAt = state.clock.now();
  });

  const flow = await loadFlow(state, options.entry);
  state.budget = new Budget(options.overrides?.concurrency || flow.config.concurrency);
  state.cleanupGrace = flow.config.cleanupGrace;
  state.nestIterations = flow.dataset !== undefined;

  // §14.5's identity file has to exist before the first step, so the capture is opened as soon as
  // the flow's own retention and redaction settings are known and before anything is dispatched.
  if (options.overrides?.capture?.enabled !== false) {
    state.capture = createCapture({
      ports: options.ports,
      context: flowContext,
      scopeRoot: scopeRoot(state),
      dir: options.overrides?.capture?.dir,
      startedAt: new Date(state.clock.now()).toISOString(),
      retainRuns: flow.config.captureRetainRuns,
      redactHeaders: flow.config.redactHeaders
    });
    await state.capture.start();
  }

  // The bound belongs to whoever knows the environment, which is usually CI rather than the flow
  // file — so `--max-run-duration` overrides, and neither is set by default (§11.3).
  const maxRunDuration = options.overrides?.maxRunDuration ?? flow.config.maxRunDuration;
  if (maxRunDuration !== undefined) state.deadline = state.clock.now() + maxRunDuration;

  const rows: (Vars | undefined)[] = flow.dataset
    ? parseDataset(
        flow.dataset.source,
        await readText(state, path.resolve(path.dirname(flow.file), flow.dataset.source))
      )
    : [undefined];

  state.emit({ type: 'run:start', runId, flow: options.entry, iterationCount: rows.length });

  const iterations: IterationResult[] = [];
  const parallel = flow.dataset?.parallel || 1;

  for (let start = 0; start < rows.length; start += parallel) {
    const batch = rows.slice(start, start + parallel).map(async (row, offset) => {
      const index = start + offset;
      state.emit({ type: 'iteration:start', index, row });
      const { results, verdictFailed } = await executeFlow(state, {
        flow,
        prefix: '',
        params: options.params || {},
        row,
        iteration: index,
        profiles: {}
      });
      const status = iterationStatus(results, verdictFailed, signal.aborted);
      state.emit({ type: 'iteration:end', index, status });
      return { index, row, status, steps: results };
    });

    iterations.push(...(await Promise.all(batch)));
  }

  iterations.sort((left, right) => left.index - right.index);
  const steps = iterations.flatMap((iteration) => iteration.steps);

  const result: RunResult = {
    runId,
    status: signal.aborted
      ? 'cancelled'
      : iterations.some((iteration) => iteration.status === 'failed')
        ? 'failed'
        : 'passed',
    iterations,
    summary: {
      total: steps.length,
      passed: steps.filter((step) => step.status === 'success').length,
      failed: steps.filter((step) => step.status === 'failed').length,
      skipped: steps.filter((step) => step.status === 'skipped').length,
      cancelled: steps.filter((step) => step.status === 'cancelled').length
    },
    diagnostics: [],
    captureDir: state.capture?.dir
  };

  if (state.capture) {
    try {
      await state.capture.finish(result);
    } catch {
      // §14.5's interrupted state: a run.json with no summary.json beside it. A reader is already
      // required to treat that as legible rather than corrupt, so a failed write lands somewhere
      // with a defined meaning and the result still reaches the caller.
    }
  }

  state.emit({ type: 'run:end', result });
  return result;
};
