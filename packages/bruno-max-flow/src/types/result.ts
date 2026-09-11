/**
 * What a run reports — 001 §13.2, with the vocabulary of §14.6.
 *
 * The strings below are a public contract: additive only, never renamed. §14.6 remains their
 * definition; these unions are a restatement for the compiler.
 */
import type { FlowDescription } from './describe';
import type { RunOrigin } from './options';
import type { Vars } from './ports';

export type StepStatus = 'success' | 'failed' | 'skipped' | 'cancelled';
export type RunStatus = 'passed' | 'failed' | 'cancelled';

export type StepReason
  = | 'unexpected-status'
    | 'invalid-request'
    | 'schema-validation-failed'
    | 'assertion-failed'
    | 'transport-error'
    | 'retries-exhausted'
    | 'max-duration-exceeded'
    | 'file-read-failed'
    | 'script-error'
    | 'subflow-failed'
    | 'unmet-dependency'
    | 'condition-false'
    | 'unresolved-dependency'
    | 'run-cancelled';

export type SchemaResult = {
  valid: boolean;
  errors: { path: string; message: string; keyword?: string }[];
};

export type AssertionResult = {
  expr: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
};

export type StepResult = {
  /** Sub-flow steps namespaced: "auth/login". */
  id: string;
  /** The step's `name:` — what a human reads where the id is a handle. */
  name?: string;
  /**
   * What the step's `meta:` declared, carried verbatim — a reporter reads `meta.testId`, and the
   * engine interprets no key of it. Absent when the step declared none.
   *
   * Survives `structuredClone` by construction: the values are whatever YAML produced — scalars,
   * plain objects and arrays — and `FlowEvent` requires every result on the stream to clone.
   */
  meta?: Record<string, unknown>;
  /** A `uses:` step is a container; internals sit alongside it in a flat array. */
  kind: 'operation' | 'subflow';
  status: StepStatus;
  reason?: StepReason;
  /**
   * The occurrence, where `reason` names the rule — the same pairing `Diagnostic` makes between a
   * `code` and a message, and for the same reason: `unresolved-dependency` says which rule fired and
   * nothing about *which* reference was missing, which is the only thing anyone reads it to find out.
   *
   * Human text, present whenever the engine knows something the reason does not. Deliberately not a
   * stable format: hosts display it, and nothing parses it.
   */
  message?: string;
  attempts: number;
  durationMs: number;
  /**
   * §6.2's pacing, in ms: what this step spent waiting its turn at the API's bucket, summed over
   * its attempts (004 §7). Absent when the step waited for nothing, which is every step of a flow
   * that declares no `rateLimit:`.
   *
   * Included in `durationMs` rather than taken out of it — that number is the step's wall time and
   * already contains §11.1's retry delays. This says how much of it was the flow being polite.
   */
  rateLimitWaitMs?: number;
  assertions: AssertionResult[];
  /** §10.1's automatic checks — absent when both are off. */
  validation?: {
    request?: SchemaResult;
    response?: SchemaResult;
  };
  outputs: Record<string, unknown>;
  capturePath?: string;
};

export type IterationResult = {
  index: number;
  row?: Vars;
  status: RunStatus;
  steps: StepResult[];
  /**
   * The steps whose outcome decided `status` — §14.6. Empty when it passed.
   *
   * A cancelled iteration names the steps that had **already failed** when the interrupt arrived,
   * without those steps having decided anything: the interrupt owns the status, and this is the
   * only place a failure that happened first survives it.
   */
  decidedBy?: string[];
};

export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
};

/** Carries no exit code: mapping an outcome to 0–4 is §14.2's, and the app has no use for it. */
export type RunResult = {
  runId: string;
  /**
   * §14.5's manifest reports the same object, so a reporter (§14.8) and the live view (002 §10)
   * read who ran this from here rather than from the host that happens to be rendering — the app
   * and the CLI cannot then disagree with what the run's own file says.
   *
   * Present when the host supplied one. Plain strings throughout, so it clones.
   */
  origin?: RunOrigin;
  status: RunStatus;
  iterations: IterationResult[];
  /**
   * Every iteration's `decidedBy`, in iteration order and without repeats — the steps that decided
   * this run's status, or, where it was cancelled, the ones that had already failed under it.
   *
   * Step ids rather than a reason of its own, because each one already carries the `reason` and
   * `message` that say what it did: a second vocabulary here would be a restatement that can
   * disagree, and a run failed by both a 500 and an unresolved skip would have to choose between
   * them. Named at all because `summary` counts statuses, and 001 §11.2's `failOnUnresolved` fails a
   * run through a step that is *skipped* — a red run whose every count reads green.
   */
  decidedBy?: string[];
  summary: RunSummary;
  /**
   * Whole-run milliseconds, `run:start` to `run:end`, on the injected clock — every iteration and
   * the cleanup window included. 002 §8.4's summary line reads it; `StepResult.durationMs` is per
   * step and cannot be summed into this under `concurrency > 1`.
   */
  duration: number;
  /** Validation warnings that did not stop the run. */
  diagnostics: Diagnostic[];
  captureDir?: string;
};

