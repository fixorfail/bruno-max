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
import { describeFlow } from './describe';
import {
  FileRef,
  normalizeFlow,
  parseAssertion,
  parseDocument,
  type NormalizedFlow,
  type NormalizedStep
} from './document';
import { evaluateCondition, evaluationContext } from './expression';
import { createFileReader, FileAccessError, parseStructured, resolveWithin } from './files';
import { loadLibrary, withLibrary } from './functions';
import { markRunActive, markRunFinished } from './history';
import { interpolateScalar, interpolateValue, type Scope } from './interpolate';
import { materialize, MaterializationError, type AuthProfile, type Materialized } from './materialize';
import { SpecLoader } from './openapi';
import { createSecretTracker, MASK, type SecretTracker } from './redact';
import { runAttempt, retryDelay, runPreScripts, sleepFor, wantsRetry, type ScriptRunner } from './step';
import type { FlowSnapshot } from './types/capture';
import type { RunOptions } from './types/options';
import type { Clock, FlowContext, Vars } from './types/ports';
import type { ExecutedResponse } from './types/request';
import type {
  Diagnostic,
  FlowEvent,
  IterationResult,
  RunResult,
  RunStatus,
  StepResult,
  StepStatus
} from './types/result';

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  /**
   * §11.3's cancellation reaches a *sleeping* run through this. A retry delay is where a polling
   * step spends nearly all of its time (§11.1 allows 30s of it), so a sleep that ignored the signal
   * is a cancel that appears to do nothing for half a minute at a time.
   *
   * Resolving rather than rejecting: waking early is not an error, and the caller re-checks whether
   * the run is still going. Nothing is cleaned up on abort but the timer.
   */
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();

      let wake = () => {};
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', wake);
        resolve();
      }, ms);

      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', wake, { once: true });
    })
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
  /**
   * §14.4's secret values, which everything this run *reports* is masked against.
   *
   * Run-scoped and growing: a host's `secret: true` values are known up front, a `secret: true`
   * param resolves when its flow starts, and an auth profile's credentials only when the step using
   * them materializes. Sub-flows share the set, because a value is no less secret one level down.
   */
  secrets: SecretTracker;
  /**
   * What happened during the run that did not stop it — §13.2's `RunResult.diagnostics`.
   *
   * An artifact write that failed is the case this exists for: it must not fail a run, and until it
   * was collected here it was not reported either, which left a step whose capture is missing looking
   * like a step that never sent anything.
   */
  diagnostics: Diagnostic[];
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
  } catch (cause) {
    /**
     * Still not a failure of the run — the same argument §13.2 makes for a throwing event consumer:
     * a flow that passed did pass, whatever the disk did afterwards. But swallowing it *silently* is
     * how a step ends up with no request and no response to show and nothing saying why, so it is
     * reported as a warning against the run.
     */
    state.diagnostics.push({
      severity: 'warning',
      code: 'capture-write-failed',
      message: `${record.stepId} attempt ${record.attempt}: ${cause instanceof Error ? cause.message : String(cause)}`,
      file: state.flowContext.flow,
      stepId: record.stepId
    });
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

/**
 * The flow as it is about to be executed — 001 §14.5's snapshot, written into the run directory
 * before the first step.
 *
 * **It is built here rather than by the host, so a `bru` run records exactly what an app run does.**
 * A host that assembled it would be a second implementation of the same idea, and the CLI — which
 * has no graph of its own — would be the one to go without.
 *
 * `describeFlow` is called rather than the graph being derived from the flow this run already
 * normalized: a viewer draws what `describeFlow` returns, and a history built any other way could
 * differ from the live view for the same file. The cost is one describe per *run*, alongside the
 * parse the run does anyway.
 *
 * **A snapshot that cannot be built never fails the run.** Describing resolves OpenAPI documents and
 * can therefore fail on a network the run itself may not need; the run proceeds without a snapshot,
 * and 002 §10 reads such a run the way it read every run before snapshots existed.
 */
/**
 * §14.4: what a run was started with, with the declared secrets replaced before anything serializes
 * them. `MASK` is not length-preserving, so the record does not leak how long the value was.
 *
 * A param the flow does not declare cannot reach here — `paramsFor` builds this from the
 * declarations — so there is no unclassified value to decide about.
 */
const maskedParams = (declared: NormalizedFlow['params'], params: Vars): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      declared[name]?.secret && value !== undefined ? MASK : value
    ])
  );

/**
 * The params as a value rather than as an expression: a declared default is written in the file
 * (`default: "{{testUserPassword}}"`) and a record of the placeholder would say where the value came
 * from without ever saying what it was.
 *
 * Resolved against the run's **environment only**, because that is all that exists this early — the
 * capture opens before the first step, and `vars:` and `steps.*` are resolved per iteration inside
 * `executeFlow`. A default reading `{{row.x}}` under a dataset therefore records as written; it has
 * no single value across iterations, so there is nothing truer to record.
 */
