# Conformance fixtures

The corpus 001-C's scenarios run against. **These files are the artifact**, not test scaffolding:
each `.flow.yml` is a real file rather than a string inside a test, so a format change that breaks
one shows up as a parse failure at a path instead of a diff inside a template literal (001-C §2).

```
specs/       minimal OpenAPI documents — one per service the flows bind
flows/       the .flow.yml fixtures, verbatim from 001-C where it gives them
datasets/    CSV, JSON and YAML rows for F1 and R4d2
```

## Flows

| File | Scenario | Source |
|---|---|---|
| `f1-role-matrix.flow.yml` | F1 — dataset iteration, negative tests, `row.*` in assertions | 001-C §3, verbatim |
| `f2-order-fulfillment.flow.yml` | F2 — `any` joins, shared slots, cleanup ordering | 001-C §4, verbatim |
| `f3-batch-settlement.flow.yml` | F3 — typed interpolation, structured outputs, lexical profiles | 001-C §5, verbatim |
| `f4-partner-acceptance.flow.yml` | F4 — per-step base URLs, script filtering, polling | 001-C §6, verbatim |
| `f2-login.flow.yml` | the sub-flow F2, F3 and F4 invoke | referenced by 001-C, written here |
| `f4-tenant-parent.flow.yml` | F4.4 — a base URL a step produces | 001-C §6, plus the `version:`/`meta:` preamble §5.2 requires |
| `f4-workspace-session.flow.yml` | F4.4's sub-flow half | 001 §6.3, written here |

Three of these are not in 001-C verbatim. `f2-login.flow.yml` is fixed by what its callers consume
(`steps.<id>.token`, `steps.<id>.userId`) and by F2.4, which stubs its internal step and requires
the failure to name `auth/login`. The two tenant flows come from 001 §6.3's worked example.

## Specs

Minimal by design (001-C §8): real-world OpenAPI robustness — `$ref` cycles, vendor extensions,
missing `operationId`, multi-document specs — is separate ground from execution semantics and is
tracked in 001 §19.

Two details are load-bearing rather than decorative:

- **`platform-v1.yml` has a `servers[0].url`.** F4.4 asserts `createWorkspace` goes there while the
  `workspace-api` binding over the same document resolves to a host the run produced (001 §6.3).
- **`audit-v1.yml`'s `reconciled` and `tags` carry no `example`.** F3.1 extends the fixture to prove
  a boolean and an array survive whole-value interpolation, and 001 §7.1 seeds an optional property
  only when it has an `example` or `default` — so giving them one would put them in every request.

## What is not here

The harness (`harness.js`) and the spec files. 001-C §2 specifies them: a stub `ExecuteRequest`
keyed by operation id, a stubbed `ReadFile`, an injected `Clock` so a 30-attempt poll costs no
wall-clock time, and a **real** bruno-js runtime for `RunScript` — F3's derived output and F4's
`find` predicate turn on what a script actually returns, so stubbing it would assert the engine
calls the port and nothing about the behavior those scenarios exist to pin.