export type Diagnostic = {
  severity: 'error' | 'warning';
  /** Stable, machine-readable — §14.6. */
  code: string;
  message: string;
  file: string;
  stepId?: string;
  /** JSON pointer into the flow document. */
  path?: string;
  line?: number;
  column?: number;
};

/**
 * Observational only. A throwing consumer never fails the run, redaction is applied before
 * emission, and every event survives `structuredClone` — bodies live in the capture (§13.2).
 */
export type FlowEvent
  = | {
    type: 'run:start';
    runId: string;
    /** As on `RunResult`, and for the same reason: one statement of who ran this, read from the run. */
    origin?: RunOrigin;
    flow: string;
    iterationCount: number;
    captureDir?: string;
    /**
     * The graph this run is executing — §14.5's snapshot, reported as well as written.
     *
     * A watcher that drew the *current* file would redraw the run it is watching the moment the
     * file was edited, which 002 §4.3 makes a two-second operation. Reporting it costs one payload
     * per run rather than per step, which is the size argument §13.2 makes about bodies read the
     * other way round.
     *
     * Absent when the run records no snapshot — under `--no-capture` there is nothing to report,
     * and a consumer falls back to describing the file itself.
     */
    description?: FlowDescription;
    /**
     * §12.5's params this run was started with — what a host supplied over the flow's declared
     * defaults, with `secret: true` values already masked (§14.4).
     *
     * Reported as well as written, for the reason `description` is: 002 §5.6's inputs node switches
     * from boxes to a record the moment a run starts, and a node that had to wait for the capture to
     * be read back would show the run it is watching as having been started with nothing. Present
     * under `--no-capture` too — this is the run saying what it is doing, not the artifact.
     */
    params: Record<string, unknown>;
  }
  | { type: 'iteration:start'; index: number; row?: Vars }
  /**
   * §7.3's `vars:` as this iteration resolved them, once — after `iteration:start` and before its
   * first step.
   *
   * Its own event rather than a field on `iteration:start`, because the values do not exist when
   * that one is emitted: `vars:` resolve inside the iteration, against a scope that includes its
   * row. The entry flow's only; a sub-flow's vars are its internals (§12.3).
   */
  | { type: 'iteration:vars'; index: number; vars: Vars }
  /**
   * `steps` is the number of internal steps a `uses:` step is about to run — what §14.7's
   * `sub-flow (2 steps)` prints while the container's own line is still in flight, and a count no
   * consumer can take from `step:end`, which arrives only once every internal has. Absent for an
   * operation step.
   */
  | { type: 'step:start'; id: string; index: number; operation?: string; steps?: number }
  | { type: 'step:attempt'; id: string; index: number; attempt: number; status: string; durationMs: number }
  | {
    type: 'step:end';
    id: string;
    index: number;
    result: StepResult;
    /**
     * §14.5's inline copy of the step's last attempt — the request as sent and the response body,
     * each cut at `config.capturePreviewBytes` and masked exactly as the capture is (§14.4). The
     * console's `--verbose` line (§14.7) reads it; the untruncated payload stays in the capture.
     * Absent where the step sent nothing, and never a binary body (§14.5).
     */
    preview?: { request?: string; response?: string };
  }
  | { type: 'iteration:end'; index: number; status: RunStatus }
  /**
   * §11.3's cleanup window has opened: the run is stopped, and only steps whose `depends` accepts
   * `cancelled` run from here until `deadline` (epoch ms on the run's clock). Emitted once, before
   * any such step starts, so 002 §7.1's control can show the state rather than appear hung.
   */
  | { type: 'run:cleanup'; runId: string; deadline: number }
  | { type: 'run:end'; result: RunResult };
