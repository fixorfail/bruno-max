/**
 * What a run reports — 001 §13.2, with the vocabulary of §14.6.
 *
 * The strings below are a public contract: additive only, never renamed. §14.6 remains their
 * definition; these unions are a restatement for the compiler.
 */
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
  = | { type: 'run:start'; runId: string; flow: string; iterationCount: number; captureDir?: string }
    | { type: 'iteration:start'; index: number; row?: Vars }
    | { type: 'step:start'; id: string; index: number; operation?: string }
    | { type: 'step:attempt'; id: string; index: number; attempt: number; status: string; durationMs: number }
    | { type: 'step:end'; id: string; index: number; result: StepResult }
    | { type: 'iteration:end'; index: number; status: RunStatus }
    | { type: 'run:end'; result: RunResult };
