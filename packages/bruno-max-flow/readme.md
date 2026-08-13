# @bruno-max/flow

The API Flows engine: sequenced, spec-driven request execution shared by `bruno-cli` and
`bruno-electron`.

- **Spec:** [`docs/specs/001-api-flows.md`](../../docs/specs/001-api-flows.md) — semantics, format, CLI
- **App surface:** [`docs/specs/002-api-flows-ui.md`](../../docs/specs/002-api-flows-ui.md) — `describeFlow`, `listRuns`, `readCapture`
- **Conformance:** [`docs/specs/001-api-flows-conformance.md`](../../docs/specs/001-api-flows-conformance.md)

This is a **fork-owned package** (`@bruno-max/*` in `packages/bruno-max-*`), so it never collides
with an upstream package by name or path. It must not import `bruno-app` or `bruno-electron`
(001 §13.1).

## Status

`runFlow`, `validateFlow`, `listRuns` and `readCapture` are implemented and the conformance suite is
green — F1–F4 and the engine-level rows of 001-C §7. What that covers is the §7 materialization
pipeline, the §10.2 dialect, §9's graph, datasets and slots, §11's retry and propagation, §12's
sub-flows, and §14.5's capture directory in both directions.

Not implemented: `describeFlow`, cookie-jar scoping (§7.6), the §5.4 document schema, and **the
primary half of §14.4's redaction**. §14.4 specifies two
mechanisms; the header-name denylist is in `redact.ts`, and provenance tracking is not, because
§13.2's `VariableTiers` carries no field saying which environment entries are `secret: true` and
neither host loads environments for flows yet — there is nothing yet to track. It lands with the
host work that supplies it; 001-C's R4n holds the rows either way.
`config.capturePreviewBytes` is likewise unread: previews are the reporter's inline copy, and no
flow reporter writes one yet.
`tests/conformance/fixtures/readme.md` lists the conformance rows that go with all of these.

The surface is five functions:

| Function | Spec | |
|---|---|---|
| `runFlow` | 001 §13.2 | implemented |
| `validateFlow` | 001 §13.2, §14.3 | implemented |
| `describeFlow` | 002 §11.1 | — |
| `listRuns` | 002 §11.2 | implemented |
| `readCapture` | 002 §11.2 | implemented |

**`.flow.yml` is parsed with `yaml` v2, not `js-yaml`,** because §5.4's positions and `js-yaml`'s
flat event listener do not fit: one `parseDocument` yields the model *and* every node's source
range, so `Diagnostic.line` and `FlowNode.position` come from the same read as the model. Two
options are load-bearing and neither is the library default — `merge: true` (a `<<:` anchor would
otherwise leave a literal `<<` field, silently changing a committed flow) and the `!file` / `!...`
custom tags. R4p pins both.

The modules under `src/` map onto the spec rather than onto layers: `document.ts` is §5,
`openapi.ts` §6, `materialize.ts` §7, `expression.ts` §10.2, `step.ts` §10 and §11.1, `run.ts` §9,
§11.2 and §12, `dataset.ts` §9.4, `validate.ts` §14.3, `redact.ts` §14.4, `capture.ts` §14.5, and
`history.ts` 002 §11.2 — the reader of what `capture.ts` writes, sharing its path computation so the
layout has one implementation rather than two.

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

The Electron host and the app surface ([002](../../docs/specs/002-api-flows-ui.md)) are not built.

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
