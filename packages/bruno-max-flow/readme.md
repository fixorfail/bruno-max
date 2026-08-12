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

Types only. `src/types/` is 001 §13.2's engine boundary and 002 §11's read-only entries as real
TypeScript; no entry point is implemented yet.

The surface, when it exists, is five functions:

| Function | Spec |
|---|---|
| `runFlow` | 001 §13.2 |
| `validateFlow` | 001 §13.2, §14.3 |
| `describeFlow` | 002 §11.1 |
| `listRuns` | 002 §11.2 |
| `readCapture` | 002 §11.2 |

## The engine sends no HTTP

Dispatch, file access, spec loading and script evaluation are injected ports (001 §13.2), because
the two hosts do each of them differently and duplicating that logic would reintroduce the drift
this package exists to remove. The engine owns *when* and *what*; a host owns *how*.

That is also what makes the conformance suite unit tests rather than integration tests — see
`tests/conformance/fixtures/readme.md`.

## Commands

```bash
npm test --workspace=packages/bruno-max-flow
npm run typecheck --workspace=packages/bruno-max-flow
npm run build --workspace=packages/bruno-max-flow
```
