/**
 * The run — 001 §9, §11 and §12.
 *
 * Scheduling, propagation and iteration live here: which steps are eligible (§9.1), how many run
 * at once (§9.2), what a failure does to the steps below it (§11.2), and how a sub-flow's internals
 * join the result (§12). Everything a single step decides for itself is `step.ts`.
 */
import * as path from 'path';
import { randomUUID } from 'crypto';

import { parseDataset } from './dataset';
import {
  normalizeFlow,
  parseAssertion,
  parseDocument,
  type NormalizedFlow,
  type NormalizedStep
} from './document';
import { evaluateCondition, evaluationContext } from './expression';
import { interpolateValue, type Scope } from './interpolate';
import { materialize, MaterializationError, type AuthProfile } from './materialize';
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
};

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

  // §7.3: flow vars are evaluated once before any step runs, and once per iteration — which is
  // what makes a generated identity stable across the steps that read it and distinct per row.
  resolvedVars = interpolateValue(flow.vars, scopeFor()).value as Vars;

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

    const materialized = materialize(step, binding, resolved, profiles, flow.config, scopeFor());
    if (materialized.unresolved.length) return { result: skip(step, prefix, 'unresolved-dependency') };

    const jar = { id: `${state.runId}:${run.iteration}` };
    let attempt = 0;
    let outcome = await runAttempt({
      step,
      resolved,
      materialized,
      scope: scopeFor(),
      runScript,
      dispatch: () => {
        attempt += 1;
        state.emit({ type: 'step:attempt', id: `${prefix}${step.id}`, index: run.iteration, attempt, status: 'sent', durationMs: 0 });
        return state.options.ports.executeRequest(materialized.request, {
          ...state.flowContext,
          stepId: `${prefix}${step.id}`,
          iteration: run.iteration,
          attempt,
          cookieJar: jar,
          timeoutMs: step.timeout,
          signal: state.flowContext.signal
        });
      }
    });

    let attemptsRun = Math.max(attempt, 1);
    while (
      attemptsRun < step.retry.maxAttempts
      && (await wantsRetry(step.retry, outcome, attemptsRun, evaluationContext(scopeFor()), runScript))
    ) {
      await sleepFor(state.clock, retryDelay(step.retry, attemptsRun), state.flowContext.signal);
      outcome = await runAttempt({
        step,
        resolved,
        materialized,
        scope: scopeFor(),
        runScript,
        dispatch: () => {
          attempt += 1;
          return state.options.ports.executeRequest(materialized.request, {
            ...state.flowContext,
            stepId: `${prefix}${step.id}`,
            iteration: run.iteration,
            attempt,
            cookieJar: jar,
            timeoutMs: step.timeout,
            signal: state.flowContext.signal
          });
        }
      });
      attemptsRun += 1;
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
        id: `${prefix}${step.id}`,
        kind: 'operation',
        status: reason ? 'failed' : 'success',
        reason,
        attempts: attemptsRun,
        durationMs: state.clock.now() - startedAt,
        assertions: outcome.assertions,
        validation: outcome.validation && Object.keys(outcome.validation).length ? outcome.validation : undefined,
        outputs: outcome.outputs
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

    if (state.flowContext.signal.aborted) {
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
  const signal = options.signal || new AbortController().signal;
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
    }
  };

  const flow = await loadFlow(state, options.entry);
  state.budget = new Budget(options.overrides?.concurrency || flow.config.concurrency);

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
    diagnostics: []
  };

  state.emit({ type: 'run:end', result });
  return result;
};
