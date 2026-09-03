/**
 * What a CLI reporter implements — the host side of 001 §14's report files.
 *
 * These types live in the engine rather than beside the reporters that implement them so a
 * reporter cannot drift from `RunResult`: a suite is a list of runs, and the moment the shapes are
 * restated somewhere else the restatement becomes the thing that goes stale. Nothing here runs —
 * the engine neither builds a `SuiteResult` nor calls a hook; a host assembles the suite from the
 * runs it drove.
 *
 * A reporter sees `FlowEvent` and `RunResult` and nothing else, which is what makes a report file
 * redacted by construction: §14.4's masking happens before either is emitted, so there is no path
 * from a reporter to a capture or a `MaterializedRequest`.
 */
import type { Diagnostic, FlowEvent, RunResult, RunSummary } from './result';

/** Why a flow in the selection ended the way it did. `invalid` = it never ran (validation error, or
 *  `runFlow` refused it — a missing required param); the diagnostics say which. */
export type FlowOutcome = 'passed' | 'failed' | 'cancelled' | 'invalid';

export type FlowIdentity = {
  /** Absolute path of the .flow.yml. */
  file: string;
  /** Path relative to the scope root with `.flow.yml` removed, posix separators — §5.2's identity. */
  id: string;
  /** meta.name, or the file's stem. */
  name: string;
  /** From `meta.testId` — what the flow-level JUnit shape emits as `test_id` (§14.8.1b). */
  testId?: string;
  /** meta.tags, in file order. */
  tags: string[];
};

export type FlowRunRecord = FlowIdentity & {
  startedAt: string; // ISO 8601
  finishedAt: string;
  durationMs: number;
  outcome: FlowOutcome;
  /** Absent when the flow never ran. */
  result?: RunResult;
  /** Pre-run validation diagnostics, plus a `run-refused` error when `runFlow` rejected. */
  diagnostics: Diagnostic[];
  /**
   * Which attempt this record is of — 1 unless `--retries` re-ran the flow. Absent for 1, so a
   * report of an invocation that never retried carries no attempt numbers at all.
   *
   * A reporter sees a record per *attempt*, and `onSuiteEnd` sees one final record per flow: hiding
   * the attempt that failed would hide the flakiness the retry is evidence of.
   */
  attempt?: number;
  /**
   * An earlier attempt failed and a later one passed. Only ever set beside `outcome: 'passed'` —
   * §14.8's rule is that the final attempt is the flow's outcome, so a flaky flow is a pass, and CI
   * must not go red for it. Marked all the same, because a pass nobody can see was retried is a
   * flake that goes on being rediscovered.
   */
  flaky?: boolean;
};

export type SuiteSummary = {
  /**
   * `flaky` is counted **beside** `passed`, not instead of it: a flaky flow passed, and the four
   * outcome counts still have to add up to `total` for a report to be readable as one.
   */
  flows: { total: number; passed: number; failed: number; cancelled: number; invalid: number; flaky: number };
  /** Every flow's `result.summary`, summed. */
  steps: RunSummary;
};

export type SuiteResult = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** In run order (path order, §14.1). */
  flows: FlowRunRecord[];
  summary: SuiteSummary;
  /**
   * Basename of the suite this invocation re-ran, when `--retry-failed` produced it. A retry opens
   * its own suite directory and its own report — it is a new invocation, never an edit of the old
   * one — so this is the only thing tying the two together.
   */
  retryOf?: string;
  /** §14.2's code the process will exit with. */
  exitCode: number;
};

/**
 * What a reporter may implement. Every hook is optional; a hook that throws is reported on stderr
 * and never fails the run or changes the exit code.
 */
export type FlowReporter = {
  onSuiteStart?(suite: { startedAt: string; flows: FlowIdentity[] }): void | Promise<void>;
  onFlowStart?(flow: FlowIdentity): void | Promise<void>;
  /** The engine's §13.2 stream, already redacted, tagged with the flow it belongs to. */
  onEvent?(event: FlowEvent, flow: FlowIdentity): void | Promise<void>;
  onFlowEnd?(record: FlowRunRecord): void | Promise<void>;
  onSuiteEnd?(suite: SuiteResult): void | Promise<void>;
};

export type ReporterContext = {
  /**
   * Where the reporter writes, absolute and always known (§14.8.5): `--reporter <module>=<path>`
   * when the command named one, and otherwise the built-in's default beneath the capture root. A
   * custom reporter has no default, so it is given a path or it is a usage error.
   */
  outputPath: string;
  /** process.cwd() when the command ran. */
  cwd: string;
  /** Free-form `--reporter-option key=value` pairs, for custom reporters. */
  options: Record<string, string>;
};

/** A reporter module's default export (or `module.exports`). */
export type ReporterFactory = (context: ReporterContext) => FlowReporter;
