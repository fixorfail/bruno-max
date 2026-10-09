/**
 * The run — 001 §9, §11 and §12.
 *
 * Scheduling, propagation and iteration live here: which steps are eligible (§9.1), how many run
 * at once (§9.2), what a failure does to the steps below it (§11.2), and how a sub-flow's internals
 * join the result (§12). Everything a single step decides for itself is `step.ts`.
 */
import { randomUUID } from 'crypto';

import { createCapture, previewAttempt, type AttemptPreview, type AttemptRecord, type Capture } from './capture';
import { Connectors } from './connectors';
import { parseDataset } from './dataset';
import { describeFlow } from './describe';
import {
  FileRef,
  normalizeFlow,
  type FlowConfig,
  parseAssertion,
  parseDocument,
  type LoopSpec,
  type NormalizedFlow,
  type NormalizedStep
} from './document';
import { evaluateCondition, evaluationContext } from './expression';
import { createFileReader, FileAccessError, parseStructured, resolveSubflowTarget, resolveWithin } from './files';
import { loadLibrary, withLibrary } from './functions';
import { markRunActive, markRunFinished } from './history';
import { interpolateScalar, interpolateValue, scopeVariables, type Scope } from './interpolate';
import { describeIteration, interpolateLoopSource, loopScope, loopShapeError } from './loop';
import { materialize, MaterializationError, type AuthProfile, type Materialized } from './materialize';
import { resolveSpecSource, SpecLoader } from './openapi';
import { createRedactor, createSecretTracker, MASK, type Redactor, type SecretTracker } from './redact';
import {
  loopUntilMatches,
  lowerCasedKeys,
  responseView,
  runAttempt,
  retryDelay,
  runPreScripts,
  sleepFor,
  wantsRetry,
  type ScriptRunner
} from './step';
import { createLimiter, type Limiter } from './ratelimit';
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
  StepReason,
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
  /** §8.5's connector files, read once per run and applied to every document `loadFlow` reads. */
  connectors: Connectors;
  budget: Budget;
  /**
   * §6.2's declared pacing, one bucket per bound document (004). Run-scoped exactly as `budget` is:
   * every step, sub-flow and iteration of this run draws from it, and nothing outside the run does.
   * Absent under `--no-rate-limit`, which is the only way a declared limit is not honoured.
   */
  limiter?: Limiter;
  emit: (event: FlowEvent) => void;
  /** The environment tiers, flattened per §7.3's order. `--env-var` merges into `environment`. */
  environment: Vars;
  /** §11.3's whole-run budget, as a deadline on the injected clock. Absent unless asked for. */
  deadline?: number;
  /** When the run was stopped, so §11.3's cleanup window can be bounded from it. */
  stoppedAt?: number;
  cleanupGrace: number;
  /** Whether `run:cleanup` has gone out — it is emitted once, when the run first acts on a stop. */
  cleanupAnnounced: boolean;
  /**
   * The flows executing right now — the entry's, per iteration, and every sub-flow in flight. Once
   * the run stops these are the only places a cleanup step can still come from: a sub-flow that
   * has not started is skipped whole, and one that has finished has nothing left to run.
   */
  activeFlows: NormalizedFlow[];
  stop: () => void;
  /** §14.5's artifact directory. Absent under `--no-capture`. */
  capture?: Capture;
  /**
   * §14.4's header denylist and §14.5's preview cap, both the root flow's — the same policy the
   * capture applies, held here because `step:end` carries a preview whether or not a capture is
   * being written.
   */
  redactor: Redactor;
  previewBytes: number;
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
/**
 * The exception §11.3 carves out: steps whose `depends` accepts `cancelled` still run, so a flow
 * can clean up after an interrupted run. Deliberately bounded — only steps that *declared*
 * `cancelled` are eligible, and only inside `config.cleanupGrace`.
 */
const isCleanup = (step: NormalizedStep): boolean =>
  step.depends.entries.some((entry) => entry.status.includes('cancelled'));

/**
 * 002 §7.1's state: from here until the deadline only cleanup steps run, and a host that was not
 * told would show a cancel that appears to do nothing for up to `cleanupGrace`. Announced the first
 * time the scheduler acts on the stop rather than from the abort listener, which can fire after
 * `run:end` — and `run:end` is last (§13.2). The deadline is the one `withinCleanupGrace` enforces.
 *
 * **Only when there is a cleanup step to run.** The window is a state a host shows, and a run with
 * no step eligible for it goes straight from the stop to `run:end`; announcing a window nothing
 * will use would have the control read "cleaning up" over a run that is simply over. Whether one
 * exists is asked of the flows in flight, which is where a step can still come from after a stop.
 */
const announceCleanup = (state: RunState): void => {
  if (state.stoppedAt === undefined) state.stoppedAt = state.clock.now();
  if (state.cleanupAnnounced || !state.activeFlows.some((flow) => flow.steps.some(isCleanup))) return;
  state.cleanupAnnounced = true;
  state.emit({ type: 'run:cleanup', runId: state.runId, deadline: state.stoppedAt + state.cleanupGrace });
};

const stopped = (state: RunState): boolean => {
  const overBudget = state.deadline !== undefined && state.clock.now() >= state.deadline;
  if (!state.flowContext.signal.aborted && !overBudget) return false;
  if (overBudget) state.stop();
  announceCleanup(state);
  return true;
};

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