const startedWith = (state: RunState, declared: NormalizedFlow['params'], params: Vars): Record<string, unknown> =>
  maskedParams(declared, interpolateValue(params, { vars: state.environment, namespaces: {} }).value as Vars);

const flowSnapshot = async (
  state: RunState,
  entry: string,
  params: Record<string, unknown>,
  dataset: NormalizedFlow['dataset']
): Promise<FlowSnapshot | undefined> => {
  try {
    const [description, source] = await Promise.all([
      describeFlow({ entry, scope: state.options.scope, ports: state.options.ports }),
      readText(state, entry)
    ]);
    /**
     * **The dataset is the run's, not the file's.** `describeFlow` reads the document, so under
     * §14.1's `--dataset` it would report the source that was overridden — and 002 §5.5 decides
     * whether to offer an iteration selector from precisely this field, so a flow given a dataset
     * it does not declare would run its rows with no way to look at any but the first. `source`
     * beside it stays the file verbatim, which is what §14.5's `flowChanged` digest is taken over.
     */
    return { description: { ...description, dataset }, source, params };
  } catch {
    return undefined;
  }
};

const loadFlow = async (state: RunState, file: string): Promise<NormalizedFlow> => {
  const flow = normalizeFlow(parseDocument(await readText(state, file)), file);
  // `bru flow validate` reports these as diagnostics and exits 2 before a run is attempted (§14.3),
  // so reaching here means nobody validated. Refusing is the point: the parser recovers a partial
  // tree from a syntax error, and running it would send requests the file does not describe.
  if (flow.errors.length) {
    const [first] = flow.errors;
    throw new Error(`${file}:${first.line}:${first.column} ${first.message}`);
  }
  return flow;
};

/**
 * §8.6: every script this flow runs sees the flow's own library, and only its own. A sub-flow is a
 * separate `executeFlow` with a library of its own, which is §12's isolation applied to the one
 * thing that would otherwise leak across it — a caller's helper resolving inside a flow that never
 * declared it would make the sub-flow's behaviour depend on who called it.
 */
const scriptRunner = (state: RunState, library: () => string): ScriptRunner => (source, args) =>
  state.options.ports.runScript(withLibrary(library(), source), args, state.flowContext);

/**
 * §12.5's declared params, filled from what the caller supplied and from their declared defaults.
 *
 * **Both ways in resolve them the same way**, which is why this is one function: a `uses:` step
 * passes `with:` and a host passes `params`, and a default that applied to one but not the other
 * would make the same library flow behave differently depending on who ran it. A host that supplies
 * nothing — the app's run configuration with its inputs left empty, `bru flow run` with no `--param`
 * — gets exactly the flow's own defaults, rather than `{{params.x}}` reaching the wire verbatim:
 * `params` is a reserved root (§7.3) whose miss is not a `steps.*` miss, so nothing skips the step
 * and nothing reports it.
 */
const paramsFor = (declared: NormalizedFlow['params'], supplied: Vars): Vars =>
  Object.fromEntries(
    Object.entries(declared).map(([name, param]) => [
      name,
      supplied[name] === undefined ? param.default : supplied[name]
    ])
  );

/**
 * What every `StepResult` opens with, in one place: a step that was skipped or failed before it ran
 * carries the same `name:` and `meta:` as one that succeeded, and a report keyed on either would
 * otherwise have holes exactly where it is read most.
 */
const identity = (step: NormalizedStep, prefix: string): Pick<StepResult, 'id' | 'name' | 'meta' | 'kind'> => ({
  id: `${prefix}${step.id}`,
  ...(step.name === undefined ? {} : { name: step.name }),
  // Passed through rather than copied: the values are the parse's own, which are the plain objects
  // and scalars `FlowEvent` needs every result to clone.
  ...(Object.keys(step.meta).length ? { meta: step.meta } : {}),
  kind: step.kind
});

/**
 * §11.2. A step referencing an output that was never produced is skipped rather than failed, and
 * only that skip reason is what `failOnUnresolved` acts on.
 */
