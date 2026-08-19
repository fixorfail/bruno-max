/**
 * What a run reports — 001 §13.2, with the vocabulary of §14.6.
 *
 * The strings below are a public contract: additive only, never renamed. §14.6 remains their
 * definition; these unions are a restatement for the compiler.
 */
import type { FlowDescription } from './describe';
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
  /** The steps whose outcome decided `status` — §14.6. Empty when it passed or was cancelled. */
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
  status: RunStatus;
  iterations: IterationResult[];
  /**
   * Every iteration's `decidedBy`, in iteration order and without repeats — the steps that decided
   * this run's status.
   *
   * Step ids rather than a reason of its own, because each one already carries the `reason` and
   * `message` that say what it did: a second vocabulary here would be a restatement that can
   * disagree, and a run failed by both a 500 and an unresolved skip would have to choose between
   * them. Named at all because `summary` counts statuses, and 001 §11.2's `failOnUnresolved` fails a
   * run through a step that is *skipped* — a red run whose every count reads green.
   */
  decidedBy?: string[];
  summary: RunSummary;
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
  }
  | { type: 'iteration:start'; index: number; row?: Vars }
  | { type: 'step:start'; id: string; index: number; operation?: string }
  | { type: 'step:attempt'; id: string; index: number; attempt: number; status: string; durationMs: number }
  | { type: 'step:end'; id: string; index: number; result: StepResult }
  | { type: 'iteration:end'; index: number; status: RunStatus }
  | { type: 'run:end'; result: RunResult };
