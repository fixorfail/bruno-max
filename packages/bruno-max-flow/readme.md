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

`runFlow` and `validateFlow` are implemented and the conformance suite is green — F1–F4 and the
engine-level rows of 001-C §7. What that covers is the §7 materialization pipeline, the §10.2
dialect, §9's graph, datasets and slots, §11's retry and propagation, and §12's sub-flows.

Not implemented: capture (§14.5) and the three read-only entries built on it, cookie-jar scoping
(§7.6), redaction (§14.4) and the §5.4 document schema.
`tests/conformance/fixtures/readme.md` lists the conformance rows that go with them.

The surface is five functions:

| Function | Spec | |
|---|---|---|
| `runFlow` | 001 §13.2 | implemented |
| `validateFlow` | 001 §13.2, §14.3 | implemented |
| `describeFlow` | 002 §11.1 | — |
| `listRuns` | 002 §11.2 | — |
| `readCapture` | 002 §11.2 | — |

The modules under `src/` map onto the spec rather than onto layers: `document.ts` is §5,
`openapi.ts` §6, `materialize.ts` §7, `expression.ts` §10.2, `step.ts` §10 and §11.1, `run.ts` §9,
§11.2 and §12, `dataset.ts` §9.4, `validate.ts` §14.3.

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