const skip = (
  step: NormalizedStep,
  prefix: string,
  reason: StepResult['reason'],
  message?: string
): StepResult => ({
  ...identity(step, prefix),
  status: 'skipped',
  reason,
  message,
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

/**
 * Which parents the skip is about, and what they did instead. A step whose four dependencies were
 * fine except one names that one; without it the reader is left diffing the graph against the run.
 */
const unmetBy = (step: NormalizedStep, outcomes: Map<string, StepResult>): string =>
  step.depends.entries
    .filter((entry) => {
      const parent = outcomes.get(entry.on);
      return !parent || !entry.status.includes(parent.status);
    })
    .map((entry) => `${entry.on} ${outcomes.get(entry.on)?.status || 'never ran'}`)
    .join(', ');

/**
 * §8.3's `steps.<id>.headers.<name>`, keyed so an author can write one.
 *
 * HTTP header names are case-insensitive and nothing tells a flow which case the server chose, so
 * `{{steps.login.headers.x-request-id}}` has to resolve whatever `X-Request-Id` arrived as. Only the
 * keys are touched — a value is reported as the response gave it, a repeated header included.
 */
const lowerCasedKeys = (headers: Record<string, string | string[]>): Record<string, string | string[]> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

const executeFlow = async (
  state: RunState,
  run: FlowRun
): Promise<{ results: StepResult[]; exports: Vars; verdictCauses: string[] }> => {
  const { flow, prefix } = run;
  const results: StepResult[] = [];
  const outcomes = new Map<string, StepResult>();
  const stepState: Record<string, Record<string, unknown>> = {};
  const slots: Record<string, unknown> = {};
  // Resolved once, below, before any step runs; the runner reads it at call time because the files
  // it comes from are read through the same async port everything else is.
  let library = '';
  const runScript = scriptRunner(state, () => library);
  let resolvedVars: Vars = {};
  /**
   * §12.3 resolves a sub-flow's `with:` in the *caller's* scope, so an invoked flow's params arrive
   * resolved and are used as they are. A top-level run has no caller, and its params are whatever a
   * host supplied plus §12.5's declared defaults — which are written in the file and may reference a
   * variable, so they are resolved here, once, against the environment the run was given.
   */
  let resolvedParams: Vars = run.params;
  /**
   * The steps that failed the run *without failing themselves* — §11.2's `failOnUnresolved`, which
   * is the only rule that does that. Ids rather than a flag because a red run whose steps are all
   * green or grey has to be able to say which one it is about.
   */
  const verdictCauses: string[] = [];

  const specs = await Promise.all(
    Object.values(flow.apis).map(async (binding) => [binding.alias, await state.specs.load(binding.source, flow.file)] as const)
  );
  const indexed = Object.fromEntries(specs);

  /**
   * §8.7's `pre` is the one namespace that is not run-scoped: it holds what *this* step computed, so
   * it is a parameter rather than run state. A scope built without one carries an empty `pre`, which
   * is what every position outside a step's own materialization sees.
   */
  const scopeFor = (pre: Record<string, unknown> = {}): Scope => ({
    vars: { ...state.environment, ...resolvedVars },
    namespaces: {
      steps: stepState,
      row: run.row || {},
      params: resolvedParams,
      shared: slots,
      flow: { runId: state.runId, name: flow.meta.name, iteration: run.iteration },
      pre,
      process: { env: state.options.variables.processEnv || {} }
    }
  });

  const readFile = createFileReader(
    state.options.ports.readFile,
    { ...state.flowContext, flow: flow.file },
    scopeRoot(state)
  );

  // §8.6: the script library, read once per flow run rather than per script — a helper file is the
  // same file for every step, and re-reading it per call would make a 20-attempt poll read it 20
  // times.
  library = await loadLibrary(flow, readFile);

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
  if (!prefix) {
    resolvedParams = interpolateValue(run.params, scopeFor()).value as Vars;
  }

  /**
   * §12.5's `secret: true` params, as values (§14.4). `maskedParams` masks them by *name* in the
   * run's own inputs record, which says nothing about the places the value travels to from there.
   * A sub-flow declares its own, and they are resolved by the caller before this runs.
   */
  for (const [name, declared] of Object.entries(flow.params)) {
    if (declared.secret) state.secrets.add(resolvedParams[name]);
  }

  if (!prefix) {
    // 002 §5.6: the values this iteration actually ran with, handed to the capture rather than
    // re-derived — `{{$guid}}` would generate a different one on a second evaluation. The entry
    // flow's own only: a sub-flow's `vars:` are its internals, and §5.4 does not draw them.
    const reported = state.secrets.mask(resolvedVars);
    state.capture?.vars(run.iteration, reported);
    // The same values, to a host watching the run rather than reading it back afterwards (§5.6).
    state.emit({ type: 'iteration:vars', index: run.iteration, vars: reported });
  }

  const profiles: Record<string, AuthProfile> = {
    ...run.profiles,
    ...Object.fromEntries(
      Object.entries(flow.authProfiles).map(([name, fields]) => [name, { fields, scope: scopeFor }])
    )
  };

  const record = (step: NormalizedStep, result: StepResult) => {
    if (result.reason === 'unresolved-dependency' && step.flags.failOnUnresolved) verdictCauses.push(result.id);
    /**
     * §14.4 masks a **copy**, at the point a result leaves the run — this array becomes
     * `RunResult.iterations`, and the event is the other way out. `publish` below is handed the
     * unmasked result on purpose: a step reading `{{steps.login.token}}` has to be sent the token.
     */
    const reported = state.secrets.mask(result);
    outcomes.set(step.id, reported);
    results.push(reported);
    state.emit({ type: 'step:end', id: reported.id, index: run.iteration, result: reported });
  };

  /** §8.3's built-in metadata, alongside the step's declared outputs under the same id. */
  const publish = (step: NormalizedStep, result: StepResult, response?: ExecutedResponse) => {
    stepState[step.id] = {
      /**
       * §8.3's undeclared access to the response itself. Both are absent where there is no response
       * to give — a `uses:` container, a step that never ran — rather than published as `undefined`,
       * so `{{steps.x.body}}` there is a miss §11.2 can report.
       *
       * **They defer to a declared output of the same name**, where the four built-ins below still
       * win over one. The asymmetry is deliberate: `body` and `headers` were ordinary output names
       * until they became built-ins, and a flow that declares one must not silently start reading
       * the raw response instead.
       */
      ...(response ? { body: response.body, headers: lowerCasedKeys(response.headers) } : {}),
      ...result.outputs,
      status: response?.status,
      ok: result.status === 'success',
      skipped: result.status === 'skipped',
      duration: result.durationMs
    };
    for (const { slot, output } of step.shared) {
      if (result.outputs[output] !== undefined) slots[slot] = result.outputs[output];
    }
  };

  const executeOperation = async (
    step: NormalizedStep,
    pre: Record<string, unknown>
  ): Promise<{ result: StepResult; response?: ExecutedResponse }> => {
    const startedAt = state.clock.now();
    const binding = step.operation ? flow.apis[step.operation.alias] : undefined;
    const spec = step.operation ? indexed[step.operation.alias] : undefined;
    const resolved = spec?.operations.get(step.operation?.operationId || '');

    let materialized: Materialized;
    try {
      // Handled here rather than thrown past the step: it is the same refusal materialization makes
      // for every other shape it cannot build a request from, and a step that announced `step:start`
      // has to announce its end (§13.2). `bru flow validate` reports it before a run either way.
      if (!resolved) {
        throw new MaterializationError(
          'unknown-operation',
          `${step.id}: ${step.operation?.operationId} is not in ${binding?.source}`
        );
      }

      materialized = await materialize(step, binding, resolved, profiles, flow.config, scopeFor(pre), readFile);
    } catch (cause) {
      // A fixture that could not be read fails the step with a reason rather than crashing the run
      // (§14.6). Everything else materialization refuses is a shape `bru flow validate` reports
      // before a run — reaching here means nobody validated, and the request is still never sent.
      if (!(cause instanceof FileAccessError) && !(cause instanceof MaterializationError)) throw cause;
      return {
        result: {
          ...skip(step, prefix, undefined, cause.message),
          status: 'failed',
          reason: cause instanceof FileAccessError ? 'file-read-failed' : 'invalid-request',
          attempts: 0
        }
      };
    }
    /**
     * §14.4's provenance, from the one source the engine resolves itself. It is known no earlier
     * than this: a profile's `token:` may read `{{steps.login.token}}`, so the credential is a value
     * the run produced rather than one it was started with.
     */
    for (const secret of materialized.secrets) state.secrets.add(secret);

    if (materialized.unresolved.length) {
      // §11.2 skips on *a* reference the run never produced; which one is the whole of what the
      // author has to go and fix, and it is known only here.
      return {
        result: skip(step, prefix, 'unresolved-dependency', `never produced: ${materialized.unresolved.join(', ')}`)
      };
    }

    const jar = { id: `${state.runId}:${run.iteration}` };
    const stepId = `${prefix}${step.id}`;
    let attemptsRun = 0;
    let capturePath: string | undefined;

    /**
     * §11.1's `maxDuration` — the whole step's budget, retries and the delays between them included,
     * where `timeout` bounds one attempt. `maxAttempts × (timeout + delay)` is the wall-clock a poll
     * can otherwise take, and on the schedules polls actually use that is tens of minutes.
     *
     * A deadline read off the injected clock rather than a timer, exactly as §11.3's whole-run budget
     * is: the clock is the engine's only source of time (§13.2), and a step whose budget was a real
     * timer would elapse differently under a host that supplies its own — including the conformance
     * harness, where a poll's delays are the *only* thing that advances time.
     */
    const budgetEnds = step.maxDuration === undefined ? undefined : startedAt + step.maxDuration;
    const overBudget = () => budgetEnds !== undefined && state.clock.now() >= budgetEnds;

    /**
     * §11.1 aborts the attempt in flight when the budget elapses, and the port already has the
     * mechanism for that: the request timeout. Handing it whichever of the two runs out first is
     * what stops a step from sitting inside one attempt long past the budget that governs it —
     * without a second timer, and without the engine reaching for a clock it was not given.
     */
    const attemptTimeout = () => {
      const remaining = budgetEnds === undefined ? undefined : Math.max(1, budgetEnds - state.clock.now());
      if (remaining === undefined) return step.timeout;
      return step.timeout === undefined ? remaining : Math.min(step.timeout, remaining);
    };

    // Each attempt is captured separately (§14.5) and announces itself (§13.2), so the two live
    // here rather than in the dispatch closure — a poll that reported only its first attempt would
    // be indistinguishable from a hang, which is 002 §8.2's `attempt n/m` case.
    const attemptOnce = async () => {
      attemptsRun += 1;
      const attempt = attemptsRun;
      const attemptStartedAt = state.clock.now();
      state.emit({ type: 'step:attempt', id: stepId, index: run.iteration, attempt, status: 'sent', durationMs: 0 });

      const outcome = await runAttempt({
        pre,
        step,
        resolved,
        materialized,
        // §8.7: step-local, so an assertion and an output script inside this step see it too.
        scope: scopeFor(pre),
        runScript,
        dispatch: () =>
          state.options.ports.executeRequest(materialized.request, {
            ...state.flowContext,
            stepId,
            iteration: run.iteration,
            attempt,
            cookieJar: jar,
            timeoutMs: attemptTimeout(),
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

    /**
     * §8.2: a `shouldRetry` that throws fails **the step**, like the other two script positions.
     *
     * Left to propagate it takes the whole run with it — out of the step, out of the scheduler and
     * out of `runFlow` — where a host is holding a promise it resolved at `run:start` and has no
     * step to attach the failure to. The predicate is also the one script that runs against a
     * response that may not exist: §11.2 hands it `undefined` after a transport error, so
     * `(res) => res.body.task.status` throws on the first connection that drops — which is exactly
     * the case a poll exists to survive.
     */
    let outcome = await attemptOnce();
    let predicateError: string | undefined;
    const asksToRetry = async () => {
      if (predicateError) return false;
      try {
        return await wantsRetry(step.retry, outcome, attemptsRun, evaluationContext(scopeFor(pre)), runScript);
      } catch (cause) {
        predicateError = `shouldRetry threw: ${cause instanceof Error ? cause.message : String(cause)}`;
        return false;
      }
    };

    /**
     * §11.3: a cancelled run stops polling, and the step says so.
     *
     * Without this the step serves out its whole schedule — up to `maxAttempts` delays of `maxDelay`
     * — after the run has been declared over, sending requests nobody is waiting for. And a poll cut
     * short has not passed: reporting its last attempt as the verdict calls a step that never
     * reached its condition a success.
     */
    let interrupted = false;
    let exceeded = false;
    while (attemptsRun < step.retry.maxAttempts && !stopped(state) && (await asksToRetry())) {
      // Asked *after* the predicate, so a step that settled inside its budget is judged on what it
      // settled as. The budget only ever answers a step that wanted to go on.
      if (overBudget()) {
        exceeded = true;
        break;
      }
      await sleepFor(state.clock, retryDelay(step.retry, attemptsRun), state.flowContext.signal);
      if (stopped(state)) {
        interrupted = true;
        break;
      }
      if (overBudget()) {
        exceeded = true;
        break;
      }
      outcome = await attemptOnce();
    }

    // The other way a budget ends a step: the attempt itself was cut off by the timeout above, which
    // arrives as a transport error indistinguishable from any other. Over budget, it is this one.
    exceeded = exceeded || (overBudget() && outcome.reason === 'transport-error');

    // `maxAttempts` is a hard cap that always applies: a step exhausts its retries when the
    // predicate is still asking to retry at the cap (§11.1).
    const exhausted = attemptsRun >= step.retry.maxAttempts && step.retry.maxAttempts > 1 && (await asksToRetry());

    /**
     * §14.6's order: the first check to fail names the step. A predicate that threw *after* the
     * attempt had already failed does not rename that failure — it only explains a step that would
     * otherwise have looked fine.
     *
     * A budget that elapsed outranks both, because it is why the step stopped where it did: reporting
     * the last attempt's `unexpected-status` would describe a poll that was still working when its
     * time ran out as one that had settled on a bad answer.
     */
    const reason = exceeded
      ? 'max-duration-exceeded'
      : exhausted
        ? 'retries-exhausted'
        : outcome.reason || (predicateError ? 'script-error' : undefined);

    return {
      response: outcome.response,
      result: {
        ...identity(step, prefix),
        // §14.6: `cancelled` is the status of a step that had started, where a step the run never
        // reached is `skipped`. Both name `run-cancelled`, because both are about the same event.
        status: interrupted ? 'cancelled' : reason ? 'failed' : 'success',
        reason: interrupted ? 'run-cancelled' : reason,
        // The last attempt's, which is the one the step's verdict was built from — a run that
        // exhausted its retries is explained by what the final attempt did, not by the cap.
        message: exceeded
          ? `the step's ${step.maxDuration}ms budget elapsed after ${attemptsRun} attempts`
          : outcome.message || predicateError,
        attempts: attemptsRun,
        durationMs: state.clock.now() - startedAt,
        assertions: outcome.assertions,
        validation: outcome.validation && Object.keys(outcome.validation).length ? outcome.validation : undefined,
        outputs: outcome.outputs,
        capturePath
      }
    };
  };

  const executeSubflow = async (step: NormalizedStep, pre: Record<string, unknown>): Promise<StepResult[]> => {
    const startedAt = state.clock.now();
    const target = path.resolve(path.dirname(flow.file), step.uses as string);
    const child = await loadFlow(state, target);

    // §8.7: the caller's computed values are in scope while `with:` is resolved, and go no further —
    // §12.2's isolation is what stops them, since the sub-flow builds its own scopes.
    const args = interpolateValue(step.args, scopeFor(pre)).value as Vars;
    const params = paramsFor(child.params, args);

    const inner = await executeFlow(state, {
      flow: child,
      prefix: `${prefix}${step.id}/`,
      params: interpolateValue(params, scopeFor(pre)).value as Vars,
      iteration: run.iteration,
      profiles
    });

    // Namespaced already, so a cause inside a sub-flow names the internal step rather than the
    // container the caller sees — which is the step whose message explains it.
    verdictCauses.push(...inner.verdictCauses);
    const failedInside = inner.results.filter((result) => result.status === 'failed');
    const failed = failedInside.length > 0;

    // A failed step inside a sub-flow fails the invoking `uses:` step, which then propagates by
    // the normal §11.2 rules. Its `attempts` is always 1, since §12.4 bars `retry:` there.
    return [
      {
        ...identity(step, prefix),
        status: failed ? 'failed' : 'success',
        reason: failed ? 'subflow-failed' : undefined,
        // Which internals failed, because the container's own line is all a collapsed sub-flow
        // shows (§14.7) and `subflow-failed` alone names nothing to go and look at.
        message: failed ? failedInside.map((result) => result.id).join(', ') : undefined,
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
      } catch (cause) {
        // A throwing condition fails the step rather than skipping it: "this errored" is not
        // "this was false", and a skip would be a false statement about why (§8.2).
        record(step, {
          ...identity(step, prefix),
          status: 'failed',
          reason: 'script-error',
          message: `when: threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          attempts: 1,
          durationMs: 0,
          assertions: [],
          outputs: {}
        });
        return;
      }
    }

    /**
     * §8.7, after `when:` and before anything is built: a condition is the cheaper question and the
     * one that can make the rest unnecessary, so a step about to be skipped computes nothing.
     */
    let pre: Record<string, unknown> = {};
    if (step.pre.length) {
      const computed = await runPreScripts(step.pre, evaluationContext(scopeFor()), runScript);
      if (computed.error) {
        // §8.2's rule, one position along: a throw fails the step, and no request is sent.
        record(step, {
          ...identity(step, prefix),
          status: 'failed',
          reason: 'script-error',
          message: computed.error.message,
          attempts: 0,
          durationMs: 0,
          assertions: [],
          outputs: {}
        });
        return;
      }
      pre = computed.values;
    }

    // A `uses:` step does not draw from the budget while its internals run: its internals draw
    // from the same run-wide pool (§9.2), and a container holding a slot too would deadlock a
    // sub-flow at `concurrency: 1` — the setting §9.2 recommends for debugging.
    const produced
      = step.kind === 'subflow'
        ? { steps: await executeSubflow(step, pre), response: undefined }
        : await state.budget.run(async () => {
            const { result, response } = await executeOperation(step, pre);
            return { steps: [result], response };
          });

    const [own, ...internals] = produced.steps;
    record(step, own);
    results.push(...internals);
    publish(step, own, produced.response);
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
        /**
         * A stopped run explains a step that did not run better than its parents do (§11.3): once
         * the run is over the step above it is `cancelled`, and *every* step below then reads as an
         * unmet dependency — which describes the graph rather than what happened. A cleanup step
         * still answers to its `depends`, because accepting a cancelled parent is the whole of how
         * it was declared.
         */
        record(
          step,
          stopped(state) && !isCleanup(step)
            ? skip(step, prefix, 'run-cancelled')
            : skip(step, prefix, 'unmet-dependency', unmetBy(step, outcomes))
        );
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
        record(step, skip(step, prefix, 'unmet-dependency', unmetBy(step, outcomes)));
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

  return { results, exports, verdictCauses };
};

/**
 * §11.2. A failed step fails the flow with no exemption flag; a skip is not itself a failure, with
 * the single exception `failOnUnresolved` names — and the flag changes the verdict, never the
 * step's outcome or the schedule.
 */
const iterationStatus = (
  results: StepResult[],
  verdictCauses: string[],
  cancelled: boolean
): { status: RunStatus; decidedBy: string[] } => {
  // A cancelled run is decided by the interrupt, not by a step: the steps it cut short did nothing
  // wrong, and naming them would read as blaming them.
  if (cancelled) return { status: 'cancelled', decidedBy: [] };

  const failed = results.filter((result) => result.status === 'failed').map((result) => result.id);
  if (failed.length || verdictCauses.length) return { status: 'failed', decidedBy: [...failed, ...verdictCauses] };
  return { status: 'passed', decidedBy: [] };
};

const executeRun = async (runId: string, options: RunOptions): Promise<RunResult> => {
  // The host's signal and the budget's are folded into one, because §11.3 requires the timeout and
  // the interrupt to take the identical path — everything downstream sees a single signal.
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', () => controller.abort());

  const signal = controller.signal;
  const flowContext: FlowContext = { runId, flow: options.entry, scope: options.scope, signal };
  // The manifest, the stream and the result all report this same object, so nothing that reads a
  // run can disagree with the run's own file about where it came from.
  const origin = options.origin;

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
    // The values only this host can know are secret (§14.4); the engine adds the ones it resolves
    // itself — a `secret: true` param, an auth profile's credentials — as the run reaches them.
    secrets: createSecretTracker(options.secrets),
    diagnostics: [],
    stop: () => {
      if (state.stoppedAt === undefined) state.stoppedAt = state.clock.now();
      controller.abort();
    }
  };

  signal.addEventListener('abort', () => {
    if (state.stoppedAt === undefined) state.stoppedAt = state.clock.now();
  });

  const flow = await loadFlow(state, options.entry);

  /**
   * §12.5's required params, for a run that has no caller.
   *
   * `validate.ts` already makes this a describe-time error for a `uses:` step, whose `with:` keys are
   * written in the file — but a top-level run's params come from the host and are not knowable until
   * now. Unchecked they resolve to `undefined`, and a `params` miss is not a `steps.*` miss: nothing
   * skips the step and nothing reports it, so `{{params.email}}` reaches the wire verbatim and the
   * API rejects a request the run then calls successful.
   *
   * Thrown before `run:start` and before the capture opens, so a run that was never viable leaves no
   * artifact behind and no run for a host to attach events to — the same shape as a flow that does
   * not parse. The predicate is `validate.ts`'s, unchanged: a param with a default is supplied by
   * its default, and only an absent value is missing.
   */
  const missingParams = Object.entries(flow.params)
    .filter(([name, declared]) => declared.required && declared.default === undefined && options.params?.[name] === undefined)
    .map(([name]) => name);
  if (missingParams.length) {
    throw new Error(
      `no value was supplied for the required param${missingParams.length > 1 ? 's' : ''} ${missingParams.join(', ')}`
    );
  }

  /**
   * What this run was started with — the host's params over the flow's declared defaults (§12.5).
   *
   * Resolved once for the whole run rather than per iteration, because it is an input *to* the run:
   * every iteration is handed the same set, and the record 002 §5.6 reads has to name one thing.
   */
  const runParams = paramsFor(flow.params, options.params || {});
  /**
   * The same values the capture records, computed whether or not one is being taken: 002 §5.6's
   * node reports what the run was started with, and `--no-capture` does not make a run anonymous.
   */
  const reportedParams = startedWith(state, flow.params, runParams);

  /**
   * The dataset this run iterates, which is the flow's unless the host replaced it — §14.1's
   * `--dataset` and 002 §7.2's panel control, both arriving as `overrides.dataset` (§13.2).
   *
   * **An override supplies a dataset as readily as it replaces one.** A flow that declares none
   * runs once per row of the given file, because the case the flag exists for is a flow written
   * against one row set and pointed at another by CI — refusing unless the file already named a
   * dataset would serve the rarer half of that and reject the common one. `parallel:` is the
   * flow's either way: it is a statement about whether *these steps* can safely overlap, which is
   * a property of the flow rather than of the rows, so a flow tuned for concurrent iterations
   * keeps that tuning when the source changes under it.
   */
  const dataset = options.overrides?.dataset
    ? { source: options.overrides.dataset, parallel: flow.dataset?.parallel || 1 }
    : flow.dataset;

  state.budget = new Budget(options.overrides?.concurrency || flow.config.concurrency);
  state.cleanupGrace = flow.config.cleanupGrace;
  state.nestIterations = dataset !== undefined;
  // The root flow's policy governs the whole run, sub-flows included — the same value and the same
  // scope the capture below is given, so a host and a capture can never mask different sets.
  flowContext.redactHeaders = flow.config.redactHeaders;

  // §14.5's identity file has to exist before the first step, so the capture is opened as soon as
  // the flow's own retention and redaction settings are known and before anything is dispatched.
  let snapshot: FlowSnapshot | undefined;
  if (options.overrides?.capture?.enabled !== false) {
    state.capture = createCapture({
      ports: options.ports,
      context: flowContext,
      dir: options.overrides?.capture?.dir,
      origin,
      startedAt: new Date(state.clock.now()).toISOString(),
      redactHeaders: flow.config.redactHeaders,
      secrets: state.secrets
    });
    snapshot = await flowSnapshot(state, options.entry, reportedParams, dataset);
    await state.capture.start(snapshot);
  }

  // The bound belongs to whoever knows the environment, which is usually CI rather than the flow
  // file — so `--max-run-duration` overrides, and neither is set by default (§11.3).
  const maxRunDuration = options.overrides?.maxRunDuration ?? flow.config.maxRunDuration;
  if (maxRunDuration !== undefined) state.deadline = state.clock.now() + maxRunDuration;

  /**
   * §7.4's containment applies here as it does to `!file`, through the same helper — a dataset is
   * a fixture read like any other, and an override arrives from a command line where `../` costs
   * nothing to type. The path is resolved against the flow's directory and refused if it leaves
   * the scope root; `parseDataset` is still handed the source as written, so a format or parse
   * error names the path the author typed rather than one this machine assembled.
   */
  const rows: (Vars | undefined)[] = dataset
    ? parseDataset(dataset.source, await readText(state, resolveWithin(dataset.source, flow.file, scopeRoot(state))))
    : [undefined];

  // The snapshot is reported as well as written, so a watcher draws the flow this run is executing
  // rather than the file, which can be edited while the run is still going (002 §4.3, §8.1).
  state.emit({
    type: 'run:start',
    runId,
    ...(origin ? { origin } : {}),
    flow: options.entry,
    iterationCount: rows.length,
    captureDir: state.capture?.dir,
    description: snapshot?.description,
    params: reportedParams
  });

  const iterations: IterationResult[] = [];
  const parallel = dataset?.parallel || 1;

  /**
   * **After `run:start`, a run always ends with `run:end`.**
   *
   * Everything below is written not to throw — a step's failure is a `StepResult`, an artifact write
   * never fails a run — but "written not to" is not a guarantee, and the shape of the failure when
   * one escapes is the worst available: the promise a host resolved at `run:start` rejects somewhere
   * it cannot attach the error to a step, no terminal event is emitted, and a watching app is left
   * with a run that is running forever and a cancel with nothing to cancel. So §13.2's stream
   * terminates whatever happened, and the rejection still propagates for a host awaiting the result.
   */
  const crashed = (error: unknown): RunResult => ({
    runId,
    ...(origin ? { origin } : {}),
    status: 'failed',
    iterations,
    decidedBy: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 },
    diagnostics: [
      ...state.diagnostics,
      {
        severity: 'error',
        code: 'run-failed',
        message: error instanceof Error ? error.message : String(error),
        file: options.entry
      }
    ],
    captureDir: state.capture?.dir
  });

  try {
    for (let start = 0; start < rows.length; start += parallel) {
      const batch = rows.slice(start, start + parallel).map(async (row, offset) => {
        const index = start + offset;
        state.emit({ type: 'iteration:start', index, row });
        const { results, verdictCauses } = await executeFlow(state, {
          flow,
          prefix: '',
          params: runParams,
          row,
          iteration: index,
          profiles: {}
        });
        const { status, decidedBy } = iterationStatus(results, verdictCauses, signal.aborted);
        state.emit({ type: 'iteration:end', index, status });
        return { index, row, status, steps: results, decidedBy };
      });

      iterations.push(...(await Promise.all(batch)));
    }

    iterations.sort((left, right) => left.index - right.index);
    const steps = iterations.flatMap((iteration) => iteration.steps);

    const result: RunResult = {
      runId,
      ...(origin ? { origin } : {}),
      status: signal.aborted
        ? 'cancelled'
        : iterations.some((iteration) => iteration.status === 'failed')
          ? 'failed'
          : 'passed',
      iterations,
      // The flatten lives here rather than in each host: two of them read this, and a join done twice
      // is a join that can be done differently twice. Without repeats, because a dataset runs the same
      // step per row and "which steps decided this run" has one answer however many rows hit it.
      decidedBy: [...new Set(iterations.flatMap((iteration) => iteration.decidedBy || []))],
      summary: {
        total: steps.length,
        passed: steps.filter((step) => step.status === 'success').length,
        failed: steps.filter((step) => step.status === 'failed').length,
        skipped: steps.filter((step) => step.status === 'skipped').length,
        cancelled: steps.filter((step) => step.status === 'cancelled').length
      },
      diagnostics: state.diagnostics,
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
  } catch (error) {
    state.emit({ type: 'run:end', result: crashed(error) });
    throw error;
  }
};

/**
 * The registration around the run is what lets `listRuns` tell a run still going from one that
 * died: both are a `run.json` with no `summary.json` beside it, and only the process executing one
 * knows which it is (002 §10, §11.2).
 */
export const runFlow = async (options: RunOptions): Promise<RunResult> => {
  const runId = randomUUID();
  markRunActive(runId);
  try {
    return await executeRun(runId, options);
  } finally {
    markRunFinished(runId);
  }
};