/**
 * One iteration of a `loop:` step, as the executors receive it (006 §3).
 * A step without `loop:` has no turn. It runs as it ran before.
 */
type LoopTurn = {
  /** `loop.index`. */
  index: number;
  /** The `loop.*` namespace for this iteration. */
  scope: Record<string, unknown>;
  /**
   * The time when `maxDuration` of the whole loop ends, on the injected clock. The loop bounds
   * each iteration. An iteration never starts a new bound of its own.
   */
  budgetEnds?: number;
  /**
   * Set only when the loop has `concurrency` above 1 (006 §6). It aborts when the run stops, and
   * when a sibling iteration fails.
   */
  signal?: AbortSignal;
};

/** What a `loop:` step publishes in `steps.<id>`, in addition to its outputs (006 §4). */
type LoopPublication = {
  matched: boolean;
  count: number;
  index?: number;
  iterations: Record<string, unknown>[];
};

/** What the executor of a step gives back to `execute`, which records it and publishes it. */
type Produced = {
  steps: StepResult[];
  response?: ExecutedResponse;
  preview?: AttemptPreview;
  loop?: LoopPublication;
};

/** An iteration of a loop that has run. */
type IterationRun = {
  index: number;
  value: unknown;
  scope: Record<string, unknown>;
  /** The values of `pre:` for this iteration. `until` and `next` receive them in `ctx`. */
  pre: Record<string, unknown>;
  /** The result of the iteration, as it is for a step without `loop:`. */
  result: StepResult;
  /** The steps inside the sub-flow, for a `uses:` step. */
  internals: StepResult[];
  response?: ExecutedResponse;
  preview?: AttemptPreview;
};

/**
 * How a loop ended. `done` is a success. `at` is the iteration that decided the result.
 * `skipped` means that the first iteration found a reference that no step produced.
 */
type Verdict
  = | { kind: 'done'; matched: boolean; at?: IterationRun }
    | { kind: 'failed'; reason?: StepReason; message: string; at?: IterationRun }
    | { kind: 'cancelled'; at?: IterationRun }
    | { kind: 'skipped'; message: string };

/** Where the values of a loop come from (006 §2). */
type LoopSource = { kind: 'list'; items: unknown[] } | { kind: 'cursor'; first: unknown; next: string };

/** The value of the next iteration, or the end of the loop. */
type Upcoming = { present: false } | { present: true; value: unknown };

/** A cursor ends at `null` or `undefined` (006 §2). */
const cursorValue = (value: unknown): Upcoming =>
  value === null || value === undefined ? { present: false } : { present: true, value };

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The requests of each iteration, in the place of its `loop.index`. An iteration that the loop
 * cancelled is not in `ran`, and its place holds 0.
 */
const attemptsByIndex = (ran: IterationRun[]): number[] => {
  const byIndex = new Map(ran.map((done) => [done.index, done.result.attempts]));
  return Array.from({ length: Math.max(...byIndex.keys()) + 1 }, (unused, index) => byIndex.get(index) ?? 0);
};

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

