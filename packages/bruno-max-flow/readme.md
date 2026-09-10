# @bruno-max/flow

The API Flows engine: sequenced, spec-driven request execution shared by `bruno-cli` and
`bruno-electron`.

- **Authoring guide:** [`docs/writing-flows.md`](../../docs/writing-flows.md) — how to write a
  `.flow.yml`, for the people who write them. Its examples are executed by
  `tests/conformance/guide.spec.js`, so a change here that breaks them fails the suite.
- **Spec:** [`docs/specs/001-api-flows.md`](../../docs/specs/001-api-flows.md) — semantics, format, CLI
- **App surface:** [`docs/specs/002-api-flows-ui.md`](../../docs/specs/002-api-flows-ui.md) — `describeFlow`, `listRuns`, `readRun`, `readCapture`
- **Conformance:** [`docs/specs/001-api-flows-conformance.md`](../../docs/specs/001-api-flows-conformance.md)

This is a **fork-owned package** (`@bruno-max/*` in `packages/bruno-max-*`), so it never collides
with an upstream package by name or path. It must not import `bruno-app` or `bruno-electron`
(001 §13.1).

## Status

**All six entry points are implemented** and the conformance suite is green — F1–F4 and the
engine-level rows of 001-C §7. What that covers is §5.4's document schema, the §7 materialization
pipeline, the §10.2 dialect, §9's graph, datasets and slots, §11's retry and propagation, §12's
sub-flows, §14.5's capture directory in both directions, and 002 §11.1's resolved graph.

The one thing §14.4 asks for that a `bru` run does not get is **provenance redaction**. §14.4
specifies two mechanisms and the engine has both: the header-name denylist, and
`createSecretTracker` in `redact.ts`, which masks the values a run was told are secret wherever
they later surface — so a secret promoted into a shared slot (§9.1) or extracted into an output
stays masked for free. `bruno-electron` feeds the tracker from the environment entries it decrypts
before the renderer ever sees them (002 §7.2, 002-C U5.2).

**`bruno-cli` passes no `secrets`, and that is a decision rather than a shortfall.** It holds no
value it *knows* to be secret: a `secret: true` variable's value lives in the app's encrypted store
and `parseEnvironment` zeroes it, and an `--env-var` was typed on a command line the shell already
recorded — masking every one of those would blank ordinary values out of every report. Two sources
still reach the tracker under `bru`, because the *engine* derives them rather than the host
declaring them: a param the flow marked `secret: true`, and the credentials an auth profile
resolves to. `redaction.integration.spec.js` under `bruno-cli` pins all three, the negative
included. 001-C's R4n holds the rows for both hosts.

`tests/conformance/fixtures/readme.md` maps the corpus onto the conformance rows it serves.

The surface is six functions:

| Function | Spec | |
|---|---|---|
| `runFlow` | 001 §13.2 | implemented |
| `validateFlow` | 001 §13.2, §14.3 | implemented |
| `describeFlow` | 002 §11.1 | implemented |
| `listRuns` | 002 §11.2 | implemented |
| `readRun` | 002 §11.2 | implemented |
| `readCapture` | 002 §11.2 | implemented |

**`.flow.yml` is parsed with `yaml` v2, not `js-yaml`,** because §5.4's positions and `js-yaml`'s
flat event listener do not fit: one `parseDocument` yields the model *and* every node's source
range, so `Diagnostic.line` and `FlowNode.position` come from the same read as the model. Two
options are load-bearing and neither is the library default — `merge: true` (a `<<:` anchor would
otherwise leave a literal `<<` field, silently changing a committed flow) and the `!file` / `!...`
custom tags. R4p pins both.

The modules under `src/` map onto the spec rather than onto layers: `document.ts` is §5, `schema/`
§5.4, `openapi.ts` §6, `materialize.ts` §7, `expression.ts` §10.2, `step.ts` §10 and §11.1,
`run.ts` §9, §11.2 and §12, `dataset.ts` §9.4, `validate.ts` §14.3, `redact.ts` §14.4,
`capture.ts` §14.5, `history.ts` 002 §11.2 — the reader of what `capture.ts` writes, sharing its
path computation so the layout has one implementation rather than two — and `describe.ts` 002
§11.1.

