/**
 * @bruno-max/flow — the API Flows engine.
 *
 * Specified by docs/specs/001-api-flows.md (semantics, CLI) and 002-api-flows-ui.md (the app's
 * read-only entries), which 001 §13.2 enumerates — two entries that execute, and the read-only ones
 * beside them, some taking ports and some only a flow's text.
 *
 * This package must not import bruno-app or bruno-electron (§13.1).
 */

export * from './types/ports';
export * from './types/request';
export * from './types/result';
export * from './types/options';
export * from './types/describe';
export * from './types/capture';
// 001 §14's report files: the contract a CLI reporter implements, kept beside `RunResult` so it
// cannot drift from what a run reports.
export * from './types/reporter';

export { runFlow } from './run';
// §14.4's masking, for a host reporting a request on a surface of its own (002 §8.5). Exported so
// the policy has one implementation rather than one per host.
export { createRedactor, MASK } from './redact';
export type { Redactor } from './redact';
export { validateFlow, resolveFunctions } from './validate';
// 002 §4.1's sidebar name, read from a flow's text without describing it — so a host listing flows
// never parses `.flow.yml` itself and never has to know §5.4's local tags.
export { readFlowMeta } from './document';
// 002 §4.4's properties dialog. The format's only writer, for §5.1's reason: a host editing `meta:`
// with a YAML library of its own would be the second serializer flows being YAML-only bought away.
export { readFlowProperties, writeFlowProperties } from './meta';
// §5.2's identity, exported because a roster, a report and a rerun are matched to each other by it:
// three hosts deriving it separately would be three chances for those three to disagree.
export { flowIdentity } from './meta';
// §14.7's listing row: that identity plus §12.5's library flag and the step count. Exported for
// §5.1's reason — `bru flow list` must not be the second thing that parses `.flow.yml`.
export { readFlowSummary } from './meta';
export type { FlowProperties } from './meta';
// Selecting flows by pattern — `bru flow run --grep` and the app's sidebar search box. The terms a
// flow is matchable on are extracted here so the two hosts cannot disagree about what a flow
// contains; only the pattern is theirs to compile.
export { flowSearchTerms, flowMatches } from './search';
export { describeFlow } from './describe';
export { listRuns, readRun, readCapture } from './history';
// §14.5's `suite.json` — the invocation-level index the run directories cannot supply on their own,
// since a flow that never ran leaves no directory to be found. Read here and written by the host
// that owns the suite directory, which is why the two halves are exported separately.
export { listSuites, readSuite } from './history';
// §14.5's capture root and the ignore entry that comes with it. Exported because §14.8's report
// files default into the same directory — under `--no-capture` too, where no capture ever creates
// it — and a host computing either on its own would be the copy that drifts from §14.5.
export { CAPTURE_DIRNAME, resolveCaptureRoot, ensureCaptureIgnored } from './capture';
// §14.8.5's per-invocation report directory, which sits in the capture root beside the runs without
// being one. Exported for §14.5's reason above, plus one of its own: the `suite-` prefix is what
// keeps it out of `RUN_DIRECTORY`, so a CLI spelling the name itself could make a report directory
// that `listRuns` lists as a run and `prune` deletes.
export { SUITE_DIRECTORY, resolveSuiteDirectory } from './capture';
// The roster's format, for the hosts that own a suite: the CLI's spans one command's flows and the
// app's spans one rerun's, and neither may spell a `suite.json` of its own — `listSuites` reads one
// format, not two.
export { SUITE_MANIFEST_FILE, writeSuiteManifest } from './capture';