const loadFlow = async (
  state: RunState,
  file: string,
  /** The invoking flow's `config:`, which a sub-flow inherits as defaults (§12.3). */
  inheritedConfig?: FlowConfig
): Promise<NormalizedFlow> => {
  const flow = normalizeFlow(parseDocument(await readText(state, file)), file, inheritedConfig);
  // `bru flow validate` reports these as diagnostics and exits 2 before a run is attempted (§14.3),
  // so reaching here means nobody validated. Refusing is the point: the parser recovers a partial
  // tree from a syntax error, and running it would send requests the file does not describe.
  if (flow.errors.length) {
    const [first] = flow.errors;
    throw new Error(`${file}:${first.line}:${first.column} ${first.message}`);
  }
  // §8.5: a connector-supplied output is extracted and published exactly as an `outputs:` entry is,
  // so from here on nothing in the run knows a connector file exists. Which files apply is decided
  // by where *this* document is, not by who invoked it (§12.3).
  const applied = await state.connectors.apply(flow);

  /**
   * 004 §6: a document's bucket exists from the moment a flow that binds it is *read*, not from the
   * first step that reaches it.
   *
   * Two consequences, both wanted. A sub-flow binding the same document without a `rateLimit:` of
   * its own is still paced by the one its caller declared — the limit describes the service, and a
   * sub-flow is not a way around it. And where two documents in the run disagree, the bucket has
   * already seen both by the time anything dispatches, so the rate does not depend on which step
   * won the race to it.
   */
  for (const binding of Object.values(applied.apis)) {
    if (binding.rateLimit) state.limiter?.register(resolveSpecSource(binding.source, file), binding.rateLimit);
  }

  return applied;
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
   *
   * `loop` is a parameter for the same reason (006 §3). It holds the iteration of the step that the
   * engine builds. A scope without it has no `loop` namespace.
   */
  const scopeFor = (pre: Record<string, unknown> = {}, loop?: Record<string, unknown>): Scope => ({
    vars: { ...state.environment, ...resolvedVars },
    tiers: { env: state.environment, vars: resolvedVars },
    namespaces: {
      steps: stepState,
      row: run.row || {},
      params: resolvedParams,
      shared: slots,
      flow: { runId: state.runId, name: flow.meta.name, iteration: run.iteration },
      pre,
      ...(loop ? { loop } : {}),
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

  const record = (step: NormalizedStep, result: StepResult, preview?: AttemptPreview) => {
    if (result.reason === 'unresolved-dependency' && step.flags.failOnUnresolved) verdictCauses.push(result.id);
    /**
     * §14.4 masks a **copy**, at the point a result leaves the run — this array becomes
     * `RunResult.iterations`, and the event is the other way out. `publish` below is handed the
     * unmasked result on purpose: a step reading `{{steps.login.token}}` has to be sent the token.
     * The preview arrives already masked — `previewAttempt` has to cut after masking, not before.
     */
    const reported = state.secrets.mask(result);
    outcomes.set(step.id, reported);
    results.push(reported);
    state.emit({
      type: 'step:end',
      id: reported.id,
      index: run.iteration,
      result: reported,
      ...(preview ? { preview } : {})
    });
  };

  /**
   * §9.1: **last writer in declaration order wins.** Writes land as steps finish, and two branches
   * running concurrently finish in whatever order the network returns — so a slot remembers which
   * step wrote it and takes a later-finishing write only from a later-declared step. File order is
   * what makes the same flow resolve the same value on a loaded CI machine and on a laptop.
   */
  const slotWriters: Record<string, number> = {};
  const writeSlot = (slot: string, value: unknown, writer: number) => {
    if (slotWriters[slot] !== undefined && slotWriters[slot] > writer) return;
    slotWriters[slot] = writer;
    slots[slot] = value;
  };

  /**
   * §8.3's built-in metadata, alongside the step's declared outputs under the same id.
   * A `loop:` step also publishes `matched`, `iterations`, `count` and, when an `until` matched,
   * `index` (006 §4). They come last, so they win over a declared output of the same name.
   */
  const publish = (step: NormalizedStep, result: StepResult, response?: ExecutedResponse, loop?: LoopPublication) => {
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
      duration: result.durationMs,
      ...(loop
        ? {
            matched: loop.matched,
            iterations: loop.iterations,
            count: loop.count,
            ...(loop.index === undefined ? {} : { index: loop.index })
          }
        : {})
    };
    const declaredAt = flow.steps.indexOf(step);
    for (const { slot, output } of step.shared) {
      if (result.outputs[output] !== undefined) writeSlot(slot, result.outputs[output], declaredAt);
    }
  };

  const executeOperation = async (
    step: NormalizedStep,
    pre: Record<string, unknown>,
    turn?: LoopTurn
  ): Promise<{ result: StepResult; response?: ExecutedResponse; preview?: AttemptPreview }> => {
    const startedAt = state.clock.now();
    // The scope of every position that this step builds or evaluates. In a loop it has `loop.*`.
    const scope = () => scopeFor(pre, turn?.scope);
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

      materialized = await materialize(step, binding, resolved, profiles, flow.config, scope(), readFile);
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
    /** 004 §7: what this step spent waiting its turn, reported apart from what the requests took. */
    let stepWaitMs = 0;

    /**
     * §6.2's bucket for this step's API — the document its binding resolves to, which is what the
     * limiter is keyed on (004 §3). Computed once per step rather than per attempt: it cannot change
     * between attempts, and `resolveSpecSource` is the same path `SpecLoader` already read.
     */
    const pacingKey = binding ? resolveSpecSource(binding.source, flow.file) : undefined;

    /**
     * §11.1's `maxDuration` — the whole step's budget, retries and the delays between them included,
     * where `timeout` bounds one attempt. `maxAttempts × (timeout + delay)` is the wall-clock a poll
     * can otherwise take, and on the schedules polls actually use that is tens of minutes.
     *
     * A deadline read off the injected clock rather than a timer, exactly as §11.3's whole-run budget
     * is: the clock is the engine's only source of time (§13.2), and a step whose budget was a real
     * timer would elapse differently under a host that supplies its own — including the conformance
     * harness, where a poll's delays are the *only* thing that advances time.
     *
     * In a loop, the loop owns the budget (006 §5). Each iteration would otherwise start a new
     * budget, and `maxDuration` would bound one iteration and not the whole loop.
     */
    const budgetEnds = turn
      ? turn.budgetEnds
      : step.maxDuration === undefined
        ? undefined
        : startedAt + step.maxDuration;
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

    /**
     * Whether the engine itself aborted the attempt that just settled, which is how §14.6's
     * `cancelled` is told apart from a genuine `transport-error`: the port reports both as a
     * rejection, and only the side owning the signal knows which of the two it caused.
     */
    let dispatchAborted = false;

    /**
     * The signal the host aborts this request with, and what to do once the request has settled.
     *
     * §11.3's cleanup exception schedules a step *after* the run has stopped, so the run's own
     * signal is aborted before the request is even built: handed over, it cancels the very work the
     * grace window exists to let finish. Such a dispatch gets a signal of its own, bounded by that
     * window — live now, aborting at the deadline `run:cleanup` announced. Every other dispatch is
     * the run's, and is aborted by the cancellation exactly as before.
     *
     * The deadline is a timer rather than a reading of the injected clock because it has to
     * interrupt a promise the *host* owns while nothing in the engine is running: `Clock` exists so
     * retry delays and `maxRunDuration` are drivable in tests (§13.2), and both of those are read
     * where the scheduler already passes through. `stoppedAt` and the grace are still the clock's,
     * so the window a run announces and the window it enforces are one value.
     */
    const beginDispatch = (): { signal: AbortSignal; settled: () => void } => {
      const { stoppedAt } = state;

      if (!isCleanup(step) || stoppedAt === undefined) {
        return {
          // In a loop with `concurrency`, the signal of the loop aborts when the run stops or when a
          // sibling iteration fails (006 §6). `dispatchAborted` follows the run only. A request
          // that the loop cancels is not a cancelled run.
          signal: turn?.signal || state.flowContext.signal,
          settled: () => {
            dispatchAborted = state.flowContext.signal.aborted;
          }
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        dispatchAborted = true;
        controller.abort();
      }, Math.max(0, stoppedAt + state.cleanupGrace - state.clock.now()));

      return { signal: controller.signal, settled: () => clearTimeout(timer) };
    };

    // Each attempt is captured separately (§14.5) and announces itself (§13.2), so the two live
    // here rather than in the dispatch closure — a poll that reported only its first attempt would
    // be indistinguishable from a hang, which is 002 §8.2's `attempt n/m` case.
    /**
     * How long this attempt may spend waiting for a token before the wait is pointless — the sooner
     * of the step's `maxDuration` and the run's `maxRunDuration`.
     *
     * §11.3's deadline is *polled*, at scheduling points and around a retry delay, so a bucket
     * declaring `requests: 1, per: hour` would otherwise sleep an hour past a run that had already
     * run out of time, with nothing looking. A cleanup step is the exception: it runs after the run
     * has stopped, so the run's deadline is behind it by definition and would refuse every wait —
     * the grace window bounds that one instead, and the window is already this dispatch's signal.
     */
    const pacingBudget = (): number | undefined => {
      if (isCleanup(step) && state.stoppedAt !== undefined) return undefined;

      const ends = [budgetEnds, state.deadline].filter((end): end is number => end !== undefined);
      return ends.length ? Math.max(0, Math.min(...ends) - state.clock.now()) : undefined;
    };

    const attemptOnce = async () => {
      attemptsRun += 1;
      const attempt = attemptsRun;
      const attemptStartedAt = state.clock.now();
      /** Kept apart from the attempt's elapsed time: a paced request is not a slow one. */
      let attemptWaitMs = 0;
      state.emit({
        type: 'step:attempt',
        id: stepId,
        index: run.iteration,
        // Which iteration of a loop this is an attempt of. Under `concurrency` the attempts of
        // several iterations interleave, and the number of the attempt cannot say whose it is.
        ...(turn ? { iteration: turn.index } : {}),
        attempt,
        status: 'sent',
        durationMs: 0
      });

      dispatchAborted = false;
      const outcome = await runAttempt({
        pre,
        step,
        resolved,
        materialized,
        // §8.7: step-local, so an assertion and an output script inside this step see it too.
        scope: scope(),
        runScript,
        dispatch: async () => {
          const bound = beginDispatch();
          try {
            /**
             * 004 §7's token, taken here and on **every** attempt — a retry is a request like any
             * other, and a poll that ignored the limit while retrying would break it exactly when
             * the API is already saying it is under strain.
             *
             * Inside `dispatch` rather than at the top of the attempt because `runAttempt` runs
             * §10.1's request validation first and can refuse without sending: a token spent there
             * would pace a request that never went out. Inside `beginDispatch` because the signal it
             * mints is the one that governs this dispatch — for a cleanup step that is the grace
             * window, not the run's aborted signal.
             */
            if (pacingKey) {
              const paced = await state.limiter?.acquire(pacingKey, bound.signal, pacingBudget());
              if (paced) {
                attemptWaitMs += paced.waitedMs;
                if (!paced.acquired) {
                  // Refused: the run stopped while this step queued, or the wait outlasted the time
                  // it had. Both already have a name downstream — a rejected dispatch is a transport
                  // error, and `dispatchAborted` plus `overBudget()` decide which of the two it was.
                  dispatchAborted = bound.signal.aborted;
                  throw new Error(`${step.id}: rate-limited, and the run ran out of time waiting`);
                }
              }
            }

            return await state.options.ports.executeRequest(materialized.request, {
              ...state.flowContext,
              stepId,
              iteration: run.iteration,
              attempt,
              cookieJar: jar,
              // The scope the request was built from, `pre` included — not one rebuilt for the
              // host, which could only differ from it.
              variables: scopeVariables(scope()),
              timeoutMs: attemptTimeout(),
              signal: bound.signal
            });
          } finally {
            bound.settled();
          }
        }
      });

      stepWaitMs += attemptWaitMs;

      capturePath = await recordAttempt(state, {
        stepId,
        iteration: state.nestIterations ? run.iteration : undefined,
        loopIteration: turn?.index,
        attempt,
        startedAt: new Date(attemptStartedAt).toISOString(),
        // Net of §6.2's pacing: this number answers "how long did the API take", and a request held
        // back by the flow's own limiter did not take any longer for it (004 §7).
        durationMs: state.clock.now() - attemptStartedAt - attemptWaitMs,
        rateLimitWaitMs: attemptWaitMs || undefined,
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
        return await wantsRetry(step.retry, outcome, attemptsRun, evaluationContext(scope()), runScript);
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

    /**
     * §14.6: a request the engine aborted because the run had stopped is `cancelled`, not a
     * transport error. §11.3 names both halves of the same event — a step the run never reached is
     * skipped, and one whose request was in flight is `cancelled` — and without this only the
     * second-and-later attempts of a poll could reach it, since the retry delay was the sole place
     * a stop was noticed.
     */
    if (dispatchAborted && outcome.reason === 'transport-error') interrupted = true;

    // The other way a budget ends a step: the attempt itself was cut off by the timeout above, which
    // arrives as a transport error indistinguishable from any other. Over budget, it is this one.
    exceeded = exceeded || (!interrupted && overBudget() && outcome.reason === 'transport-error');

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
      // The last attempt's — the one the verdict was built from, and the one the capture path names.
      preview: previewAttempt(
        {
          request: outcome.reason === 'invalid-request' ? undefined : materialized.request,
          response: outcome.response
        },
        state.redactor,
        state.secrets,
        state.previewBytes
      ),
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
        /**
         * Reported beside the step's wall time rather than subtracted from it (004 §7). The step's
         * number already contains §11.1's retry delays, and taking one kind of waiting out of it and
         * not the other would leave one field meaning two things. An attempt's `durationMs` is the
         * one that means "the request", and the pacing does come out of that.
         */
        rateLimitWaitMs: stepWaitMs || undefined,
        assertions: outcome.assertions,
        validation: outcome.validation && Object.keys(outcome.validation).length ? outcome.validation : undefined,
        outputs: outcome.outputs,
        capturePath
      }
    };
  };

  /**
   * The sub-flow a `uses:` step runs, read before the step is announced so `step:start` can say how
   * many steps it holds (§14.7). §12.2's `workspace:` prefix and its containment (§7.4) are the same
   * refusal a malformed path gets from `loadFlow`: reaching either means nobody ran `bru flow
   * validate` first.
   */
  const loadSubflow = (step: NormalizedStep): Promise<NormalizedFlow> =>
    loadFlow(state, resolveSubflowTarget(step.uses as string, flow.file, state.options.scope), flow.config);

  const executeSubflow = async (
    step: NormalizedStep,
    child: NormalizedFlow,
    pre: Record<string, unknown>,
    turn?: LoopTurn
  ): Promise<StepResult[]> => {
    const startedAt = state.clock.now();

    // §8.7: the caller's computed values are in scope while `with:` is resolved, and go no further —
    // §12.2's isolation is what stops them, since the sub-flow builds its own scopes.
    // In a loop, `loop.*` is in scope here too, and stops at the same boundary (006 §7).
    const callerScope = scopeFor(pre, turn?.scope);
    const args = interpolateValue(step.args, callerScope).value as Vars;
    const params = paramsFor(child.params, args);

    const inner = await executeFlow(state, {
      flow: child,
      // Each iteration of a loop has a namespace of its own, so the steps of two iterations never
      // share an id or a capture directory (006 §7). A step id cannot contain `-`, so the
      // segment cannot be the id of a step in the sub-flow.
      prefix: `${prefix}${step.id}/${turn ? `iteration-${turn.index}/` : ''}`,
      params: interpolateValue(params, callerScope).value as Vars,
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

  /**
   * A step with `loop:` (006). The loop runs the lifecycle of the step one time for each value.
   * `when:` and `depends:` have already answered for the whole loop. The loop repeats the rest,
   * from `pre:` on. The same checks decide if an iteration passes, as for a step without a loop.
   * The loop only decides if it goes on.
   */
  const executeLoop = async (step: NormalizedStep, spec: LoopSpec, child?: NormalizedFlow): Promise<Produced> => {
    const startedAt = state.clock.now();
    const stepId = `${prefix}${step.id}`;
    const loopEnds = step.maxDuration === undefined ? undefined : startedAt + step.maxDuration;
    const overBudget = () => loopEnds !== undefined && state.clock.now() >= loopEnds;
    // A cleanup step keeps running during the grace window, as it does when it has no loop (§11.3).
    const interrupted = () => stopped(state) && !(isCleanup(step) && withinCleanupGrace(state));

    const refused = (message: string): Produced => ({
      steps: [{ ...skip(step, prefix, undefined, `${step.id}: ${message}`), status: 'failed', reason: 'invalid-request' }]
    });

    // Nobody validated the flow if this fails (§14.3), and the run sends no request.
    const shapeError = loopShapeError(spec);
    if (shapeError) return refused(shapeError);

    const resolved = interpolateLoopSource(spec.over !== undefined ? spec.over : spec.start, scopeFor());
    if (resolved.unresolved.length) {
      return {
        steps: [skip(step, prefix, 'unresolved-dependency', `never produced: ${resolved.unresolved.join(', ')}`)]
      };
    }

    let source: LoopSource;
    if (spec.over !== undefined) {
      if (!Array.isArray(resolved.value)) {
        return refused(`loop.over is not a list — it resolved to ${resolved.value === null ? 'null' : typeof resolved.value}`);
      }
      source = { kind: 'list', items: resolved.value };
    } else {
      // `loopShapeError` has checked that `next:` is present when `start:` is.
      source = { kind: 'cursor', first: resolved.value, next: spec.next as string };
    }
    const of = source.kind === 'list' ? Math.min(source.items.length, spec.max) : undefined;

    const runIteration = async (
      index: number,
      value: unknown,
      earlier: Record<string, unknown>[] | undefined,
      signal?: AbortSignal
    ): Promise<IterationRun> => {
      const scope = loopScope(spec, value, index, earlier);
      const turn: LoopTurn = { index, scope, budgetEnds: loopEnds, signal };

      state.emit({
        type: 'step:iteration',
        id: stepId,
        index: run.iteration,
        iteration: index,
        ...(of === undefined ? {} : { of }),
        value: state.secrets.mask(value)
      });

      // §8.7 again, with `loop.*` in scope. A throw fails the step and sends no request.
      let pre: Record<string, unknown> = {};
      if (step.pre.length) {
        const computed = await runPreScripts(step.pre, evaluationContext(scopeFor({}, scope)), runScript);
        if (computed.error) {
          const result: StepResult = {
            ...skip(step, prefix, undefined, computed.error.message),
            status: 'failed',
            reason: 'script-error'
          };
          return { index, value, scope, pre, result, internals: [] };
        }
        pre = computed.values;
      }

      if (child) {
        const [result, ...internals] = await executeSubflow(step, child, pre, turn);
        return { index, value, scope, pre, result, internals };
      }
      // Each iteration takes a place in the budget of the run for itself. The loop holds none
      // between two iterations, and other steps can use the place.
      const { result, response, preview } = await state.budget.run(() => executeOperation(step, pre, turn));
      return { index, value, scope, pre, result, internals: [], response, preview };
    };

    const failedAt = (at: IterationRun): Verdict => ({
      kind: 'failed',
      reason: at.result.reason,
      message: `${describeIteration(at.index, at.value)} failed${at.result.message ? `: ${at.result.message}` : ''}`,
      at
    });

    const scriptFailed = (at: IterationRun, position: string, cause: unknown): Verdict => ({
      kind: 'failed',
      reason: 'script-error',
      message: `${describeIteration(at.index, at.value)}: ${position} threw: ${errorText(cause)}`,
      at
    });

    const exceeded = (count: number): Verdict => ({
      kind: 'failed',
      reason: 'max-duration-exceeded',
      message: `the ${step.maxDuration}ms budget of the loop elapsed after ${count} iterations`
    });

    const maxReached: Verdict = {
      kind: 'failed',
      reason: 'loop-max-reached',
      message: `${spec.max} iterations ran, and the loop has more values`
    };

    /**
     * The scope of an iteration after it ended, for `until` and `next`. `loop.iterations` then
     * includes the iteration itself, and `loop.previous` is still the iteration before it (006 §3).
     */
    const endedScope = (done: IterationRun, finished: Record<string, unknown>[]) => ({
      ...done.scope,
      iterations: finished
    });

    const nextValue = async (done: IterationRun, finished: Record<string, unknown>[]): Promise<Upcoming> => {
      if (source.kind === 'list') {
        return done.index + 1 < source.items.length
          ? { present: true, value: source.items[done.index + 1] }
          : { present: false };
      }
      // `loop.*` in this call is the iteration that just ended, so `ctx.loop.<as>` is the cursor
      // that a script can add to.
      return cursorValue(
        await runScript(source.next, [
          done.result.outputs,
          evaluationContext(scopeFor(done.pre, endedScope(done, finished)))
        ])
      );
    };

    /** One iteration at a time. The only way for a loop with `until` or `next`. */
    const iterateInOrder = async (): Promise<{ verdict: Verdict; ran: IterationRun[] }> => {
      const ran: IterationRun[] = [];
      let upcoming: Upcoming = source.kind === 'list'
        ? (source.items.length ? { present: true, value: source.items[0] } : { present: false })
        : cursorValue(source.first);
      // The outputs of the iterations that finished. Each scope gets its own copy of the list.
      const finished: Record<string, unknown>[] = [];

      while (upcoming.present) {
        if (interrupted()) return { verdict: { kind: 'cancelled' }, ran };
        if (overBudget()) return { verdict: exceeded(ran.length), ran };

        const done = await runIteration(ran.length, upcoming.value, [...finished]);
        const { result } = done;

        // A reference that no step produced is the same for every iteration, because no step
        // publishes until the loop ends. So it can happen only in the first iteration, and the
        // loop has sent nothing. The step is skipped, as a step without `loop:` is (§11.2).
        if (result.status === 'skipped') {
          return { verdict: { kind: 'skipped', message: `${describeIteration(done.index, done.value)}: ${result.message}` }, ran };
        }
        ran.push(done);
        if (result.status === 'cancelled') return { verdict: { kind: 'cancelled', at: done }, ran };
        if (result.status === 'failed') return { verdict: failedAt(done), ran };
        finished.push(result.outputs);

        if (spec.until) {
          let matched: boolean;
          try {
            matched = await loopUntilMatches(
              spec.until,
              child ? result.outputs : responseView(done.response),
              result.outputs,
              evaluationContext(scopeFor(done.pre, endedScope(done, [...finished]))),
              runScript
            );
          } catch (cause) {
            return { verdict: scriptFailed(done, 'until', cause), ran };
          }
          if (matched) return { verdict: { kind: 'done', matched: true, at: done }, ran };
          // With `until`, a loop that ran `max` iterations without a match is a loop with no match.
          if (ran.length >= spec.max) return { verdict: { kind: 'done', matched: false }, ran };
        }

        try {
          upcoming = await nextValue(done, [...finished]);
        } catch (cause) {
          return { verdict: scriptFailed(done, 'next', cause), ran };
        }
        if (!upcoming.present) return { verdict: { kind: 'done', matched: !spec.until }, ran };
        // Without `until`, a loop that stops at `max` with values left has not done its work.
        if (ran.length >= spec.max) return { verdict: maxReached, ran };
      }

      return { verdict: { kind: 'done', matched: !spec.until }, ran };
    };

    /**
     * Up to `concurrency` iterations at the same time (006 §6). The first failure aborts the
     * requests in flight and stops the start of new ones. The step reports the lowest index of the
     * iterations that failed. `loop.previous` and `loop.iterations` are `undefined` here, because no
     * iteration waits.
     */
    const iterateTogether = async (items: unknown[]): Promise<{ verdict: Verdict; ran: IterationRun[] }> => {
      const total = Math.min(items.length, spec.max);
      const settled: IterationRun[] = [];
      const halt = new AbortController();
      const haltWithRun = () => halt.abort();
      let taken = 0;

      const worker = async () => {
        while (taken < total && !halt.signal.aborted && !interrupted() && !overBudget()) {
          const index = taken;
          taken += 1;
          const done = await runIteration(index, items[index], undefined, halt.signal);
          // The loop itself cancelled this request. A request that the loop cancels does not fail.
          if (halt.signal.aborted && done.result.reason === 'transport-error') continue;
          settled.push(done);
          if (done.result.status !== 'success') halt.abort();
        }
      };
      state.flowContext.signal.addEventListener('abort', haltWithRun, { once: true });
      try {
        await Promise.all(Array.from({ length: Math.min(spec.concurrency, total) }, worker));
      } finally {
        state.flowContext.signal.removeEventListener('abort', haltWithRun);
      }

      const unresolved = settled.find((done) => done.result.status === 'skipped');
      if (unresolved) {
        return {
          verdict: { kind: 'skipped', message: `${describeIteration(unresolved.index, unresolved.value)}: ${unresolved.result.message}` },
          ran: []
        };
      }

      const ran = settled.sort((first, second) => first.index - second.index);
      const cancelled = ran.find((done) => done.result.status === 'cancelled');
      if (cancelled) return { verdict: { kind: 'cancelled', at: cancelled }, ran };
      const failed = ran.find((done) => done.result.status === 'failed');
      if (failed) return { verdict: failedAt(failed), ran };

      if (ran.length < total) return { verdict: interrupted() ? { kind: 'cancelled' } : exceeded(ran.length), ran };
      if (items.length > spec.max) return { verdict: maxReached, ran };
      return { verdict: { kind: 'done', matched: true }, ran };
    };

    const { verdict, ran } = source.kind === 'list' && spec.concurrency > 1
      ? await iterateTogether(source.items)
      : await iterateInOrder();

    if (verdict.kind === 'skipped') {
      return { steps: [skip(step, prefix, 'unresolved-dependency', verdict.message)] };
    }
    // A step that the run stopped before it sent a request has not started (§11.3).
    if (verdict.kind === 'cancelled' && !ran.length) return { steps: [skip(step, prefix, 'run-cancelled')] };

    const at = verdict.at;
    const matched = verdict.kind === 'done' && verdict.matched;
    // The outputs of the step are the outputs of the iteration that `until` matched, and no other.
    const matchedAt = spec.until && matched ? at : undefined;
    const waited = ran.reduce((total, done) => total + (done.result.rateLimitWaitMs || 0), 0);

    const result: StepResult = {
      ...identity(step, prefix),
      status: verdict.kind === 'done' ? 'success' : verdict.kind === 'cancelled' ? 'cancelled' : 'failed',
      reason: verdict.kind === 'done' ? undefined : verdict.kind === 'cancelled' ? 'run-cancelled' : verdict.reason,
      message: verdict.kind === 'failed'
        ? verdict.message
        : verdict.kind === 'cancelled'
          ? `the run stopped after ${ran.length} iterations`
          : undefined,
      attempts: ran.reduce((total, done) => total + done.result.attempts, 0),
      durationMs: state.clock.now() - startedAt,
      rateLimitWaitMs: waited || undefined,
      loop: {
        count: ran.length,
        ...(of === undefined ? {} : { of }),
        matched,
        ...(at ? { index: at.index, value: at.value } : {}),
        ...(ran.some((done) => done.result.attempts > 1) ? { attemptsPerIteration: attemptsByIndex(ran) } : {})
      },
      assertions: at ? at.result.assertions : [],
      validation: at ? at.result.validation : undefined,
      outputs: matchedAt ? matchedAt.result.outputs : {},
      capturePath: ran.map((done) => done.result.capturePath).find(Boolean)
    };

    return {
      steps: [result, ...ran.flatMap((done) => done.internals)],
      response: at ? at.response : undefined,
      preview: at ? at.preview : undefined,
      loop: {
        matched,
        count: ran.length,
        iterations: ran.map((done) => done.result.outputs),
        ...(matchedAt ? { index: matchedAt.index } : {})
      }
    };
  };

  /** What `execute` does with the result of a step, whichever executor made it. */
  const commit = (step: NormalizedStep, produced: Produced): void => {
    const [own, ...internals] = produced.steps;
    record(step, own, produced.preview);
    results.push(...internals);
    publish(step, own, produced.response, produced.loop);
  };

  const execute = async (step: NormalizedStep): Promise<void> => {
    const child = step.kind === 'subflow' ? await loadSubflow(step) : undefined;
    state.emit({
      type: 'step:start',
      id: `${prefix}${step.id}`,
      index: run.iteration,
      operation: step.operation ? `${step.operation.alias}#${step.operation.operationId}` : undefined,
      ...(child ? { steps: child.steps.length } : {})
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

    // A loop runs `pre:` itself, once for each iteration, because `pre:` can read `loop.*` (006 §3).
    if (step.loop) {
      commit(step, await executeLoop(step, step.loop, child));
      return;
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
    const produced: Produced
      = child
        ? { steps: await executeSubflow(step, child, pre), response: undefined, preview: undefined }
        : await state.budget.run(async () => {
            const { result, response, preview } = await executeOperation(step, pre);
            return { steps: [result], response, preview };
          });

    commit(step, produced);
  };

  const pending = new Set(flow.steps.map((step) => step.id));
  const running = new Map<string, Promise<void>>();

  const schedule = async (): Promise<void> => {
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
  };

  // Registered for as long as the schedule runs: `announceCleanup` asks the flows in flight whether
  // any holds a cleanup step, and a flow that has returned can hold none.
  state.activeFlows.push(flow);
  try {
    await schedule();
  } finally {
    state.activeFlows.splice(state.activeFlows.indexOf(flow), 1);
  }

  /**
   * §12.1's exports, resolved here — after the schedule, with nothing left in flight.
   *
   * That position is what makes `shared.<slot>` exportable alongside `steps.<step>.<output>`: every
   * writer has finished, so the last write in declaration order is settled and no reader-topology
   * question (§9.1) applies to a read taken at the flow's own boundary.
   *
   * **An unwritten slot exports the empty string, and a step output that was never produced exports
   * nothing at all.** The asymmetry is each root's own rule (§11.2) carried across the boundary
   * unchanged: `{{shared.x}}` resolving empty is a value the run knows is empty, and `{{steps.x.y}}`
   * resolving to nothing is a step that did not do what it was for — which is why the second omits
   * the key and skips the caller's step, and the first hands over what it has.
   */
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
  const failed = results.filter((result) => result.status === 'failed').map((result) => result.id);

  // A cancelled run's *status* is decided by the interrupt, not by a step: the steps it cut short
  // did nothing wrong, and naming them would read as blaming them. A step that had already failed
  // is a different claim — it failed on its own, before the interrupt reached it — and dropping it
  // here is how a real regression disappears behind an infrastructure outcome, the status being the
  // only thing a reader has left. So the interrupt keeps the verdict and the failures keep their
  // names. `verdictCauses` stays out: §11.2's rule fires on an *unresolved* dependency, which under
  // an interrupt is as likely to be the cancellation's doing as the flow's.
  if (cancelled) return { status: 'cancelled', decidedBy: failed };

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

  const specs = new SpecLoader(options.ports.readSpec, flowContext);
  // Before the entry is read: the entry itself is the first document whose outputs depend on them.
  const connectors = await Connectors.load(
    options.scope,
    async (file) => (await options.ports.readFile(file, flowContext)).toString('utf8'),
    specs
  );

  const state: RunState = {
    runId,
    flowContext,
    options,
    clock: options.ports.clock || REAL_CLOCK,
    specs,
    connectors,
    budget: new Budget(options.overrides?.concurrency || 5),
    // Built before the entry flow is read, because `loadFlow` registers the buckets it declares.
    // `--no-rate-limit` leaves it absent rather than empty, so the dispatch path costs nothing at
    // all for the runs that declare no limits — which is nearly all of them.
    limiter: options.overrides?.rateLimit?.enabled === false ? undefined : createLimiter(options.ports.clock || REAL_CLOCK),
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
    cleanupAnnounced: false,
    activeFlows: [],
    nestIterations: false,
    // The flow's `config:` is not read yet; both are replaced with the root flow's below, before
    // anything is dispatched.
    redactor: createRedactor(),
    previewBytes: 8192,
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
  // scope the capture below is given, so a host, a capture and a preview can never mask different
  // sets.
  flowContext.redactHeaders = flow.config.redactHeaders;
  state.redactor = createRedactor(flow.config.redactHeaders);
  state.previewBytes = flow.config.capturePreviewBytes;

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

  // `RunResult.duration` is measured from here: the run's own clock, so a host that supplies one
  // sees a duration made of the same time its retry delays consumed (§13.2).
  const runStartedAt = state.clock.now();

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
    duration: state.clock.now() - runStartedAt,
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
          // §6.4's host-supplied profiles — the implicit `collection` among them — sit beneath
          // everything a flow declares: the entry flow's own block overrides them here, and a
          // sub-flow's overrides what it inherits, so a flow that names one of these wins.
          profiles: options.authProfiles || {}
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
      duration: state.clock.now() - runStartedAt,
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
