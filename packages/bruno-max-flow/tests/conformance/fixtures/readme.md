# Conformance fixtures

The corpus 001-C's scenarios run against. **These files are the artifact**, not test scaffolding:
each `.flow.yml` is a real file rather than a string inside a test, so a format change that breaks
one shows up as a parse failure at a path instead of a diff inside a template literal (001-C §2).

```
specs/              minimal OpenAPI documents — one per service the flows bind
flows/              the .flow.yml fixtures, verbatim from 001-C where it gives them
flows/regressions/  the minimal flows §7's regressions are asserted against
flows/validation/   correct documents R4h and R8's cases each edit one line of
flows/schema/       R4m's documents, plus §15's golden v1 file
flows/connectors/   a two-scope tree — §8.5's layering only exists across scopes
flows/subflow/      the same shape for §12.2's `uses:` resolution
datasets/           CSV, JSON and YAML rows for F1, R4c, R4c2 and R4d2
```

**Four of those are directories rather than flat files, and the nesting is the fixture.** §8.5's
resolution order is workspace file → collection file → step, and §12.2's `workspace:` prefix means
nothing without a workspace to be prefixed from — so `connectors/` and `subflow/` each hold a
miniature `flows/` beside a `collections/payments/flows/`, and a scenario points the engine's scope
at the outer directory. A flat fixture could not express either rule at all.

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
| `r4-slot-unwritten-typed.flow.yml` | §11.2 — the same slot in a typed field, where `""` and omission stop being interchangeable |
| `r9-flow-iteration-nodataset.flow.yml` | §9.4 — `{{flow.iteration}}` resolving to `0` outside a dataset |
| `r4g-cleanup-bare-cancelled.flow.yml` | §11.3 — a bare `status: [cancelled]` after a successful parent, beside the four-way list that works |
| `r4-output-unproduced.flow.yml` | R4 and R4b — an unproduced output skips its consumer |
| `r4-subflow-slot.flow.yml` · `r4-subflow-slot-child.flow.yml` | R4 — a caller's slot is not visible inside a sub-flow |
| `r4-config-inherit.flow.yml` · `r4-config-inherit-child.flow.yml` | §12.3 — a caller's `config:` reaches a sub-flow that declares none |
| `r4-config-own.flow.yml` · `r4-config-own-child.flow.yml` | §12.3 — the sub-flow's own `config:` wins over its caller's |
| `r4-config-baseurl.flow.yml` · `r4-config-baseurl-child.flow.yml` | §12.3 — `baseUrl` is the one `config:` key that does not inherit; the caller names a host the sub-flow must not be sent to |
| `r2-retry-exhausted-default.flow.yml` | §14.6 — `retries-exhausted` with no `shouldRetry` declared at all |
| `r2-retry-outputs.flow.yml` | §11.1 — a predicate polling on `ctx.outputs`, with one output whose path matches nothing |
| `r4-dataset-slots.flow.yml` | R4 — concurrent iterations each get their own slots |
| `r4b-condition-false.flow.yml` · `r4b-unmet-dependency.flow.yml` · `r4b-cancelled.flow.yml` | R4b — the three skip reasons `failOnUnresolved` must leave alone |
| `r4c-generated-vars.flow.yml` · `r4c-inline-generated.flow.yml` · `r4c-vars-steps-ref.flow.yml` | R4c — when `vars:` are evaluated, and what binding a generated value to one buys |
| `r4c2-literals.flow.yml` · `r4c2-bare-word.flow.yml` · `r4c2-braced-var.flow.yml` · `r4c2-root-prefix.flow.yml` | R4c2 — §10.2's operand table; the failing rows are one flow apiece because a failed assertion masks the rows after it |
| `r4d-file-sources.flow.yml` · `r4d-body-file-interpolated.flow.yml` | R4d — a `!file` var, a `bodyFile:` inline layer, and a path selected by an earlier step |
| `r4e-multipart.flow.yml` · `r4e-binary.flow.yml` · `r4e-ambiguous.flow.yml` | R4e — §7.5's three assembly rules: parts, raw bytes, and the media type a step must select |
| `r4g-run-budget.flow.yml` | R4g — a poll that spends §11.3's budget, so the steps after it meet a stopped run |
| `r4n-redaction.flow.yml` | R4n — credentials written straight into a flow file, which is the only case §14.4's denylist exists for |
| `r4q-graph.flow.yml` | R4q — every edge kind at once, because the distinctions between them are what 002 §5.3 calls load-bearing and a fixture per kind would never catch two being conflated |
| `r4f-cookies.flow.yml` · `r4f-cookies-login.flow.yml` · `r4f-cookies-dataset.flow.yml` · `r4f-cookies-subflow.flow.yml` | R4f — §7.6's jar scoped to a run, to an iteration, and shared into a sub-flow |
| `r9-slot-declaration-order.flow.yml` | R9.1 — §9.1's tiebreak is declaration order; the fixture holds the first-declared writer's response back so a completion-order implementation resolves the other value |
| `r9-script-context.flow.yml` | R9.2 — `ctx.env` and `ctx.vars` across all four script positions, pinned as disjoint and as additive to the flat form |
| `r9-request-assertions.flow.yml` | R9.3 — §10.2's `req.*`, which resolved to `undefined` before the root was addressable |
| `r9-preview.flow.yml` | R9.4 — `step:end`'s preview, with the cap set deliberately small so the cut is observable while the attempt file beside it keeps the whole body |
| `r9-host-auth-profiles.flow.yml` | R9.10 — a host-supplied `collection` profile: nothing declares it here, and a flow's own profile of the same name wins over it |
| `r9-implicit-collection-auth.flow.yml` | R9.10 — §6.4's third rank, which is a flow naming no profile anywhere; the second step's `auth: none` is the opt-out from what the collection would have sent |

