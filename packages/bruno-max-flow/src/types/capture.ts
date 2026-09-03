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
import type { FlowDescription } from './describe';
import type { RunOrigin } from './options';
// A suite's roster names flows and their outcomes in §14.8's vocabulary, deliberately: a manifest
// with a second spelling of either would let the index and the reports disagree about what a flow
// is called and about what happened to it.
import type { FlowIdentity, FlowOutcome } from './reporter';
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
 * extension and never previews them. `upload` is a whole-body file source (§7.5's `bodyFile:` and
 * binary bodies), which §14.5 captures by reference for the same reason a multipart file part is.
 */
export type CapturedBody
  = | { kind: 'text'; contentType?: string; text: string }
    | { kind: 'binary'; contentType?: string; byteLength: number; file: string }
    | { kind: 'upload'; sourcePath: string; filename: string; contentType: string; byteLength: number }
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
  /**
   * Digest of the flow's own text as it was when the run started.
   *
   * It rides in the manifest rather than in the snapshot beside it because `listRuns` reads only
   * this file per run: telling a reader that a run predates the flow's current text has to cost one
   * small read per directory, not a parse of every snapshot in the history.
   *
   * Absent on a run written before the snapshot existed, which is *unknown* rather than unchanged —
   * a reader must not report an old run as matching.
   */
  flowHash?: string;
  /**
   * Who started the run and against which environments — here for `flowHash`'s reason: `listRuns`
   * reads only this file per run, so a history that says where each one came from costs one small
   * read per directory rather than a second artifact.
   *
   * Absent on a run written before it was recorded, and on a host that supplied none.
   */
  origin?: RunOrigin;
};

/**
 * One flow's line in an invocation's roster — §14.5's `suite.json`, beside `RunManifest` and there
 * for the same reason: an index that costs one small read per suite rather than a parse of every
 * run inside it.
 */
export type SuiteFlowRecord = FlowIdentity & {
  outcome: FlowOutcome;
  /**
   * Basename of this flow's run directory inside the suite, absent when the flow never opened one.
   *
   * That absence is the whole point of the manifest: a flow that failed validation (§14.3) never
   * reaches `runFlow`, so a reader scanning run directories cannot see it at all — and it is
   * exactly the flow a rerun most wants back.
   */
  runDir?: string;
  /** Which attempt produced this outcome. Absent for 1, so a suite that never retried says nothing. */
  attempt?: number;
  /**
   * An earlier attempt failed and a later one passed (§14.8). Only ever set beside
   * `outcome: 'passed'`, because the final attempt is the flow's outcome and a flaky flow passed.
   */
  flaky?: boolean;
};

/**
 * `suite.json` — which flows one invocation selected, and what became of each.
 *
 * Deliberately slim. This is a discovery index, not a result: the whole result, with every
 * `RunResult` in it, is what `--reporter-json` writes (§14.8.3), and a second copy here would be a
 * second thing to keep in step. What it adds that nothing else on disk has is the **roster** — the
 * report files are optional and a flow that never ran leaves no directory, so without this a reader
 * asking "what did that invocation run" has to infer the answer from what happens to be there.
 *
 * Written by the host that owns the suite directory, through `writeSuiteManifest` — the engine sees
 * one flow at a time and never the invocation around it (§13.2).
 */
export type SuiteManifest = {
  suiteId: string;
  startedAt: string;
  finishedAt: string;
  /** §14.2's code the invocation exited with. */
  exitCode: number;
  origin?: RunOrigin;
  /** Basename of the suite this one re-ran, when `--retry-failed` produced it. */
  retryOf?: string;
  /** In run order (path order, §14.1). */
  flows: SuiteFlowRecord[];
};

/**
 * The flow as it was when the run started — 001 §14.5, added because a run directory that names its
 * flow by path alone describes a file that has since moved on.
 *
 * `description` is what a viewer draws: 002 §10 paints a run's step outcomes onto a graph, and
 * painting them onto *today's* graph silently drops a renamed step's result, invents a
 * never-started node for one added since, and draws edges the run never had. `source` is for the
 * human question the description cannot answer — what did this file actually say — and for the diff
 * against what it says now.
 */
export type FlowSnapshot = {
  description: FlowDescription;
  source: string;
  /**
   * §12.5's params as the run was started with them — what a host supplied, filled in from the
   * flow's declared defaults. 002 §5.6 draws these when a stored run is opened, where the inputs
   * node shows values rather than boxes.
   *
   * **A param declared `secret: true` is masked here, not on the way out.** §14.5 requires that a
   * secret never be written into a file buffer at all, so the masking happens before this reaches
   * `writeJson` — a reader of `inputs.json` sees `••••` because that is what is on disk.
   */
  params: Record<string, unknown>;
};
