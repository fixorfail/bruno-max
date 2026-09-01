/**
 * @bruno-max/flow — the API Flows engine.
 *
 * Specified by docs/specs/001-api-flows.md (semantics, CLI) and 002-api-flows-ui.md (the app's
 * read-only entries). The package's surface is five functions; only the types exist so far.
 *
 * This package must not import bruno-app or bruno-electron (§13.1).
 */

export * from './types/ports';
export * from './types/request';
export * from './types/result';
export * from './types/options';
export * from './types/describe';
export * from './types/capture';

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
export type { FlowProperties } from './meta';
export { describeFlow } from './describe';
export { listRuns, readRun, readCapture } from './history';