R4b's two override rows are not files: they are the `r4-output-unproduced` fixture with one field
changed, which `harness.js`'s `variant()` applies in memory. A near-duplicate file would have to be
kept in step with the original by hand, and the assertion would stop meaning "the fixture minus
this edit" the moment they drifted. F3.4 and F4.4's structural halves work the same way.

## Validation

`flows/validation/` is where R4h and R8.1–R8.10 live, and it is built the other way round from
`regressions/`: each file here is **correct**, and a case is that file with one line changed by
`harness.js`'s `variant()`. What a check reports is then the edit rather than the fixture, and a rule
that stopped firing shows up as a case that stopped failing instead of as a message nobody reads.
Most blocks open by asserting the clean file reports nothing at all — the half that catches a check
firing on correct flows, which is what a static checker gets retired for.

| File | Row |
|---|---|
| `graph.flow.yml` | R8.1 — the shape every dependency, slot and reference case edits |
| `overrides.flow.yml` | R8.4 — every inline override position at once, each naming a field the operation declares |
| `r4h-request.flow.yml` · `multipart.flow.yml` | R4h — a `requestBody` declaring `count: integer`, an operation declaring none, and the multipart case whose binary part is not checked |
| `multipart.flow.yml` · `multipart-text-part.flow.yml` · `attachment.flow.yml` | R8.5 — a media type selected, a `format: binary` part supplied as text, one not supplied at all |
| `binary.flow.yml` · `binary-options.flow.yml` · `file-in-json.flow.yml` | R8.5 — §7.5's raw payload, its multipart-only options, and a `!file` in a JSON body that is serialized rather than read |
| `files.flow.yml` · `file-option-typo.flow.yml` | R8.6 — every path position §7.4 has, and a `!file` key that is a parse error rather than an ignored one |
| `drop.flow.yml` · `drop-misplaced.flow.yml` | R8.6 — `!...` where §7.2 puts it, and outside any merge layer where it reads as `null` |
| `parent.flow.yml` · `login.flow.yml` | R8.7 — a `uses:` step carrying only what §12.4 permits, over a library flow with a real interface |
| `duplicate-operation.flow.yml` | R8.10 — a reference naming two operations at once (§6.5) |
| `signing.flow.yml` | R8.13 — a step under an `awsv4` profile carrying a header of its own; the cases edit which header it sets, and which mode the profile is |
| `collection-auth.flow.yml` | R8.14 — `auth: collection` with no `authProfiles:` block at all, so what validate reports depends on the scope it is given rather than on the file |

