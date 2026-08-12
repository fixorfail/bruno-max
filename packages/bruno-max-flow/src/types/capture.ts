/**
 * What `readCapture` returns — 002 §11.2, over the layout 001 §14.5 declares.
 *
 * A StepCapture is one *attempt*, not one step: §14.5 captures each retry separately, and 002 §9's
 * Attempts tab is a row per call. It is self-describing, which is what makes an interrupted run
 * readable — with no summary.json there is no step-level record anywhere else.
 *
 * The step's final status, reason and outputs are NOT here; they live in summary.json, which
 * carries the run's outcome (§14.5). A poll that settles on attempt 3 has one outcome and three
 * captures, and copying the outcome into each would let the copies disagree.
 *
 * These payloads are untruncated. The preview/truncated/originalSize fields in §14.5's JSON
 * example belong to the *reporter's* inline copy — that is what "storage is split" means.
 * Redaction (§14.4) has already been applied, so nothing reading these filters anything.
 */
import type { AssertionResult, StepResult } from './result';

/** A file part is captured by reference (§7.5): its content is already in the repository. */
export type CapturedPart
  = | { name: string; kind: 'field'; value: string; contentType?: string }
    | {
      name: string;
      kind: 'file';
      sourcePath: string;
      filename: string;
      contentType: string;
      byteLength: number;
    };

/**
 * `text` holds a textual body — JSON included — as sent, rather than as a re-serialized value.
 * `binary` names a sibling artifact: §14.5 writes binary payloads out with an appropriate
 * extension and never previews them.
 */
export type CapturedBody
  = | { kind: 'text'; contentType?: string; text: string }
    | { kind: 'binary'; contentType?: string; byteLength: number; file: string }
    | { kind: 'multipart'; parts: CapturedPart[] };

export type CapturedRequest = {
  method: string;
  /** As sent — resolved, query string included. */
  url: string;
  headers: Record<string, string>;
  body?: CapturedBody;
};

export type CapturedResponse = {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  body?: CapturedBody;
  responseTimeMs: number;
};

export type StepCapture = {
  /** Namespaced for sub-flow internals (§14.5). */
  stepId: string;
  iteration: number;
  /** 1-based, matching §11.1's numbering. */
  attempt: number;
  startedAt: string;
  durationMs: number;
  /** Absent when nothing was sent — a step failing validateRequest never dispatches (§10.1). */
  request?: CapturedRequest;
  /** Absent on a transport error (§11.2) or an attempt aborted by maxDuration/cancel (§11.3). */
  response?: CapturedResponse;
  assertions: AssertionResult[];
  validation?: StepResult['validation'];
};

/** Written when the run starts, so a run in progress can be attributed to its flow (§14.5). */
export type RunManifest = {
  runId: string;
  flow: string;
  startedAt: string;
};
