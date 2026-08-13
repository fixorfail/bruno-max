# Conformance fixtures

The corpus 001-C's scenarios run against. **These files are the artifact**, not test scaffolding:
each `.flow.yml` is a real file rather than a string inside a test, so a format change that breaks
one shows up as a parse failure at a path instead of a diff inside a template literal (001-C §2).

```
specs/              minimal OpenAPI documents — one per service the flows bind
flows/              the .flow.yml fixtures, verbatim from 001-C where it gives them
flows/regressions/  the minimal flows §7's regressions are asserted against
datasets/           CSV, JSON and YAML rows for F1, R4c, R4c2 and R4d2
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

### Regressions

`flows/regressions/` holds one minimal flow per row of 001-C §7, named for the row it serves.
These are not scenarios: each exists because the defect it guards is invisible in a flow that
works, so they are as small as the rule allows and bind the generic `regressions-v1.yml`.

| File | Row |
|---|---|
| `r1-dead-service.flow.yml` | R1 — a 500 with the downstream guard disabled, so the status check is tested alone |
| `r2-retry-default.flow.yml` · `r2-retry-optin.flow.yml` | R2 — the safe default, and that opting in still works |
| `r3-negative-no-optout.flow.yml` · `r3-optout-no-assertion.flow.yml` | R3 — each half of §10.3's two-part rule, asserted alone |
| `r4-slot-nondescendant.flow.yml` | R4 — a slot read off the writer's branch |
| `r4-slot-unwritten.flow.yml` | R4 and R5 — an unwritten slot resolves empty and reaches the wire as `""` |
| `r4-output-unproduced.flow.yml` | R4 and R4b — an unproduced output skips its consumer |
| `r4-subflow-slot.flow.yml` · `r4-subflow-slot-child.flow.yml` | R4 — a caller's slot is not visible inside a sub-flow |
| `r4-dataset-slots.flow.yml` | R4 — concurrent iterations each get their own slots |
| `r4b-condition-false.flow.yml` · `r4b-unmet-dependency.flow.yml` · `r4b-cancelled.flow.yml` | R4b — the three skip reasons `failOnUnresolved` must leave alone |
| `r4c-generated-vars.flow.yml` · `r4c-inline-generated.flow.yml` · `r4c-vars-steps-ref.flow.yml` | R4c — when `vars:` are evaluated, and what binding a generated value to one buys |
| `r4c2-literals.flow.yml` · `r4c2-bare-word.flow.yml` · `r4c2-braced-var.flow.yml` · `r4c2-root-prefix.flow.yml` | R4c2 — §10.2's operand table; the failing rows are one flow apiece because a failed assertion masks the rows after it |
| `r4d-file-sources.flow.yml` · `r4d-body-file-interpolated.flow.yml` | R4d — a `!file` var, a `bodyFile:` inline layer, and a path selected by an earlier step |
| `r4e-multipart.flow.yml` · `r4e-binary.flow.yml` · `r4e-ambiguous.flow.yml` | R4e — §7.5's three assembly rules: parts, raw bytes, and the media type a step must select |
| `r4g-run-budget.flow.yml` | R4g — a poll that spends §11.3's budget, so the steps after it meet a stopped run |

R4b's two override rows are not files: they are the `r4-output-unproduced` fixture with one field
changed, which `harness.js`'s `variant()` applies in memory. A near-duplicate file would have to be
kept in step with the original by hand, and the assertion would stop meaning "the fixture minus
this edit" the moment they drifted. F3.4 and F4.4's structural halves work the same way.

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
- **`regressions-v1.yml` is deliberately generic.** Its operations are `createThing`, `getThing`,
  `signIn` and `getState`, because naming them after a domain would suggest a scenario that the
  flows binding it are not testing.

## Datasets

| File | Used by |
|---|---|
| `roles.csv` · `roles.json` · `roles.yml` | F1, and R4d2's requirement that the three formats produce identical iteration outcomes |
| `typing.csv` | R4d2's per-cell typing rows |
| `things.csv` | R4's per-iteration slots, at `parallel: 3` |
| `pair.csv` | R4c — two iterations, which is what makes "different across them" assertable |
| `operand-row.csv` | R4c2 — the single row `row.role` and the `when:` row resolve against |

## What is not here

R4f (cookie jars), R4g2 (capture layout), R4h (request validation) and R4m (the document schema).
Those rows need a capture directory and the §5.4 schema, neither of which exists yet, or — for
R4f — a host-side jar the stub port would have to implement before the engine's scoping rules
become observable. R4i and R4l are the CLI's, and live in `packages/bruno-cli/tests/fork/flow/`.