`references.ts` is shared by `validate.ts` and `describe.ts` for the same reason: §8.3 makes raw
`.body` access legal but *undeclared*, so the validator's warning and the graph's dashed edge come
from one answer about what a step reads. Either alone is a claim the other would contradict.

**`listRuns` distinguishes `running` from `interrupted` per process.** Both are a `run.json` with no
`summary.json`, and only the process executing one can tell them apart (002 §10), so `runFlow`
registers its `runId` for the duration. A run the CLI is executing in another process therefore
reads as `interrupted` from the app — the honest answer from where the app is standing.

## Hosts

`bruno-cli` is the first one: `bru flow run <paths...>` and `bru flow validate <paths...>`, with
§14.2's exit codes and §14.7's console output. Its half of the boundary — dispatch, `fs`, spec
loading and the script runtime — is fork-owned under `packages/bruno-cli/src/fork/flow/`, reached
through a single auto-registered `commands/flow.js`, so the CLI costs no upstream edit beyond the
dependency line §13.4's manifest already lists.

`bruno-electron` is the second, under `src/ipc/flow/` with its watcher in `src/app/flowsWatcher.js`,
serving 002 §11.3's channels. Its `ExecuteRequest` is the app's own `configureRequest`, so a flow
step inherits the proxy settings, client certificates, cookie jar and OAuth2 token cache a request
already gets (002 §7.3) — which is the payoff the port design was for, and the reason
`MaterializedRequest.auth` had to become Bruno's real `Auth` shape rather than the flat form a flow
authors (001 §6.4, 001-C R4j).

Two things about this host are worth knowing, both recorded where they belong rather than only here.
A collection in **safe mode** runs a flow's `script:` forms rather than refusing them or escalating
to `node:vm`, which took a second QuickJS entry point: the sandbox's own closure resolves to the
fixed string `'done'` and discards whatever a script evaluated to, which is the one thing a flow
script exists to produce. `runScriptInQuickJsForValue`
(`bruno-js/src/fork/quickjs-value-runner.js`) dumps the value out of the VM instead, and both hosts
use it. A flow with no collection has no `securityConfig` to read and takes `safe` as the reading of
that absence. And **cookie-jar scoping (§7.6) is honoured**: the engine mints a jar id per run and
per dataset iteration and never looks inside it, so each host only has to give an id a jar — here
cloned from the app's process-wide jar at first use, so a flow starts from the session the app
already has; under `bru`, empty, there being no such session to inherit.

`bruno-app` is the third, under `src/fork/flows/` behind the one delegation surface `src/fork/registry.js`
(001 §13.3): the sidebar section, the flow tab, a hand-rolled SVG graph, run controls and the step
detail pane. It computes no flow semantics — nodes, edges and ranks come from `describeFlow`, node
states from `FlowEvent`s, bodies from `readCapture` — which is what 002-C's R4 exists to assert.

`readRun` and `run:start`'s `captureDir` were both added while building it: 002 §10 needs a stored
run's per-step outcomes, which `listRuns` (counts) and `readCapture` (one attempt) do not carry, and
§9 needs the capture directory *during* a run rather than only in `RunResult`.

## The engine sends no HTTP

Dispatch, file access, spec loading and script evaluation are injected ports (001 §13.2), because
the two hosts do each of them differently and duplicating that logic would reintroduce the drift
this package exists to remove. The engine owns *when* and *what*; a host owns *how*.

That is also what makes the conformance suite unit tests rather than integration tests: it supplies
those ports itself. `tests/conformance/harness.js` is where they are stubbed, and
`tests/conformance/fixtures/readme.md` describes the corpus they run against.

## Commands

**`bru flow` runs the built bundle, not `src/`.** `bruno-cli` resolves this package through its
`main`, so an engine change is invisible to the CLI until `npm run build` — the tests will be green
and the command will still be running the previous engine. Rebuild, or keep `npm run watch` going,
before trusting anything you see at the CLI.

```bash
npm test --workspace=packages/bruno-max-flow
npm test --workspace=packages/bruno-max-flow -- f1-role-matrix   # one scenario
npm run typecheck --workspace=packages/bruno-max-flow
npm run build --workspace=packages/bruno-max-flow
```