`data/` and `fixtures/` under it are what those flows' `dataset:`, `bodyFile:` and `!file` positions
resolve to. `specs/validation-v1.yml` is their document — it carries a nested `$ref`, a free-form
object, a query parameter and an operation with no `operationId` (§6.1's method-and-path fallback) —
and `specs/validation-duplicates-v1.yml` exists for one row: the same `operationId` on two operations.

## The document schema

`flows/schema/` is R4m's, built the same way: `document.flow.yml` is one correct document carrying
one of each shape the schema decides — all three `depends` forms, a `uses:` step, a retry policy, an
assertion, a slot — and every case is that file with one line changed. It carries no local tag on
purpose, because the mutation helper round-trips through plain YAML; the tags are covered by
`golden-v1.flow.yml`, which is §15's golden fixture and is read as committed and never edited.
`library.flow.yml` is the sub-flow the others invoke, so §12.4's permitted and refused fields both
have somewhere to be decided.

`golden-v1.flow.yml` is deliberately broad rather than minimal. A golden fixture only catches what it
exercises, and §5.4 promises a version's schema only *optional* additions — so this file must keep
validating against `flowSchema(1)` for as long as anyone may write a v1 document, including after a
v2 exists.

## Connectors and sub-flow resolution

Both are trees rather than files, for the reason above: the rules they pin are about scopes.

```
connectors/
  flows/connectors.yml                          the workspace layer
  flows/shared/login.flow.yml                   §12.3's row — a sub-flow resolves its own
  collections/payments/flows/connectors.yml     the collection layer over it
  collections/payments/flows/*.flow.yml         inherit · override · uses-shared
subflow/
  flows/shared/login.flow.yml                   the workspace's shared flow
  collections/payments/flows/local-login.flow.yml
  collections/payments/flows/uses-relative-ok.flow.yml
  collections/payments/flows/uses-workspace-prefix.flow.yml
```

| Fixture | Row |
|---|---|
| `connectors/…/inherit.flow.yml` | R10.1 — no `outputs:` block anywhere, and a third alias for the same document |
| `connectors/…/override.flow.yml` | R10.3 — the step's own block over both files: one entry suppressed with `!...`, one overridden, one added, one still inherited |
| `connectors/…/uses-shared.flow.yml` | R10.3's §12.3 row — the shared flow resolves the workspace file alone, so an entry this collection suppresses is still exported into it |
| `subflow/…/uses-workspace-prefix.flow.yml` | R12.1 — a collection flow reaching the workspace's shared flow through `workspace:` instead of a `../../` chain |
| `subflow/…/uses-relative-ok.flow.yml` · `local-login.flow.yml` | R12.1 — an ordinary relative path, unchanged by the prefix existing |

**The two connector files bind the same document under different aliases on purpose.** §8.5 matches
on the document and `operationId` a reference resolves to, never on the alias string, and a fixture
whose three files happened to agree on a name would pass whichever rule the code implemented.

## Specs

Minimal by design (001-C §8): real-world OpenAPI robustness — `$ref` cycles, vendor extensions,
missing `operationId`, multi-document specs — is separate ground from execution semantics and is
tracked in 001 §19.

Three details are load-bearing rather than decorative:

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

R4g2 and R4o need no fixture of their own: §14.5's layout is a property of *every* run, so
`capture.spec.js` and `history.spec.js` assert it over the flows above — the retry one for a file
per attempt, the dataset one for iteration nesting, the sub-flow pair for a nested `auth/login`, and
`r4b-condition-false` for a skipped step writing no directory at all. §14.5's path rule has its own
block in `capture.spec.js` beside those, asserted on `stepCaptureDir` rather than through a run: the
cases that decide whether the rule is sound — a device name at depth, a segment past the cap, two
ids differing only in how a separator is spelled — are ones no reasonable flow contains.

## What is not here

**One row of one requirement.** R4h's `--dry-run` case has no fixture because it has no subject: the
flag is scheduled for v2 (001 §19.1) and `bru flow run` rejects it today, so the case is registered as
an `it.todo` rather than written against a command that does not exist. Everything else R4h asks for
is `validation/r4h-request.flow.yml` and the multipart file beside it, since `validateRequest` itself
has always run (`step.ts`).

R4i, R4l, R7.1–R7.8 and R13.1–R13.3 are not here either, and never will be: they are the CLI's own,
and live in `packages/bruno-cli/tests/fork/flow/`. 001-C §2's table says which and why — a jar, a
wire format, a proxy, a sandbox choice, a collection root on disk and what a command prints are all
things the host owns and the stubbed ports cannot show. §6.4's implicit `collection` profile splits
across both: the engine's half is the mapping and the resolution order (`collection-auth.spec.js`
beside this corpus, and the two `r9-` flows above), and the host's half is reading the collection
file that produced it (`collection-auth.spec.js` under `bruno-cli`).
