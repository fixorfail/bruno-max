# 001 — API Flows

**Status:** Draft — **contracts settled; implementation may start.** §18's remaining questions are
each local to one execution path and none changes a signature; the ports, the engine boundary, the
expression dialect and the document schema are decided.
**Owner:** Jake Campbell
**Last revised:** 2026-09-02

Sequenced, spec-driven API request execution: a flow references OpenAPI operations instead of
copying them, declares the data that moves between steps, and runs identically in the app and the
CLI. Its companion, [001-C](./001-api-flows-conformance.md), holds the scenarios this behavior was
derived from, written to be implemented as tests. The app surface is
[002](./002-api-flows-ui.md) — read this first; it is the prerequisite.

---

## How to read this

Nobody reads this front to back. Pick an entry:

| If you are… | Read |
|---|---|
| **Authoring a flow** | §5 format · §7 how a request is built · §8 connectors · §9 control flow · §10 assertions. §16 is a complete worked example |
| **Implementing the engine** | §5–§12 in order — they are the semantics — then §13.2 for the boundary you expose |
| **Implementing the CLI** | §13.2 for what you call, then §14 entire |
| **Implementing the app** | §13.2, §13.3, §13.4 — then [002](./002-api-flows-ui.md), which is the UI |
| **Reviewing a proposed change** | §17 first. If the option is already there, the argument has been had |
| **Judging whether it's ready** | §18 open questions · §19 future work · the companion's §9 traceability table |

### Sections

| | |
|---|---|
| **§1–§4** | Problem, goals, non-goals, vocabulary |
| **§5** | File format — layout, a step, the JSON Schema (§5.4), stages (§5.5) |
| **§6** | Resolving an `operation:` — bindings, base URLs, auth profiles |
| **§7** | Building a request — seeding, merging, interpolation, files, multipart, cookies |
| **§8** | Connectors — declared outputs, scripts, connector files, the script library, visibility |
| **§9** | Control flow — dependencies, joins, shared slots, concurrency, conditions, datasets |
| **§10** | Automatic validation, assertions, negative tests |
| **§11** | Retry, failure propagation, cancellation, run budget |
| **§12** | Sub-flows — interface, isolation, library flows |
| **§13** | Engine package, the host boundary, app integration, **fork isolation manifest (§13.4)** |
| **§14** | CLI — flags, exit codes, validate, redaction, capture, vocabulary, console output, reporters |
| **§15–§16** | Compatibility and persistence; a worked example end to end |
| **§17–§19** | Rejected alternatives, open questions, future work |

### The contracts

Most of this document is reasoning. These parts are commitments other things depend on, and
changing one breaks something outside this feature:

| Contract | Where | Consumed by |
|---|---|---|
| The `.flow.yml` format | §5, §5.4 | Committed files, editors, every flow already written |
| Engine API, ports, events | §13.2 | `bruno-cli` and `bruno-electron`, independently |
| Exit codes | §14.2 | CI pipelines |
| Status, reason and diagnostic strings | §14.6 | Reporters, CI, anything parsing a run |
| Capture directory layout | §14.5 | CI artifacts, the future UI |
| Reporter contract (`FlowReporter`, `SuiteResult`) and the JUnit/JSON mapping | §14.8 | Custom reporters, CI tooling, TestRail-style importers |
| Upstream files touched | §13.4 | Re-checked after every merge from upstream |

§15 governs how the first of these may change; §14.6 and §5.4 govern themselves. The rest of the
document can be rewritten freely as long as behavior holds.

---

## 1. Problem

Bruno models a collection as a tree of individual requests. There is no way to express *"run
these operations in this order, feed data from one into the next, and assert on the result."*

Teams work around this by **duplicating requests**. The same `POST /payments` call is copied into
dozens or hundreds of folders — one per scenario — each with its own slightly-drifted copy of the
URL, headers, auth, and body. When the endpoint changes, every copy has to be found and updated
by hand. The copies drift silently, and the drift is only discovered when a test fails for the
wrong reason.

The `openapi-sync` feature already reconciles a collection against an OpenAPI spec, so the spec is
established as a source of truth for request *shape*. Nothing yet lets a test **reference** that
shape instead of copying it.

## 2. Goals

1. **Reference, never duplicate.** A flow step points at an operation in an OpenAPI spec. Changing
   the spec changes every flow that references it, with no per-copy edits.
2. **Sequence naturally.** A flow reads top-to-bottom as an ordered list of calls. Parallelism is
   something you opt into, not something you have to reason about to write a linear test.
3. **Make data paths explicit.** The values that travel between requests are declared, named, and
   introspectable — not buried in imperative script.
4. **Executable in CI.** Flows run under the `bru` CLI with the same fidelity as in the app.
5. **Committed to the repo.** Flows are plain-text, reviewable in a PR, and shared by the team.
6. **Minimal upstream footprint.** This repository is a fork of Bruno's open-source repo and
   merges regularly from upstream `main`. The feature must keep its code out of upstream files so
   those merges stay clean — see §13.4, which constrains the design throughout.

## 3. Non-goals

- **UI/UX design.** This spec defines only the file format, semantics, and CLI, and everything here
  must be expressible and executable without any UI. The app's run-and-observe surface is specified
  separately in [002](./002-api-flows-ui.md); the visual *builder* remains deliberately deferred and
  is tracked in 002 §15. That separation is the point — a UI reworked freely without touching this
  document is what the format-as-contract position buys.
- **Replacing collections or the existing runner.** Flows are a new artifact alongside them.
- **Load or performance testing.** Concurrency exists to shorten flow runtime, not to generate load.
- **Non-HTTP and non-OpenAPI protocols.** A step resolves an OpenAPI operation (§6), so flows are
  REST-only in this version — GraphQL, gRPC, WebSocket and SSE requests are not sequenceable, even
  though Bruno supports them as requests. This is a scope decision, not a limitation of the design:
  the graph, connectors and assertions are protocol-agnostic, and the binding is what assumes HTTP.
  Extending it means giving each protocol an operation-identity equivalent to `operationId`, which
  is its own spec. Tracked in §19.

## 4. Concepts

| Term | Meaning |
|---|---|
| **Flow** | An ordered, dependency-aware graph of steps in a single `.flow.yml` file. |
| **Step** | One invocation of an API operation *or* a sub-flow, plus its inputs, outputs, assertions and retry policy. |
| **Operation** | An endpoint defined in an OpenAPI document, referenced by `operationId`. |
| **API binding** | A flow-local alias mapping a short name to an OpenAPI document. |
| **Connector** | A declared, named value exported by one step and consumed by a later one. |
| **Connector file** | A shared file declaring an operation's default outputs once, so flows don't each re-declare them. |
| **Sub-flow** | A flow invoked as a single opaque step by another flow, communicating only through declared `params` and `exports`. |
| **Library flow** | A flow declaring `params:`; excluded from glob runs, invokable directly or as a sub-flow. |
| **Auth profile** | A named, reusable auth configuration declared once and referenced by API bindings and steps. |
| **Dependency status** | The set of parent outcomes — `success`, `failed`, `skipped`, `cancelled` — under which a step runs. |

---

## 5. File format

### 5.1 Location and naming

Flows live in a `flows/` directory and always use the `.flow.yml` extension. There are **two
scopes**:

```
workspace/
  workspace.yml
  apispec/
    payments-v3.yml
  flows/                          # WORKSPACE scope
    connectors.yml                #   shared output declarations (§8.5)
    e2e-checkout.flow.yml         #   spans services and collections
    shared/
      login.flow.yml              #   shared by every collection
  collections/
    payments/
      bruno.json
      flows/                      # COLLECTION scope
        connectors.yml            #   overrides the workspace file
        refund.flow.yml           #   inherits this collection's context
      payments/
        create-payment.bru
```

**Collection-scoped** flows inherit that collection's active environment and its auth as the
default profile — the common case needs no configuration at all. **Workspace-scoped** flows have
no collection to inherit from; they resolve variables against the workspace's environments and its
`.env`, and declare auth explicitly via profiles (§6.4).

A workspace's environments are the same thing Bruno calls **global environments** — one mechanism,
not two. They are stored per workspace and served by `renderer:get-global-environments` from
`workspaceEnvironmentsManager` when a workspace path is present, falling back to the app-data store
when it is not (`bruno-electron/src/ipc/global-environments.js`). Naming them as two scopes would
send an implementer looking for a workspace environment tier that does not exist. In §13.2's terms a
workspace-scoped flow populates `globalEnvironment`, `processEnv` and `envVarOverrides`, and leaves
`collectionVars` and `environment` empty; [002](./002-api-flows-ui.md) §7.2 has the table.

Roots are detected by walking up for `bruno.json` (collection) and `workspace.yml` (workspace).

**Flows are YAML-only, regardless of the collection's format.** A `.bru` collection and a `.yml`
collection both store flows as `.flow.yml`. This is a deliberate departure from how requests
behave, and it is the single most important cost decision in this spec: it means one parser, one
serializer, and one set of round-trip tests instead of the dual-format lockstep that
`.claude/rules/dsl-changes.md` requires for anything expressed in both formats.

Flows are still a **public on-disk contract** — they are committed, shared between Bruno versions,
and hand-edited. All the additive-and-optional, lossless-round-trip, and migrate-on-read rules in
`dsl-changes.md` apply in full.

### 5.2 Top-level structure

```yaml
version: 1                     # flow format version; required

meta:
  name: Checkout happy path
  description: Creates a payment, settles it, and verifies the ledger entry.
  testId: C1000                # optional; a test-management case id carried into reports — see §14.8.1b
  tags: [checkout, smoke]
  library: false               # default false; true excludes it from glob runs — see §12.5

apis:                          # alias -> OpenAPI document
  payments-api: ../../apispec/payments-v3.yml
  ledger-api: ../../apispec/ledger-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"    # optional; see resolution order in §6.3
  failOnStatusCode: true       # default true; status >= 400 fails a step — see §10.1
  failOnUnresolved: true       # default true; an unresolved-dependency skip fails the flow — §11.2
  validateRequest: true        # default true; check the body before sending — §10.1
  validateSchema: true         # default true; check the response against the spec — §10.1
  strictSchema: false          # default false; an undocumented status fails the step — §10.1
  concurrency: 5               # max steps in flight; default 5
  maxRunDuration: 900000       # ms, whole run incl. all iterations; off unless set — §11.3
  cleanupGrace: 30000          # ms allowed for cancelled-accepting cleanup; default 30000
  retry:                       # flow-level retry defaults, overridable per step
    maxAttempts: 3
    delay: 1000
  redactHeaders: [X-Legacy-Key]   # added to the built-in denylist; see §14.4
  capturePreviewBytes: 8192       # inline preview cap; see §14.5

authProfiles:                  # named, reusable auth configs — see §6.4
  user-token:
    mode: bearer
    token: "{{steps.auth.token}}"

vars:                          # flow-scoped values; referenced bare as {{currency}} — see §7.3
  currency: USD                # evaluated once before any step runs
  testEmail: "qa+{{$randomUUID}}@example.com"    # generated once, stable across steps
  catalog: !file ./fixtures/catalog.json         # loaded from disk — see §7.4

shared: [chargeId]             # cross-branch value slots; a mapping where one names its
                               # own `writers:` rule — see §9.1

dataset: ./fixtures/customers.csv   # optional; see §9.4

stages:                        # optional; names for regions of the graph — see §5.5
  setup: login                 # a stage name -> the step it begins at
  test: create_payment
  teardown: refund

steps:    [ ... ]              # the graph — see §9
```

A **library flow** additionally declares `params:` and `exports:` — see §12.1 — and marks itself
`meta.library: true`, which is what changes how it is discovered (§12.5). The canonical structure
above is an ordinary runnable flow.

`version` is required and exists so the parser can migrate older files on read rather than
forcing users to edit them by hand.

**A flow's identity is its path**, relative to the scope root with `.flow.yml` removed:
`flows/shared/login.flow.yml` is `flows/shared/login`. There is no `id:` field, because a second
source of identity can disagree with the first — a file renamed without its id, or an id duplicated
across two files — and every consumer of a flow's identity (§14.1's `--tags` filtering and
selection, §14.7's listing, [002](./002-api-flows-ui.md) §4.1's sidebar) is already naming it by
path. `bru flow list` and the sidebar **display** the final segment, falling back to the fuller path
only when two flows share a stem. Nothing persists an identity across runs, so renaming a file is
just a rename.

### 5.3 A step

```yaml
steps:
  - id: create_payment                        # required, unique within the flow
    name: Create a pending payment            # optional human label
    meta:                                     # optional; open mapping carried into reports — see §14.8.4
      testId: C1234
    operation: payments-api#createPayment      # required — see §6
                                              #   (or `uses:` + `with:` instead — §12, never both)
    auth: user-token                          # optional; an authProfiles name — see §6.4

    depends: [login]                          # optional — see §9.1
    when: steps.login.status eq 200           # optional — see §9.3

    body:                                     # inline overrides — see §7
                                              #   (or `bodyFile:` instead — §7.4, never both)
      amount: 9900
      currency: "{{currency}}"                # flow vars resolve bare — see §7.3
      legacy_field: !...                      # drop a spec-seeded key — see §7.2
    query:
      expand: customer
    headers:
      Idempotency-Key: "{{flow.runId}}"
    pathParams:
      tenantId: "{{tenantId}}"
    contentType: application/json             # only when the operation declares more
                                              #   than one request media type — see §7.5

    pre:                                      # computed before the request — see §8.7
      signature: |
        (ctx) => hmac(ctx.vars.nonce, ctx.env.key)

    outputs:                                  # declared connectors — see §8
      paymentId: data.id
      state: data.state

    shared:                                   # publish an output to a slot — see §9.1
      chargeId: paymentId

    assert:                                   # see §10
      - res.status eq 201
      - res.body.data.amount eq 9900

    retry:                                    # see §11.1
      maxAttempts: 5
      delay: 2000
      backoff: exponential
      shouldRetry: |
        (res, attempt, ctx) => res.status === 429

    failOnStatusCode: true                    # overrides config.failOnStatusCode — see §10.1
    failOnUnresolved: true                    # overrides config.failOnUnresolved — see §11.2
    validateRequest: true                     # overrides config.validateRequest — see §10.1
    validateSchema: true                      # overrides config.validateSchema
    strictSchema: false                       # overrides config.strictSchema — see §10.1
    timeout: 30000                            # ms, per attempt — see §11.1
    maxDuration: 120000                       # ms, whole step incl. retries — optional
```

A step declares **either** `operation:` or `uses:` (§12), never both.

**A step `id` matches `^[a-zA-Z_][a-zA-Z0-9_]*$`** and is unique within its flow. The constraint is
not stylistic: an id is addressed as `{{steps.<id>.field}}`, so anything containing a dot or a space
is unreachable, and ids become directory names under `.bruno-runs/` (§14.5), where separators and
Windows reserved device names are hazards. Rejecting those at authoring time beats a step that runs
but cannot be referenced.

**`-` is excluded for the same reason as `.` and a space, not as a style preference.** `-` is
subtraction in the expression dialect (§10.2) and in every `script:` form (§8.2), so
`steps.my-step.status` is either a second addressing syntax or an expression that silently means
something else. The alternative — allowing `-` and requiring `steps["my-step"]` — buys kebab-case
ids at the price of a rule people get wrong exactly once per flow, in a place where the wrong
version parses. `bru flow validate` reports `invalid-step-id` with the underscored id as a
suggestion. Allowing `-` later is additive; retracting it later is not, which is the asymmetry that
decides an open case.

### 5.4 The document schema

A **JSON Schema** describes the flow document, shipped in `@bruno-max/flow` and emitted by
`bru flow schema` (§14.1). It gives editors completion and inline errors for a format people write
by hand, and it is the first pass of `bru flow validate` (§14.3).

**It is the structural half of validation, not the whole of it.** The split is worth being explicit
about, because a schema that appears authoritative invites the assumption that passing it means a
flow is correct:

| The schema decides | Only code can decide |
|---|---|
| Field names, types, enums (`status`, `backoff`, auth `mode`) | Whether an `operation:` resolves in the bound document |
| Required fields; `operation` XOR `uses`; `body` XOR `bodyFile` | Whether a `{{steps.*}}` reference is a transitive ancestor (§8.4) |
| The three shapes of `depends` — list, `all:`, `any:` | Whether the graph is acyclic |
| The step-id pattern (§5.3) and uniqueness | Whether a shared slot has a writer upstream of its reader (§9.1) |
| That `retry.maxAttempts` is a positive integer | Whether a signing-mode profile conflicts with an overridden field (§6.4) |

The right-hand column needs the OpenAPI documents and the resolved graph, so §14.3 remains the
authority. The schema exists to catch the class of mistake that happens while typing — `assertt:`,
`status: [suceess]`, a string where a number belongs — at the moment it is typed rather than at the
next run.

#### Local tags and the data model

JSON Schema validates a parsed data model, and this format uses two YAML local tags — `!...` (§7.2)
and `!file` (§7.4) — that have no JSON equivalent. Three forms of the document therefore exist, and
naming them is what keeps the schema, the engine and the editor from disagreeing about a file none of
them reads quite the same way:

| Form | What it is | Read by |
|---|---|---|
| **Authored** | the YAML on disk, tags intact | a human, and the YAML language server |
| **Resolved** | what the flow parser produces — each tag becomes an engine value with *identity* | the engine, §7's pipeline, the semantic half of `bru flow validate` |
| **Projected** | the resolved form with each tag value replaced by the node the tag was applied to | ajv, and nothing else |

##### What the parse is, beyond the tags

The parser reads the **whole document into an AST with source ranges**, and the resolved form is a
projection of that AST rather than a separate load. Positions are not a debugging nicety: §13.2's
`Diagnostic` carries `line` and `column`, [002](./002-api-flows-ui.md) §6 puts diagnostics in the
gutter of the document view, and 002 §11.1's `FlowNode.position` is what makes clicking a graph node
scroll to its step. A second pass to find line numbers would be a second reader of the format, and
the two would disagree the first time one of them was wrong.

**Merge keys (`<<:`) are resolved.** A flow may share step configuration through a YAML anchor, and
the merged fields are the step's own. This is stated rather than left to the parser's default
because the two obvious YAML libraries disagree about it, and the failure mode is silent: a step
gains a literal `<<` field instead of the fields the anchor names, and every assertion about that
step still passes. 001-C's R4p pins it.

##### The resolved form

```ts
/** §7.2's removal tag. A symbol, so no authored document can produce a value equal to it. */
export const DROP: unique symbol;

/** §7.4's file reference, from either the scalar or the mapping form. */
export class FileRef {
  readonly path: string;
  readonly filename?: string;      // multipart only — §7.5
  readonly contentType?: string;   // multipart only — §7.5
}
```

**Identity, not shape, is what makes these unambiguous.** §17 rejects a `{ file: ... }` mapping
because in a value position it cannot be told apart from a literal object carrying a `file` key, and
resolving the tag *to* a marker object would reintroduce exactly that ambiguity one layer down: a
request body legitimately containing `{"$file": {...}}` would be read as a file reference and
uploaded. YAML cannot produce a symbol at all, and no mapping parses to a class instance, so the
collision cannot occur however hostile the body.

A `!file` mapping carrying a key other than `path`, `filename` or `contentType` is a parse error
rather than an ignored one — the tag has three options and a fourth is a typo.

##### The projected form: strip the tag, keep the node

```
!file ./fixtures/catalog.json           ->  "./fixtures/catalog.json"
!file { path: ./c.pdf, filename: x }    ->  { path: "./c.pdf", filename: "x" }
!...                                    ->  null
```

That rule is chosen for one property: **it is exactly what a tag-unaware reader already sees.** Given
`yaml.customTags`, the YAML language server permits each tag and reads the node beneath it — so the
projection and the editor converge on the same document, and a single schema serves both without
either being told that tags exist.

Projecting to a marker object instead would make the schema name a shape the editor never produces,
and the `yaml.schemas` mapping below would then flag every valid `!file` in the file. A schema whose
purpose is catching the mistake you make while typing cannot be one that red-squiggles the format's
own syntax.

##### What the schema therefore cannot decide

Stripping a tag discards it, so wherever a tag is legal the schema accepts the underlying node
whether or not the tag was written:

| Written | Projects to | Schema | `bru flow validate` |
|---|---|---|---|
| `state: !...` | `null` | valid | valid — drops the inherited connector entry (§8.5) |
| `state: null` | `null` | valid | **error** — `null` is not the removal token (§8.5) |
| `document: !file ./x.pdf` | `"./x.pdf"` | valid | valid |
| `document: "./x.pdf"` | `"./x.pdf"` | valid | **error** where the part is `format: binary` (§7.5) |

The right-hand column works on the resolved form and has the identity the projection dropped. This is
the division of labor the table at the top of §5.4 already draws, applied to the one case where the
two halves see the same characters and must reach different verdicts — and it is why the schema is
*the structural half* rather than a smaller copy of validation.

The cost is that a key left empty by accident — `state:` with nothing after it — projects to `null`
and passes the schema at any tag-legal position. It fails at `bru flow validate`, one command later,
naming the field. Paying that is what buys an editor that never lies about the format's own tags,
and §14.3's check list is where the rule is enforced either way.

Editors need the tags registered or they will flag valid files. For the YAML language server that is
a one-time workspace setting, which `bru flow schema --editor` emits alongside the schema:

```jsonc
// .vscode/settings.json
{
  "yaml.customTags": ["!file scalar", "!file mapping", "!... scalar"],
  "yaml.schemas": { "./.bruno/flow.schema.json": ["*.flow.yml"] }
}
```

A file may also point at the schema directly, which is what makes a flow self-describing when it
travels to a machine with no workspace settings:

```yaml
# yaml-language-server: $schema=./.bruno/flow.schema.json
version: 1
```

#### Strictness and forward compatibility

The schema sets `additionalProperties: false` — catching a typo'd key is most of its value — but an
unknown property is reported by `bru flow validate` as a **warning**, not an error.

That difference is deliberate and resolves a conflict with §15. Flows are committed and shared, so
an older Bruno will open a file written by a newer one; if an unrecognized field were an error, the
older CLI would refuse a valid flow rather than ignore a field it does not implement. As a warning,
the author gets the red squiggle in their editor and CI keeps running, with `--strict` available
when a team wants the stricter posture.

#### Versioning

**One schema per format `version`.** `bru flow schema --version 1` emits v1's; the current version
is the default. Within a version the schema only ever gains optional properties, matching §15's
additive rule, so a v1 schema shipped today still accepts a v1 file written a year from now.

A new `version` means a new schema file rather than a modified one, which is what lets §15's golden
fixtures for every prior version be validated against the schema that was current when they were
written.

### 5.5 Stages

A flow's graph is usually read in parts — what is being set up, what is under test, what is being
cleaned up — and nothing in the file says where one part ends. `stages:` names those regions:

```yaml
stages:
  setup: login
  test: create_payment
  teardown: refund
```

An **ordered mapping of a stage name to the step it begins at**. A stage covers the run of `steps:`
from that step up to the next stage's, and the steps before the first boundary belong to no stage.
Mapping order is the order the regions appear, exactly as `apis:` order decides which binding gets
which colour (§6.2).

**A stage names one step however many it covers.** This is the whole reason the block is boundaries
rather than membership lists: adding, removing or reordering steps *inside* a stage is not an edit
to `stages:` at all, so the two halves of the file cannot drift apart while nobody is looking. The
one thing that does touch it is deliberately moving a boundary.

**It changes nothing about what a flow does.** Like §6.2's `color`, this is presentation — a name
for a region of a drawing ([002](./002-api-flows-ui.md) §5.5 is the only reader). It is in the
format rather than in the app's own settings because a stage is a fact about *this flow* that a
teammate reading the same file and `bru flow run` should both see. Deleting the block changes no
schedule, no status and no capture; a reader that does not implement it ignores an unknown top-level
key and runs the flow identically, which is what makes it safe to add to a format older readers
still parse (§5.4). Nothing in `steps:` changes, so §9.1's implicit sequence is unaffected: a stage
boundary is **not** a barrier, and the first step of a stage still depends on the step above it
unless it says otherwise. Cleanup remains what §11.3 makes it — a step accepting `failed` or
`cancelled` — whether or not a stage happens to be called `teardown`.

**Not every boundary can be drawn, and the ones that cannot are dropped.** A stage renders as a
vertical rule before its first step's column, which requires that everything listed above the
boundary also *runs* before it (§9.1 ranks a step below all of its dependencies). A step declared
earlier but ranked level with the boundary shares its column, and no line passes between them —
the common case being a cleanup step that depends on an early step and therefore runs early. Where
that happens the rule is suppressed and `bru flow validate` reports `stage-out-of-order` naming the
step that crossed it, rather than the graph rearranging itself to look tidy. A tidy picture of an
order the run does not have is worse than no picture.

The three ways a boundary is refused, all **warnings** (§14.3) for §6.2's reason — they decide how
a graph is drawn and never what a flow does:

| Code | When |
|---|---|
| `unknown-stage-step` | the named step is not a step of this flow — including a step inside a `uses:` sub-flow, which is not addressable from the caller (§12) |
| `stage-boundary-order` | the boundary does not come after the one before it, so it describes no run of steps — two stages naming the same step included |
| `stage-out-of-order` | the schedule contradicts the boundary, as above |

A warning rather than silence for the same reason a bad `color` is one: a suppressed rule leaves a
graph with no line where the author wrote one, which is indistinguishable from having declared no
stage at all.

---

## 6. Operation resolution

### 6.1 Reference syntax

```
<api-alias>#<operationId>
```

`payments-api#createPayment` resolves the alias `payments-api` through the flow's `apis:` block to
an OpenAPI document, then finds the operation whose `operationId` is `createPayment`.

**Fallback for specs without operationIds.** `operationId` is optional in OpenAPI. Where it is
absent, a step may address the operation by method and path:

```yaml
operation: payments-api#POST /payments/{id}/refund
```

The path is normalized before matching, by the **same rules** `openapi-sync.js` applies when it
builds its `METHOD:/path` endpoint identity — strip interpolations and the origin, drop the query,
convert `{param}` to `:param`, collapse and trim slashes — so flows and openapi-sync agree on what a
path *is*.

**The same rules, deliberately not the same function.** `normalizeUrlPath` is a private const inside
`bruno-electron/src/ipc/openapi-sync.js`, and this package may not import `bruno-electron` (§13.1);
extracting it would mean editing one of the most-churned files in the app and paying for it at every
upstream merge. The engine therefore owns its own implementation, and agreement is enforced by a
**committed corpus of input/output pairs asserted by both** — the engine's tests and a test over
`openapi-sync.js`. Drift becomes a failing test rather than a flow that silently cannot resolve an
operation openapi-sync matches fine.

Shared code would be the stronger guarantee, and it is the wrong trade here: eight lines of regex
duplicated behind a shared corpus costs one test file, where the extraction costs a merge conflict
forever.

`operationId` is the preferred form because it survives path refactors. Method+path is a
compatibility affordance, not the recommended style.

### 6.2 API bindings

```yaml
apis:
  payments-api: ../../apispec/payments-v3.yml     # shorthand
  ledger-api:                                     # expanded
    source: ../../apispec/ledger-v1.yml
    baseUrl: "{{ledgerBaseUrl}}"                  # per-API base URL override
    auth: service-account                         # auth profile name — see §6.4
    color: "#8ab4f8"                              # optional; how a viewer marks this API
    defaultHeaders:                               # applied to every step targeting this API
      X-Tenant-Id: "{{tenantId}}"
      X-Client: bruno-e2e
    defaultQuery:
      api_version: "2026-01"
```

**`color` is the one field here that changes nothing about what a flow does.** It is presentation —
002 §5.1 marks each step with the binding it calls, and this is where an author says which colour
that binding gets. It is in the format rather than in the app's own settings because the binding is
the thing being coloured and this file is the only place both hosts agree on: a colour stored beside
the app would be one machine's, invisible to a teammate reading the same flow and to `bru`. Teams
recognise a service by whatever colour their dashboards already give it, and that is worth more than
any ordering a renderer could pick for them.

`#rgb` or `#rrggbb`, and a warning (§14.3) for anything else — not an error, because it decides how a
graph is drawn and never what a flow does. The warning is the point: a colour a renderer cannot parse
falls back to its unpainted default, which is indistinguishable from a binding that declared no
colour at all, so silence would hide the typo rather than the consequence. A viewer with no colours
ignores it, which is what makes it safe to add to a format older readers still parse (§5.4).

`defaultHeaders` and `defaultQuery` remove the cross-cutting values that would otherwise be
repeated on every step of every flow — a tenant id or API version that the vendor's spec examples
will never supply. They are a merge layer beneath the step's inline values (§7.2), so any step can
override one, and `null` drops it for that step.

Paths are resolved **relative to the flow file**. This lets a flow reference the workspace's
`apispec/` directory (where the existing API Spec feature stores documents) without hardcoding an
absolute path, and lets a flow span multiple APIs — the reason the reference is alias-qualified
rather than a bare `operationId`.

**Every source — local or remote — loads through the `ReadSpec` port** (§13.2). The engine hands
over the source string as written and receives the document text; it never distinguishes a path from
a URL, because doing so would put network policy in the shared package. Remote sources (`https://…`)
therefore resolve through the existing `renderer:fetch-api-spec` / `swagger-fetch` path in the app
and a direct fetch in the CLI, and **each host owns its cache** — location, TTL, invalidation and
offline behaviour are host policy, not flow semantics, and no engine output changes with a cache
hit. Referencing a remote spec still means a network dependency at run time; teams that want
hermetic CI should vendor the spec into the repo.

### 6.3 Base URL

Not expressed on the step. Resolution order, first match wins:

the step's API binding `baseUrl` → flow `config.baseUrl` → the spec's `servers[0].url`.

**`--env-var` is not a tier in this list.** It overrides a *variable*, so it reaches the base URL
only through whatever `{{...}}` the winning tier contains: `--env-var apiBaseUrl=…` changes
`config.baseUrl: "{{apiBaseUrl}}"` by interpolation (§7.3), not by outranking it. Environment
variables reach the base URL the same way — there is no separate "environment supplies the base
URL" rule, because that is what interpolating `config.baseUrl` already does.

#### Base URLs that a step produces

**A binding's `baseUrl` is resolved per step, at that step's materialization** — not once when the
flow is loaded. It may therefore reference `{{steps.*}}` and `{{params.*}}` like any other
interpolated value, which is what makes a per-tenant host testable: a workspace whose subdomain does
not exist until a step creates it.

```yaml
apis:
  signup-api: ../../apispec/platform-v1.yml       # global host, from the spec's servers[0]
  workspace-api:
    source: ../../apispec/platform-v1.yml         # same document, tenant host
    baseUrl: "https://{{steps.create_workspace.subdomain}}.example.com"

steps:
  - id: create_workspace
    operation: signup-api#createWorkspace
    outputs:
      subdomain: data.workspace.subdomain

  - id: workspace_settings
    operation: workspace-api#getSettings          # resolves to the tenant host
```

Two aliases may bind the **same** document with different base URLs, which is how the global and
tenant-scoped halves of one API coexist in a flow.

**The §6.4 ancestor rule generalizes to every binding-level reference.** A step targeting a binding
whose `baseUrl`, `defaultHeaders` or `defaultQuery` references `{{steps.X}}` must have `X` as a
transitive ancestor, or `bru flow validate` fails. A host is a data dependency exactly as a token
is, and it is worth strictly more: a step that resolves its base URL from a value the run has not
produced yet does not fail cleanly, it sends a real request to a malformed host.

**Across separate flows, prefer `params.*` to `{{steps.*}}`.** When the phases are already separate
flows — create the workspace, log into it, work inside it — a sub-flow declares its own binding
against its own parameter, and the tenant host arrives at the call site where it can be seen:

```yaml
# flows/workspace-session.flow.yml
params:
  subdomain: { required: true }

apis:
  workspace-api:
    source: ../../apispec/platform-v1.yml
    baseUrl: "https://{{params.subdomain}}.example.com"
```

```yaml
  - id: session
    uses: ./workspace-session.flow.yml
    with:
      subdomain: "{{steps.create_workspace.subdomain}}"
```

This needs no ancestor rule — `params.*` is resolved before the sub-flow starts — and it is why
§12.3 has sub-flow bindings resolve from their own scope rather than the caller's. A shared flow
parameterized by tenant is reusable against any workspace; one reaching into a caller's step state
would only work below the flow that happened to create one.

### 6.4 Auth profiles

A flow's `apis:` block spans multiple OpenAPI documents, so a flow routinely talks to services
with **different** auth schemes. A single inherited collection auth config cannot express that.
Auth is therefore declared as **named profiles**, referenced where the target service is already
named:

```yaml
authProfiles:
  none:
    mode: none
  user-token:
    mode: bearer
    token: "{{steps.auth.token}}"
  service-account:
    mode: oauth2
    grantType: client_credentials
    clientId: "{{clientId}}"
    clientSecret: "{{clientSecret}}"

apis:
  auth-api:
    source: ../apispec/auth-v2.yml
    auth: none
  payments-api:
    source: ../apispec/payments-v3.yml
    auth: user-token
  ledger-api:
    source: ../apispec/ledger-v1.yml
    auth: service-account
```

A profile body carries the **fields of the existing Bruno auth modes** (the `mode` union in
`bruno-schema-types/src/common/auth.ts`). Every mode Bruno already supports — bearer, basic,
oauth2, apikey, awsv4, digest, ntlm, wsse — works unchanged, and OAuth2 profiles reuse the
existing token cache and `clear-oauth2-cache` handling. Flows introduce no new auth mechanics.

**A profile is authored flat and delivered nested.** Bruno's `Auth` puts each mode's fields under a
key named for the mode — `{ mode: 'bearer', bearer: { token } }` — which is what a request carries
on disk and what every host's auth code reads. Writing that in a flow would mean saying `bearer`
twice, so the format keeps the flat form above, and **the engine converts to `Auth` when it
materializes a request** (§13.2). The two are different contracts with different readers: the flat
one is `.flow.yml`'s, read by whoever writes a flow, and the nested one is `ExecuteRequest`'s, read
by code that already exists in both hosts.

That conversion is the whole of §6.4's "no new auth mechanics" claim. Handing over the authored
shape instead would require each host to write its own translation to reach `setAuthHeaders`, the
OAuth2 cache and the signing interceptors — two adapters, diverging quietly, for a mapping the
engine can do once. 001-C's R4j pins it in both directions.

**Resolution order**, first match wins: step's `auth:` → the API binding's `auth:` → the implicit
`collection` profile → `none`.

**Overrides are per-field.** A value the step declares explicitly wins for *that field only*;
everything else the profile would contribute still applies. This is mode-agnostic — it works the
same whether the profile sets a header, a query parameter, or several of both:

```yaml
  - id: legacy_call
    operation: payments-api#legacy
    headers:
      Authorization: "{{preSignedToken}}"   # this header only; profile still applies elsewhere
```

To disable authentication for a step entirely, use `auth: none`.

**Signing modes are the exception, and validation enforces it.** `awsv4`, `digest`, `ntlm` and
`wsse` compute a signature across several request fields; overriding one of those fields leaves a
signature that no longer matches what was signed, producing a 401 that looks like a credentials
problem rather than a configuration one. `bru flow validate` therefore **errors** when a step
explicitly sets a field that its resolved signing-mode profile would compute, and directs the
author to `auth: none` plus a fully hand-built request instead.

The implicit **`collection`** profile exists only for collection-scoped flows and carries that
collection's configured auth. This is what keeps the simple case free: a collection flow calling
one API declares no `authProfiles` at all and authenticates exactly as the collection does.
Workspace-scoped flows have no such profile and must declare what they use.

**Profiles resolve lexically.** A profile whose value references `{{steps.*}}` — as `user-token`
does above — is evaluated at the moment a step uses it, in the context of the flow that *declared*
the profile, not the flow that inherited it. Two consequences:

- §8.4's visibility rule applies through profiles. A step authenticating with `user-token` must
  have `auth` as a transitive ancestor, or validation fails. An auth dependency is a real data
  dependency and is checked like one.
- A sub-flow inheriting a parent's profile cannot use it to reach parent step data indirectly,
  preserving the isolation boundary in §12.3.

### 6.5 Resolution errors

Unresolvable alias, unknown `operationId`, ambiguous `operationId` (duplicated within one
document), or a method+path with no match are **validation errors**, surfaced by
`bru flow validate` before any request is sent — not at the moment the step is reached.

---

## 7. Request materialization

A step's concrete request is built in a fixed, five-stage pipeline. Each stage is deterministic
and independently testable.

```
1. RESOLVE    operation ref  ->  OpenAPI operation object
2. SEED       operation schema  ->  a full candidate request
3. MERGE      API binding defaults, then the step's inline values, over the seed
4. INTERPOLATE  {{...}} against the run context
5. AUTH + SEND  apply the resolved auth profile, dispatch
```

### 7.1 Seeding from the spec (stage 2)

Values are derived from the operation's request schema, in this precedence:

1. The media type's `example`
2. The first entry in `examples`
3. A property's `default`
4. A generated value from `type`/`format` (`string` → `""`, `integer` → `0`, `enum` → first member)

Required properties are always seeded. Optional properties are seeded **only** when they have an
`example` or `default` — otherwise an optional field with no meaningful value would be sent on
every request.

**`format: binary` properties are never seeded**, required or not: there is no useful placeholder
for a file, and an empty string would upload zero bytes while looking intentional (§7.5).

This is what makes a step terse: a five-field payload where one field matters is three lines, not
eight. It also means **a step's effective payload changes when the spec's examples change.**

That coupling is the feature, not a defect — it is the mechanism by which one spec edit updates
hundreds of flows. Drift is therefore handled by splitting it into two classes and treating them
differently:

- **Structural drift is an error.** A step overriding `body.customer_id` when the operation's
  schema has no such property is caught by `bru flow validate` (§14.3), which checks every inline
  override against the resolved schema. Without that check the request silently carries a field
  the API ignores, and the test passes while asserting nothing meaningful.
- **Value drift is accepted.** An example changing from `USD` to `EUR` flows through to every step
  that did not override it, by design. Flows are **not** pinned to a spec version: pinning would
  reintroduce the per-copy update burden this feature exists to remove, in another form.

`bru flow run --dry-run` (§14.1) prints the effective request for every step, so the blast radius
of a spec change is inspectable on demand without sending anything.

### 7.2 Merge semantics (stage 3)

Three layers, each overriding the one before:

```
spec seed  ->  API binding defaultHeaders / defaultQuery  ->  step's inline values
```

A step's `bodyFile:` (§7.4) occupies the same layer as its inline `body:` — the two are mutually
exclusive, so the layer has one source either way.

- Objects **deep-merge**; the step's value wins at each leaf.
- Arrays **replace** wholesale. They are not concatenated or index-merged — element-wise merging
  of arrays is ambiguous and produces surprising results.
- The **local tag `!...`** removes a key the seed introduced. `null` keeps its ordinary meaning and
  sends a literal JSON null.

```yaml
    body:
      amount: 9900
      legacy_field: !...        # drop the spec-seeded key entirely
      note: null                # send "note": null
```

A distinct tag is required because YAML has no other way to express this. A tag from the `!!`
shorthand — which expands to `tag:yaml.org,2002:`, the namespace the YAML spec reserves for its own
types — would resolve to the ordinary null value and be indistinguishable from `null` after
parsing. `!...` is a **local tag** (single `!`), which is exactly what YAML reserves for
application-defined values; js-yaml registers it as a custom `Type` yielding a sentinel the merge
stage recognizes.

`...` is also YAML's document-end marker, but that marker is only recognized at the *start of a
line*, and a tag is always introduced by `!` — so the two can never collide in any position the tag
may legally appear. Parser coverage for `!...` as a mapping value, a sequence entry, and the final
node in a file is ordinary diligence, not a defence against ambiguity.

Two dots (`!..`) was considered and rejected: `..` is already bruno-query's deep-descent operator in
output paths (§8.1), and one token with two unrelated meanings in a single file format is worth
avoiding.

### 7.3 Interpolation (stage 4)

The governing rule is:

> **Values a human authored resolve bare. Structured state the engine produces is namespaced.**

**Authored values are `{{bare}}`** and resolve through Bruno's existing scope chain, unchanged —
there is no flow-specific variable syntax to learn. Flow `vars:` slot in as one more scope,
positioned where folder variables sit for a request. Innermost wins:

```
global environment  ->  collection vars  ->  environment (incl. --env-var)
   ->  flow vars:  ->  oauth2 credential vars  ->  runtime vars (bru.setVar)
```

This mirrors the order in `bruno-electron/src/ipc/network/interpolate-vars.js`, so a variable
resolves identically whether it is read by a request or by a flow.

#### `--env-var` and `process.env` are not ranks in that chain

§13.2's `RunOptions.variables` carries five fields and the chain has six ranks, which reads like a
discrepancy and is not. Two of those fields are not tiers, and one tier is not a field:

**`--global-env <name>` fills the `globalEnvironment` rank**, from the workspace's own
`environments/<name>.yml` — the file the app edits and `bru run --global-env` already reads, so the
two commands and the app cannot end up naming three different things. `bru` resolves it per flow's
scope, because a selection can span two workspaces, and a name matching no file is a usage error
reported before the first request rather than after it. A `secret: true` value is not in that file
(002 §7.2 records why), so from `bru` it arrives empty and `--env-var`, a `.env` or the process
environment is the answer for one.

**`--env-var` overrides a variable; it does not outrank a scope.** It merges into the **environment**
tier and wins inside it, which is exactly what `bru run` does today
(`bruno-cli/src/commands/run.js` assigns each `--env-var` into `envVars` before the environment is
handed on). It therefore *loses* to a flow `vars:` entry of the same name, and that is the intended
behaviour rather than an accident of reuse:

- §6.3 already settled the same question for base URLs — "`--env-var` is not a tier in this list; it
  overrides a *variable*, so it reaches the base URL only through whatever `{{...}}` the winning tier
  contains." A flag that outranked every scope would contradict that rule one section later.
- The alternative fails goal 4 in the place it matters most. `--env-var currency=EUR` would change a
  flow run and not the `bru run` beside it in the same pipeline, so the two commands would disagree
  about a variable while §7.3 claims they cannot.

A flow value meant to be overridable from CI says so, by reading a variable instead of fixing one:

```yaml
vars:
  currency: "{{currency}}"      # --env-var currency=EUR reaches this
  region: EU                    # a constant of the flow; --env-var will not change it
```

`envVarOverrides` stays a **separate field** rather than being pre-merged by the host, for the reason
§13.2 keeps every tier separate: merging is precedence, precedence is a flow semantic, and a host
that folded the two would be deciding it. Keeping them apart also preserves provenance for §14.4 —
an environment entry can be `secret: true`, and a value typed on a command line never is.

**`process.env` is a namespace, not a tier.** `interpolate-vars.js` nests it under a `process.env`
key rather than spreading it, so `{{process.env.HOME}}` resolves and a bare `{{HOME}}` does not.
`RunOptions.processEnv` populates that namespace and takes no position in the chain, which is why it
cannot shadow or be shadowed by anything in it. `{{process.env.VAR}}` keeps working exactly as it
does today.

That makes **`process` a reserved root** alongside §7.3's five: a variable named `process` in any
scope is shadowed by the namespace, and `bru flow validate` warns, as it does for the others.

**Runtime variables are the tier with no field.** `bru.setVar` values are produced *during* a run, by
the script positions of §8.2, so no host can supply them up front. The engine owns that tier as run
state. Whether a flow `script:` may call `bru.setVar` at all is still open (§18) — the tier's rank is
settled here either way, because it is the rank `interpolate-vars.js` already gives it.

There is deliberately **no `vars.` or `env.` prefix**. A flow variable and an environment variable
are the same kind of thing to whoever writes `{{tenantId}}`; which scope supplies it is a
resolution detail, exactly as it is in a collection.

**Engine-produced state is namespaced**, because it is a lookup into run state rather than a
variable, and because a bare name could be shadowed by a user's:

| Namespace | Contents |
|---|---|
| `steps.<id>.*` | A prior step's declared outputs and built-in metadata (§8.3) |
| `row.*` | The current dataset row (§9.4) |
| `params.*` | This flow's declared inputs, when invoked as a sub-flow (§12) |
| `shared.*` | Cross-branch value slots declared in `shared:` (§9.1) |
| `flow.*` | `flow.runId`, `flow.name`, `flow.iteration` |
| `pre.*` | Values this step computed before its request (§8.7) — **step-local** |

`row.*` and `params.*` stay namespaced even though a human named their contents, because both are
**inputs crossing a boundary** — a dataset column entering an iteration, an argument entering a
sub-flow. Keeping them explicit means a call site shows what it passes rather than relying on
ambient resolution.

**`pre.*` is the one namespace that is not run-scoped.** Every other row above addresses state any
step can read; `pre.*` addresses the values *this* step computed, and it means nothing in another
step — which is why §8.7's values leave a step through `outputs:` rather than by being readable from
outside it. A namespace that resolved to a different step's values depending on where it was read
would be the one thing this table exists to prevent.

`steps`, `row`, `params`, `shared`, `flow`, `pre` and `process` are reserved at the top level. A variable in
any scope with one of those names is shadowed, and `bru flow validate` reports it as a warning.
`process` is reserved by the same mechanism but not by this table — it is Bruno's existing
`process.env` namespace (above), shadowing a bare variable in flows exactly as it already does in
requests.

**Interpolation and expressions are different operations and use different syntax.** `{{...}}`
*injects a value into a request* — a body field, a header, a query param. Conditions and
assertions instead *evaluate an expression* and are written bare, with no braces:

```yaml
    body:
      customer_id: "{{steps.login.userId}}"     # interpolation — inject into the request
    when: steps.login.status eq 200             # expression  — evaluate a condition
```

Overloading `{{}}` for both would imply they are the same operation. They are not, and keeping
them visually distinct is what lets conditions be statically analyzed while interpolation stays a
substitution rather than an evaluation.

#### Types survive a whole-value reference

**When a scalar's entire value is a single `{{...}}` reference, the resolved value keeps its native
type.** A placeholder embedded in surrounding text stringifies, as it must:

```yaml
    body:
      item_count: "{{steps.get_batch.itemCount}}"          # -> 12          number
      active:     "{{steps.get_batch.isActive}}"           # -> true        boolean
      tags:       "{{steps.get_batch.tagList}}"            # -> ["a","b"]   array
      label:      "batch {{steps.get_batch.id}} (EU)"      # -> "batch B-42 (EU)"   string
```

Without this rule nothing typed can reach a JSON body at all. YAML forces the quotes — `{` opens a
flow mapping, so a bare `item_count: {{...}}` is not the reference it looks like — and *every* value
crossing from a step output into a structured body would otherwise arrive as a string, and a numeric
field would break on the first request. The rule is not an ergonomic nicety; it is what makes outputs
usable as request data.

**An unquoted whole-value reference is a parse error** (§14.3's `parse-error`, anchored at the value).
It is tempting to call it a YAML syntax error and leave it to the parser, but it is not one: `token:
{{ token }}` is a well-formed mapping whose single key is the mapping `{ token }`, so the file parses,
the flow runs, and the request goes out carrying `{"{ token }": null}` where its author wrote a
reference. Nothing downstream can recover the intent — by then the text is gone — so the parse is
where it has to be caught. A key that is a collection has no other use in this format, which is what
makes the check exact rather than a heuristic over `{{`.

The boundary is deliberately syntactic rather than schema-driven. "Whole value or not" is visible
in the file and identical whether or not the operation's schema is complete, whereas coercing to
the spec's declared type would silently do different things for a documented and an undocumented
field. Where a number genuinely must be sent as a string, say so at the source — an output whose
`script:` returns `String(...)` — rather than relying on a formatting trick at the call site.

#### When flow `vars:` are evaluated

**Once, before any step runs — and once per iteration under a dataset.** Not lazily at each point of
use.

This is what makes a generated value reusable. A flow that signs up and then logs in needs *the same*
address in both steps, and re-evaluating per use would produce two:

```yaml
vars:
  testEmail: "qa+{{$randomUUID}}@example.com"
```

```yaml
      email: "{{testEmail}}"          # the same address in every step that reads it
```

Per-iteration evaluation is what keeps dataset rows independent: three rows generate three
identities rather than sharing one, matching how `steps.*` and `shared.*` are already scoped per
iteration (§9.4).

Because no step has run at that point, **`vars:` may not reference `{{steps.*}}` or `{{shared.*}}`**
— a validation error, not a runtime empty. They may reference `{{row.*}}` and `{{params.*}}`, both
of which are settled before a flow or iteration begins.

#### Generated values

Bruno's mock variables work in flows, because §7.3's scope chain is Bruno's own: `{{$randomUUID}}`,
`{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomBoolean}}`,
`{{$randomIP}}` and the rest of `mockDataFunctions`, exported from `@usebruno/common`
(`packages/bruno-common/src/utils/faker-functions.ts`, matched by `interpolate/index.ts:18`).

**Each occurrence generates independently.** That is the right default for a value wanted fresh —
an idempotency key per attempt — and the wrong one for an identity two steps must agree on. Bind it
to a `var:` when it must be stable, as above.

`flow.runId` is usually the better choice for test-data uniqueness. It is stable across every step
of a run, unique between runs, and *traceable*: a record left behind names the run that made it,
which a random UUID cannot.

Generated values obey the whole-value typing rule like any other reference — `{{$randomInt}}` alone
in a field injects a number, not `"42"`. Bruno's existing interpolator stringifies mock output
(`interpolate/index.ts:41`), so the engine resolves whole-value references itself and delegates only
embedded ones. That is the same path the typed rule above already requires; generation rides it
rather than adding a second exception.

**There is no seeding.** A run using generated data cannot be replayed identically. §14.5's captures
record what was actually sent, so a failure remains diagnosable, but reproducing it means pinning the
value in a `var:`. Seeding is tracked as future work (§19).

### 7.4 File sources

Flows read data from files in two places. Both resolve through the same rules.

**A file is referenced by the local tag `!file`**, in any value position:

```yaml
vars:
  catalog: !file ./fixtures/catalog.json     # JSON, YAML, or CSV — parsed at flow start
```

The tag takes a mapping instead of a scalar when it needs options:

```yaml
  contract: !file
    path: ./fixtures/contract.pdf
    filename: signed-contract.pdf            # multipart only — see §7.5
    contentType: application/pdf
```

A tag rather than a `{ file: ... }` mapping, for the same reason `!...` is a tag (§7.2): in a value
position a plain mapping is ambiguous with a literal object that happens to have a `file` key, and
resolving that by consulting the operation's schema would make the meaning depend on how completely
the API is documented. `!file` is unambiguous wherever it appears. It is a **local tag** — single
`!`, the namespace YAML reserves for application-defined values.

The result is an ordinary structured value, so `{{catalog.items[0].sku}}` navigates into it exactly
as it would a structured output (§8.1). This is the loader `dataset:` is not — `dataset:` runs the
flow once per row, which is iteration, not reading.

**A step may take its body from a file**, merged as that step's inline layer at stage 3 (§7.2):

```yaml
  - id: create_order
    operation: orders-api#createOrder
    bodyFile: ./fixtures/large-order.json
```

Spec seeding, `!...` deletion and `{{}}` interpolation all continue to apply, so a fixture
containing `{{steps.auth.userId}}` resolves like any inline body. `bodyFile` and an inline `body:`
on the same step is a validation error — two sources for one value, with no obvious precedence.

**The path itself interpolates**, which is what makes a mid-flow read possible. `bodyFile` is
resolved when the step materializes, so a fixture can be selected by something an earlier step
produced:

```yaml
    bodyFile: "./fixtures/{{steps.pick_variant.variant}}.json"
```

The order is: interpolate the path, read the file, merge the contents, then interpolate the
contents.

**Paths resolve relative to the flow file** and must stay **within the scope root** — the collection
or workspace root that owns the flows, the same boundary §14.5 writes captures to. A path escaping
it is a validation error.

That containment is not hypothetical hygiene. Flows are committed and shared, so a flow arriving on a
teammate's branch runs on your machine with your credentials, and `file: ../../../../.ssh/id_rsa`
would be read and sent. §14.4's redaction cannot help — a file's contents have no secret-variable
provenance to trace.

**The engine does not touch `fs`.** Reads go through an injected port alongside `ExecuteRequest`
(§13.2), so each host keeps its own path handling and conformance scenarios stub fixtures instead of
writing them to disk. The same holds for the one thing a run *writes* — capture (§14.5) goes through
`WriteFile` and `RemoveDirectory`, with the engine computing every path and the host writing bytes,
so the layout stays single-sourced without putting `fs` in the package.

### 7.5 Multipart and binary bodies

**The operation's declared media type decides how a body is assembled.** Nothing on the step selects
it, because the spec already says what the endpoint accepts — the same argument that keeps base URLs
and content types off the step everywhere else.

| Declared media type | Body assembled from |
|---|---|
| `application/json`, `application/x-www-form-urlencoded`, `*+json` | the merged structure (§7.2), interpolated |
| `multipart/form-data` | one part per key of the merged structure |
| anything else (`application/pdf`, `application/octet-stream`, …) | the raw bytes of a single `!file` or `bodyFile:` |

#### When the operation declares more than one

An operation offering both `application/json` and `multipart/form-data` is ordinary, and the rule
above has no answer for it — "the operation's declared media type" presumes there is one.

**The step selects with `contentType:`, and only then.** Declaring it on an operation with a single
request media type is a validation error, so the field cannot spread into the ordinary case and
become a second place to look for something the spec already said. Omitting it where the operation
is ambiguous is `ambiguous-media-type`, which lists the declared types.

```yaml
  - id: create_order
    operation: orders-api#createOrder         # declares json and multipart
    contentType: multipart/form-data
    body:
      manifest: !file ./fixtures/manifest.csv
```

Nothing is inferred from the body's shape. Deducing multipart from the presence of a `!file` would
make the request's wire format change when someone edits a value — implicit in exactly the place
this section set out to be explicit — and a fixed precedence order (`json` beats `multipart`) would
resolve every case correctly except the one where the author wanted the other type, with no way to
say so.

#### Multipart

Each key of `body:` becomes a part. A `!file` value makes that part a file upload; anything else is
a field:

```yaml
  - id: attach_invoice
    operation: billing-api#uploadInvoice
    body:
      document: !file ./fixtures/invoice.pdf
      description: "Q3 invoice"
      amount: 9900
```

Repeated parts are an array, consistent with §7.2 replacing arrays wholesale rather than merging
them:

```yaml
      attachments:
        - !file ./fixtures/a.pdf
        - !file ./fixtures/b.pdf
```

**Filename** defaults to the basename of the path and is overridable with `filename:`. It is not
cosmetic — servers routinely key validation and storage on it, so a fixture named
`tmp-3f9a.pdf` can fail a check that `invoice.pdf` passes.

**Content type per part**, first match wins: an explicit `contentType:` → the operation's
`encoding.<part>.contentType` → inferred from the file extension → `application/octet-stream`. The
spec's `encoding` is consulted before inference because the API's own declaration is better evidence
than a file suffix.

Non-file parts are serialized as the schema declares them: a part typed `object` is sent as JSON with
`application/json`, matching OpenAPI's default encoding rather than flattening it to a string.

#### Raw binary

For a single-payload media type the body *is* the file, with no merge layer and **no interpolation**
— substituting into bytes would corrupt them:

```yaml
  - id: upload_scan
    operation: docs-api#uploadScan          # declares application/pdf
    bodyFile: ./fixtures/scan.pdf
```

`body: !file ./fixtures/scan.pdf` is **exactly equivalent** — the same file, read the same way, with
the same absence of a merge layer. §7.4's promise is that `!file` works in any value position, and a
raw payload is a value position; making it the one place the tag is refused would mean learning
which key a media type wants before writing either. The two are one form with two spellings, not two
behaviours, and `body:`/`bodyFile:` remain mutually exclusive (§7.2).

The tag's **options stay multipart-only**, as §7.4 has them: `filename:` and `contentType:` on a raw
binary body are a validation error. There is no part to name, and the payload's type is the
operation's declared media type — a `contentType:` on the tag would be a third answer to a question
§7.5 gives one answer to.

This is the one case where a body file is not parsed and merged (§7.4). The media type is what
distinguishes them, so the same key behaves consistently for a given operation.

#### Seeding

§7.1 does **not** seed a property of `type: string, format: binary`. There is no useful placeholder
for a file — an empty string would produce a zero-byte upload that looks deliberate. A required
binary part with no `!file` is a validation error naming the part, which is a better failure than a
request the server rejects for reasons the flow cannot explain.

#### Size and capture

`ReadFile` returns a buffer (§13.2), so an upload is held in memory. That is a deliberate limit
rather than an oversight: streaming would push chunked-transfer concerns into the engine, and
functional API tests upload fixtures, not gigabytes. Flows needing genuinely large payloads should
treat that as out of scope rather than expect it to work.

**Captures record file parts by reference** — path, filename, content type, and byte length, never
content (§14.5). A capture directory is a CI artifact, and inlining uploads would put the fixture
corpus in every run.

### 7.6 Session state

Cookies are the one thing that moves between steps without being declared. §8's model — named
outputs, drawn as edges — cannot cover them: a server sets a cookie the flow never asked for, and
the next request must carry it or the session is lost. Leaving that unspecified would make
cookie-authenticated APIs work by accident or not at all.

**A cookie jar is scoped to a flow run, isolated per dataset iteration, and inherited by
sub-flows.**

| Scope | Jar |
|---|---|
| One flow run | one jar; every step shares it |
| A dataset iteration (§9.4) | **its own jar**, never shared with sibling iterations |
| A sub-flow (§12) | the caller's jar |

Per-iteration isolation is the load-bearing rule. A role matrix that logs in as three users across
three rows shares one session under a run-wide jar: row two sends row one's cookie, the server
answers as the wrong user, and the flow passes while having tested one identity three times. Under
`parallel:` it is worse — the jar becomes shared mutable state between concurrent iterations, so
which session a request carries depends on timing.

Sub-flows inherit because a login sub-flow exists precisely to establish a session for its caller.
This is consistent with §12.3's rule rather than an exception to it: a cookie jar is **ambient
configuration of the transport**, like a proxy or a client certificate, not flow data. What does not
cross is anything the flow *names* — `steps.*`, `vars:`, `shared.*` — and cookies are by definition
unnamed.

**The engine owns jar scoping; the host owns cookie mechanics.** Parsing `Set-Cookie`, domain and
path matching, expiry and `Secure`/`HttpOnly` handling stay in each host's existing implementation
(§13.2), which is mature and differs for good reasons. What the engine decides is *which jar* a
request uses, because that is a flow semantic — and if it were left to the hosts, the CLI and the app
could disagree about whether iteration two is a fresh session, which is exactly the divergence goal 4
exists to prevent.

Cookies set before a run — a collection's stored cookies — seed the jar as they do for a single
request today. `Cookie` and `Set-Cookie` remain on §14.4's redaction denylist wherever they are
reported.

---

## 8. Connectors — how data moves between steps

### 8.1 Declared outputs

A step declares what it exports. This is the core of the feature: the data paths are *named*, so
they can be listed, validated, and drawn as edges rather than inferred from script.

```yaml
  - id: login
    operation: auth-api#login
    outputs:
      token: data.access_token
      userId: data.user.id
```

Consumed by name:

```yaml
  - id: create_payment
    body:
      customer_id: "{{steps.login.userId}}"
```

**Path syntax is `@usebruno/query`'s, not JSONPath.** That package is already in the repo and
supports deep navigation and indexing:

```yaml
    outputs:
      firstItemId: data.items[0].id
      anyItemAmount: ..items.amount        # deep navigation
```

**Filtering is not expressible in a path and uses the `script:` form** (§8.2). bruno-query's `[?]`
operator takes its predicate as a *second argument* to `get()` — `get(data, '..items[?]', {id: 2})`
(`packages/bruno-query/README.md`) — and a declarative path string has nowhere to put it. So
find-the-matching-element extractions are written as scripts:

```yaml
    outputs:
      partnershipId:
        script: |
          (res, ctx) => res.body.data.partnerships
            .find((p) => p.status === 'active' && p.role === 'owner')?.id
```

Returning `undefined` when nothing matches is the correct behavior, not a bug to guard: the output
is then **not produced**, and any step referencing it is skipped as `unresolved-dependency` (§11.2)
rather than proceeding with a missing id. Under the default `failOnUnresolved` that skip also fails
the run, so a filter matching nothing is reported rather than quietly skipped past — which is what
the flag exists for.

A leading `$.` is accepted and stripped, because it is what most authors will type out of habit —
`$.data.id` and `data.id` are the same path. This is an ergonomic affordance only; the canonical
form written by the app is without the prefix.

Outputs are evaluated against the response **body** by default. Other sources are addressable:

```yaml
    outputs:
      location: { from: headers, path: location }
      code:     { from: status }
```

**An output may be structured.** A path selecting an object or array, or a `script:` returning one
(§8.2), yields a value that references navigate into with ordinary dot and index syntax:

```yaml
    outputs:
      batch:
        script: |
          (res, ctx) => {
            const [, region, sequence] = res.body.data.batch.ref.split('/');
            return { region, sequence, itemCount: res.body.data.batch.items.length };
          }
```

```yaml
      region:     "{{steps.get_batch.batch.region}}"
      item_count: "{{steps.get_batch.batch.itemCount}}"
```

This is what lets a value be **derived once and consumed by several steps**. The alternative — one
output per field, each re-parsing the same response — pays a sandbox invocation per field and
duplicates the parsing rule, so the two copies drift when the format changes.

A whole-value reference to a structured output injects the object or array itself (§7.3), so
`items: "{{steps.get_batch.batch.items}}"` sends a real JSON array. `bru flow validate` treats the
output as declared and the sub-path as the run-time navigation it is: the *output* is checked
statically, its interior is not.

### 8.2 The JS escape hatch

Some values need computation — signing, decoding, deriving. An output may be a script instead of
a path:

```yaml
    outputs:
      signature:
        script: |
          (res, ctx) => hmac(res.body.nonce, ctx.env.signingSecret)
```

Scripts run in the **existing bruno-js sandbox** — QuickJS in `safe` mode, `node:vm` in `developer`
mode, honoring the collection's `securityConfig`. Flows introduce no new execution environment and
no new security posture.

**Evaluation is an injected port, not a direct call.** Each host already decides how it selects a
runtime, and the two decide it differently: `bruno-electron/src/ipc/network/index.js` derives it from
a `collection`, `bruno-cli/src/commands/run.js` from a `sandbox` option, in two separate functions
that happen to share a name. Neither is importable by the engine (§13.1). So sandbox selection
crosses the boundary as `RunScript` (§13.2), for the same reason dispatch does — the host owns how it
is done, the engine owns when.

This is what keeps "no new security posture" true rather than aspirational: the engine never chooses
a runtime, so it cannot choose a weaker one than the host would have.

#### When a script throws

Four positions run user JS — an output (above), a `when:` condition (§9.3), `shouldRetry` (§11.1) and
a `pre:` value (§8.7) — and one rule covers all four: **a throw fails the step with reason
`script-error`**
(§14.6). The message names the position and carries the thrown message, so
`outputs.partnershipId threw: Cannot read properties of undefined (reading 'find')` is the failure
rather than something two steps downstream.

This is deliberately *not* §8.1's `undefined` rule. Returning `undefined` is an answer — nothing
matched — and the flow has a designed response to it. A throw is not an answer, and every way of
treating it as one converts a bug in the flow into a quiet, wrong outcome:

- A throwing **`when:`** fails the step rather than skipping it. "This errored" is not "this was
  false", and a skip would remove the step from the run with `condition-false` as the stated reason,
  which is a false statement about why.
- A throwing **`shouldRetry`** stops retrying and fails, rather than being read as "do not retry".
  Otherwise a predicate with a typo turns a 20-attempt poll into a one-attempt failure whose reason
  says nothing about the typo.
- A throwing **output** fails the step, but **the remaining outputs are still extracted**, so the
  capture and the failure block show what the step actually got back. Diagnosing a script that threw
  needs the response it threw on.

A throw fails one step, not the run — a bad row in a dataset (§9.4) must not take the other
iterations with it, and §11.3's cleanup steps still run. Propagation from there is §11.2's ordinary
path, unchanged.

### 8.3 Built-in step metadata

Always available without declaration:

`steps.<id>.status`, `.headers.<name>`, `.duration`, `.body`, `.ok`, `.skipped`

`steps.<id>.body` gives raw access to a prior response. It is permitted — refusing it would just
push people to declare junk outputs — but it is **not a declared data path**. The distinction is
load-bearing:

> Declared outputs are drawn as edges in the graph and statically validated.
> Raw `.body` access resolves at run time and is reported by `bru flow validate` as an
> **undeclared dependency** warning.

This keeps the "make data paths explicit" goal enforceable by tooling rather than by convention,
without making the escape hatch unavailable.

### 8.4 Visibility rule

**A step may only reference outputs of its transitive ancestors, or its own.**

A step's **assertions** may also reference its own declared outputs (§10.2), since extraction
precedes assertion — that is how a flow requires an extraction to have succeeded. Everywhere else,
referencing a step that is not a proven ancestor is a validation error, not a runtime race. Under
parallel execution there is no ordering guarantee between sibling branches, so a reference across
branches is a bug every time — it must be caught statically. This rule is what makes the DAG safe
to parallelize.

When a value genuinely has to cross branches — a join reading whichever branch produced it — the
sanctioned channel is a **shared slot** (§9.1), which carries its own descend-from-every-writer
rule so the read stays statically ordered. What is never allowed is naming a sibling's step id.

### 8.5 Reusable connectors

Declaring `token: data.access_token` in every flow that calls `login` is the duplication problem
of §1 reappearing one layer down: when the API renames that field, every flow has to be edited
individually. Requests avoid this because §7.1 seeds them from the spec; extractions had no
equivalent shared source.

A **connector file** supplies an operation's default outputs once:

```yaml
# flows/connectors.yml
version: 1

apis:
  auth-api: ../../apispec/auth-v2.yml
  payments-api: ../../apispec/payments-v3.yml

connectors:
  auth-api#login:
    token:  data.access_token
    userId: data.user.id

  payments-api#createPayment:
    paymentId: data.id
    state:     data.state
```

A step targeting a covered operation gets those outputs with no `outputs:` block at all:

```yaml
  - id: create_payment
    operation: payments-api#createPayment
    # steps.create_payment.paymentId and .state are available
```

**Matching is by resolved spec identity, not by alias string.** The connector file declares its
own `apis:` bindings, and an entry applies to any step whose operation resolves to the same
document and `operationId` — whatever local alias that flow happens to use. Aliases are
flow-local, so keying on them literally would silently miss flows that named the same spec
differently.

**Resolution order**, later overriding earlier: workspace connector file → collection connector
file → the step's own `outputs:`. A step's block **extends** what it inherits; same-named entries
override, and **`!...` suppresses an inherited one** — the same removal tag as §7.2, for the same
reason. `null` keeps its ordinary meaning everywhere in the format; one token with two meanings in
one file is what §7.2 introduced the tag to avoid, and that argument does not weaken one section
later just because a `null` output path happens to be useless.

```yaml
  - id: create_payment
    operation: payments-api#createPayment
    outputs:
      state: !...                  # drop the inherited connector entry
      paymentId: data.payment.id   # override it
```

Connector-supplied outputs are declarations like any other: they satisfy §8.4's visibility rule,
are drawn as graph edges, and their paths are checked against the operation's response schema by
`bru flow validate`.

**The cost is locality.** A step's available outputs are no longer visible by reading the step,
which cuts against §8's premise that data paths are explicit. That is why `bru flow validate` and
`--dry-run` both print each step's *resolved* outputs and where each was declared — the
information stays discoverable even though it is no longer inline.

### 8.6 A script library

§8.2's escape hatch is per-position by design, and the same helper written into three flows is §1's
duplication problem in JavaScript rather than in YAML. A flow may declare **functions** once and call
them from every position that runs a script — an output, a `when:` script, `shouldRetry`:

```yaml
functions:
  use:
    - ../shared/functions.yml     # a library document
    - ./lib/text.js               # raw source

  lastFour: |
    (value) => String(value).slice(-4)

steps:
  - id: charge
    operation: payments-api#createPayment
    outputs:
      tail:
        script: |
          (res) => lastFour(res.body.card)
```

**A function is in scope by its name.** The library is composed into the same program the call site
is evaluated in, so nothing is imported, injected as an argument or reached through an object — which
is what lets one mechanism serve all three positions without any of them changing shape. `use:` is
reserved inside the block; everything else is a function.

**`use:` is explicit, and nothing is picked up implicitly.** §8.5's connector files are discovered by
convention, and the cost it names — *a step's available outputs are no longer visible by reading the
step* — is worse here: an output resolved from a file you did not know about is a value with a
provenance, while a *function* resolved from one is arbitrary code. What a flow's scripts can call is
readable from the flow.

A `use:` entry is a **library document** — a `functions:` block of its own, which may `use:` further
files — or **raw source**, by extension: `.yml`/`.yaml` is the first, anything else is the second. A
library file is the case where a dozen helpers live in one place in the language they are written in;
naming each one in YAML to reach it would be the duplication this removes.

**Order is `use:` first, depth-first, then the flow's own definitions, and the last word on a name
wins.** A flow overrides a helper its library declares the way a step's `outputs:` overrides an
inherited connector (§8.5). A file already included is skipped rather than read twice, so two
libraries that include each other are a diamond rather than an error.

**A library does not cross a sub-flow boundary.** A `uses:` flow gets its own, from its own file
(§12.2's isolation). A helper resolving inside a sub-flow because its *caller* declared it would make
the sub-flow's behaviour depend on who called it — the property §12 exists to prevent.

**`bru flow validate` lists what resolved, and where each came from.** §8.5 pays the same cost one
layer along and answers it the same way — *a step's available outputs are no longer visible by
reading the step* — and a library is the sharper case: an output resolved from a file you did not
know about is a value, a *function* resolved from one is arbitrary code. A name appears once,
carrying the declaration that won; a raw source file is listed as the file it is, because nothing in
the toolchain parses JavaScript to find out what it declares.

**It also resolves the files and checks the names**, because a library reaches every
script in the flow: an unreadable file or a name that is not a JavaScript identifier is one broken
prelude and *every* script position failing at once, with `script-error` naming whichever step
happened to run first. A name that shadows what §8.2 hands a script — `res`, `ctx` — is a warning:
legal, occasionally meant, never meant twice.

**No host changes, deliberately.** §13.2's `RunScript` receives an expression that evaluates to a
function; the engine composes the library into that expression rather than adding a port argument or
an injected global. A mechanism a host had to cooperate with would be one that behaved differently in
`bru` than in the app, and §8.2's "no new execution environment" would stop being true — the sandbox,
its mode and the collection's `securityConfig` are exactly as they were.

### 8.7 Values computed before the request

§8.2's positions all run **after** a response, or decide whether to send at all. Nothing computes a
value the request itself needs — a signature over the body, a timestamp, a nonce derived from an
earlier step — and the workaround is a step that exists only to produce one, which sends a request
nobody wanted in order to run three lines of JavaScript.

A step may declare **`pre:`**, a mapping of name to script, evaluated before its request is built:

```yaml
steps:
  - id: charge
    operation: payments-api#createPayment
    pre:
      timestamp: |
        () => String(Date.now())
      signature: |
        (ctx) => hmac(`${ctx.steps.auth.token}:${ctx.vars.nonce}`, ctx.env.signingSecret)
    headers:
      X-Timestamp: "{{pre.timestamp}}"
      X-Signature: "{{pre.signature}}"
```

**It is `outputs:` one stage earlier, deliberately.** The same mapping shape, the same one-value-per-
name rule, the same `undefined`-means-not-set rule (§8.1) — so there is one thing to learn rather
than two. What it does not have is `path:`: there is no response to select from, which is the whole
reason the position exists.

**The script is handed `(ctx)` and no `res`**, exactly as a `when:` script is (§9.3) and for the same
reason — it runs before the request, so there is no response for it to address. §8.6's library is in
scope by name, with no change to how it is composed.

**`pre.*` is step-local, and that is the point.** A step reads what it computed as `{{pre.signature}}`
while its request is being built, and no other step can address it at all. The alternative —
publishing into `steps.<id>.*` beside the outputs — was rejected: it makes one reference mean two
things, since `{{steps.charge.x}}` would name a value computed before the request or extracted after
it with nothing at the call site to say which, and it forces `pre:` and `outputs:` to share a
namespace they would then have to be forbidden from colliding in.

Being step-local is also what keeps this position honest about what it is. A value computed to build
*this* request is a detail of building it. A value other steps depend on is a declared output, and
§8.1 already has a word for that.

#### Leaving the step

A `pre` value becomes an output by saying so, through a fourth **`from:`** source alongside `body`,
`headers` and `status` (§8.1):

```yaml
    pre:
      correlationId: |
        () => crypto.randomUUID()

    outputs:
      correlationId: { from: pre }                  # same name
      traceId:       { from: pre, path: correlationId }   # under another

    shared: [correlationId]                         # §9.1, unchanged
```

`path:` names which `pre` value to take and defaults to the output's own name, so the ordinary case
is one line. Nothing else about `outputs:` changes, and **`shared:` does not change at all** — it
publishes an output to a slot, as it always did, so there is exactly one route out of a step and one
place to read what leaves it.

**The string form is a path, not an interpolation**, which is why this needs a `from:` at all.
`outputs: { correlationId: "{{pre.correlationId}}" }` would be read as a JSONPath into the response
body, select nothing, and leave the output unset by §8.1's rule — silently, because selecting nothing
is an ordinary answer. `bru flow validate` reports a `{{...}}` in an output path as a warning for that
reason.

**A `from: pre` output is extracted where every other output is** — after the response, alongside the
rest. So a step whose request never dispatched produces no outputs at all, `from: pre` included, even
though the value itself was computed before the attempt. One rule for when outputs exist is worth
more than a value that survives a transport error, and §11.3's cleanup steps have `shared:` and their
own `pre:` for what they need.

**No script position writes anything.** §8.7's scripts return a value and that is all they do; there
is no `bru.setVar` equivalent, in this position or any of §8.2's. What a step publishes is named in
the file and routed by it, so the graph's data edges (§5.3) stay a claim the file supports — a script
that could write a slot would make them one it could not.

#### Where it sits in the step

```
depends gate  ->  when:  ->  pre:  ->  materialize  ->  validate request  ->  dispatch
                                                                            ->  outputs:  ->  assert:
```

**`when:` runs first, so a skipped step computes nothing.** A condition is the cheaper question and
the one that can make the rest unnecessary; running a signature for a step that is about to be
skipped `condition-false` is work with nowhere to go. The consequence is stated rather than hidden: a
`when:` condition **cannot** read a `pre` value, because it ran before them.

**It runs once per step, not once per attempt** (§11.1's retries), because materialization is once
per step. A retried step therefore re-sends the values its first attempt computed. For a timestamp or
a nonce that is the wrong answer, and the honest workaround today is `maxAttempts: 1` on a step whose
signature must be fresh — moving materialization inside the attempt loop is the change that would fix
it, and it changes request-building for every step rather than for these.

A dataset run (§9.4) is unaffected by that: each iteration executes the step, so each iteration
computes its own values.

**A throw fails the step with `script-error`**, §8.2's rule for every script position, and the message
names the position — `pre.signature threw: ...`. The remaining `pre:` scripts do **not** run, which
is where this differs from `outputs:`. An output that throws still lets its siblings extract, because
diagnosing it needs the response the step actually got; a `pre:` script that throws means no request
is built at all, so there is nothing the siblings' values could be for.

**Nothing is captured.** §14.5 records the request and the response; `outputs:` are not written to a
capture and neither are these, so the feature adds no new place for a computed secret to be stored.
A value that reaches the wire does so as a request header, where §14.4's denylist already masks it.

**A `uses:` step may declare `pre:` too.** Its values are in scope as `{{pre.*}}` while the sub-flow's
`with:` arguments are resolved, so a computed value can be passed in. §12.2's isolation is untouched
and is in fact sharper for it: the sub-flow sees the arguments it was given, and `pre.*` inside it
means its own steps' computed values, never the caller's.

---

## 9. Control flow

### 9.1 Dependencies

**A step with no `depends` depends on the step immediately above it.** A plain list of steps is
therefore a plain sequence, read top to bottom, and an author who never writes `depends` never has
to think about the graph.

Parallelism is opt-in via explicit `depends`:

```yaml
steps:
  - id: login                              # root
  - id: create_payment                     # implicitly after login
  - id: fetch_profile
    depends: [login]                       # explicit -> parallel with create_payment
  - id: reconcile
    depends: [create_payment, fetch_profile]
```

The first step in `steps:` is the root. `depends: []` declares an additional root explicitly.
Cycles are a validation error.

**A dependency carries a status condition.** The shorthand above means "runs when these parents
succeeded"; the expanded form states the accepted outcomes:

```yaml
  - id: delete_payment
    depends:
      - on: create_payment
        status: [success, failed, cancelled]
```

| Status | Meaning |
|---|---|
| `success` | The parent ran and its status check, schema validation and assertions all passed (§10). **The default.** |
| `failed` | The parent ran and something failed, or it exhausted its retries. |
| `skipped` | The parent did not run — its own `when` was false, or its dependencies were unmet. |
| `cancelled` | The run was aborted (Ctrl-C, CI timeout) before the parent completed. |

A step whose dependencies are not satisfied is **skipped** with reason `unmet-dependency`; it is not
a failure, and it does not by itself fail the flow.

**Join mode.** `depends` accepts either a bare list — implicitly `all` — or a mapping carrying
exactly one of `all:` or `any:`:

```yaml
  - id: reconcile
    depends: [create_payment, fetch_profile]    # all — the shorthand, unchanged

  - id: send_receipt
    depends:
      any:                                       # satisfied if at least one is
        - on: primary_charge
        - on: fallback_charge
```

`any` **waits for every listed parent to reach a terminal outcome**, then requires at least one to
be satisfied. It does not fire on the first success — doing so would make it a race whether the
remaining parents had run, and the same flow would behave differently between runs.

This single mechanism replaces four things a separate design would need:

**Reaching past a failed parent.** Depend on a step further up the branch, and an intervening
failure becomes irrelevant:

```yaml
  - id: create_payment
  - id: verify              # implicitly depends on create_payment
  - id: audit_log
    depends: [create_payment]   # runs even if `verify` failed or was skipped
```

**Cleanup without a teardown phase.** A step that accepts `failed` and `cancelled` runs whether or
not the work it cleans up succeeded — which is what a dedicated always-run phase used to provide:

```yaml
  - id: create_payment
  - id: settle
  - id: verify_ledger

  - id: delete_payment
    depends:
      - on: verify_ledger                          # the LAST step to touch the payment
        status: [success, failed, skipped, cancelled]
    failOnUnresolved: false                           # nothing to delete is a valid outcome — §11.2
    operation: payments-api#deletePayment
    pathParams:
      id: "{{steps.create_payment.paymentId}}"
```

> **A cleanup step depends on the last step that touches the resource, not on the step that
> created it.** The instinct is to write `depends: [create_payment]` — clean up what you made — and
> it is a race. That step becomes eligible the moment `create_payment` finishes, so under any
> `concurrency` above 1 it runs *beside* `settle` and `verify_ledger` and may delete the resource
> out from under them. Intermittently, and only on a loaded machine.

The status list is the four-way `[success, failed, skipped, cancelled]` because the question being
asked is "has the work finished, however it went?" — `skipped` included, or cleanup is itself
skipped whenever the step before it was. Naming the resource's creator in `pathParams` is what ties
the cleanup to the right thing; naming it in `depends` only says when to start.

**Fallback branches.** A step that runs only when its predecessor failed, rejoined with `any`:

```yaml
  - id: primary_charge
    operation: payments-api#charge

  - id: fallback_charge
    depends: [{ on: primary_charge, status: [failed] }]
    operation: payments-api#chargeViaBackup

  - id: send_receipt
    depends:
      any:
        - on: primary_charge
        - on: fallback_charge
```

Under `all` this cannot be written naturally. `depends: [primary_charge, fallback_charge]` never
runs: if the primary succeeds the fallback is *skipped* and fails the join; if the primary fails it
fails the join itself. The only `all` formulation that works enumerates the skip state of the branch
that was not taken — correct, but it reads like nothing and the obvious version is silently broken.

**Explicit skip propagation.** Because the default status set is `[success]`, a failed or skipped
parent stops its dependents by default — but that is now a *declared* rule the author can see and
override, not an implicit cascade.

#### Scheduling is not value selection

`any` decides **whether a step runs**. It does not decide **which branch's values it reads**. A
joining step that interpolates `{{steps.primary_charge.chargeId}}` is skipped as
`unresolved-dependency` (§11.2) on any run where the primary was skipped — and under the default
`failOnUnresolved` that skip fails the run, so the naive formulation goes red on exactly the runs
the fallback was written for. A join over branches that produce *the same logical value by different
routes* needs a place for that value to land that does not name the branch it came from.

**A shared slot is that place.** The flow declares the slot, each branch publishes one of its own
outputs into it, and the joining step reads the slot:

```yaml
shared: [chargeId]

steps:
  - id: primary_charge
    operation: payments-api#charge
    outputs:
      chargeId: data.id
    shared: [chargeId]                 # publish this output to the slot of the same name

  - id: fallback_charge
    depends: [{ on: primary_charge, status: [failed] }]
    operation: payments-api#chargeViaBackup
    outputs:
      backupChargeId: data.charge.id
    shared:
      chargeId: backupChargeId         # slot: the local output that feeds it

  - id: send_receipt
    depends:
      any:
        - on: primary_charge
        - on: fallback_charge
    body:
      charge_id: "{{shared.chargeId}}"
```

A step's `shared:` entry names one of **its own declared outputs** (§8.1, including
connector-supplied ones — §8.5), not a second extraction path. The slot is a promotion of a value
that is already named and already validated, so the graph keeps one extraction per data path.
`shared: [chargeId]` is shorthand for `chargeId: chargeId`.

**Reading a slot requires descending from every writer.** A step may reference `{{shared.x}}` only
if it is a transitive descendant of every step declaring `x` in its `shared:` block. This is §8.4's
visibility rule adapted to slots, and it does the same job: it guarantees every writer has reached a
terminal outcome before the read happens, so a read is never a race against a branch still in
flight. Violations are validation errors, not runtime surprises.

**A slot whose writers are alternatives asks for less, and says so.** The rule above is written for a
*join*: several branches may run, and the reader sits below all of them. The other shape is branches
that exclude each other — one produces the value and the steps after it *on that same branch* consume
it — where no reader can descend from every writer, because only one writer ever runs. A slot declares
which it is:

```yaml
shared:
  chargeId:      { writers: all }   # the join above — and the default
  sessionToken:  { writers: any }   # alternatives: descend from one writer, not all
```

`shared: [chargeId]` remains the list form and means `writers: all`, so every existing flow keeps its
meaning. Under `any` a reader must still descend from *a* writer — a read with none above it is
reading nothing — and a slot no step writes stays legal under both, resolving empty as below.

**`any` is declared, not inferred.** Whether two branches truly exclude each other depends on `when:`,
which is a runtime predicate, so the validator cannot prove it and does not try. The cost is stated
plainly: under `any` a reader below one writer while another is still in flight is a race the author
has taken responsibility for. `all` stays the default so nobody acquires that by accident.

**The auth token is why this matters at the scale flows are written.** A flow that can reach its API
by more than one route — seeded or signed up, cached credential or fresh login — produces its session
token on either branch and then needs it on *every* request after that. Expressed as a slot with
`writers: any` and read from an `authProfiles:` entry bound to the api (§6.4), that is four lines in
the file and nothing at all in the steps:

```yaml
shared:
  sessionToken: { writers: any }

authProfiles:
  session:
    mode: apikey
    key: Authorization
    value: "Token {{shared.sessionToken}}"
    placement: header

apis:
  backend:
    source: ./openapi.yml
    auth: session                     # every step on this binding, unless it says `auth: none`
```

Each producing step adds `shared: [sessionToken]` beside the output it already declares. No step names
a header, and a step that must go out unauthenticated — the probe, the login itself — says `auth:
none`, which is the same opt-out it would need anyway. §8.4's visibility sweep covers a profile's
fields and a binding's `defaultHeaders` exactly as it covers a body, so the credential is a data
dependency like any other: validated, and drawn as an edge (002 §5.3).

**Last writer in declaration order wins.** When more than one writer ran and produced a value, the
slot holds the one whose step appears last in `steps:`. The join barrier orders the writes against
the *read*, but not against *each other* — two branches running concurrently finish in whatever
order the network returns, so resolving by completion time would make the same flow produce
different values on a loaded CI machine than on a laptop. File order is stable, inspectable, and
costs nothing in the case that motivates the feature: mutually exclusive branches produce exactly
one write, so there is nothing to order.

A writer that was skipped, or that ran but produced no value (§11.2 — a failure with no response),
does not write. **A slot no branch wrote resolves empty** — see §11.2 for why that is empty rather
than a skip.

### 9.2 Concurrency

Ready steps execute up to `config.concurrency` (default **5**) in flight, overridable with
`--concurrency`. `concurrency: 1` forces fully serial execution regardless of the graph, which is
the recommended setting when debugging.

**`concurrency` is a single run-wide budget.** Parallel steps, sub-flow internals (§12.4) and
dataset iterations (§9.4) all draw from the same pool, so total in-flight requests never exceed it
however deeply the flow nests. One number bounds what a run does to a test environment, and it does
not multiply out of sight.

**What draws from the pool is a request, not a container.** A `uses:` step and a dataset iteration
hold no slot of their own while the work inside them runs — only the steps that dispatch do. A
container that held one too would deadlock a sub-flow at `concurrency: 1`: the container would take
the only slot and its first internal step could never acquire one, which is the setting recommended
for debugging one sentence above.

### 9.3 Conditions

`when:` uses **the same expression dialect as `assert`** (§10.2) — `<expr> <op> <value>`, compiled
to the triple `AssertRuntime` already consumes. There is no separate condition language to learn,
and the same static checks apply to both.

```yaml
  - id: refund
    depends: [create_payment]
    when: steps.create_payment.status eq 201
```

A **list means implicit AND**, exactly as a list of assertions does:

```yaml
    when:
      - steps.fetch_profile.tier eq premium
      - steps.create_payment.amount gt 100
```

For disjunction or genuine computation, a `script:` form mirrors the one `outputs` accepts (§8.2)
and runs in the same bruno-js sandbox:

```yaml
    when:
      script: |
        (ctx) => ctx.steps.primary.ok || ctx.steps.fallback.ok
```

A condition script that **throws** fails the step with `script-error` rather than skipping it — §8.2
has the rule and why a skip would be a false statement about what happened.

The dialect is shared with `assert`, and so is most of the context — including §10.2's rule for how
a bare operand resolves, so `when: steps.fetch_profile.tier eq premium` compares against the string
`premium` and `when: row.canCreate eq true` against the boolean. Both address `steps.*`, `row.*`,
`params.*`, `shared.*`, `flow.*`, and bare variables. The difference is one-directional: an
assertion additionally sees `res.*` and `req.*`, because it is evaluated against a response. A
condition is evaluated before the request is built, so there is no response for it to address —
which is the whole reason the two are separate constructs rather than one.

A step whose `when` is false is **skipped, not failed** — the flow's exit status is unaffected.

`when` and `depends` answer different questions and are evaluated in that order:

1. **`depends` decides whether the step is eligible at all**, from its parents' outcomes (§9.1).
   Unsatisfied → skipped as `unmet-dependency`, and `when` is never evaluated.
2. **`when` decides whether an eligible step should run**, from flow state. False → skipped as
   `condition-false`.

So propagation past a skipped or failed parent is controlled by `depends`, not by `when`. A step
that should survive its parent being skipped declares `status: [success, skipped]`, or depends on
something further up the branch.

### 9.4 Dataset iteration

`dataset` takes either a path shorthand or a mapping:

```yaml
dataset: ./fixtures/customers.csv       # shorthand
```

```yaml
dataset:
  source: ./fixtures/customers.csv      # required
  parallel: 3                           # concurrent iterations; default 1
```

The whole flow runs once per row, with the row available as `{{row.<column>}}` and the zero-based
index as `{{flow.iteration}}`. **CSV, JSON and YAML are supported** — the same three formats and the
same loader as `!file` (§7.4). A JSON dataset is an array of objects and a YAML dataset a sequence
of mappings; excluding YAML from the one and not the other would be a difference authors discover
by hitting an error that has no reason behind it.

#### Row values are typed

A dataset is compared against, not just interpolated — `when: row.canCreate eq true` has to know
whether the cell holds a boolean or the string `"true"` — and JSON and YAML carry types natively
while CSV does not.

**A CSV cell is resolved by §10.2's rule for a bare operand**, unchanged: `true`, `false`, `null`
and `undefined` become those values, a numeric cell becomes a number, a quoted cell becomes a
string, and anything else is a string. One typing rule serves the whole format, so a flow behaves
identically whichever of the three files its rows came from — which matters most when a dataset is
converted from one to another and nothing else in the flow is touched.

```
canCreate,tier,zip,note
true,premium,02134,"007"
```

```
row.canCreate -> true       (boolean)
row.tier      -> "premium"  (string)
row.zip       -> 2134       (number — leading zeros are not preserved)
row.note      -> "007"      (quoted, so a string)
```

**Quoting is how a value stays a string**, which is the escape hatch for the `zip` case above and
worth knowing before a postcode column silently loses a digit. It is a real cost of inference, taken
because the alternative — every CSV column a string — makes a boolean or numeric column compare
wrongly against the flow that was authored against a JSON dataset's real types.

Iterations are **sequential by default** (`parallel: 1`), since they typically contend for the same
backend state. Concurrent iterations draw from the **same run-wide `concurrency` budget** as
everything else (§9.2) — `parallel: 3` with `concurrency: 5` means three iterations competing for
five slots, not fifteen requests in flight.

**Each iteration gets its own set of `shared:` slots** (§9.1) and its own **cookie jar** (§7.6), as
it does its own `steps.*` state.
Concurrent iterations run the same writers against different rows, so a single shared set would have
them overwrite each other and the last row to finish would decide every iteration's value.

A failing iteration does not halt the others; the run reports per-iteration results and fails
overall if any iteration failed.

---

## 10. Assertions and schema validation

### 10.1 Automatic validation

Three checks run on every step without anyone writing an assertion. All default to on, and all are
overridable per step and per flow.

They are **evaluated** in the order request validation → status code → response schema, then the
explicit assertions of §10.2. Request validation comes first because it runs before dispatch and
the other two need a response. That order is what §14.6's first-failure rule refers to; the
subsections below are ordered for reading, not for execution.

**Status code.** A response with status **>= 400 fails the step**, with reason `unexpected-status`.
This is `failOnStatusCode`, default `true`, settable per step and as `config.failOnStatusCode`.

The default has to be this way round because the alternative fails open: a step with no assertions
that receives a 500 would be recorded as a *success*, and the run would report the outage as a
passing test of it. A testing tool that stays silent when the API returns nothing but errors is
worse than no tool. Whatever a step forgot to assert, it never forgot that a 500 is not what it
wanted.

`failOnUnresolved` (§11.2) catches the *downstream* half of the same outage — the steps that skip
because the failed call produced no outputs. The two are independent guards on one failure mode, and
this one is the load-bearing half: it names the step that actually broke, rather than the steps that
could not proceed because of it.

A step that *wants* an error status opts out explicitly — see §10.3.

**Request schema.** The materialized request is validated against the operation's `requestBody`
schema **before it is dispatched**. This is `validateRequest`, default `true`, settable per step and
as `config.validateRequest`. A failure fails the step with reason `invalid-request`, and **no request
is sent** — there is nothing to learn from a call the flow already knows is malformed.

This is what closes the loop on §7.3's typed interpolation. A body that sends `"12"` where the schema
declares an integer is otherwise rejected by the server in its own terms — a 400 describing the API's
internals rather than the flow's mistake — and `--dry-run` would print a request that looks right.
Validating locally names the field and the flow.

Not applicable, and skipped, when the operation declares no `requestBody` schema, for `format:
binary` parts, and for raw binary bodies (§7.5), none of which have anything checkable.

**A deliberately malformed request must opt out.** A negative test sending a bad payload to check the
API rejects it is a legitimate and common shape, and this check would block it before dispatch —
`validateRequest: false` on that step is how it gets sent (§10.3).

**Response schema.** Every response is validated against the spec's response schema for the
**actual** status code returned. This is on by default (`config.validateSchema: true`) and is the
main reason to reference a spec rather than copy a request: contract drift is caught without anyone
writing an assertion.

- A validation failure fails the step.
- If the spec defines **no** schema for the returned status, validation is **not applicable** and
  passes. Setting `config.strictSchema: true` turns that case into a failure instead — useful for
  catching undocumented status codes, off by default because most real specs are incomplete.
- Validation uses **ajv 8**, already a dependency of both `bruno-filestore` and `bruno-js`.
- Disable per step with `validateSchema: false`.

### 10.2 Explicit assertions

Business-logic checks on top of the schema. These reuse Bruno's existing assertion operators and its
operand rule — flows do not introduce a second assertion dialect, with
the single exception of reserved-root references, specified below.

```yaml
    assert:
      - res.status eq 201
      - res.body.data.amount eq 9900
      - res.body.data.state in ["pending", "settled"]
      - res.headers.location isDefined
```

The shorthand `<expr> <op> <value>` compiles to the `(expr, operator, value)` triple that
`AssertRuntime` already consumes. The expanded mapping form is also accepted for values that are
awkward inline:

```yaml
    assert:
      - expr: res.body.data.description
        op: contains
        value: "a string, with a comma"
```

`==` is accepted as an alias for `eq` and `!=` for `neq`.

#### How a bare operand resolves

The right-hand side of an assertion mixes literals (`eq settled`) with references (`eq row.role`),
and the rule separating them has to be decidable by reading the line — a reader who has to know
which variables exist cannot tell what `res.body.x eq status` compares against.

**Bruno's existing rule holds, with one addition.** `AssertRuntime` resolves an unquoted operand
through `evaluateJsTemplateLiteral` (`packages/bruno-js/src/utils.js:65`): `true`, `false`, `null`
and `undefined` become those values, a numeric operand becomes a number, a quoted operand becomes a
string, and **anything else is a string**. Flows keep that unchanged, and add: **an unquoted operand
whose first dot-segment is a reserved root resolves as a reference.**

The reserved roots are `res`, `req`, `steps`, `row`, `params`, `shared` and `flow` — §7.3's
namespaces, which are already illegal as variable names. That is what makes the rule decidable
without a symbol table: the seven roots are fixed, so a reader classifies an operand by looking at
its first segment and nothing else.

```yaml
    assert:
      - res.body.data.state eq settled          # "settled"  — a string
      - res.status eq 201                       # 201        — a number
      - res.body.data.active eq true            # true       — a boolean
      - res.body.data.role eq row.role          # a reference — `row` is a reserved root
      - res.body.data.tier eq status            # "status"   — a string, not a variable
      - res.body.data.tier eq {{status}}        # the variable — unchanged from today
```

`{{...}}` continues to work in every operand position, so a variable is always reachable and the
distinction never traps an author — it only means the short form is reserved for the namespaces.
The same resolution governs `when:` (§9.3), which is one operand rule for the whole format rather
than one per clause.

Left-hand sides are unaffected: they have always been expressions and are evaluated as such.

**An assertion addresses flow state as well as the response** — `steps.*`, `row.*`, `params.*`,
`shared.*`, `flow.*`, and bare variables, alongside `res.*` and `req.*`:

```yaml
    assert:
      - res.body.data.role eq row.role                      # expected value varies per dataset row
      - res.body.data.id eq steps.add_product.productId     # cross-checks a value sent earlier
```

Without this, a data-driven flow can only assert what is identical across every row, which is
exactly the assertion worth least. Branching on the row does not substitute: `when:` is step-level,
so it gates the whole request rather than one expectation, and it cannot express "this field equals
*this row's* value" for more than two rows without a step per row.

§8.4's visibility rule applies, with one addition: **a step's assertions may reference that step's
own outputs.** Outputs are extracted before assertions are evaluated — which §11.2 already requires,
since outputs must survive a failed assertion — so by the time an assertion runs, the step's own
extractions are available:

```yaml
  - id: partnerships
    operation: user-api#listPartnerships
    outputs:
      partnershipId:
        script: |
          (res, ctx) => res.body.data.partnerships
            .find((p) => p.status === 'active' && p.role === 'owner')?.id
    assert:
      - steps.partnerships.partnershipId isDefined
```

**This is the right way to require an extraction to succeed.** An extraction that finds nothing is
otherwise a *quiet* outcome — the output is not produced, consumers skip, and the run reports on the
consequence rather than the cause. Asserting the located value states the requirement where it
belongs: the step that did the locating fails, and it names the reason.

The alternative — re-deriving the value in the assertion — duplicates the `find` and lets the two
copies drift, which is the same argument that made structured outputs preferable to one script per
field (§8.1).

Self-reference is limited to a step's own declared outputs. `steps.<other>.…` still requires an
ancestor, and a step cannot reference its own built-in metadata (§8.3) in this way, since `.status`
and `.duration` are not settled until the step finishes.

**Latency is asserted through the response, not through step metadata.** `res.responseTime` is
already part of Bruno's response object (`packages/bruno-js/src/bruno-response.js:12`) and is
available to assertions like any other `res.*` field:

```yaml
    assert:
      - res.responseTime lt 500
```

That is the SLA check the metadata restriction above might otherwise appear to rule out. The two
differ meaningfully: `res.responseTime` is one request, while `steps.<id>.duration` covers the whole
step including every retry and delay — so a downstream step asserting on `.duration` is measuring
something else, and usually not what an SLA means.

This costs nothing to implement. `AssertRuntime` already evaluates against a context object built
by spreading every variable scope over `bru`/`req`/`res`
(`packages/bruno-js/src/runtime/assert-runtime.js:443-453`); flow namespaces are additional keys on
that object, not a second evaluation path.

#### What the engine reuses, and what it restates

The **dialect** is Bruno's and is reused literally: the operand rule above is
`evaluateJsTemplateLiteral`, and a left-hand side is `evaluateJsExpression`, both imported from
`packages/bruno-js/src/utils.js`. What the engine does **not** reuse is `AssertRuntime` itself. That
module loads the QuickJS sandbox at import time — a runtime §8.2 makes the *host's* to select, and
one the engine must not pull in — and it is built around a Bruno request/response pair and emits
test results rather than the `AssertionResult` triple §13.2 reports. So the operator table is
restated in `expression.ts`.

That restatement is the one place a second dialect could drift into existence, and the guard against
it is 001-C's R4c2: it asserts the operand rule directly rather than through a flow that happens to
exercise it, so an operator behaving differently here than in a `.bru` test shows up as a failure
rather than as a surprise years later.

### 10.3 Negative tests

An error status fails a step by default (§10.1), so a test that *expects* one says so in two parts —
it **allows** the error, and it **asserts** the specific error it wanted:

```yaml
  - id: add_product_denied
    operation: shop-api#addProduct
    auth: viewer-token
    failOnStatusCode: false          # allow a non-2xx
    assert:
      - res.status eq 403            # and require this exact one
```

A viewer correctly denied gives 403, the assertion passes, and the step is `success` — the run is
green. A viewer who *can* create a product gives 201, the assertion fails, and the step is `failed`
— the run is red and names the step. Pass on the expected failure, fail otherwise.

**Both halves are required.** `failOnStatusCode: false` alone allows *any* status, so a step
carrying it and no status assertion passes on a 500 as readily as on the 403 it meant. That is the
fail-open default of §10.1 reintroduced one step at a time, and `bru flow validate` warns on exactly
that shape (§14.3). The assertion alone is not enough either — without the opt-out the step fails on
the 403 before its assertions are consulted.

Three things follow, and each is load-bearing:

**Retry must not fire on an assertion failure by default** (§11.1). A negative test that
unexpectedly succeeds has failing assertions; retrying it repeats the request that just proved the
bug, so a flow-level `config.retry` would turn one leaked resource into `maxAttempts` of them.

**A malformed-payload test needs `validateRequest: false`.** Checking that an API rejects a bad body
means sending one, and §10.1 validates the request before dispatch — so without the opt-out the step
fails locally and the endpoint is never exercised:

```yaml
  - id: reject_negative_amount
    operation: billing-api#createInvoice
    validateRequest: false           # the payload is bad on purpose
    failOnStatusCode: false
    body:
      amount: -100
    assert:
      - res.status eq 400
```

**Error responses want schemas.** Automatic validation (§10.1) checks the response against the
schema for the status actually returned, so a documented `403` body is contract-checked like any
other. Under `config.strictSchema: true` an *undocumented* error status fails the step, which would
break a deliberate negative test against an incompletely specified API — document the error
response, or set `validateSchema: false` on that step.

**Declare outputs on a negative step anyway.** When it unexpectedly succeeds it has created
something real, and a cleanup step can only reach that resource through a declared output. A
negative test with no `outputs:` leaks precisely when it finds a bug.

---

## 11. Failure semantics

### 11.1 Retry

Retry is evaluated **after** the status check, schema validation and assertions (§10), so the
predicate sees the full outcome rather than just the response. This makes polling a first-class
pattern: retry until the response says what you are waiting for.

```yaml
    retry:
      maxAttempts: 10
      delay: 2000
      backoff: exponential        # fixed | exponential; default fixed
      maxDelay: 30000             # ms, caps one delay; default 30000
      jitter: none                # none | full; default none
      shouldRetry: |
        (res, attempt, ctx) => res.body.state === 'pending'
```

**The delay sequence.** `delay` is the base and the wait *before* each retry, so a step with
`maxAttempts: n` waits `n - 1` times. With `backoff: fixed` every wait is `delay`. With
`backoff: exponential` the wait before attempt `n + 1` is:

```
min(delay * 2 ** (n - 1), maxDelay)
```

`delay: 1000, maxAttempts: 6, backoff: exponential` therefore sleeps `1000, 2000, 4000, 8000,
16000`; with `maxDelay: 5000` it sleeps `1000, 2000, 4000, 5000, 5000`.

The multiplier is fixed at 2 rather than authorable. A configurable factor is a third knob on a
block most flows leave alone, and a non-integer one produces fractional milliseconds that have to be
rounded somewhere — a rule to specify and test in exchange for matching a backoff an API documented
but does not enforce.

**`maxDelay` defaults to 30 s and always applies**, including to `backoff: fixed`, where it only
ever bites on a `delay` that was already longer than it. Without a cap, `delay: 5000` with
`maxAttempts: 12` schedules a final wait of nearly three hours — a flow that looks like a poll and
behaves like a hang. `maxDuration` (below) bounds the step as a whole; `maxDelay` stops one wait
from being absurd on its own.

**Jitter is off by default.** `jitter: full` replaces each wait with a uniform random value in
`[0, computed]`, which is what avoids a thundering herd when concurrent iterations (§9.4) poll the
same endpoint on the same schedule. It is opt-in because the delay sequence is otherwise exactly
reproducible, and a conformance run asserts the values passed to `Clock.sleep` and not merely the
count — a test runner whose own timing is unpredictable by default cannot be used to find a timing
bug. Nothing in the engine samples randomness unless a step asks for it.

`shouldRetry` receives the response, the 1-based attempt number, and a context carrying
`ctx.env`, `ctx.steps`, and `ctx.failures` (the assertion/schema failures from this attempt). It
returns `true` to retry.

**With no `shouldRetry`, retry fires only on a transport error or a 5xx** — never on an assertion
or schema failure. Those say the server answered and the answer was wrong, which repeating will not
change; the two failures worth retrying are the ones where no answer arrived or the server said it
could not answer yet. Polling therefore requires an explicit predicate, as in the example above.

This default is what keeps a flow-level `config.retry` safe to set. Without it, every failing
assertion on a non-idempotent step replays the request — `maxAttempts` orders placed, or
`maxAttempts` resources leaked by a negative test that just found an authorization bug (§10.3).
Making the destructive case the one you have to ask for is worth the explicit predicate on polls.

`maxAttempts` is a **hard cap that always applies**, even when the predicate keeps returning
`true`. The predicate decides *whether* to retry; it cannot decide to retry forever. An unbounded
predicate is an infinite hang in CI, which is the worst possible failure mode for a test runner.
`maxAttempts` defaults to 1 (no retry) and to `config.retry.maxAttempts` when the flow sets one.

**A step exhausts its retries when the predicate is still asking to retry at `maxAttempts`**, and
that fails the step with reason `retries-exhausted` — the poll never reached the state it was
waiting for. A predicate that returns `false` stops early and the step is judged normally by §10, so
a poll that settles on attempt 3 of 10 is a plain success.

Assert the terminal condition as well as polling for it. The predicate decides when to *stop*; the
assertion is what puts the awaited state in the failure message instead of a bare
`retries-exhausted`:

```yaml
  - id: await_settlement
    operation: payments-api#getPayment
    retry:
      maxAttempts: 20
      delay: 3000
      shouldRetry: |
        (res, attempt, ctx) => res.body.data.state !== 'settled'
    assert:
      - res.body.data.state eq settled
```

`retry:` is not permitted on a `uses:` step — see §12.4.

**Timeouts.** `timeout` bounds **each attempt**, matching how HTTP clients — and Bruno's existing
per-request timeout preference, which supplies the default — already behave. A retried step
therefore gets a fresh timeout per attempt rather than a shrinking one.

Because `maxAttempts × (timeout + delay)` can still be a long wall-clock time, an optional
`maxDuration` caps the **whole step**, retries and delays included. When it elapses, the in-flight
attempt is aborted, no further attempts are scheduled, and the step fails with reason
`max-duration-exceeded`. It is off unless set; `timeout` alone bounds each request, `maxDuration`
bounds the step.

**The budget is a deadline read off the injected clock, not a timer** — the same mechanism §11.3's
whole-run budget uses, and for the same reason: the clock is the engine's only source of time
(§13.2), so a budget kept by a timer would elapse differently under a host that supplies its own,
including the one where a poll's delays are the only thing that advances time.

**Aborting the attempt in flight is the request timeout doing it.** Each attempt is bounded by
whichever of `timeout` and the budget's remainder runs out first, so a step cannot sit inside one
attempt past the budget that governs it, and the engine needs no second timer to make that true. The
abort arrives as a transport error like any other; over budget, that is what it is reported as.

**The budget answers a step that wanted to go on.** It is consulted after the retry predicate, so a
poll that settles inside its budget is judged on what it settled as. And it outranks the last
attempt's own reason (§14.6), because it is why the step stopped where it did: reporting
`unexpected-status` would describe a poll that was still working when its time ran out as one that had
settled on a bad answer.

### 11.2 Failure propagation

When a step fails:

- Dependents whose `depends` does not accept `failed` are **skipped** with reason
  `unmet-dependency` (§9.1). Dependents that do accept it run.
- **Independent branches run to completion.** A failure in one branch does not cancel or curtail
  work that does not depend on it — one run surfaces as many genuine failures as possible instead
  of stopping at the first.
- The flow's final status is **failed** if any step failed, regardless of what else succeeded. This
  has no exemption flag: a step that failed unexpectedly goes red. A step whose failure was
  *expected* is not a failure at all — it asserted the error it wanted and passed (§10.3).
- **Being skipped is not itself a failure**, with one exception: an `unresolved-dependency` skip
  fails the flow under `failOnUnresolved` (below). A skipped step is never recorded as `failed`
  either way — the flag changes the run's verdict, not the step's outcome or the schedule.

**Outputs are extracted whenever a response arrived**, even when assertions or schema validation
then failed. This is precisely what makes cleanup work: a `createPayment` that returned 201 but
failed an assertion still yields `paymentId`, so a step depending on it with
`status: [success, failed]` can delete the resource it created. A step that failed *without* a
response — connection refused, DNS failure, timeout — produces no outputs.

**A step referencing an output that was never produced is skipped**, with reason
`unresolved-dependency` — not failed. Combined with the rule above, this gives cleanup the right
behavior in both directions: the resource exists, so it is deleted; the resource was never
created, so nothing runs.

Cleanup that cannot apply should not manufacture a second failure obscuring the real one — which is
why cleanup steps carry `failOnUnresolved: false` (below). The step-level outcome is a skip
regardless; the opt-out is what keeps that skip out of the flow's verdict too.

#### `failOnUnresolved`

A skip is not automatically benign. A flow whose data never matched can skip its way to the end and
report success: F4.2 in the conformance companion is exactly that — a filter matches nothing, the
consumer skips, everything downstream skips, and the run exits 0 having tested nothing.

**Prefer an assertion where the requirement is known.** A step that must locate something says so
with `assert: steps.<self>.<output> isDefined` (§10.2), which fails *at the extraction* and names
what was not found. `failOnUnresolved` is the backstop for everything nobody thought to assert; it
fires one step later, at the consumer, so it reports that the flow could not proceed rather than why.
Both should hold — the flag is what keeps the fail-open case from being silent, not a substitute for
saying what the flow requires.

**`config.failOnUnresolved` (default `true`) fails the flow when a step is skipped as
`unresolved-dependency`.** It is overridable per step.

It is named for the skip reason it acts on rather than for skipping in general, because only one of
the four reasons means something went wrong:

| Reason | Fails the flow under `failOnUnresolved` | Why |
|---|---|---|
| `unresolved-dependency` | **yes** | The step was eligible and a value it needed never arrived. Nobody asked for this. |
| `condition-false` | no | `when:` is an author instruction not to run here. Failing on it would make every conditional branch red. |
| `unmet-dependency` | no | The `status` set is an author declaration of which outcomes are acceptable. A fallback branch skipping because the primary succeeded is the design working. |
| `run-cancelled` | no | Already reported as flow status `cancelled`, exit 4 (§11.3). |

Under a blanket "any skip fails" rule the feature would not work at all: conditional branches,
fallback branches and dataset rows that legitimately diverge all skip by design.

**Cleanup steps usually want `failOnUnresolved: false`.** A cleanup that references an id the run
never produced *should* skip quietly — that is §11.2's whole point, and it is why the flag is
step-overridable rather than flow-wide only:

```yaml
  - id: cleanup_leak
    depends:
      - on: add_product_denied
        status: [success, failed, skipped, cancelled]
    failOnUnresolved: false                # nothing leaked on a passing run — skipping is correct
    pathParams:
      id: "{{steps.add_product_denied.leakedProductId}}"
```

The default is `true` because the failure mode it catches is silent, and the exemption is one line
on the steps that genuinely want it.

**A shared slot (§9.1) that no branch wrote resolves empty instead**, and does not skip the reader.
The two rules look similar but describe different intents. `{{steps.create_payment.paymentId}}`
names one specific step, so the value's absence means the thing the step was about did not happen —
proceeding would be meaningless. `{{shared.chargeId}}` deliberately does not name a producer; a slot
that stayed empty is one of its legal outcomes, and the reader is the only thing that knows whether
that matters. A reader that should not run without a value says so with `when:`.

Empty means an **empty string**, or omission for a structured `body` field. It explicitly does not
inherit Bruno's interpolation default, which leaves an unresolved `{{var}}` in the string verbatim
(`packages/bruno-common/src/interpolate/index.ts:121` —
`replacement !== undefined ? replacement : match`). That behavior is right for a variable a human
may still define; for a slot the engine owns and knows was never written, sending
`charge_id: "{{shared.chargeId}}"` to a live API turns a missing value into a malformed request.

### 11.3 Cancellation

When a run is aborted — Ctrl-C, `SIGTERM`, a CI timeout — in-flight requests are aborted and their
steps recorded as **`cancelled`**. Steps that had not started are skipped with reason
`run-cancelled`.

**A polling step stops where it stands, and reports `cancelled`.** §11.1 lets a retry schedule run to
`maxAttempts` delays of up to `maxDelay` each, so a poll that served out its schedule after the stop
would go on sending requests for minutes into a run that was already over — and, from an app, for as
long as the current delay lasts after a cancel that appeared to do nothing. Two things follow: the
delay itself is interruptible, so a stop lands during a sleep rather than after it; and the step's
verdict is the interruption rather than its last attempt, because a poll cut short before its
condition held has not passed.

**Once the run is stopped, a step that does not run says so.** A step below a cancelled one has an
unmet dependency in the strict sense, and reporting it that way describes the graph rather than what
happened — every step below the stop would name its parent instead of the stop. The exception is a
step whose `depends` accepts `cancelled`, which is answering its declaration.

The exception is steps whose `depends` accepts `cancelled` (§9.1): those still run, so a flow can
clean up after an interrupted run. This is the only circumstance in which the engine schedules work
after a stop signal, and it is deliberately bounded — only steps that *declared* `cancelled` are
eligible, and a second interrupt aborts unconditionally without running anything further.

**Cleanup runs under a grace window**, `config.cleanupGrace` (default **30000** ms). When it
elapses the run aborts unconditionally, whatever is still pending. A second interrupt is not a
sufficient bound on its own: an unattended CI run has nobody to send one, so an unbounded cleanup
phase would hang exactly where hanging is worst.

#### A whole-run budget

**`config.maxRunDuration` bounds the entire run**, all dataset iterations included, and is off unless
set. `--max-run-duration <ms>` sets or overrides it, which is how CI imposes a bound without every
flow having to carry one.

The name is deliberately not `config.maxDuration`. Every other `config` key is a **default for
steps** that a step may override, so `config.maxDuration` would read as the default step budget
rather than a whole-run one — a misreading that fails open, since a run nobody bounded is exactly
the case this exists for.

When it elapses the run enters **exactly the cancellation path above** — in-flight requests aborted
and recorded `cancelled`, unstarted steps skipped `run-cancelled`, steps accepting `cancelled` given
the grace window, flow status `cancelled`, exit **4**.

That equivalence is the reason to have it. A run killed by the CI runner's own timeout dies on
`SIGKILL`: no cleanup step runs, the exit code is the runner's (124, 137, 143), and the resources
the flow created are left behind. A budget the engine owns turns the same wall-clock limit into the
documented shutdown — which is what makes `depends: [cancelled]` cleanup dependable rather than
best-effort.

`maxRunDuration` is off by default because flows differ by orders of magnitude and a wrong default would
fail long polls that were working. The bound belongs to whoever knows the environment, which is
usually CI rather than the flow file. Bounding a *step* is different and stays per-step (§11.1).

A cancelled run reports flow status `cancelled` and exits **4** (§14.2) — a code distinct from a
test failure, so a CI job can tell an interrupted or timed-out run from a genuine regression without
parsing output.

---

## 12. Composition — sub-flows

A step may invoke another flow instead of an operation. The sub-flow is **opaque**: the parent
declares inputs and consumes declared exports, and never references the sub-flow's internal step
ids. This is goal 1's reference-not-duplicate argument one level up — a login sequence is written
once rather than pasted into every flow that needs a token.

### 12.1 Declaring an interface

```yaml
# flows/shared/login.flow.yml
version: 1

meta:
  name: Login

apis:                            # a sub-flow declares its own bindings
  auth-api: ../../apispec/auth-v2.yml

params:
  email:    { required: true }
  password: { required: false, default: "{{testUserPassword}}" }

exports:
  token:  steps.login.token
  userId: steps.login.userId

steps:
  - id: login
    operation: auth-api#login
    body:
      email: "{{params.email}}"
      password: "{{params.password}}"
    outputs:
      token: data.access_token
      userId: data.user.id
```

### 12.2 Invoking

```yaml
  - id: auth
    uses: ./shared/login.flow.yml
    with:
      email: "{{testUserEmail}}"

  - id: create_payment
    operation: payments-api#createPayment
    body:
      customer_id: "{{steps.auth.userId}}"
```

**A sub-flow's `exports:` are the invoking step's outputs.** There is no re-declaration in the
parent — `steps.auth.token` reads exactly like any other step's declared output, and §8.4's
visibility rule applies to it unchanged. This is why sub-flows needed no change to the connector
model: outputs were already namespaced per step.

`uses` and `operation` are mutually exclusive.

Paths resolve relative to the invoking flow file. A `workspace:` prefix resolves from the
workspace root, so a collection flow can reach a shared library without a brittle `../../../`
chain:

```yaml
  - id: auth
    uses: workspace:flows/shared/login.flow.yml
```

A sub-flow may live in a different scope or a different collection than its caller — that is the
point of workspace-level shared flows.

### 12.3 Isolation

Ambient configuration crosses the boundary; flow data does not.

| Visible inside a sub-flow | Not visible |
|---|---|
| Environment variables (`{{apiBaseUrl}}`) | Parent `steps.*` |
| Auth profiles (own definitions shadow inherited) | Parent flow `vars:` |
| Its own `vars:` and `params.*` | Parent `row.*` |
| Its own `shared:` slots | Parent `shared.*` |
| The caller's cookie jar (§7.6) | — |
| `flow.runId`, shared across the whole run | Parent `flow.iteration` |

The rule is: **anything that is configuration inherits; anything that is data must be declared.**

Without the first half, every sub-flow would redeclare base URLs and credentials at every call
site — precisely the boilerplate sub-flows exist to remove. Without the second half, a sub-flow
silently couples to its parent's internals, and stops being reusable or independently validatable.

The table's first two rows look like they conflict for the commonest profile there is:
`user-token: { token: "{{steps.auth.token}}" }` inherits, but the `steps.auth` it names does not.
**§6.4's lexical resolution is what reconciles them** — an inherited profile's `{{steps.*}}`
resolves against the flow that *declared* the profile. The profile is configuration and travels;
the step state it closes over stays the parent's and never becomes addressable inside the sub-flow.
A sub-flow may still shadow an inherited profile, and its own definition then resolves against its
own steps.

**`apis:` bindings and connector files are the exceptions and do not inherit from the caller.** A
sub-flow declares its own bindings, and its connector files (§8.5) resolve from its own scope.

If either inherited, the same alias could resolve to a different document — or an operation could
gain and lose its default outputs — depending on who called the sub-flow. A sub-flow whose
`exports:` reference a connector-supplied output would then work when invoked from one collection
and break when invoked from another. Resolving both locally is what makes a shared flow
self-contained and independently validatable.

**A sub-flow executes in its caller's context, not its own file location's.** A shared flow stored
under `workspace/flows/shared/` and invoked from the `payments` collection runs against
`payments`' environment and auth; invoked from `ledger`, it runs against `ledger`'s. This is what
makes a shared library flow genuinely reusable — its behavior is determined by who calls it, not
by where it happens to sit on disk.

`row.*` is deliberately excluded: a sub-flow invoked inside a dataset iteration must receive the
row values it needs through `with:`, so its dependencies stay visible at the call site rather than
being absorbed from ambient state.

`shared.*` is excluded for the same reason and by the same rule — it is data. A sub-flow's slots are
its own; a value moving in or out crosses through `params:` and `exports:` (§12.1) where the call
site can see it. Inheriting slots would also break §9.1's ordering guarantee, since a caller's
writers are not ancestors of anything inside the sub-flow.

### 12.4 Constraints

**Which step fields a `uses:` step may carry.** §5.4 makes `operation` XOR `uses` a schema rule, so
the schema needs the full list rather than a rule per field discovered later:

| | Fields |
|---|---|
| **Legal** | `id` `name` `uses` `with` `when` `depends` `outputs` `shared` `assert` `maxDuration` |
| **Error** | `retry` `timeout` `failOnStatusCode` `validateRequest` `validateSchema` `strictSchema` `failOnUnresolved` `body` `bodyFile` `query` `headers` `pathParams` `contentType` `auth` |

The division is one question: **does the field address a response?** A sub-flow has no single
response — it has many, or none if every step skipped — so a field that names one is not merely
useless there but unanswerable, and the schema says so rather than accepting it as a quiet no-op.
What remains is what a sub-flow genuinely has: it runs or is skipped, it depends on things, it takes
time, and it exports values. `outputs:` and `shared:` read those exports (§12.1), and `assert:`
checks them:

```yaml
  - id: auth
    uses: ./shared/login.flow.yml
    with: { email: "{{testEmail}}" }
    assert:
      - steps.auth.token isDefined      # the sub-flow's exports, not a response
```

`maxDuration` is legal and bounds the whole sub-flow, which is the useful bound; `timeout` is
per-attempt against one request and has nothing to apply to. The individual reasons behind the
sharper constraints follow.

- **`retry:` on a `uses:` step is a validation error.** Replaying a multi-step sequence replays
  every side effect it already committed — duplicated resources, double charges. Retry belongs on
  individual steps *inside* the sub-flow, where its blast radius is a single request.
- **`dataset:` in a sub-flow is a validation error.** Only a top-level flow iterates; nesting
  would multiply combinatorially and make failure reporting incomprehensible.
- **Cycles are detected across files.** `A uses B uses A` fails validation exactly like an
  intra-flow cycle.
- A sub-flow's internal parallelism draws from the **run-wide** `concurrency` budget, so nesting
  cannot multiply in-flight requests without bound.
- A failed step inside a sub-flow fails the invoking `uses` step, which then propagates by the
  normal §11.2 rules. `when:` on a `uses` step skips the entire sub-flow.
- A `required` param with no `default` and no value at the call site is a validation error.

### 12.5 Library flows

**A flow that declares `meta.library: true` is a library flow.** It is excluded from directory and
glob runs, so `bru flow run flows/` in CI never fires `login.flow.yml` standalone and reports a
spurious missing-param failure.

**The mark is explicit rather than inferred from `params:` or `exports:`.** Inferring it makes a
flow's discoverability a side effect of declaring an interface, so adding a param to a flow that CI
runs deliberately would remove it from CI silently — a change of behaviour with no change that says
so. The cost of being explicit is the opposite mistake: a flow with required params that forgets the
flag, which is the spurious CI failure this rule exists to prevent. That is caught by a lint rather
than by inference — **`bru flow validate` warns when a flow declares a `required` param with no
`default` and is not marked `library: true`** (§14.3), naming the flag. A warning and not an error,
because a flow taking a required param from `--param` on every invocation is legitimate.

It remains directly runnable when named explicitly, which is what keeps it testable in isolation:

```
bru flow run flows/shared/login.flow.yml --param email=qa@example.com
```

**A direct run resolves `params:` exactly as an invoking `uses:` step does** — each declared param
takes what the caller supplied, and its `default` where the caller supplied nothing. The two paths
have to agree or the same library flow behaves differently depending on who ran it, and the way this
fails is quiet: `params` is a reserved root (§7.3), so a param nobody filled is not an unproduced
`steps.*` reference — nothing skips the step and nothing reports it, and `{{params.x}}` goes out on
the wire verbatim. A default may itself reference a variable, so a direct run resolves it against the
run's own environment, which is what a sub-flow's caller does for it.

`bru flow list` marks library flows, so the distinction is visible without opening files.

---

## 13. Execution architecture and fork isolation

### 13.1 A shared engine package

The engine lives in a new package, **`@bruno-max/flow`** (directory `packages/bruno-max-flow/`),
consumed by both `bruno-cli` and `bruno-electron`. Anything else means the CLI and the app diverge
in behavior, which defeats goal 4.

The fork-distinct scope and directory prefix are deliberate: a package named `@usebruno/flow` in
`packages/bruno-flow/` would collide with both the npm name and the directory if upstream ever
ships one. All fork packages use `@bruno-max/*` and `packages/bruno-max-*` (§13.4).

Per `.claude/rules/architecture.md`, this sits as a mid-level consumer:

```
@bruno-max/flow  ->  common, query, js, requests   (schema-types as devDep)
bruno-cli        ->  flow, ...
bruno-electron   ->  flow, ...
```

No cycle is introduced: `cli` and `electron` are top consumers and already depend on `js`,
`common`, `requests`, and `query`. `@bruno-max/flow` must not import `bruno-app` or
`bruno-electron`.

The engine owns graph scheduling, materialization, connectors, sub-flow resolution, assertions,
retry, and reporting.

**It reports through its return value and its events, and writes to no console.** §13.2's ports are
the whole of what it reaches for, and stdout is not among them: the CLI owns its output (§14.7) and
is the half a reporter is parsed from, and in the app the same stream is an Electron main process
nobody is reading. This binds the engine's dependencies too — a YAML or schema library that logs an
advisory on the engine's behalf breaks the rule exactly as a `console.log` here would, so a parser
that has a quiet mode is put in it and anything worth saying is returned as a diagnostic instead.

### 13.2 The engine boundary

Everything crossing between `@bruno-max/flow` and a host: what the engine calls out to, what a host
calls in, and what the engine reports while running. All three are one contract, because a rule that
lives on the wrong side of it is a rule the CLI and app can implement differently.

#### Ports the engine calls out to

The engine **does not send HTTP itself.** Request dispatch differs between hosts — the app routes
through `ipc/network`, the CLI through `runner/run-single-request.js` — and duplicating that
logic would reintroduce exactly the drift this feature exists to eliminate.

The engine therefore takes injected ports:

```ts
type ExecuteRequest   = (request: MaterializedRequest, ctx: StepContext) => Promise<ExecutedResponse>;
type ReadFile         = (path: string, ctx: FlowContext) => Promise<Buffer>;
type WriteFile        = (path: string, data: Buffer, ctx: FlowContext) => Promise<void>;
type ListDirectory    = (path: string, ctx: FlowContext) => Promise<string[]>;
type RemoveDirectory  = (path: string, ctx: FlowContext) => Promise<void>;
type ReadSpec         = (source: string, ctx: FlowContext) => Promise<SpecDocument>;
type RunScript        = (source: string, args: unknown[], ctx: FlowContext) => Promise<unknown>;
type Clock            = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

type SpecDocument = { text: string; from: 'file' | 'network' | 'cache' };
```

Each host supplies its own implementation and keeps its existing auth, cookie, proxy, and
certificate handling.

`ReadFile` covers §7.4's sources and `dataset:`, and exists for the same reason: the engine stays
free of `fs`, each host keeps its own path and permission handling, and conformance scenarios supply
fixtures in memory rather than on disk. Scope-root containment (§7.4) is enforced by the engine
before the port is called, so no host can forget it.

`WriteFile`, `ListDirectory` and `RemoveDirectory` serve `.bruno-runs/` (§14.5) — which the engine
reads back as well as writes, see 002 §11.2. **The engine owns the capture layout**: it computes
every path, decides what a run directory contains, and applies §14.5's retention by removing the
directories that fall outside it. A host writes the bytes it is handed and nothing else.

That division is the point. §14.5's layout is a declared contract, and the engine already depends on
it to read a run back — a host-side writer would put one layout in two implementations and let the
CLI and app produce directories neither can fully read. The rule "the engine never touches `fs`"
(§7.4, §17) is unchanged: these are ports, and a conformance run supplies an in-memory
implementation exactly as it does for `ReadFile`. All three carry the same containment rule as
`ReadFile`: a path outside the capture root is refused before the port is called, and the capture
root is inside the scope root unless the operator moved it with `--capture-dir` — §14.5 has the one
exception and why it is narrow.

`ReadSpec` loads an OpenAPI document named by an `apis:` binding (§6.2), whether that source is a
relative path or an `https://` URL. It is separate from `ReadFile` because the two have different
containment rules — a spec source is deliberately allowed to be remote, and a fixture is
deliberately not — and because each host already has a spec loader worth reusing: the app's
`renderer:fetch-api-spec` / `swagger-fetch` path, the CLI's direct fetch. **Caching is the host's**:
location, TTL, invalidation and offline behaviour are not flow semantics, and nothing in the
engine's output changes with a cache hit. The `from` field exists so a host can report where a
document came from without the engine knowing how it got there.

`RunScript` evaluates the `script:` forms of §8.2, §9.3 and §11.1's `shouldRetry` in the host's
chosen bruno-js sandbox. It is a port rather than a direct dependency because the two hosts select
that runtime differently and neither selector is reachable from this package — §8.2 has the detail.
The engine passes source and arguments; what the host does about `securityConfig` is the host's,
unchanged from how it treats a request script today.

`StepContext` carries the **cookie jar handle** the request must use (§7.6). The host keeps its own
cookie implementation; the engine decides which jar applies, because iteration and sub-flow scoping
is a flow semantic and hosts that answered it independently would diverge.

`Clock` is defaulted to real time and exists so retry delays (§11.1) and `maxRunDuration` (§11.3)
are drivable in tests without global timer patching. It is the only reason a conformance run of a
30-attempt poll costs no wall-clock time.

#### The types the ports name

The signatures above are the contract two hosts implement independently, so every type in them is
part of it. A name left to each host to infer is a name the CLI and the app will infer differently —
which is the divergence §13.1 exists to prevent, arriving through the door the port set was supposed
to close.

```ts
type Vars = Record<string, unknown>;
```

`unknown` rather than `string`, because collection variables already hold parsed JSON and §7.3's
whole-value typing rule (`item_count: "{{steps.x.count}}"` → a number) requires a non-string to
survive the chain. `processEnv` is string-valued in practice; the type does not narrow it, because
the tier it occupies is still open (§18) and a narrower type would look like an answer.

```ts
type FlowContext = {
  runId: string;
  flow: string;                        // absolute path of the .flow.yml being executed
  scope: { workspaceRoot: string; collectionRoot?: string };
  signal: AbortSignal;                 // the run's, per §11.3
  redactHeaders?: string[];            // the run's `config.redactHeaders` — see below
};

type CookieJarHandle = { readonly id: string };

type StepContext = FlowContext & {
  stepId: string;                      // namespaced for sub-flow internals: "auth/login"
  iteration: number;                   // 0-based; always present — see below
  attempt: number;                     // 1-based, per §11.1
  cookieJar: CookieJarHandle;
  timeoutMs?: number;                  // the step's per-attempt `timeout` (§11.1)
  signal: AbortSignal;                 // the attempt's — aborts on timeout, maxDuration, or the run's
};
```

**`redactHeaders` crosses so that a host can obey §14.4 rather than approximate it.** The engine
applies the policy to everything *it* emits, but a host may report a request on a surface of its own
— 002 §8.5's network panel is one — and a host that only knew the built-in denylist would unmask
exactly the headers an author added to the list. It is the root flow's value, whatever the depth of
a sub-flow, which is the scope the capture already uses; it is absent until the flow is loaded, which
is before anything is dispatched.

**The cookie jar crosses as an opaque handle, not as a jar.** §7.6 splits this deliberately — the
engine owns *which* jar a request uses, each host owns what a jar *is* — and a handle is what
expresses that split in a type. The engine mints an id per §7.6's scoping rules (one per run, one per
dataset iteration, inherited by sub-flows) and never looks inside; the host maps the id to its own
`CookieJar` and creates one on first sight. Typing the field as a jar would put one host's cookie
implementation in the shared package and make the other one wrong.

`StepContext.signal` is the **attempt's**, narrower than the run's. A per-attempt `timeout`, a step
`maxDuration` and a run-level cancel all have to abort an in-flight request (§11.1, §11.3), and a
host that received only the run's signal could implement none of the three.

`StepContext.iteration` is **always present and is not `{{flow.iteration}}`.** It is the index the
engine uses to scope a cookie jar and to nest a capture directory, so it exists for every run and is
`0` when there is no dataset. Whether the *interpolated* `{{flow.iteration}}` is exposed outside a
dataset is a separate question and still open (§18); a port context that went absent along with it
would leave capture nesting and jar scoping undefined for the ordinary single-iteration run.

```ts
type MaterializedRequest = {
  method: string;                      // upper-case
  url: string;                         // absolute, resolved (§6.3), path params substituted, no query
  query: { name: string; value: string }[];   // a list, so repeated keys survive
  headers: Record<string, string>;
  body: RequestBody;
  auth: Auth;                          // the resolved profile (§6.4), in Bruno's own Auth shape
  operation?: { api: string; operationId?: string; method: string; path: string };
};

type RequestBody =
  | { kind: 'none' }
  | { kind: 'json';       value: unknown }                     // serialized by the host
  | { kind: 'text';       value: string; contentType: string }
  | { kind: 'urlencoded'; fields: { name: string; value: string }[] }
  | { kind: 'multipart';  parts: MultipartPart[] }             // §7.5
  | { kind: 'binary';     file: FilePayload };                 // §7.5, raw — never interpolated

type MultipartPart =
  | { name: string; kind: 'field'; value: string; contentType?: string }
  | { name: string; kind: 'file';  file: FilePayload };

type FilePayload = {
  bytes: Buffer;                       // already read through the ReadFile port (§7.4)
  filename: string;                    // §7.5's basename-or-override
  contentType: string;                 // §7.5's four-step resolution, decided by the engine
  sourcePath: string;                  // for capture-by-reference only (§14.5) — never sent
};
```

Four things this shape is asserting, each of which a flatter type would lose:

**`url` excludes the query string and `query` is a list.** One field cannot be both the source and
the result without the host having to guess which half already happened. A list rather than a record
is what lets `?tag=a&tag=b` exist at all — §7.2 replaces arrays wholesale rather than merging them,
so an array-valued query parameter is an ordinary authored value and a `Record<string, string>` would
silently drop every entry but the last.

**`body` is a tagged union, so §7.5's decision is made once — by the engine.** The media type is
resolved from the operation, and `contentType:` disambiguates it only where the operation declares
several. Handing hosts a bare object and a content-type header would leave each of them re-deriving
"is this multipart?" from the body's shape, which §7.5 rejects by name. `kind` is the answer, already
computed.

**`auth` is declarative and stays Bruno's `Auth` type**, imported from `bruno-schema-types`. §6.4
promises flows introduce no new auth mechanics, and this is where that is cashed: the engine resolves
*which* profile applies and interpolates its fields, then hands over the same structure a request
carries today, so OAuth2 token caching, AWS signing, digest challenge/response and the rest stay in
each host's existing code.

The type does raise a question §6.4 has not answered: **Bruno's `AuthMode` union has twelve members
and §6.4 names eight.** `oauth1` and `akamai-edgegrid` go unmentioned, and both compute a signature
across several request fields exactly as `awsv4`, `digest`, `ntlm` and `wsse` do — so §6.4's
signing-mode override error should almost certainly cover six modes rather than four, and §5.4's
schema enum needs the full list either way. `inherit` is the third: it means "take the parent
folder's auth" for a request and has no referent at a flow's profile boundary, so §6.4 has to either
resolve it before this point or reject it in validation. Recorded in §18 rather than decided here.

**Headers are a record, and repeated request headers are therefore not expressible.** That matches
what Bruno's request object does today rather than improving on it, and going further would mean the
engine's type outrunning both hosts' ability to honour it. Repeated *response* headers are a
different question, below.

One rule about handling the object, rather than about its shape:

**A `MaterializedRequest` carries live secrets.** Redaction (§14.4) applies to what is *reported* —
events, captures, reporter files — and the engine applies it to copies. The object handed to
`ExecuteRequest` is the real request, token included, because it has to be sendable. A host must not
log it.

```ts
type ExecutedResponse = {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  body: unknown;                       // parsed when the host could parse it, else a string
  bytes?: Buffer;                      // raw, for binary capture (§14.5) and byte assertions
  responseTimeMs: number;
  size?: { body: number; headers: number };
  requestHeaders?: Record<string, string>;  // what the host actually wrote — see below
};
```

**`requestHeaders` is how "the request that was sent" gets into the capture.** A
`MaterializedRequest` carries the headers the *step* declared; the auth profile, the body's content
type, the cookie jar and the proxy are all the host's to apply (§13.2), and they are applied after
the engine hands the request over. §14.5 writing the declared set alone records a request that was
never sent — one with no `Content-Type` on a JSON body and no `Authorization` at all, which is
exactly the request you would be inspecting a capture to check. The host reports what it wrote, the
capture prefers it, and §14.4's masking applies on the same terms: a header the host added is no more
exempt than one the flow declared.

It is optional, and a host that omits it leaves the capture with the declared headers — the behaviour
before this field existed.

`headers` admits `string[]` because `Set-Cookie` genuinely repeats and §7.6 depends on it. `body`
mirrors what both hosts already produce — parsed JSON where parsing succeeded, the decoded string
where it did not — so `res.body.data.id` means in a flow exactly what it means in a request today.
`responseTimeMs` is what §10.2's `res.responseTime` reads.

**A transport failure is a rejection, not a status.** `ExecuteRequest` rejects when no response
arrived — connection refused, DNS failure, TLS error, a timeout the host enforced — and the engine
maps the rejection to `transport-error` (§14.6), extracts no outputs (§11.2), and applies §11.1's
default retry. A response *object* carrying an error field would make every consumer check two places
for the same question, and the one thing the engine must know here is binary: did an answer arrive.

```ts
type TransportError = Error & { code?: string };   // e.g. ECONNREFUSED, ETIMEDOUT, CERT_HAS_EXPIRED
```

`code` is optional and advisory — it reaches the failure message and the capture, and nothing
branches on it. Aborts are not transport errors: the engine owns the signal, so it already knows
whether it cancelled the attempt and reports `max-duration-exceeded` or `cancelled` on its own
authority rather than inferring it from a rejection it caused.

#### The entry API

Two entry points execute and validate. Four more are **read-only** — `describeFlow`, which returns
the resolved graph, and `listRuns` / `readRun` / `readCapture`, which read `.bruno-runs/` back. They exist for
the app and are specified in [002](./002-api-flows-ui.md) §11.1 and §11.2 rather than here, because
nothing in this document consumes them; they are named here so the boundary's readers know the
package's surface is six functions and not two.

```ts
declare function runFlow(options: RunOptions): Promise<RunResult>;
declare function validateFlow(options: ValidateOptions): Promise<Diagnostic[]>;

type RunOptions = {
  entry: string;                       // path to a .flow.yml, resolved by the host
  scope: { workspaceRoot: string; collectionRoot?: string };
  ports: {
    executeRequest: ExecuteRequest;
    readFile: ReadFile;
    writeFile: WriteFile;
    listDirectory: ListDirectory;
    removeDirectory: RemoveDirectory;
    readSpec: ReadSpec;
    runScript: RunScript;
    clock?: Clock;
  };

  variables: {                         // resolved per scope by the host — NOT a merged map
    globalEnvironment?: Vars;
    collectionVars?: Vars;
    environment?: Vars;
    envVarOverrides?: Vars;            // --env-var; merges into `environment`, winning — §7.3
    processEnv?: Vars;                 // populates the `process.env` namespace, not a tier — §7.3
  };

  params?: Vars;                       // --param, for a library flow (§12.5)
  origin?: RunOrigin;                  // who started this run and against what — recorded, never consulted
  overrides?: {
    concurrency?: number;
    maxRunDuration?: number;
    dataset?: string;
    capture?: {
      enabled?: boolean;                 // --no-capture (§14.5)
      dir?: string;                      // write runs directly here, no suite of their own (§14.5, §14.8.5)
    };
  };
  signal?: AbortSignal;
  onEvent?: (event: FlowEvent) => void;
};
```

**Capture is an override rather than a port decision.** §14.5 gives the CLI `--no-capture` and
`--capture-dir` and [002](./002-api-flows-ui.md) §7.2 puts the same switch in the app's run panel, so
both hosts need a way to say it — and the engine has to be the one that hears it, because it computes
every path (§14.5) and applies retention. A host that answered by declining to implement `WriteFile`
would silently lose run identity and pruning along with the payloads.

`dir` carries the same containment rule as every other path (§7.4): resolved relative to the scope
root and refused if it escapes.

**Variables arrive as tiers, not as a merged map.** §7.3's precedence chain is a flow semantic and
belongs to the engine; *finding* each tier — locating `bruno.json`, resolving `--env` across
collection, workspace and global scopes (§14.1) — is host knowledge. Handing over a pre-merged map
would move the ordering into two hosts and let them disagree about which scope wins, which is the
one thing this package exists to prevent.

Two of these five are not ranks in the chain and the sixth rank has no field here: §7.3 has the rule
and the reasoning. The short form is that `envVarOverrides` merges into `environment`,
`processEnv` populates a namespace, and runtime variables are produced during the run rather than
supplied before it.

**One flow per call.** Selecting flows from a directory, path ordering, and `--bail` (§14.1) are the
CLI's, because they are about a *suite*; the engine's unit is a flow and its iterations.

**Cancellation is an `AbortSignal`** — Ctrl-C and `SIGTERM` in the CLI, a stop control in the app.
`maxRunDuration` is enforced by the engine against `Clock`, because §11.3 requires the timeout and
the signal to take the identical path.

```ts
type RunResult = {
  runId: string;
  origin?: RunOrigin;                  // as the host supplied it, when it did
  status: 'passed' | 'failed' | 'cancelled';
  iterations: IterationResult[];
  decidedBy?: string[];                // §14.6 — the steps the verdict fell on, deduped
  summary: { total: number; passed: number; failed: number; skipped: number; cancelled: number };
  diagnostics: Diagnostic[];           // validation warnings that did not stop the run
  captureDir?: string;
};

/**
 * Recorded for readers and read by no rule: the engine neither validates a name nor resolves
 * anything through it. The environments' *values* arrive in `variables` — these are the labels a
 * history, a report or a live view shows beside a run.
 */
type RunOrigin = {
  host: 'app' | 'cli';
  environment?: string;                // the collection environment's name, when one was selected
  globalEnvironment?: string;          // the workspace (global) environment's name
};

type IterationResult = {
  index: number;
  row?: Vars;
  status: 'passed' | 'failed' | 'cancelled';
  steps: StepResult[];
  decidedBy?: string[];                // this iteration's own — §14.6
};

type StepResult = {
  id: string;                          // sub-flow steps namespaced: "auth/login"
  name?: string;                       // §5.3's `name:` — the human label, where the id is a handle
  meta?: Record<string, unknown>;      // §5.3's `meta:`, verbatim — what a report keys the step by
  kind: 'operation' | 'subflow';       // a `uses:` step is a container — see below
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  reason?: StepReason;                 // §14.6 — the rule that fired
  message?: string;                    // §14.6 — the occurrence, in human words
  attempts: number;
  durationMs: number;
  assertions: { expr: string; passed: boolean; expected?: unknown; actual?: unknown }[];
  validation?: {                       // §10.1's automatic checks — absent when both are off
    request?:  SchemaResult;
    response?: SchemaResult;
  };
  outputs: Record<string, unknown>;
  capturePath?: string;
};

type SchemaResult = { valid: boolean; errors: { path: string; message: string; keyword?: string }[] };

type StepReason =
  | 'unexpected-status' | 'invalid-request' | 'schema-validation-failed' | 'assertion-failed'
  | 'transport-error'   | 'retries-exhausted' | 'max-duration-exceeded'  | 'file-read-failed'
  | 'script-error'      | 'subflow-failed'
  | 'unmet-dependency'  | 'condition-false'  | 'unresolved-dependency'   | 'run-cancelled';
```

`StepReason` is §14.6's table as a union, and §14.6 remains its definition — the strings are a public
contract, so this type is a restatement for the compiler's benefit and gains a member only when that
table does.

**`message` is the occurrence to `reason`'s rule**, the same pairing `Diagnostic` makes between its
`code` and its message, and it exists because a reason on its own frequently names nothing to go and
look at: `unresolved-dependency` does not say which reference was never produced, and
`schema-validation-failed` does not say which field. Both facts are known only where the step failed,
and a run that drops them makes the host reconstruct them from a capture — which a
`--no-capture` run does not have, and which the *skipped* step that failed the run never wrote. It is
present whenever the engine knows more than the reason says and absent otherwise, it is human text
rather than a stable format, and every host displays it: §14.7's failure block, and
[002](./002-api-flows-ui.md) §9's step detail. It can quote a response value — the failing assertion's
actual, a rejected field — exactly as `assertions[]` already does, so §14.4's policy governs it on the
same terms and a provenance-aware redactor has to reach it too.

**A schema is validated in the document it was written in.** An operation's schema is a *fragment* of
its OpenAPI document, and nearly every real one refers to the rest of it —
`$ref: '#/components/schemas/Thing'` resolves against the root of whatever is being validated, which
for a bare fragment is the fragment. So the document's definition sections travel with every schema
the engine hands a validator: `components` for OpenAPI 3, `definitions` for Swagger 2, whichever the
document uses. Without them the first `$ref` fails to resolve, and it fails by refusing to *compile*
rather than by validating loosely — which is a thrown error where a check was expected.

**A `oneOf` that failed because *several* branches matched says so.** The validator's sentence is the
same either way — nothing matched, or more than one did — and the second is a statement about the
document: two schemas that both accept the payload, which is what a pair written for human readers
usually is, since neither declares `required` and both allow extra properties. Told only "must match
exactly one", a reader goes looking for the fault in their response. The count is in the error and
not in its text, so the engine puts it there.

**A schema that will not compile fails its step, not the run.** It is a statement about the document
rather than about the response, and §13.2 has no way to attach an escaping throw to a step. It is
reported as a failed check whose error says the schema could not be compiled.

**Schema validation reports separately from assertions.** §10.1's checks are the engine's, §10.2's
are the author's, and a step can fail one while passing all of the other — which a single `reason`
cannot express and a flattened `assertions[]` would misattribute. Keeping them apart also keeps the
path-keyed error list a schema mismatch actually produces, which is the thing worth showing when a
response drifts from its spec; `reason` still names which side failed through §14.6's existing
`invalid-request` and `schema-validation-failed`. The field travels in the result rather than in the capture so it survives capture being
disabled — [002](./002-api-flows-ui.md) §9 renders it and 002-C U4.10 tests exactly that.

**`decidedBy` names the steps the verdict fell on**, because `status` and `summary` between them
cannot. The counts are a tally of *step statuses*, and §11.2's `failOnUnresolved` is the one rule that
fails a run through a step that is not itself failed — so a red run can report `0 failed` with every
step green or skipped, and no consumer can work out which skip it was: the flag is per-step and
`StepResult` does not carry it. Step ids rather than a reason of its own, because each named step
already carries the `reason` and `message` that say what it did; a run-level vocabulary would be a
restatement that can disagree with them, and a run failed by both a 500 and an unresolved skip would
have to choose between two of them. An iteration reports its own, the run reports theirs deduped in
iteration order, and a cancelled run names nothing — the interrupt decided it, and the steps it cut
short did nothing to be named for. §14.7's console output and [002](./002-api-flows-ui.md) §8.4's run
summary both read it.

**Sub-flow steps are ordinary members of a flat `steps[]`.** A `uses:` step produces its own
`StepResult` with `kind: 'subflow'`, and each internal step produces one alongside it with a
namespaced id, in the same array — not nested inside the container. `step:start` and `step:end` fire
for internal steps exactly as for top-level ones, so a host can render a sub-flow expanding while it
runs rather than only after the fact ([002](./002-api-flows-ui.md) §5.4, 002-C U1.8). `kind` exists
so no consumer has to parse `/` out of an id to tell a container from a leaf, and so the CLI can
collapse a sub-flow to one line without `--verbose` (§14.7) while the app expands it. A container's
`status` is derived from its internals by the normal §11.2 rules; its `attempts` is always 1, since
§12.4 bars `retry:` there.

**`RunResult.diagnostics` is where a run reports on itself**, as against §14.3's, which report on the
file. Two things go here and nowhere else: an artifact write that failed (§14.5 requires that it not
fail the run, which is not the same as not reporting it — a step whose capture never reached disk has
no request and no response to show, and without this nothing anywhere says why), and the failure of a
run that ended on its own account (§13.2's termination guarantee), which belongs to no step and so
cannot be carried by one. A host that shows a run's status and not these has a run whose entire
account of itself is one word.

`RunResult` carries **no exit code**. Mapping an outcome to 0–4 is §14.2's, and the app has no use
for it — an engine that returned one would be encoding a CLI concern into the shared package.

`validateFlow` returns diagnostics and never dispatches; the same call backs `bru flow validate`
(§14.3) and the app's inline authoring feedback, so the two cannot drift.

`readFlowMeta(text)` answers one question — what a flow calls itself — from the document a host
already has, with no ports and no I/O. It is here rather than left to the host because §5.4 gives the
format local tags: a host that parsed `.flow.yml` with an ordinary YAML reader rejects `!file` as an
unknown tag and concludes the file is unreadable, which is invisible in every flow that uses no
fixture and silent in the ones that do. [002](./002-api-flows-ui.md) §4.1's sidebar names every flow
it lists, including the ones nobody has opened, and `describeFlow` is the wrong instrument for that:
it resolves sub-flows and OpenAPI documents, over the network where a binding names a URL.

```ts
type ValidateOptions = {
  entry: string;
  scope: { workspaceRoot: string; collectionRoot?: string };
  ports: { readFile: ReadFile; readSpec: ReadSpec };
  params?: Vars;                       // --param, so a library flow's required params check (§14.3)
};
```

**Two ports, not eight.** Validation resolves operations and reads connector files, sub-flow files
and statically-known fixture paths — nothing else. Requiring a host to supply `executeRequest` or
`runScript` to *validate* would mean the app could not lint a flow without standing up the machinery
to run one, and §6 of [002](./002-api-flows-ui.md) runs this on every watcher change. `describeFlow`
takes the same two ports for the same reason.

`params` is here because §14.3 checks that every `required` param is satisfied, and a library flow
invoked with `--param` satisfies them from outside the file. Without it, validating a library flow
would report a missing param that the run supplies.

```ts
type Diagnostic = {
  severity: 'error' | 'warning';
  code: string;                        // stable, machine-readable — §14.6
  message: string;
  file: string;
  stepId?: string;
  path?: string;                       // JSON pointer into the flow document
  line?: number;
  column?: number;
};
```

#### Events the engine emits

`onEvent` is how a host observes a run in progress. Without it neither host can report anything
until the run ends — the CLI could not print a step as it completes, and the app could not render a
running graph.

```ts
type FlowEvent =
  | { type: 'run:start';       runId: string; flow: string; iterationCount: number; captureDir?: string;
                               description?: FlowDescription; origin?: RunOrigin }
  | { type: 'iteration:start'; index: number; row?: Vars }
  | { type: 'step:start';      id: string; index: number; operation?: string }
  | { type: 'step:attempt';    id: string; index: number; attempt: number; status: string; durationMs: number }
  | { type: 'step:end';        id: string; index: number; result: StepResult }
  | { type: 'iteration:end';   index: number; status: IterationResult['status'] }
  | { type: 'run:end';         result: RunResult };
```

Four rules make the stream safe to depend on:

**Observational only.** A consumer cannot alter execution, and the engine ignores its return value.
An event handler that could veto or reorder a step would put flow semantics in the host, which is
where divergence starts.

**A throwing consumer never fails the run.** Emission is wrapped; a host bug in rendering must not
turn a passing flow red.

**Redaction is applied before emission**, not by the consumer (§14.4). Events are the most-copied
thing in the system — logged, forwarded over IPC, rendered — so a raw secret in one would leak
everywhere at once.

**`run:start` carries `captureDir`**, absent when capture is disabled. `RunResult.captureDir` reports
the same path, and reporting it only at the end would mean a consumer could not open a *running*
step's capture — which is exactly what [002](./002-api-flows-ui.md) §9 does, and the engine knows the
directory before the first step (§14.5 writes `run.json` into it at run start). A consumer that had
to wait for `run:end` would show bodies only for runs that had already finished, which is the
opposite of when they are wanted.

Deriving it instead from a step's `capturePath` is what this avoids. That path is the step's own
directory, so recovering the run's would mean stripping a step id off the end — and a sub-flow's id
is namespaced (`auth/login`), so the strip is two segments for some steps and one for others. That is
a path computation, and §14.5 gives every one of those to the engine.

**`run:start`, `RunResult` and §14.5's manifest all report the same `origin`.** A reader therefore
learns who started a run and against which environments from the run itself, whichever of the three
it happens to be holding — a live view (002 §10) has it before the run ends, a reporter (§14.8) has
it at the end, and a history has it without opening the run at all. Reporting it once per run from
one source is what stops the app and the CLI from disagreeing with the file on disk. Absent when the
host supplied none; the engine records it and consults it for nothing.

**`run:start` also carries the run's `description`** — §14.5's snapshot, reported as well as written,
and absent for the same reason the file is: a run under `--no-capture` records nothing. A consumer
that drew the *current* file instead would redraw the run it is watching the moment that file was
edited, and [002](./002-api-flows-ui.md) §4.3 makes editing one a two-second operation. It is the one
payload in this list that is not small, and it is bounded the way the others are not by being *per
run* rather than per step — the same size argument as bodies, read the other way round.

**Events are small and structured-clone-safe.** They carry ids, statuses and durations; bodies and
uploaded files are not included, only the `capturePath` that holds them (§14.5). In the app the
engine runs in the Electron main process and the UI in the renderer, so every event crosses IPC —
attaching response bodies would put each payload through serialization twice for data the UI can
fetch when a step is opened.

Ordering is guaranteed: `step:start` precedes its `step:end`, both sit inside their
`iteration:start`/`iteration:end`, and `run:end` is last. Under `concurrency > 1` events from
different steps interleave, so consumers key on `id` and `index` rather than assuming adjacency.

**Termination is guaranteed too: once `run:start` has been emitted, `run:end` follows.** A step's
failure is a `StepResult` and an artifact write never fails a run, so nothing here is *expected* to
throw — but an engine defect that escapes has to land somewhere a host can put it, and without this
it lands nowhere: `runFlow`'s promise rejects at a point where the host has already resolved its own
(it resolves at `run:start`, so a run can be watched and cancelled while it executes), and a watching
app is left with a run that is running forever and a cancel with nothing to cancel. The failure is
reported as a run that failed, carrying a `run-failed` diagnostic, and the rejection still propagates
for a host awaiting the result. A host is then wrong only if it ignores what it is told, rather than
having been told nothing.

### 13.3 App integration

All renderer code for flows lives under **`packages/bruno-app/src/fork/`** — a directory upstream
will never create, so nothing in it can ever conflict:

```
packages/bruno-app/src/fork/
  registry.js               # the single delegation surface upstream files call into
  flows/
    FlowTabPane/index.js
    FlowSidebarSection/index.js
    slice.js
```

Upstream files do not gain feature logic. They gain **one delegating line each**, calling into
`fork/registry.js`, which is where flow panes, tab labels, reducers, sidebar sections, and tab
types are actually registered. UI beyond this wiring is deliberately out of scope for this spec.

The Electron side needs no such indirection: `registerFlowIpc` is a new
`bruno-electron/src/ipc/flow.js`, wired by the one `require` + call that every IPC domain already
adds.

### 13.4 Fork isolation

This repository is a fork of Bruno's open-source repo and merges regularly from upstream `main`.
Every line of fork code sitting inside a file upstream also edits is a merge conflict, re-paid at
every merge, forever. Keeping that footprint small is a design constraint on this feature, not an
implementation detail (goal 6).

**What the design avoids entirely.** Flows require **no** change to `bruno-lang`'s grammar,
`bruno-filestore`'s serializers, or `bruno-schema`'s Yup schemas — the layers upstream changes most
often. Flows own their format and validation (§15). The CLI needs **zero** upstream edits:
`yargs.commandDir('commands')` auto-registers `commands/flow.js`.

**The complete upstream touchpoint manifest.** This table is the contract — it is the list to
re-check after every upstream merge, and a change that adds to it needs justifying:

| Upstream file | Edit | Lines |
|---|---|---|
| `package.json` (root) | add `packages/bruno-max-flow` to `workspaces` | 1 |
| `package.json` (root) | add `build:bruno-max-flow`, and call it from `scripts/setup.js` | 2 |
| `.github/actions/common/setup-node-deps/action.yml` | build the engine in CI | 1 |
| `eslint.config.js` | add the package to `mainLintFiles` | 1 |
| `packages/bruno-cli/package.json` | add engine dependency | 1 |
| `packages/bruno-electron/package.json` | add engine dependency | 1 |
| `bruno-electron/src/index.js` | `require` + call `registerFlowIpc` | 2 |
| `bruno-electron/src/index.js` | `await ipc/flow.shutdown()` in the `before-quit` chain (002 §4.2) | 1 |
| `bruno-app/jsconfig.json` | add the `fork/*` path alias | 1 |
| `bruno-app/…/RequestTabPanel/index.js` | import + delegate to the fork pane registry | 2 |
| `bruno-app/…/RequestTabs/RequestTab/index.js` | import + spread fork types into `specialTabs`, and pass `tabName` on the fallback branch | 3 |
| `bruno-app/…/RequestTabs/RequestTab/SpecialTab.js` | import + a `default:` case delegating the label | 4 |
| `bruno-app/…/providers/ReduxStore/index.js` | import + spread fork reducers into the map | 2 |
| `bruno-app/…/components/Sidebar/index.js` | import + spread fork sidebar sections | 2 |
| `.gitignore` | ignore `.bruno-runs/` (§14.5) | 1 |

**The counts include the `import` line**, which the first version of this table did not — every
delegation needs one, and a manifest that undercounts by a third is not the thing to re-check a merge
against. `SpecialTab.js` is four because its switch had no `default:` to extend, so the delegation is
a three-line case rather than an expression.

**A tab type needs two registrations in the tab strip, not one.** `SpecialTab.js` supplies the label,
but `RequestTab/index.js` decides whether a tab is *special at all* — a type missing from its
`specialTabs` list falls through to a branch that looks the tab up as a request in a collection,
finds nothing, and renders "Not found". Registering only the label produces a tab that opens
correctly and is titled as missing. The `tabName` on its fallback branch is the second line: the
terminal `<SpecialTab>` passed only `type`, so every fork tab would otherwise share one static
label.

The build rows are here because a fork package whose `dist/` is gitignored is invisible to a fresh
clone: the engine resolves through `main`, so without them `npm run setup` completes and the app then
fails to boot on `require('@bruno-max/flow')`. They were found by a clone on a second machine, not by
CI, because until `bruno-electron` required the engine at startup the only consumer was a lazily
loaded `bru` subcommand.

`bruno-app/jsconfig.json` earns its row the same way `eslint.config.js` does: the bundler resolves
bare specifiers only through that `paths` map, so without `fork/*` every upstream delegating line
would have to be a relative `../../fork/registry` — which is both uglier and *more* fragile across a
merge that moves a file. One entry in a list that changes about never, and a second fork feature
reuses it.

`eslint.config.js` earns its row by the same argument as the `workspaces` line above it: the file
gates linting on an explicit `mainLintFiles` allowlist, so a fork package that is not named there is
silently unlinted, and fork code held to a lower standard than the code around it is the more
expensive mistake. It is one glob at a stable point in a list that changes only when a package is
added, and a second fork package costs one more.

**`tabs.js` left this table when the feature was built, and the reason generalises.** It was claimed
for two lists — `NON_CLOSABLE_TAB_TYPES` and the `nonReplaceableTabTypes` declared *inside* a reducer
body — and a flow needs neither. It is closable, and the second list is singleton *per type*, which
would collapse every flow in a collection into one tab; the per-pathname dedupe a flow actually wants
is already `addTab`'s default, and permanence comes from passing `preview: false` at the call site.
The lesson worth keeping is that an upstream list is only worth extending when the fork's semantics
genuinely match its, and the awkward edit inside a reducer body is a hint that they may not.

Everything else — the engine, the renderer components, the Redux slice, the IPC handler, the CLI
command — lives in files upstream does not have. **Reporters (§14.8) add no row either:**
`packages/bruno-cli/src/fork/flow/reporters/` and `@bruno-max/flow`'s `types/reporter.ts` are both
new files, and `--reporter` is a flag on the same `commands/flow.js` builder the table above already
covers, so the feature costs this manifest nothing further.

**The hooks amortize.** Establishing these delegation points is a one-time cost paid by the first
fork feature. A second feature registers into the same registry and adds **zero** new upstream
edits. That is the justification for indirection a non-forked codebase wouldn't need: the cost is
paid once, the saving recurs at every merge.

**Rules for implementation:**

- Never inline feature logic into an upstream file. The line there delegates and does nothing else.
- Place each insertion at a stable, low-churn point in the file, and keep it to a single line where
  the surrounding code allows.
- New fork packages use the `@bruno-max/*` scope in `packages/bruno-max-*` directories, so a future
  upstream package never collides by name or path.
- If upstream later ships a real extension point for one of these seams, migrate the hook onto it
  and delete the fork's version.

---

## 14. CLI

`bruno-cli` uses `yargs.commandDir('commands')`, so a new `commands/flow.js` auto-registers.

```
bru flow run <path...>        Run one or more flows (file, glob, or directory)
bru flow list [path]          List discovered flows with their ids, tags, step counts and kind
bru flow schema [--out <p>]   Emit the JSON Schema for the flow document (§5.4)
                              --version <n> selects a format version; --editor adds editor settings
bru flow validate <path...>   Static validation; sends no requests
```

### 14.1 `bru flow run`

| Flag | Purpose |
|---|---|
| `--env <name>` | Bruno environment to run against |
| `--global-env <name>` | Workspace environment to run against — `<workspace>/environments/<name>.yml`, the file and flag `bru run` already uses; the name is recorded as the run's origin (§14.8.1) |
| `--env-var k=v` | Override a single variable (repeatable) |
| `--param k=v` | Supply a declared `params` value (repeatable); for running a library flow directly |
| `--dataset <path>` | Override the flow's dataset |
| `--concurrency <n>` | Override `config.concurrency` |
| `--max-run-duration <ms>` | Bound the whole run; elapsing takes the cancellation path and exits 4 (§11.3) |
| `--tags` / `--exclude-tags` | Filter flows by `meta.tags`, matching `bru run`'s existing tag filtering |
| `--bail` | Stop after the first failing flow when several were selected |
| `--reporter <spec>` | Repeatable. `<module>` or `<module>=<path>`; `<module>` is a built-in (`junit`\|`junit-flows`\|`json`\|`html`), a path, or a package name. `=<path>` is optional for a built-in — it defaults into the invocation's suite directory, alongside every selected flow's own run directory (§14.8.5) — and required for a custom module |
| `--reporter-junit [<path>]` | Sugar for `--reporter junit[=<path>]`; omitted, it defaults into the invocation's suite directory (§14.8.5) |
| `--reporter-junit-flows [<path>]` | Sugar for `--reporter junit-flows[=<path>]` — one testcase per flow rather than per step (§14.8.1b) |
| `--reporter-json [<path>]` | Sugar for `--reporter json[=<path>]` |
| `--reporter-html [<path>]` | Sugar for `--reporter html[=<path>]` |
| `--reporter-option k=v` | Repeatable; passed to every reporter's `ReporterContext.options` (§14.8) |
| `--strict` | Promote §14.3's warnings to errors (exit 2) |
| `--show-sensitive` | Disable masking **for stdout only**; never affects reporter files or captures (§14.4) |
| `--verbose` / `--quiet` / `--silent` | Console detail level (§14.7) |
| `--no-color` / `--no-unicode` | Disable ANSI colour or box-drawing glyphs (§14.7) |
| `--no-capture` / `--capture-dir <path>` | Disable capture, or relocate the capture root (§14.5) that each invocation's suite directory (§14.8.5) is written under |
| `--dry-run` | Materialize and validate every step, send nothing |

Directory and glob arguments **skip library flows** (§12.5). Naming a library flow explicitly runs
it.

**Selected flows run one at a time, in path order.** `config.concurrency` bounds steps *within* the
running flow (§9.2) and never spans flows, so the number of in-flight requests is the same whether
one flow or forty were selected.

Sequential is the default because flows in a collection routinely exercise the same backend state —
two flows creating the same fixture tenant, or one asserting a list another appends to. Running them
concurrently would make a suite's result depend on scheduling, which is the kind of flakiness a test
runner exists to remove rather than introduce. Path order rather than discovery order makes a run
reproducible across machines and filesystems.

`--bail` stops after the first failing flow; without it the whole selection runs and the exit code
reflects the worst outcome (§14.2).

**Discovery** covers both scopes: `bru flow run` walks up for `bruno.json` and `workspace.yml` to
locate the collection and workspace roots, then resolves paths against whichever contains them. A
bare `bru flow run` with no path runs every non-library flow in the current collection, or in the
workspace when invoked outside one.

**`--env` resolves** collection environments → workspace/global environments, first match wins. A
workspace-scoped flow simply has no collection tier. Those are **two** tiers, not three: a
workspace's environments are what Bruno calls global environments, one mechanism served by
`renderer:get-global-environments` (§5.1, and [002](./002-api-flows-ui.md) §7.2).

`--dry-run` is what makes §7.1's spec-coupling safe to live with: it prints the effective request
for every step, so a spec change's blast radius is inspectable before it runs. It also runs
`validateRequest` (§10.1) against each materialized body, so a type or shape broken by a spec edit
is reported offline rather than as a 400 from the API. It also prints each
step's **resolved outputs and where each was declared** — inline, collection connector file, or
workspace connector file — which is what keeps §8.5's shared declarations discoverable.

### 14.2 Exit codes

Shared by `run` and `validate`:

| Code | Meaning |
|---|---|
| `0` | All flows passed (or validated clean) |
| `1` | A step, assertion, or schema validation failed |
| `2` | Flow file invalid — parse error, cycle, unresolved operation, visibility violation; also warnings under `--strict` |
| `3` | Usage error — bad flags, no flows matched |
| `4` | Run cancelled — Ctrl-C, `SIGTERM`, CI timeout (§11.3) |

Separating `1` from `2` matters in CI: a broken flow file is an authoring problem, not a failing
API. `4` matters for the same reason — an interrupted run is neither.

`bru flow validate` only ever returns `0`, `2` or `3`, since it sends nothing.

`--strict` promotes every warning listed in §14.3 to an error, so a pipeline can gate on undeclared
dependencies or shadowed namespaces instead of only on hard failures. It applies to both `run` and
`validate`.

### 14.3 `bru flow validate`

Static checks, no network. The **document schema (§5.4) runs first**; everything below it needs the
resolved graph or the bound OpenAPI documents, which is why it cannot:

- YAML parses; `version` is known; the document satisfies §5.4's schema
- Step ids match §5.3's pattern and are unique
- Warning: an unknown property — flagged for the author, not fatal, so a file from a newer Bruno
  still runs (§5.4)
- Every `apis` alias resolves; every `operation` resolves unambiguously
- Every inline `body` / `query` / `headers` / `pathParams` override names a field that exists in
  the operation's schema, with a did-you-mean suggestion on a near miss (§7.1)
- Every `uses:` target resolves; the cross-file graph is acyclic
- Every `required` param is satisfied at each call site, and **every key in `with:` names a declared
  param** — `unknown-param`, with a did-you-mean suggestion. An argument the sub-flow does not
  declare is otherwise dropped in silence and the sub-flow runs on its default, so the failure
  surfaces far from the typo that caused it
- A `uses:` step carries only the fields §12.4 permits; `dataset:` never appears in a sub-flow
- Every `exports` entry references a real internal step output
- Every connector-file entry resolves to a real operation, and its paths check against that
  operation's response schema (§8.5)
- Every `auth:` reference names a declared profile; a workspace-scoped flow never relies on the
  implicit `collection` profile
- Warning: an `apis` binding whose `color` is not `#rgb` or `#rrggbb` (§6.2) — a viewer falls back
  to its unpainted default there, which is what a binding with no colour looks like, so nothing else
  would tell the author their typo from a colour they never declared
- Warnings: a `stages:` boundary that cannot be drawn — `unknown-stage-step`, `stage-boundary-order`,
  `stage-out-of-order` (§5.5). Suppressing the rule leaves a graph with no line where the author
  wrote one, which is what declaring no stage at all looks like
- Every `functions.use` entry resolves and stays inside the scope root; every function name is a
  JavaScript identifier (§8.6). Both are one broken prelude, which is every script position in the
  flow failing at once — a warning where a name shadows `res` or `ctx`
- Steps authenticating with a profile that reads `{{steps.*}}` have that step as a transitive
  ancestor (§6.4); the same holds for a step whose binding `baseUrl`, `defaultHeaders` or
  `defaultQuery` reads `{{steps.*}}` (§6.3)
- The graph is acyclic; every `depends` names a real step; step ids are unique; every `status` value is one of `success` / `failed` / `skipped` / `cancelled`
- A `depends` mapping carries exactly one of `all:` or `any:`, and its list is non-empty
- Every `{{steps.*}}` reference names a **transitive ancestor** (§8.4), and resolves to either one
  of that step's declared outputs or one of §8.3's built-in metadata fields. Naming a non-ancestor
  is an error; naming an ancestor's *undeclared* `.body` is the warning below, not an error
- Every `shared:` entry on a step names a declared slot and one of that step's own declared
  outputs; every `{{shared.*}}` reference names a declared slot and sits **downstream of every
  writer of that slot** (§9.1)
- Every `when:` and `assert:` expression parses, and its operator is known; both reference only
  ancestor steps (§8.4), and `when` references no `res.*` or `req.*`, which do not exist before the
  request is built (§9.3)
- No step declares both `operation:` and `uses:`, or both `body:` and `bodyFile:` (§7.4)
- Every `!file`, `bodyFile:` and `dataset:` path resolves **within the scope root**, and every
  statically-known one exists (§7.4)
- `!file` appears only where the operation accepts one: a `multipart/form-data` part, or the whole
  body of a single-payload media type, whether written as `body: !file` or `bodyFile:` (§7.5). Its
  `filename:` and `contentType:` options are multipart-only
- `contentType:` on a step appears only where the operation declares more than one request media
  type, and names one of them; an operation declaring several with no `contentType:` on the step is
  `ambiguous-media-type`, listing the choices (§7.5)
- Every `body:` key on a multipart operation names a part in the operation's schema, and every
  required `format: binary` part is supplied (§7.5)
- No `vars:` entry references `{{steps.*}}` or `{{shared.*}}`, neither of which exists when `vars:`
  are evaluated (§7.3)
- No step explicitly sets a field its resolved signing-mode profile (`awsv4`, `digest`, `ntlm`,
  `wsse`) would compute — a partial override invalidates the signature (§6.4)
- `!...` appears only where a value can be dropped — inside `body` / `query` / `headers` /
  `pathParams` — and never as a step or top-level key (§7.2)
- Warnings: undeclared `.body` dependencies (§8.3), shadowed reserved namespaces (§7.3),
  unreachable steps, outputs or exports declared but never consumed
- Warning: a flow declaring a `required` param with no `default` that is not marked
  `meta.library: true` (§12.5) — the flag was probably forgotten, and a glob run will report a
  missing-param failure that says nothing about the cause. A warning, because taking a required
  param from `--param` on every invocation is legitimate
- Warning: `failOnStatusCode: false` on a step with no `res.status` assertion — the step then
  accepts any status at all, including the 500 it did not mean to allow (§10.3)
- Warning: a slot read on a path carrying no writer, or a declared slot never written or never
  read. Warnings rather than errors, because an empty slot is a legal outcome (§11.2) — the check
  catches the typo case without outlawing a slot only some runs populate

### 14.4 Redaction

This policy governs **everything the runner emits** — stdout, `--dry-run` output, every reporter
file, and any captured request/response on failure. Two mechanisms, because each covers the
other's blind spot:

**1. Provenance tracking (primary).** As values are resolved during interpolation, the engine
records those originating from a `secret: true` environment variable or from a credential field of
an auth profile (`token`, `password`, `clientSecret`, `privateKey`, …). Those values are then
masked **wherever they subsequently appear** — request header, query string, body, response body,
or an error message that echoed them back.

Provenance is what makes this robust: an API key placed in a query param is caught just as a
bearer token in a header is, without anyone predicting where a secret might travel. It follows a
value into a shared slot (§9.1) for free, since promotion copies the value and tracking is by value
rather than by the name it is currently under.

**2. Header-name denylist (backstop).** `Authorization`, `Proxy-Authorization`, `Cookie`,
`Set-Cookie`, `X-API-Key`, `X-Auth-Token`, and `API-Key` are masked regardless of origin, extended
by `config.redactHeaders`. This catches the case provenance cannot: a credential hardcoded
directly in a flow file, which has no secret-variable origin to trace.

Masked values render as a fixed `••••` — never a length-preserving mask, which leaks the size of
the secret.

**Redaction is applied before serialization**, so a secret is never written into a file buffer and
then removed.

`--show-sensitive` disables masking **for stdout only**. It has no effect on reporter files, ever.
Stdout is ephemeral and local to whoever ran the command; reporter files get archived as CI
artifacts, attached to tickets, and committed by accident. Those two deserve different defaults,
and the safe one should not be overridable by a flag someone copy-pastes into a pipeline.

The existing `--reporter-skip-headers`, `--reporter-skip-all-headers`,
`--reporter-skip-request-body` and `--reporter-skip-response-body` flags continue to work and
compose with this: redaction is applied in addition to them, not instead of them.

### 14.5 Capture

**Every step is captured on every run**, not only failures. A green run is often the thing you
need to compare a red one against, and a step that succeeded is frequently where a later failure's
bad value entered.

Captured for each step: the materialized request (method, URL, headers, body), the response
(status, headers, body, duration), and the assertion and schema-validation outcomes. **Each retry
attempt is captured separately** and indexed — a step that polled ten times records ten attempts,
which is usually the only way to see what changed between them. Skipped steps record their status
and skip reason; no request was made, so there is nothing else to store.

Sub-flow steps are captured under a namespaced id (`auth/login`) so a shared flow's internals are
visible without colliding with the parent's step ids.

**The engine writes this directory**, through the `WriteFile` and `RemoveDirectory` ports of §13.2.
Every path below is computed by the engine, so the layout is identical whichever host is running and
`listRuns` / `readCapture` (002 §11.2) can read back what either one produced. A host supplies the
two primitives and nothing more — it does not decide names, nesting, or what a run directory
contains.

**Storage is split.** Reporters carry a truncated inline preview for quick reading; the
untruncated payload is written to an artifact directory:

```
.bruno-runs/
  2026-08-05T14-22-01Z-a3f9/          # startedAt, made path-safe, + the runId's first four hex
    run.json
    flow.json                         # the graph this run executed
    flow.yml                          # the flow's own text at run time
    summary.json
    verify_ledger/
      attempt-1.json
    await_settlement/
      attempt-1.json
      ...
      attempt-10.json
    export_ledger/
      attempt-1.json                  # names the sibling below
      attempt-1.response.pdf
```

**Every run lives in a suite directory.** A run on its own opens a suite of one, minted from its own
id so the pair carries the same four hex; a host running several flows opens one suite and writes
every run into it, beside the reports that invocation was asked for (§14.8.5). One command's output
is one folder either way, and every run sits at the same depth whoever produced it:

```
.bruno-runs/
  suite-2026-08-05T14-22-01Z-a3f9/    # the app running one flow — a suite of one
    2026-08-05T14-22-01Z-a3f9/        # …sharing the run's four hex
  suite-2026-08-05T14-31-07Z-b1c4/    # one `bru flow run` over several flows (§14.8.5)
    report-junit.xml
    report.json
    report.html
    2026-08-05T14-31-07Z-c2d1/        # the invocation's runs, one per flow, unchanged inside
    2026-08-05T14-31-09Z-e4f2/
```

A run directory's contents are identical either way — the nesting decides where a run is, never what
it holds, and `RunResult.captureDir` and `run:start` (§13.2) name the run directory as they always
have. Nothing nests below a run: the suite level is exactly one deep.

`listRuns` (002 §11.2) reads runs inside suites and reports which suite each belongs to. It also
still lists run directories sitting **directly** in the capture root: those are runs written before
the suite was the unit, kept readable rather than dropped from a user's history.

**One file per attempt, holding the whole `StepCapture`** (002 §11.2) — request, response,
assertions and schema-validation outcomes together, which is exactly the object `readCapture`
returns. Splitting it into `attempt-1.request.json` and `attempt-1.response.json` would mean a third
file for the outcomes, three reads to answer one question, and three partial states a killed run can
leave behind. The ten-attempt poll is the case that decides it: ten files rather than thirty, each
one independently parseable, which is what makes an interrupted run readable at all.

**Textual bodies are stored inline and untruncated.** Binary bodies are **never** previewed and
never inlined: the capture records content type and byte length and names a sibling artifact written
with an extension derived from the content type — `attempt-1.request.<ext>` and
`attempt-1.response.<ext>`.

```json
"capture": {
  "response": {
    "status": 200,
    "preview": "{\"entries\":[...",
    "truncated": true,
    "originalSize": 2101440,
    "full": ".bruno-runs/2026-08-05T14-22-01Z-a3f9/verify_ledger/attempt-1.json"
  }
}
```

Previews truncate at `config.capturePreviewBytes` (default 8 KB). The `preview`, `truncated` and
`originalSize` fields are the *reporter's* inline copy, and never appear in the file `full` points
at — that is what "storage is split" means.

**A step directory exists only where a step made a call.** Skipped steps and `uses:` containers
record their status and reason in `summary.json` and store nothing else, so listing a run directory
yields exactly the steps that were attempted — which is the list 002 §10 renders for a run whose
`summary.json` is missing.

**Each step id is one flat directory.** A sub-flow's namespaced `auth/login` becomes `auth__login`
rather than a nested `auth/login/`: a run directory then lists as the step ids it holds instead of
having to be walked, and a container step can never be both a directory's parent and a step
directory itself. §5.2 already constrains ids to `^[a-zA-Z_][a-zA-Z0-9_]*$`, so the only hazards
left are the Windows reserved device names an id may legally spell — `CON`, `PRN`, `AUX`, `NUL`,
`COM1`–`COM9`, `LPT1`–`LPT9` — and total path length. A reserved name takes a trailing `_`, and a
segment over 64 characters is truncated with a short hash of the full id appended, per
`.claude/rules/cross-platform.md`.

**Dataset iterations nest under a per-iteration subdirectory** — `iteration-0/verify_ledger/…` —
and *only* when the flow declares a `dataset:`. A flow without one runs a single iteration whose
index is always `0` (§13.2), and an `iteration-0/` level that never has a sibling is a directory
every reader would have to know to skip.

#### `run.json` and `summary.json`

**`run.json` is written when the run starts; `summary.json` when it ends.** The first carries
identity — `runId`, the flow's path, and `startedAt`; the second carries the outcome.

The split matters because a directory named for a timestamp and a short id says nothing about which
flow produced it. With only the end-of-run file, a run's identity does not exist until it finishes,
so **a run in progress and a run that died cannot be attributed to a flow at all** — the first is not
an edge case, it is every run while it is being watched (002 §10 lists both). Writing identity up
front costs one small file and makes the directory self-describing from its first moment.

**`flow.json` and `flow.yml` are the flow as it was when the run started**, written beside `run.json`
and before the first step for the same reason it is: a run that dies has to stay readable.

Without them a run directory describes its flow by *path*, and the file that path names moves on. A
reader then has no choice but to paint the run's outcomes onto the flow's current graph, where a step
renamed since silently loses its result, a step added since appears as one that never ran, and edges
the run never had are drawn across it. None of that fails loudly; it just shows a run that did not
happen. `flow.json` is the `FlowDescription` (002 §11.1) the run was started from — what a viewer
draws — and `flow.yml` is the text it came from, for the question a description cannot answer and for
the diff against what the file says now.

**`run.json` also carries `flowHash`**, the digest of that text. It rides in the manifest rather than
in the snapshot because `listRuns` (002 §11.2) reads only that file per run: reporting that a run
predates the flow's current text has to cost one small read per directory, not a parse of every
snapshot in the history. A run written before this existed has no hash, which is *unknown* rather
than unchanged — a reader must not report an old run as matching a file nobody can prove it matches.

**The engine writes them, not the host.** A `bru` run and an app run record the same thing, and the
CLI — which has no graph of its own — would otherwise be the one to go without. The description is
built by calling `describeFlow`, so a stored graph and a live one are the same computation over the
same file; the cost is one describe per run, alongside the parse the run does anyway.

**A snapshot that cannot be built never fails the run.** Describing resolves OpenAPI documents and
can fail on a network the run itself may not need. Such a run proceeds and records everything else,
and is read back the way every run was read before snapshots existed.

An interrupted run — `run.json` present, `summary.json` absent — is a real state and not a corrupt
one: the process was killed, or the machine lost power, which §11.3 covers for the cases the engine
can see and cannot cover for the ones it cannot. Such a run has **no status**, and a reader must not
synthesize one; the captures that exist are the record of what happened.

**Uploaded files are captured by reference, not by content** (§7.5): source path, filename, content
type and byte length. The source path is the one the flow wrote, relative to it rather than
absolute — `run.json` names the flow, so the reference resolves, and an absolute path would record
one machine's layout in an artifact meant to be read on another. Copying them in would put the
fixture corpus into every run's artifact, and
unlike a response body the content is already in the repository — the reference is the more useful
record anyway, since it names which fixture was sent.

**`run.json` also records the run's `origin`** — which host started it, and the names of the
environments it ran against. It rides in the manifest for `flowHash`'s reason: `listRuns` reads only
this file per run, so a history that says where each run came from costs one small read per
directory rather than a second artifact or a parse of every result. Absent on a run written before
it was recorded, and on a host that named none.

**Redaction (§14.4) applies to the artifact directory exactly as it does to reporter output.**
This is the more important of the two: `.bruno-runs/` is precisely the thing a CI job uploads as a
build artifact, and `--show-sensitive` never affects files.

**Nothing is ever pruned.** The capture root grows with every run, and clearing it is the user's.
The alternative — a bound that silently deletes the oldest runs — is the worse failure: the
directory is exactly what a CI job archives and what a user opens a week later to compare a
regression against, and a run that vanished on a schedule nobody chose is indistinguishable from one
that was never written. Growth is visible, recoverable and gitignored (below); silent deletion is
none of the three. §19 keeps a retention policy as future work, on the condition that it is chosen
rather than assumed.

`--no-capture` disables capture entirely for pipelines that want minimal artifacts, and
`--capture-dir` relocates the output; a host that supplies its own directory is saying where runs
go, and the engine mints no suite of its own beneath it.

**Location.** `.bruno-runs/` is written at the **root of the scope that owns the flows being run** —
the collection root for a collection-scoped run, the workspace root for a workspace-scoped one. It
is never placed relative to the current working directory, so the same command produces the same
layout wherever it is invoked from. `--capture-dir` overrides it.

**`--capture-dir` is the one exception to §13.2's scope-root containment, and only for the root
itself.** Containment exists because a *flow file* names the paths it reads (§7.4), and a flow
arriving on a teammate's branch must not be able to reach outside the scope. The capture root is
named by whoever ran the command, not by the flow — a CI job writing artifacts to a build directory
is the ordinary case, and refusing it would leave `--capture-dir` with nothing useful to point at.
Everything *inside* the root is still engine-computed and still contained: no step id, iteration
index or artifact name can escape the run directory, which is the property the rule was protecting.

`.bruno-runs/` must be added to that scope's `.gitignore` on creation — captured payloads are run
output, not source, and they contain response data that has no business in a repository.

The engine exports both halves of that rule — the root's path and the ignore entry — because §14.8's
report files default into the same directory, including under `--no-capture`, where no capture is
ever created to write the entry. A host computing either for itself would be a second copy of this
section, free to drift from it.

Those files go in the invocation's own `suite-<startedAt>-<id>/` directory (§14.8.5), alongside the
run directories it holds. The `suite-` prefix keeps the name out of the run-directory pattern, so a
suite is never mistaken for a run — `listRuns` descends into it rather than listing it. A batching
host creates and clears its own; a run given no directory opens one for itself.

**This is a different file from §13.4's manifest entry, and both are needed.** The manifest ignores
`.bruno-runs/` in *this repository*, which covers runs against the collections living here. A
collection or workspace a user opens from anywhere else has its own root and its own repository, and
only the on-creation write reaches it.

### 14.6 Status and reason vocabulary

These strings appear in `RunResult` (§13.2), in every reporter, and in `--reporter-json` output that
CI consumes. **They are a public contract**: additive only, never renamed, and defined here rather
than in the section that happens to introduce each one — a vocabulary spread across ten sections is
one that drifts.

**Statuses.** A step is `success`, `failed`, `skipped` or `cancelled` (§9.1). A flow or iteration is
`passed`, `failed` or `cancelled` — deliberately *not* the step words, so a log line is unambiguous
about what it describes.

**Step reasons.** Present whenever a step is not a plain `success`.

| Reason | Status | Meaning |
|---|---|---|
| `unexpected-status` | failed | Status >= 400 with `failOnStatusCode` on (§10.1) |
| `invalid-request` | failed | The request failed `validateRequest`; nothing was sent (§10.1) |
| `schema-validation-failed` | failed | The response did not match the spec's schema for its status (§10.1) |
| `assertion-failed` | failed | One or more `assert:` entries failed (§10.2) |
| `transport-error` | failed | No response — connection refused, DNS failure, TLS error, request timeout (§11.2) |
| `retries-exhausted` | failed | The retry predicate still wanted to retry at `maxAttempts` (§11.1) |
| `max-duration-exceeded` | failed | The step's own `maxDuration` elapsed (§11.1) |
| `file-read-failed` | failed | A `!file`, `bodyFile:` or `dataset:` source could not be read (§7.4) |
| `script-error` | failed | A `script:` output, a `when:` condition or `shouldRetry` threw (§8.2) |
| `subflow-failed` | failed | A step inside an invoked sub-flow failed (§12.4) |
| `unmet-dependency` | skipped | No parent outcome satisfied `depends` (§9.1) |
| `condition-false` | skipped | `when:` evaluated false (§9.3) |
| `unresolved-dependency` | skipped | A referenced output was never produced (§11.2) |
| `run-cancelled` | skipped, or **cancelled** where the step had started | The run stopped (§11.3) |

A step that failed carries exactly one reason — the **first** check to fail, in §10's evaluation
order: request validation, then status, then response schema, then assertions. Reporting the first
is what makes a failure actionable; a 500 that also fails four assertions is one problem, not five.

**A step's reason explains the step; `RunResult.decidedBy` (§13.2) explains the run.** A reader
looking at a red run asks which step made it red, and for `failOnUnresolved` the answer is a step
whose own status is `skipped` — so the verdict names it rather than leaving the reader to infer it
from a rule they cannot see the inputs to.

**A reason names the rule; `StepResult.message` (§13.2) names the occurrence.** These strings are a
closed vocabulary precisely so they can be matched on, which is the same property that keeps them
from saying which reference, which status or which field — so the engine reports both, and a host
that shows only the reason leaves the reader with a category where they wanted a fact. The message is
not part of this contract: it is human text, additive, and nothing parses it. Every reason above may
carry one, and the four skips are where it matters most — a skip has no capture to fall back on, and
`unresolved-dependency` fails the whole run (§11.2) while looking like a step that merely did not
happen.

Request validation leads because §10.1 runs it **before dispatch**: a step that fails it never
sends, so it has no status to be judged on and `invalid-request` and `unexpected-status` are never
candidates for the same step.

A script that **throws** fails its step, in all three positions. `shouldRetry` is the one that made
this worth stating: it runs outside the attempt it judges, against a response §11.2 may not have —
`undefined` after a transport error — so a predicate reaching into a body is one dropped connection
away from throwing, and a throw there propagates past the step, past the scheduler and out of
`runFlow`. That is not a worse error message; it is a different kind of failure, landing where no
step can carry it (§13.2).

`script-error` (§8.2) takes its place in that same order rather than overriding it, since the three
script positions run at three different points: a `when:` condition before the request is built —
ahead of every other check — an output between response-schema validation and assertions, and
`shouldRetry` after them. A step that returns a 500 *and* has a throwing output therefore reports
`unexpected-status`, because the 500 is what happened first and is the thing to fix first.

**Diagnostic codes** (§13.2's `Diagnostic.code`) are `kebab-case` and name the rule rather than the
occurrence — `parse-error`, `unknown-operation`, `cyclic-dependency`, `non-ancestor-reference`,
`undeclared-dependency`, `unresolved-alias`, `path-outside-scope`, `signing-mode-field-override`,
`invalid-step-id`, `unknown-param`, `ambiguous-media-type`. The full set follows
§14.3's check list; each check emits one code, so `--strict` and any future per-rule suppression
have something stable to name.

### 14.7 Console output

**Stdout is for humans; reporters are for machines.** The default output answers *did it pass, and
if not, where and why* with no flags. Anything that needs parsing is `--reporter-json` (§14.1),
which is why nothing below is a stable format — only the exit code (§14.2) and the reporters are.

Output is driven by the §13.2 event stream, so lines appear as steps complete rather than at the
end. A long flow shows progress, and a hung one shows where it hung — the difference between a CI
log that localises a stall and one that just stops.

#### A run

```
Checkout happy path  flows/checkout.flow.yml

  ✓ auth                 sub-flow (2 steps)      412ms
  ✓ create_payment       POST /payments          231ms
  ✓ await_settlement     GET /payments/{id}      1.4s   3 attempts
  ✗ verify_ledger        GET /ledger/{id}        189ms
  ○ premium_audit        skipped · condition-false
  ○ archive_receipt      skipped · unresolved-dependency  never produced: steps.verify_ledger.entryId
  ✓ void_payment         DELETE /payments/{id}    77ms

  verify_ledger · assertion-failed
    res.body.data.balance eq 9900
      expected  9900
      actual    8900
    capture  .bruno-runs/2026-08-07T10-14-02Z/verify_ledger/

  run failed · archive_receipt skipped · unresolved-dependency
    never produced: steps.verify_ledger.entryId

  1 failed · 4 passed · 2 skipped · 2.3s
```

`✓` success, `✗` failed, `○` skipped, `⊘` cancelled — with an ASCII fallback (`+ x - !`) when the
terminal cannot render them or `--no-unicode` is given, because a Windows console printing mojibake
is worse than a plain character.

The operation, not the URL, identifies a step: it is what the flow file names, and a resolved URL
carrying interpolated ids is both long and noisy in a column. Attempt counts appear only when
greater than one — a retry is worth seeing, and "1 attempt" on every line is not.

**The failure block is the point.** For each failure: the step, its reason (§14.6), the message that
goes with it, the specific assertion with expected and actual, and the capture path. The message is
dropped where the block already expands it — a failed assertion is listed with its expected and
actual just below, and printing the same sentence twice is how a block stops being read. Bodies are *not*
inlined — they are in the capture, and a 200 KB response in a terminal buries the one line that
mattered. Only failures get a block; a passing step is one line.

**A skip carries its message on its own line**, because it never gets a block and its reason is the
half that says least: `unresolved-dependency` fails the run (§11.2) without naming the reference, and
a CI log is where nobody can go and click the step to find out.

**A verdict that no failure block accounts for gets its own line**, naming each of §13.2's
`decidedBy` steps that has no block above — which is the `failOnUnresolved` case and, today, only
that. Its reason and message are repeated from the step's own line rather than referred back to it,
because `--quiet` prints no step lines at all: without this a quiet CI run reports `run failed` over
`0 failed` and nothing else, which is the exact log that sends someone back to re-run it locally.
A step that already has a block is left to it — a block that says everything twice stops being read.

#### Datasets and sub-flows

Iterations are headed and their steps indented, so the row that failed is identifiable without
counting:

```
  iteration 2/3 · editor@example.com
    ✓ login                POST /auth/login        180ms
    ✗ add_product          POST /products          210ms
```

A sub-flow reports as a single line by default — it is one step to the caller (§12). `--verbose`
expands it to its internal steps, namespaced `auth/login` as in captures and reporters.

#### TTY versus CI

| | TTY | Not a TTY |
|---|---|---|
| Colour | yes, honouring `NO_COLOR` / `FORCE_COLOR` / `--no-color` | never |
| In-flight steps | shown and updated in place | not shown; a line is printed on completion |
| Cursor control | used | never — no ANSI in a log file |

**Under `concurrency > 1` the order of completion lines is not stable between runs**, because that
is genuinely the order things finished. The end-of-run summary and every reporter file list steps in
**declaration order**, so anything being diffed or archived has a deterministic form. Chasing
determinism in the live stream would mean withholding lines until earlier steps finished, which
would forfeit exactly the stall-localising property the stream exists for.

#### Verbosity

| Flag | Effect |
|---|---|
| *(default)* | one line per step; a block per failure; a summary |
| `--verbose` | adds request and response previews inline (truncated at `capturePreviewBytes`), expands sub-flows, and prints passing assertions |
| `--quiet` | the summary and any failure blocks only |
| `--silent` | nothing; the exit code is the whole result |
| `--no-unicode` / `--no-color` | as above |

Redaction (§14.4) applies to all of it, including `--verbose` previews. `--show-sensitive` affects
stdout only and never reporter files.

**Collapsing a sub-flow is a display choice, not a reporting one.** Its internal steps are in
`IterationResult.steps` and in the event stream either way (§13.2) — the default output prints one
line for the `uses:` step, and `--verbose` prints the internals it already had. A failure inside a
collapsed sub-flow still prints its own failure block, naming the internal step: a collapsed line
may hide detail, never a cause.

#### Multiple flows

One line per flow as it completes, then an aggregate:

```
✓ flows/checkout.flow.yml     6 steps   2.3s
✗ flows/refunds.flow.yml      4 steps   1.1s

2 flows · 1 failed · 1 passed · 3.4s
```

Failure blocks are printed under their own flow, not deferred to the end, so a `--bail` run stops
with the reason already on screen.

#### `bru flow validate`

Compiler-style, one diagnostic per line, so `grep` and editor problem-matchers work without a
parser:

```
flows/checkout.flow.yml:24:7  error    unknown-operation  no operation 'createPaymnt' in payments-api
                                                          did you mean 'createPayment'?
flows/checkout.flow.yml:41:3  warning  undeclared-dependency  step 'verify' reads steps.create_payment.body

1 error, 1 warning
```

`file:line:column  severity  code  message`, using the `code` from §14.6 so a rule can be searched
for by name. Line and column come from the YAML node, which is why the flow document is parsed with
position information retained rather than into plain objects.

#### `bru flow list`

```
id                    kind      steps  tags              file
checkout-happy-path   flow          6  checkout, smoke   flows/checkout.flow.yml
login                 library       1  —                 flows/shared/login.flow.yml
```

Library flows (§12.5) are marked because they are excluded from directory runs, and a flow silently
not running is the thing this column exists to prevent.

The `id` column is §5.2's path-derived identity shown by its final segment; when two flows share a
segment, both are printed with as much of their path as tells them apart. `file` carries the full
path either way, so the listing is never the only place the answer is.

### 14.8 Reporters

`bru flow run` writes machine-readable reports through one contract, implemented by four built-ins
— `junit`, `junit-flows`, `json`, `html` — and by any module an author supplies. JUnit is the primary
format: it is what CI gates on and what test-management tools import from.

**The unit a reporter reports on is the invocation, not the flow.** `RunResult` (§13.2) is the
engine's unit — a flow and its iterations — but `bru flow run` routinely selects a whole directory,
and neither JUnit nor a CI pipeline wants one file per flow to reassemble itself. A JUnit consumer
expects a single `<testsuites>` spanning everything that was selected; a CI job wants one artifact to
upload, not `N` it has to glob together; and `--bail` still has to produce a report that accounts for
the flows it never reached. The CLI therefore collects every selected flow's outcome into one
`SuiteResult` and hands the whole thing to each reporter once, after the last flow finishes.

**The contract.** These types live in `@bruno-max/flow`'s `types/reporter.ts`, beside `result.ts` —
the file `RunResult` is defined in:

```ts
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
  /** meta.tags, in file order. */
  tags: string[];
};

export type FlowRunRecord = FlowIdentity & {
  startedAt: string;   // ISO 8601
  finishedAt: string;
  durationMs: number;
  outcome: FlowOutcome;
  /** Absent when the flow never ran. */
  result?: RunResult;
  /** Pre-run validation diagnostics, plus a `run-refused` error when `runFlow` rejected. */
  diagnostics: Diagnostic[];
};

export type SuiteSummary = {
  flows: { total: number; passed: number; failed: number; cancelled: number; invalid: number };
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
  /** Resolved absolute path this reporter writes to — explicit via `=<path>`, or a built-in's
   *  default location in the invocation's suite directory (§14.8.5). Always present: a custom
   *  reporter cannot be named without `=<path>`, and a built-in that receives none is given its
   *  default. */
  outputPath: string;
  /** process.cwd() when the command ran. */
  cwd: string;
  /** Free-form `--reporter-option key=value` pairs, for custom reporters. */
  options: Record<string, string>;
};

/** A reporter module's default export (or `module.exports`). */
export type ReporterFactory = (context: ReporterContext) => FlowReporter;
```

**Types and implementations are split across packages for the reason §13.1 gives every other seam in
this spec: the engine's types must not drift from what it emits.** `FlowRunRecord` wraps a
`RunResult` and `SuiteResult` sums several; a reporter written against a hand-copied version of those
shapes drifts the moment `RunResult` gains a field, silently, in whichever reporter nobody remembered
to update. Declaring `reporter.ts` next to `result.ts` in `@bruno-max/flow` makes that drift a
compile error. The built-ins themselves are host **output**, not engine behavior — the engine emits
to no file of its own; §13.2's `WriteFile` port exists for capture (§14.5), and a reporter file is
produced entirely on the CLI's side of that boundary. `junit.js`, `junit-flows.js`, `json.js`,
`html.js` and the loader that resolves a `--reporter` spec and calls its factory therefore live in
`packages/bruno-cli/src/fork/flow/reporters/`, the same fork-owned tree as the rest of the command.

**Hooks are optional and awaited in declaration order** — one reporter's `onFlowEnd` finishes before
the next reporter's fires, and a reporter that streams incrementally can rely on that ordering rather
than racing its own writes. **A hook that throws is printed to stderr as `reporter <name>:
<message>` and the run is otherwise unaffected** — neither the run's outcome nor the process's exit
code depends on any reporter, so a broken reporter cannot take a passing run down with it, the same
guarantee §13.2 already makes for a throwing `onEvent` consumer. Reporters run for `run` only —
`validate` sends nothing and produces no `RunResult` to report on. `--silent` and `--quiet` govern
stdout only (§14.7); a reporter file is written regardless, because it is frequently the *reason* a
CI log can afford to be quiet. `<module>` in a `--reporter` spec resolves as a built-in name
(`junit`, `json`, `html`), then a path when it starts with `.` or `/` or is absolute, else a package
name resolved from `cwd` — the same order `require` would use. **A custom module named without
`=<path>` is a usage error (exit 3)** — it has no default location to fall back to (§14.8.5), unlike
a built-in, and a reporter nobody can find afterward is worse than an upfront rejection. A custom
module that fails to resolve, or whose export is not a function, is also exit 3. An *explicit* output
path whose parent directory does not exist is exit 3 too, checked for every `--reporter` before any
flow runs; a defaulted one needs no such check, because the suite directory it lands in is created
before any flow runs regardless of whether it was already there (§14.8.5) — so a long run never gets
to its last line only to fail on a typo'd path, or a folder nobody made, with nothing written. Each
reporter that wrote a file prints `Wrote <name> report to <path>` on stdout unless `--silent`.

**A custom reporter is arbitrary code, `require`d directly into the CLI's own process, so it is named
on the command line only — `--reporter ./reporters/x.js=out.txt` or a package name, always with
`=<path>` (§14.8.5) — never from `.flow.yml`, `bruno.json` or `workspace.yml`, and the app never
loads one.** A flow file is committed and shared;
if a `.flow.yml` could name a reporter module, then cloning a teammate's branch and running so much
as `bru flow validate` — or opening the collection in the app, which watches and validates on every
change (002 §6) — could execute arbitrary code the instant anyone next ran a flow-aware tool against
it, with nothing in the diff louder than an unfamiliar path. That is the exact shape of a
supply-chain injection: a repository file that is ordinary data everywhere else becoming code
execution the moment the right tool opens it. Keeping `--reporter` command-line-only keeps that
decision with the person invoking `bru`, who already extends the same trust to every flag and flow
path in the invocation — it is a different trust boundary from a flow's own `script:` blocks, which
run *sandboxed* (§8.2) precisely because a flow file's author and its runner are routinely different
people. A reporter module runs with none of that sandboxing, so the app — which opens flows nobody
present necessarily wrote — never loads one; only `bru` does, from flags a person typed.

**"Existing reporters, reused unchanged" — an earlier position — is retracted.** Upstream's
`packages/bruno-cli/src/reporters/{junit,html}.js` consume a *different* result shape: `bru run`'s
unit is a flat list of individual requests, with no notion of a graph, a sub-flow's internals, a
per-iteration suite, or a skip reason. Reshaping a flow's `SuiteResult` to fit that shape would lose
exactly the structure this format exists to report — the DAG, per-step outcomes and the distinction
between a step that failed and one that was correctly skipped — so the built-ins here are new files,
not edits to those. §19's former "a flow-shaped reporter" row is this section under a different name;
it left that table because the work it named is now specified rather than merely wanted.

**Redaction holds by construction.** A reporter's only inputs are `FlowEvent` (via `onEvent`) and
`RunResult` (via `FlowRunRecord.result` and `SuiteResult`), and §14.4's masking is applied before
either is emitted — there is no unredacted form of either type for a reporter to have been handed
instead. `ReporterContext` carries `outputPath`, `cwd` and `options`; none of those is
`--show-sensitive`, which disables masking for stdout only (§14.4) and has no path into a reporter at
all, so a custom reporter cannot opt itself out of redaction even by reading its own options.

#### 14.8.1 The JUnit mapping (step-level)

This is the `junit` reporter's shape — one testcase per step, for a dashboard or a TestRail import
that wants that granularity. A second built-in, `junit-flows` (§14.8.1b), reports one testcase per
*flow* instead, for a tracker that wants exactly one case per flow and nothing finer; both can be
written from the same run.

`<testsuites name="bru flow run" tests= failures= errors= skipped= time= timestamp=>` wraps the
whole invocation. Inside it, **one `<testsuite>` per flow-iteration** — a flow run once contributes
one suite, a flow with a `dataset:` contributes one per row.

- `name` is the flow's id (§5.2), with ` [row N]` appended (`N` = the row's 1-based index) whenever
  the iteration carries a `row` or the flow ran more than one iteration — so a single-iteration flow
  with no dataset gets a bare name, and every other case is disambiguated.
- Suite attributes: `tests`, `failures`, `errors`, `skipped`, `time` (seconds, three decimals),
  `timestamp` (ISO 8601 without the trailing `Z` or milliseconds — `YYYY-MM-DDTHH:mm:ss`, the form
  most JUnit consumers expect), `hostname`.
- Suite `<properties>`: `flow` (id), `test_id` (from the flow's `meta.testId`, present only when the
  flow declares one — so a tracker importing per suite can match the flow it belongs to), `name`
  (`meta.name`), `file` (relative to `cwd` when the flow is inside it, else absolute), `tags`
  (comma-joined, present even when there are none, so a consumer can tell "no tags" from "property
  missing"), `runId`, `status`, then `host`, `environment` and
  `globalEnvironment` from `RunResult.origin` — each present only when `origin` carries it — and,
  only when the iteration has a row, `iteration` (`N`, matching the suite name's suffix) plus one
  `row.<key>` property per dataset column, each value `String()`-coerced. The first thing a reader of
  a red build asks is which environment it ran against, and `origin` is the one place that answer
  lives.

**One `<testcase name="<step id>" classname="<flow id>" time=>` per step**, including sub-flow
internals: a namespaced id like `auth/login` (§13.2) is its own testcase, so a shared sign-in
sub-flow's steps show up as cases rather than disappearing into their container. A `uses:` step's own
testcase is **dropped** when internals carrying its id as a prefix (`auth/login`, `auth/verify`, …)
exist — otherwise the container and its contents would double-count the same work, once as a step and
once as the sum of its parts. Testcase `<properties>`, each present only when it applies: `test_id`
(from `meta.testId`, `String()`-coerced — §14.8.4), then one property per remaining `meta.*` entry —
its own key, in declaration order, a scalar `String()`-coerced and anything else JSON-stringified —
then `name` (`StepResult.name`), `reason`, and `attempts` only when more than one was made — a single
attempt is the default, and writing it on every case is noise.

**Why a testcase is a step, not an assertion.** JUnit's native unit is closer to an assertion than a
request, but a step can fail with zero assertions — a `transport-error`, an `unexpected-status` with
no `res.status` check, a `script-error` in an output. A testcase per assertion would have nothing to
report for exactly the failures §10.1's automatic checks exist to catch, and would multiply one
step's retries and one step's request into a case count nobody selected. A step is also the unit a
`meta.testId` (§14.8.4) is declared on and the unit TestRail's importer expects a case's worth of
pass/fail against — so the testcase boundary follows the file's own unit rather than JUnit's usual
one.

**Status maps to element by `reason`, not by `status` alone**, because JUnit's `<failure>` and
`<error>` distinguish an assertion the test made from a fault the test infrastructure hit — a
distinction `StepReason` (§14.6) already draws:

- `success` → no child element.
- `failed` with reason `assertion-failed`, `unexpected-status`, `schema-validation-failed` or
  `subflow-failed` → `<failure type="<reason>" message="<message, or the reason if there is none>">`,
  body below.
- `failed` with any other reason (`transport-error`, `script-error`, `invalid-request`,
  `file-read-failed`, `retries-exhausted`, `max-duration-exceeded`) → `<error type= message=>`, same
  body — these are the reasons where nothing about the flow's own logic was exercised.
- `skipped` or `cancelled` → `<skipped message="<reason>[: <message>]"/>`.
- **Exception:** a step named in `RunResult.decidedBy` (§13.2, §14.6) whose own `status` is not
  `failed` — the `failOnUnresolved` case, where a run is red with `0 failed` because a skip decided
  it — is emitted as `<failure type="<reason>">` rather than `<skipped>`, its message explaining that
  this step is the one the run's verdict fell on. Without the exception, that run's JUnit file would
  show every testcase passing or skipped and no failure anywhere — green by every count a CI gate
  reads, for a run the exit code (§14.2) already reports as failed.

Body text, for both `<failure>` and `<error>`: each failed assertion as
`expr\n  expected <json>\n  actual <json>`, each schema-validation error as
`request|response <path> <message>`, the step's own `message` — except under a failed assertion, where
it is the comparison already expanded above (§14.7's console output drops it for the same reason) —
and `capture <capturePath>` when a capture exists.

**A flow with no `result` — outcome `invalid` — becomes a suite of its own**, `tests="1"
errors="1"`, one testcase named after the flow, `<error type="<first diagnostic code>">` listing
every diagnostic in `FlowRunRecord.diagnostics`. It never ran, so there is no step to report against
and no iteration to name a suite after; one case is the closest honest description of "this flow
could not be tried."

Suite `<system-out>` carries `RunResult.diagnostics` — warnings that did not stop the run — one per
line, and `captureDir` when present.

**Every string is sanitized before it reaches `xmlbuilder`**: characters illegal in XML 1.0
(`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, and the non-characters `￾`/`￿`) are stripped
first, and `xmlbuilder` does the escaping from there — a response body or an assertion's `actual` can
contain any of those, and a JUnit consumer handed one is a parse failure instead of a report.

**Counts have to agree with what was emitted, not be computed separately**: `tests` is the number of
testcases actually written, `failures`/`errors`/`skipped` the number of each element actually
written — so a bug in the mapping shows up as a JUnit consumer rejecting a malformed count rather
than as a silently wrong one.

#### 14.8.1b Flow-level JUnit

`junit-flows` reports the same invocation at flow granularity instead of step granularity: one
`<testsuite name="bru flow run" tests= failures= errors= skipped= time= timestamp= hostname=>` for
the whole run, no `<testsuites>` wrapper around it — there is never more than one — and **one
`<testcase name="<flow id>" classname="<flow id>" time=<flow's own duration>>` per flow**, not per
step.

Testcase `<properties>`, each present only when it applies: `test_id` (from the flow's `meta.testId`,
§5.2, `String()`-coerced) **first**, `name` (`meta.name`), `file` (§14.8.1's resolution), `tags`
(comma-joined, present even when empty, for the same reason §14.8.1 keeps it), `host`, `environment`
and `globalEnvironment` from `RunResult.origin` (§14.8.1), `runId`, `status`, and `iterations` — the
row count, present only for a `dataset:` flow.

**Outcome maps to element by the same failure/error split §14.8.1 draws per step, applied to
whichever steps decided the flow's own verdict** — `RunResult.decidedBy` when the flow has one, else
every `failed` step, across every iteration the flow ran:

- `passed` → no child element.
- `failed` → `<failure type="<first deciding step's reason>" message="<deciding step ids,
  comma-joined>">` when **every** deciding step's reason is one of §14.8.1's API-disagreement set
  (`assertion-failed`, `unexpected-status`, `schema-validation-failed`, `subflow-failed`); `<error>`,
  same attributes, otherwise — one non-assertion reason among several deciding steps still means the
  test infrastructure hit a fault, not only the assertion the flow wrote. Body: one line per deciding
  step, `<step id>[ [row N]]: ` followed by that step's own body text exactly as §14.8.1 already
  formats it.
- `cancelled` → `<error type="run-cancelled">` — a flow that did not finish is neither a pass nor a
  skip, so it takes the element that says something went wrong rather than the one that says nothing
  ran.
- `invalid` → `<error type="<first diagnostic code>">` listing every diagnostic in
  `FlowRunRecord.diagnostics`, the same body §14.8.1 writes for its own invalid-flow suite.

**A dataset flow is one testcase, its rows folded inside rather than one per row** — the opposite of
§14.8.1's one suite per iteration, and deliberately so: this shape exists for a tracker that wants
exactly one case per flow and nothing finer, so a row-by-row split here would just be a worse copy of
the shape §14.8.1 already provides for whoever wants that granularity. `iterations` says how many
rows ran, and a failed row's steps are named in the body with `[row N]`, but the case count itself
never grows with the dataset.

**Why a separate reporter, not a flag on `junit`.** A report's shape is part of its identity, not a
mode switch on top of one — a CI config or a TestRail import mapping names a *file* and expects a
fixed structure inside it, and a flag that could silently change what a testcase means would break
whichever import was written against the shape already in use. `junit` and `junit-flows` are
independent built-ins for that reason, and nothing stops writing both from one run:
`--reporter-junit --reporter-junit-flows` produces `report-junit.xml` and `report-junit-flows.xml`
side by side in the same suite directory (§14.8.5).

**A flow-level case is matched by its own `test_id`, not by a step's.** A flow's `meta.testId` (§5.2)
names a case for the *flow as a whole*, a separate field from a step's `meta.testId` (§14.8.4), which
names a case for one step inside it — `junit-flows` reads the flow's, since a flow-level case has no
steps of its own to have read one from instead. A flow that declares no `meta.testId` still has no
case id to key on, and a tracker falls back to matching it by `name` or `tags`, as before.

Bare `--reporter junit-flows` or `--reporter-junit-flows` defaults to `report-junit-flows.xml` in the
invocation's suite directory (§14.8.5), alongside `report-junit.xml` when both are asked for.

#### 14.8.2 JSON

`reporters/json.js` writes `JSON.stringify(suite, null, 2)` of the `SuiteResult` above, with two
extra top-level fields — `"format": "bruno-flow-suite"` and `"formatVersion": 1` — so a consumer can
tell what it is holding without inferring it from shape. `origin` rides along on each flow's own
`result` (`FlowRunRecord.result.origin`, §14.8.1) exactly as `RunResult` already carries it — nothing
extra to compute for this format, since it is the same object the engine produced. Like every other
format this spec governs (§15), it is additive-only: a field is never removed or renamed, and
`formatVersion` moves only if one has to be.

#### 14.8.3 HTML

`reporters/html.js` writes one self-contained file — inline CSS and JS, no CDN, no external asset, no
network access at read time — so it opens correctly offline and survives as a CI artifact fetched
long after the pipeline that produced it is gone. Header (command, started/finished, duration, exit
code), summary cards, one section per flow with its iterations' step tables, and an expandable detail
block per failed or skipped step. **Every interpolated string is HTML-escaped** — a response body or
an assertion's `actual` reaches this file and neither is trusted input. Unlike JUnit and JSON, this
format is **not** part of §15's compatibility contract: it exists to be looked at by a person, not
parsed by a tool, and its markup is free to change between releases.

#### 14.8.4 Step `meta:`

A step may declare `meta:` (§5.3), an open mapping the engine carries **verbatim** onto
`StepResult.meta` and (002 §11.1's) `FlowNode.meta` — present only when non-empty — and never
interprets. Its purpose is per-step data for reporters: a test-management case id, an owner, a link
to a ticket or a runbook, whatever a team's reporting tool wants attached to a step. `testId` is the
one key a built-in reporter names specially — `String()`-coerced and surfaced in JUnit as the
testcase property `test_id`, because that is the property name TestRail's own JUnit importer reads
to match a result back to a case. Every other key in the mapping still reaches the JUnit file, as a
same-named `<property>` on the testcase (§14.8.1) — `meta:` is not a `testId`-only field that
happens to allow other keys, it is a general one that this spec's own reporter gives exactly one key
a special meaning to.

**An open mapping rather than a field per concern**, because the set of things a team wants attached
to a step is exactly as varied as the set of test-management and dashboard tools that read them —
TestRail wants a case id, another tool wants an owner, a third wants a link — and the engine has no
way to anticipate that set, let alone grow a typed field for each entrant. `meta:` is the escape
hatch that keeps that variety from ever becoming this spec's problem: a new integration is a new key,
authored today, needing no engine change and no schema version bump.

**Values travel verbatim, not coerced at the boundary, because the engine does not know what a value
means — a reporter does.** `testId: 1234` reaches `StepResult.meta.testId` as the number `1234`; it
is the JUnit reporter, not the engine, that decides `test_id` is textual and calls `String()` on it
(§14.8.1). A different reporter reading the same field might want the number. Coercing at the
boundary would be the engine picking a type on every consumer's behalf for a value it has no stake
in — the same reasoning that keeps `Vars` (§13.2) `unknown` rather than `string`.

**Named `meta:` because it mirrors the flow-level block it sits alongside (§5.2), and stays open where
that one stays closed for the opposite reason.** The flow-level `meta:` has five fixed keys, each
wired to a specific behavior — `name` titles the graph, `tags` files and (eventually) filters,
`library` changes discovery (§12.5), `testId` matches a flow-level JUnit case (§14.8.1b) — so an
unrecognized key there is genuinely a typo the §14.3 unknown-property warning exists to catch. A
step's `meta:` has no such behavior to wire into; it exists only to be *carried*, so the same warning
would misfire on every legitimate key a reporter was written to read. The schema therefore declares
step `meta:` as an open object, exempt from the unknown-property check that governs everywhere else
in the document.

**The flow-level `meta.testId` does not travel verbatim the way a step's does.** That block is
closed and typed rather than a free mapping, so its `testId` is read once and `String()`-coerced by
the engine itself, the same value every consumer then sees; a step's stays exactly the value the
author wrote — number, string, or otherwise — until whichever reporter reads `StepResult.meta` decides
what it means. Being named alike is not being governed alike: a flow declares one `testId` and the
document schema owns its type, a step declares an open `meta:` and every reporter owns its own.

**A `meta:` that is not a mapping is a `validateFlow` warning, `invalid-step-meta`, and treated as
empty** — a scalar or a list under `meta:` cannot be walked key by key into testcase properties, and
warning rather than erroring keeps a step running (and reported, minus its meta) rather than failing
a flow over a field no engine behavior depends on.

**Values must be `structuredClone`-safe**, the same constraint §13.2's events already carry, because
`meta` rides on `StepResult` through the same event stream and (in the app) the same IPC boundary —
plain YAML values already satisfy this, so the constraint costs an author nothing they were not
already going to write.

#### 14.8.5 Default locations and the suite directory

**Naming a built-in with no `=<path>` is the expected, ordinary form — `--reporter junit`, or the
bare sugar `--reporter-junit`.** Every run's output lives inside a **suite directory** — that is the
one layout, not a CLI-specific one:

```
.bruno-runs/
  suite-2026-08-05T14-22-01Z-a3f9/       # a default run — the engine opens this one itself
    2026-08-05T14-22-01Z-a3f9/           # the one flow's own run directory — same id, nested
      run.json
      summary.json
      create_payment/
        attempt-1.json
  suite-2026-08-05T15-01-09Z-c02e/       # a `bru flow run` invocation — the CLI opens this one
    report-junit.xml
    report-junit-flows.xml
    report.json
    report.html
    2026-08-05T15-01-10Z-b71c/           # flows/checkout.flow.yml's own run directory (§14.5)
      run.json
      summary.json
      ...
    2026-08-05T15-01-12Z-9e02/           # flows/refunds.flow.yml's own run directory
      run.json
      summary.json
      ...
```

`suite-<startedAt>-<id>/` names the directory: `startedAt` made path-safe the same way a run
directory's is (§14.5), `id` a UUID's first four characters. **Every run is a suite; the two cases
above differ only in who opens it and how many flows land inside.** `runFlow` (§13.2) called with no
`capture.dir` — which is what a single flow run from the app does — opens a suite of its own around
that one run, `suite-<ts>-<id>/<ts>-<id>/…`, the outer and inner directory sharing the same `<ts>-<id>`
because they are one run wearing the layout twice. `bru flow run` opens a suite the same way but
passes it in as `capture.dir` before it starts the first flow, so every flow it selects, and the
reports above (§14.8), land inside the one suite it opened rather than each opening its own — a
suite of many instead of a suite of one, the same shape scaled up. A future app feature that runs
more than one flow at once needs no layout of its own for the same reason: it is a suite of *N*,
exactly like the CLI's. An explicit reporter path (`--reporter junit=reports/out.xml`,
`--reporter-junit reports/out.xml`) is the uncommon form, for a pipeline that collects a report from a
location of its own choosing instead.

**A run directory written flat at the top of `.bruno-runs/`, from before this layout existed, is
still read by `listRuns`** (002 §11.2) as a legacy entry — the pattern that recognises a run directory
does not require a `suite-.../` parent, only the `<startedAt>-<id>` name itself, so history does not
go blank the first time this version runs. Nothing new is ever written flat, though: every run from
here on opens its own suite, of one or of many.

**One folder per run, holding both its report (when there is one) and the evidence it names, because
that is what a person or a CI job actually collects.** A report that points at `create_payment`'s
failure and a capture that shows what `create_payment` actually sent and received answer one question
together and neither on its own; keeping them apart — a report at the capture root, run directories
scattered beside it — asked whoever was debugging a failure to correlate a timestamp in the report
against a timestamp in a directory listing by hand. Nested, `suite-<startedAt>-<id>/` is the one path
a CI job downloads as a build artifact and a person `cd`s into, and everything either of them needs is
already under it — true whether that suite holds one flow or forty.

**Nothing under `.bruno-runs/` is ever pruned automatically** — it is `.gitignore`d (§14.5) and grows
by one suite every run, and clearing it is the user's own to do, on their own schedule. §14.5 has the
reasoning; it applies here unchanged, since a suite is the same directory that reasoning already
governs.

**The suite directory is created, and the capture root gets §14.5's `.gitignore` entry, before any
flow runs — whenever capture is on, or a built-in reporter is defaulted, or both.** Either is enough
on its own: a default reporter's file is the artifact a CI job collects even when `--no-capture`
skipped every payload, and captures need somewhere to nest even when no reporter was asked for. The
engine names the directory — `resolveSuiteDirectory` computes the path, built from the same
`SUITE_DIRECTORY` naming pattern §14.5's `listRuns` uses to recognise one — and opens it itself for a
default run; the CLI calls the same function and opens it up front for its own invocation, the same
division of labor as the capture root (§14.5): the engine computes, whoever is running writes.

**Caveat: yargs reads the token right after a bare `--reporter-junit` as its value.**
`bru flow run --reporter-junit flows/` parses `flows/` as the JUnit output path, not as a flow to
run, because a string option with no `=` still claims whatever follows it. Put `--reporter-junit` (or
any other sugar flag) after the path arguments, or use `--reporter junit`, whose `=<path>` is
unambiguous because `--reporter` always takes one explicit value.

---

## 15. Compatibility and persistence

Flows are a committed public contract. Per `.claude/rules/dsl-changes.md`:

- New fields are **additive and optional** with safe defaults.
- `parse(stringify(x)) === x`, and stringify never drops unrecognized fields — so a flow written
  by a newer Bruno, opened and re-saved by an older one, does not lose data.
- Shape changes migrate **on read**, keyed off `version`. Users never hand-edit files to upgrade.
- Round-trip tests plus a golden fixture of every prior `version` that must still parse.

Because flows are YAML-only and live in their own files, they do **not** touch `bruno-lang`'s
grammar, `bruno-filestore`'s dual-format serializers, or `bruno-schema`'s Yup validation of
requests. Flow validation is its own schema, owned by `@bruno-max/flow`.

This is also what keeps the feature's upstream footprint small (§13.4): those three layers are
among the files upstream changes most often, and a fork edit in any of them would conflict
repeatedly.

---

## 16. Worked example

```yaml
version: 1

meta:
  name: Checkout happy path
  tags: [checkout, smoke]

apis:
  auth-api:
    source: ../../apispec/auth-v2.yml
    auth: user-token
  payments-api:
    source: ../../apispec/payments-v3.yml
    auth: user-token
  ledger-api:
    source: ../../apispec/ledger-v1.yml
    auth: service-account          # a different scheme, same flow

authProfiles:
  user-token:
    mode: bearer
    token: "{{steps.auth.token}}"  # every consumer must descend from `auth`
  service-account:
    mode: oauth2
    grantType: client_credentials
    clientId: "{{ledgerClientId}}"
    clientSecret: "{{ledgerClientSecret}}"

config:
  concurrency: 5

vars:
  currency: USD

steps:
  - id: auth
    uses: ./shared/login.flow.yml
    with:
      email: "{{testUserEmail}}"

  - id: create_payment
    operation: payments-api#createPayment
    body:                             # auth comes from the payments-api profile
      amount: 9900                    # everything else seeded from the spec's examples
      currency: "{{currency}}"
      customer_id: "{{steps.auth.userId}}"
    outputs:
      paymentId: data.id
    assert:
      - res.status eq 201
      - res.body.data.state eq pending

  - id: fetch_profile
    depends: [auth]                   # parallel with create_payment
    operation: auth-api#getProfile
    pathParams:
      userId: "{{steps.auth.userId}}"
    outputs:
      tier: data.account_tier

  - id: await_settlement
    depends: [create_payment]         # explicit: `fetch_profile` sits above it — see §9.1
    operation: payments-api#getPayment
    pathParams:
      id: "{{steps.create_payment.paymentId}}"
    retry:
      maxAttempts: 10
      delay: 2000
      backoff: exponential
      shouldRetry: |
        (res) => res.body.data.state === 'pending'
    assert:
      - res.body.data.state eq settled

  - id: verify_ledger
    depends: [await_settlement, fetch_profile]
    operation: ledger-api#getEntries
    query:
      reference: "{{steps.create_payment.paymentId}}"
    assert:
      - res.status eq 200
      - res.body.entries[0].amount eq 9900

  - id: premium_audit
    depends: [fetch_profile]
    when: steps.fetch_profile.tier eq premium
    operation: ledger-api#auditPremium

  - id: void_payment                  # cleanup — runs whatever happened downstream
    depends:
      - on: verify_ledger             # the last step to touch the payment — see §9.1
        status: [success, failed, skipped, cancelled]
    failOnUnresolved: false              # no payment to void is a valid outcome — see §11.2
    operation: payments-api#voidPayment
    pathParams:
      id: "{{steps.create_payment.paymentId}}"
```

Graph:

```
auth  (sub-flow)
 ├─ create_payment ─── await_settlement ─┐
 │                                       ├─ verify_ledger ─── void_payment
 └─ fetch_profile ───────────────────────┘                    [success, failed,
     └─ premium_audit  (conditional)                           skipped, cancelled]
```

`await_settlement` declares `depends: [create_payment]` explicitly, and has to. The step written
immediately above it is `fetch_profile`, so under §9.1's implicit-sequence rule an omitted `depends`
would make *that* its parent — leaving `{{steps.create_payment.paymentId}}` a non-ancestor
reference and a §8.4 validation error. This is finding 2 (§19) in the small: inserting
`fetch_profile` into a linear flow silently rewires the step after it, and the fix is to say what
the edge is wherever a branch sits between two steps that belong together.

`void_payment` hangs off `verify_ledger` — the **last** step to touch the payment, not the one that
created it (§9.1) — and accepts all four outcomes, so it runs whether settlement succeeded, the
ledger check failed, that check was skipped, or the run was interrupted. Depending on
`create_payment` instead would have made it eligible while `await_settlement` was still polling,
and voided the payment underneath it.

The resource it cleans up is still named through `pathParams`, not through `depends`: if
`create_payment` never returned a response there is no `paymentId`, and the step is skipped as
`unresolved-dependency` (§11.2) rather than failing — which is why it carries `failOnUnresolved: false`,
the one place that skip is the intended outcome rather than a silent hole. That is the whole of what a dedicated teardown
phase used to provide, expressed in the same mechanism as every other edge.

---

## 17. Rejected alternatives

| Option | Why not |
|---|---|
| Reference `.bru` request files instead of spec operations | Keeps request definitions duplicated across collections — the exact problem this feature exists to solve. |
| Address operations by `METHOD /path` as the primary form | Every step breaks on a path refactor. Retained only as a fallback for specs lacking `operationId`. |
| Flows stored in the collection's native format (`.bru` **and** `.yml`) | Doubles parser, serializer, and test surface under `dsl-changes.md` for no user-visible gain. |
| Raw response templating with no declared outputs | Data paths become implicit and unvalidatable, defeating goal 3. |
| JS post-response scripts as the only connector mechanism | Hides data paths inside code; not introspectable by tooling or a future graph view. |
| No `depends` = root (pure graph semantics) | A plain list of steps would all fire at once — astonishing, and contrary to goal 2. |
| Cancel in-flight siblings on failure | Discards results from branches that were about to report genuine, independent failures. |
| Unbounded retry predicate | An authoring mistake becomes an infinite hang in CI. |
| Composition via step-list `include:` splicing | The parent must know the fragment's internal step ids to write `depends` — leaky coupling, and fragments are neither independently runnable nor safely renameable. |
| Total sub-flow isolation (declared params only) | Forces every call site to redeclare base URLs and credentials — the boilerplate sub-flows exist to remove. |
| Full context inheritance into sub-flows | The sub-flow couples to parent internals, so it can't be reused or validated in isolation. |
| Retry on a whole sub-flow | Replays every side effect the sequence already committed. |
| Collection-scoped flows only | A shared login sub-flow would be copied into every collection — reintroducing duplication one level above the one this feature removes. |
| Workspace-scoped flows only | Flows stop travelling with the collection they test, and every flow must declare an environment binding the collection already knows. |
| Collection auth inherited, overridden per step | A flow spanning three services repeats the same auth block on every step targeting each one; auth belongs where the service is named. |
| Auth inline on each API binding, unnamed | Two APIs sharing one scheme duplicate its config, and a shared scheme can't be referenced by a step-level override. |
| `when: "{{expr}} == value"` | Overloads `{{}}` to mean both "inject into a request" and "evaluate a condition", and adds a third expression dialect to the file. |
| JS predicate for `when` | Conditions become opaque to static validation and to a future graph view, and each pays sandbox startup. |
| Declarative `when` with no script form | No way to express OR or a computed condition without restructuring the graph into extra steps. |
| Pinning flows to a spec digest | Every spec edit breaks every flow referencing it until re-pinned — the per-copy update burden this feature removes, returning under another name. |
| A `flows.lock` drift report | Another artifact to maintain and re-lock, for a signal `--dry-run` and schema-aware validation already cover. |
| Header-name denylist as the only redaction | Blind to secrets in query params and request bodies, and to any header name nobody predicted. |
| Redacting all headers and bodies by default | Destroys `--dry-run`'s purpose — inspecting a spec change's blast radius — to solve a problem targeted masking already solves. |
| A `--show-sensitive` that also applies to reporter files | Reporter files are archived as CI artifacts and attached to tickets; a flag copy-pasted into a pipeline would leak them permanently. |
| Reusing upstream's existing JSON/JUnit/HTML reporters unchanged | They consume `bru run`'s flat per-request result, not a flow's graph — the DAG, sub-flow internals and skip reasons a flow report needs have no field in that shape (§14.8). |
| Capturing only failed steps | A failure caused by a bad value three steps upstream gives no way to see where that value entered. |
| Capturing full bodies inline in reporters | Reporter files reach hundreds of megabytes on large payloads, and JUnit XML carrying an embedded binary body may not parse in some CI consumers. |
| Unbounded capture retention | Capturing every step of every run fills a developer's disk silently; retention has to be bounded by default, not by remembering to clean up. |
| Connector files keyed by flow-local alias | Aliases differ per flow, so the same operation would silently miss its connectors in any flow that named the spec differently. |
| Connectors as an `x-bruno-outputs` OpenAPI extension | Puts the declaration beside the schema, but is unavailable for vendor or generated specs the team doesn't own. |
| Response-envelope declaration alone | Removes the repeated `data.` prefix but still leaves every flow re-declaring each field it extracts. |
| Wrapping every shared operation in a sub-flow | Turns a one-line step into a file, purely to share a single extraction path. |
| Inlining feature logic into upstream files | Every such line is a merge conflict re-paid at every upstream merge; delegation keeps the surface to one line per file (§13.4). |
| A separate workspace package for fork renderer code | Strictest separation, but costs rsbuild/transpile configuration for a source-level workspace dependency, for no reduction in upstream touchpoints — `src/fork/` already conflicts with nothing. |
| Patch files reapplied after each upstream merge | Merges stay clean, but every patch needs rebasing whenever nearby upstream code moves, trading a one-time cost for a recurring one. |
| Naming the engine `@usebruno/flow` | Collides with both the npm name and the directory path if upstream ever ships a package of that name. |
| Dedicated `setup:` / `teardown:` phases | Subsumed by dependency status (§9.1) — a cleanup step accepting `failed`/`cancelled` gets the same guarantee, without a second execution model or the sub-flow teardown-deferral rules it dragged in. |
| `continueOnFailure` on the failing step | Lets the *parent* decide whether dependents run; the dependent is what knows which outcomes it can tolerate. Two ways to express one thing. |
| Automatic, unoverridable skip cascade | Implicit and invisible in the file. Declared status sets make the same default explicit and let a branch opt out. |
| AND-only joins | Makes the fallback branch the status model enables unusable at the merge point; the only working `all` formulation enumerates the skip state of the untaken branch and reads like nothing (§9.1). |
| `any` firing on the first satisfied parent | Would leave it a race whether the remaining parents had run, so the same flow could behave differently between runs. |
| A first-class `fallback:` construct | A second way to express what `depends` + `any` already covers, for one specific shape. |
| `timeout` as a whole-step budget | A long poll would have to set it high enough for every attempt, making the per-request bound implicit; `timeout` per attempt + optional `maxDuration` keeps both explicit. |
| Per-iteration concurrency budgets | Worst-case in-flight becomes `parallel × concurrency`, which multiplies out of sight and can overwhelm a test environment. |
| Explicit `Authorization` disabling the whole profile | Only ever worked for bearer-style modes; `apikey` can sit in a query param and signing modes touch several fields. Per-field override plus `auth: none` is mode-agnostic. |
| Cancelled runs reusing exit code 1 | A CI job could not distinguish a timeout or interrupt from a genuine regression without parsing output. |
| `vars.` and `env.` interpolation prefixes | A flow variable and an environment variable are the same kind of thing to whoever writes `{{tenantId}}`; which scope supplies it is a resolution detail, exactly as in a collection. |
| Resolving `!file` / `!...` to marker objects (`{"$file": …}`) in the data model | Reintroduces the ambiguity §17 rejected the `{ file: ... }` mapping to avoid, one layer down: a request body legitimately containing that key would be read as a file reference and uploaded. A symbol and a class instance cannot be forged by any document (§5.4). |
| A schema written against marker objects rather than the stripped node | Names a shape the YAML language server never produces, so the `yaml.schemas` mapping the format ships would flag every valid `!file` in the file — a schema that red-squiggles the format's own syntax (§5.4). |
| A `!!`-shorthand tag for deletion | `!!` expands to `tag:yaml.org,2002:`, reserved by the YAML spec for its own types; a tag there resolves to plain null and is indistinguishable from `null` after parsing. |
| An interpolation coalesce operator, `{{a ?? b}}` | Puts branch selection inside a string template, where it is invisible to the graph, and adds a second expression dialect to `{{}}` after §7.3 kept it a pure substitution. A named slot makes the same choice a declared edge. |
| Shared slots resolved by completion time | The join barrier orders writes against the read but not against each other, so concurrent branches would decide the value by network timing — the same flow yielding different results on a loaded CI machine than on a laptop. |
| Implicit slots, created on first write | A global mutable variable in all but name: no declaration to validate against, no way to catch a typo'd slot name, and the data path stops being an edge the graph can draw. |
| A step-level computed `vars:`, evaluated before materialization | Solves the same case by running a script per step, reintroducing the opaque-to-tooling connector §17 already rejected, and paying sandbox startup on steps that only needed to pick between two values. |
| Writing a slot from an extraction path rather than an output name | A second extraction of the same data, drifting from the declared output whenever one is edited; promotion keeps exactly one path per value. |
| Slots inherited by sub-flows | Data, not configuration (§12.3), and a caller's writers are not ancestors of anything inside the sub-flow, so §9.1's ordering guarantee could not hold. |
| One shared slot set across dataset iterations | Concurrent iterations would overwrite each other and the last row to finish would decide every iteration's value. |
| Assertions restricted to `res.*` | A data-driven flow could then only assert what is identical across every row. `when:` is no substitute — it gates the whole request, not one expectation. The existing `AssertRuntime` context already spreads every variable scope, so the restriction bought nothing. |
| A JSON Schema as the whole of validation | It cannot resolve an operation, prove an ancestor, or detect a cycle — the checks that matter most need the OpenAPI documents and the graph (§5.4). |
| Unknown properties as a schema **error** | An older Bruno would refuse a valid flow written by a newer one, contradicting §15's forward-compatibility rule. A warning flags the typo without breaking the shared-file case. |
| One schema covering every format version | A prior version's golden fixture (§15) could then fail against a schema that had moved on; one file per version keeps each fixture checkable. |
| Schema-only step ids with no pattern | An id containing a dot is unaddressable as `{{steps.<id>.x}}` and unsafe as a capture directory name (§5.3). |
| A machine-parseable stdout format | Two contracts to keep stable where one suffices; `--reporter-json` already serves machines, freeing the console to be readable (§14.7). |
| Buffering console lines into declaration order under concurrency | Withholding a completed step's line until earlier ones finish forfeits the stall-localising property live output exists for. Determinism belongs in the summary and reporters. |
| Inlining response bodies in default output | A 200 KB response buries the one line that mattered; the body is in the capture, which the failure block names. |
| Unicode status glyphs with no fallback | A Windows console printing mojibake is worse than a plain ASCII character. |
| No request-side validation | A body typed wrong by interpolation reaches the server, which rejects it in its own terms — a 400 about the API's internals rather than the flow's mistake — and `--dry-run` prints a request that looks correct (§10.1). |
| Request validation with no opt-out | Testing that an API rejects a malformed payload requires sending one; the check would fail the step locally and the endpoint would never be exercised (§10.3). |
| Running selected flows concurrently | Flows in a collection routinely share backend state, so a suite's result would depend on scheduling — flakiness a test runner exists to remove. |
| Ordering selected flows by discovery order | Filesystem order differs across machines, making a suite's sequence unreproducible; path order does not. |
| Sequencing GraphQL, gRPC or WebSocket requests | Each needs an operation-identity equivalent to `operationId` before it can be referenced rather than duplicated — a separate spec, not a flag (§3). |
| Asserting latency via `steps.<id>.duration` | That covers the whole step including retries and delays; `res.responseTime` is the single request an SLA actually describes (§10.2). |
| One cookie jar shared across dataset iterations | A role matrix logging in as three users would send row one's session on row two, passing while testing one identity three times — and under `parallel:` which session a request carries becomes a timing race (§7.6). |
| Cookie jar scoping left to each host | The CLI and app could disagree about whether an iteration is a fresh session — the divergence goal 4 exists to prevent. Mechanics stay with the host; scoping is a flow semantic. |
| Declaring cookies as connectors (§8) | A server sets cookies the flow never asked for; requiring them to be named would mean declaring state you cannot know in advance. |
| Relying on the CI runner's timeout instead of `config.maxRunDuration` | `SIGKILL` runs no cleanup, returns the runner's exit code rather than 4, and leaves created resources behind — making `depends: [cancelled]` best-effort instead of dependable. |
| A default `maxRunDuration` | Flows differ by orders of magnitude; any default low enough to help would fail long polls that were working. |
| Cleanup bounded only by a second interrupt | An unattended CI run has nobody to send one, so the cleanup phase would hang precisely where hanging is worst (§11.3). |
| A `{ file: ... }` mapping instead of the `!file` tag | In a value position it is ambiguous with a literal object carrying a `file` key, and disambiguating by consulting the operation's schema would make the meaning depend on how completely the API is documented. |
| A step-level `multipart: true` or explicit content type | The operation already declares what it accepts; restating it on the step is a second source of truth that can disagree with the spec (§7.5). |
| Seeding `format: binary` with an empty string | Uploads zero bytes while looking deliberate, and the server's rejection describes a malformed file rather than a missing one. |
| Interpolating `{{...}}` inside a raw binary body | Substitution into bytes corrupts the payload, and no useful case needs it. |
| Copying uploaded files into capture directories | Puts the fixture corpus in every CI artifact, for content that is already in the repository. |
| Streaming uploads through the `ReadFile` port | Pushes chunked-transfer handling into the engine to serve payload sizes functional API tests do not have. Deferred rather than closed — §19. |
| `vars:` evaluated lazily at each point of use | A generated value would differ between the step that created an identity and the step that logs in with it, making the commonest data-generation shape silently wrong. |
| One `vars:` evaluation shared across dataset iterations | Three rows would share one generated identity, so a test for per-tenant isolation would exercise a single tenant. |
| `dataset:` as the general file-reading mechanism | It iterates the whole flow per row; loading a lookup table would run the flow once per entry. Reading and iterating are different operations. |
| Letting `bodyFile:` and `body:` coexist on a step | Two sources for one merge layer with no obvious precedence, and the losing half reads as if it applied. |
| File reads unconstrained by the scope root | Flows are committed and shared, so a flow from a teammate's branch reads and transmits arbitrary local files, with no secret provenance for §14.4 to redact. |
| `fs` inside the engine | Breaks the §13.2 separation that keeps the CLI and app from diverging, and forces conformance fixtures onto disk. Reads *and* writes go through ports; §13.2 has the full set. |
| A host-implemented capture writer | §14.5's directory layout is a contract, and the engine reads it back (002 §11.2) — implementing it host-side would give the CLI and app two layouts and make `listRuns` a guess. The engine computes the paths; `WriteFile` / `RemoveDirectory` only move bytes. |
| Assertions barred from a step's own outputs | Left "this extraction had to succeed" inexpressible, so the only signal was the *consumer* skipping a step later — reporting that the flow could not proceed rather than what was not found (§10.2). |
| `failOnUnresolved` as the only guard on an extraction that matched nothing | Fires at the consumer, one step after the cause, and depends on there *being* a consumer. An assertion on the located value fails at the step that located nothing. |
| `failOnUnresolved` failing on any skip reason | Conditional branches, fallback branches and divergent dataset rows all skip by design, so every flow using them would be permanently red. Only `unresolved-dependency` means something went wrong (§11.2). |
| No `failOnUnresolved` at all | A flow whose data never matched skips from the first extraction to the end and exits 0 having tested nothing — the one failure mode a test runner must not have. |
| A declarative `where:` predicate on outputs | Would need its own predicate dialect and static-checking rules to cover a shape `script:` (§8.2) already handles, and the escape hatch is where non-trivial extraction belongs. |
| Resolving binding `baseUrl` once at flow load | A per-tenant host does not exist until a step creates it, so the workspace case — create, then log into the subdomain, then work inside it — could not be written at all. |
| Bindings rejecting `{{steps.*}}` outright | Would force every tenant-scoped flow into a sub-flow purely to gain a `params.*` indirection, including flows with a single tenant-scoped step. |
| Sub-flow bindings resolving against the caller's steps | A tenant-parameterized shared flow would only work below the flow that happened to create a workspace, instead of against any of them (§12.3). |
| Interpolation as pure string substitution everywhere | Nothing typed could reach a JSON body: YAML forces quotes around `{{...}}`, so every number, boolean and array crossing from an output would arrive as a string and break on the first typed field. |
| Coercing interpolated values to the operation's declared schema type | Silently behaves differently for a documented and an undocumented field, so the same expression means different things depending on how complete the spec is. Whole-value-or-not is visible in the file and independent of that. |
| One output per derived field | Pays a sandbox invocation per field and duplicates the parsing rule across outputs, so the copies drift when the response format changes. A structured output derives once (§8.1). |
| Auth profiles resolving against the flow that *uses* them | Breaks the canonical composition — a login sub-flow exports a token, the parent builds a profile from it, and any further sub-flow inherits a profile naming step state it cannot see (§12.3). |
| Sub-flows taking auth as a `param` and defining their own profile | Explicit, but adds a token argument to every call site of every shared flow, reintroducing the per-call-site boilerplate §12.3 exists to remove. |
| Step outcome decided by assertions alone, with no status check | Fails open: an unasserted step passes on a 500, its dependents skip as `unresolved-dependency` rather than fail, and a run against a fully unavailable service exits 0. A tool that goes green on a total outage is worse than no tool. |
| `failOnStatusCode: false` as the whole negative-test mechanism | Allows *any* status, so the step passes on a 500 as readily as the 403 it meant. Allowing the error and asserting which error are two different statements and both are needed (§10.3). |
| An `optional: true` step excluded from the flow's final status | This is a testing tool: a step that failed unexpectedly must go red. A negative test is expressed by asserting the expected failure (§10.3), which passes when it holds and fails when it doesn't — a flag that suppresses status would instead hide the case where the negative test found the bug. |
| Retrying on assertion failure by default | Replays the request that just proved the answer wrong, turning one leaked resource into `maxAttempts` of them on any non-idempotent step. Polling is the narrower case and can ask for it explicitly. |
| Cleanup depending on the step that created the resource | Becomes eligible as soon as the creator finishes, so it races the steps still using that resource — intermittently, and only under concurrency. Cleanup depends on the last step to touch it (§9.1). |

---

## 18. Open questions

The four design blockers and the ten gaps found in the first review are resolved into the body
above. A subsequent audit against the conformance companion raised twenty-eight more; **seventeen of
those are now resolved into the body too**, indexed below by where each landed. A later
implementation-readiness review added five, each a section that turned out to be silent where an
implementer needs an answer rather than a contradiction between two that speak. What remains here is
**not** resolved. Each is recorded rather than answered because it is a decision with a real trade,
and several are contradictions between two sections that both read as deliberate — picking a side
silently would discard whichever argument was right.

Each names what breaks while it stays open. **None of them blocks starting implementation**: the
contracts that everything else is written against — the port set, the engine boundary's types, the
expression dialect, the document schema — are settled. What is left below is local to one code path
apiece, and each names the code path.

Three of the five newest concern sub-flows, which is worth noticing on its own: §12 is the section
where a rule stated for a flow has to be restated for a flow inside a flow, and it is the place to
look first when something reads as settled but has no answer for the nested case.

### Resolved in this revision

An index, not a second copy of the reasoning — each answer lives in the section that owns it, which
is where a reader who hits the question will be. The rows are kept only until this revision has been
reviewed, then deleted per the convention in [README](./README.md).

| Question | Answer | Where |
|---|---|---|
| Who writes `.bruno-runs/`? | The engine, through `WriteFile` / `RemoveDirectory` ports; it computes every path | §13.2, §14.5, §7.4, §17 |
| How does a remote OpenAPI document reach the engine? | A `ReadSpec` port; hosts own caching | §13.2, §6.2 |
| Does `StepResult` carry schema-validation outcomes? | Yes — an additive `validation` field, separate from `assertions[]` | §13.2 |
| Do sub-flow internals appear in results and events? | Yes — flat `steps[]`, namespaced ids, events fire; `kind` marks the container | §13.2, §14.7 |
| How does a bare word resolve? | Bruno's existing literal rule, plus: a reserved root makes it a reference | §10.2, §9.3 |
| Are dataset values typed? | CSV inferred by the same rule; JSON and YAML keep native types | §9.4 |
| Do datasets accept YAML? | Yes — one loader with `!file` | §9.4 |
| Should `-` be legal in a step id? | No | §5.3 |
| Can a raw binary body come from `body: !file`? | Yes, equivalent to `bodyFile:`; the tag's options stay multipart-only | §7.5, §14.3 |
| What removes an inherited connector entry? | `!...`, not `null` | §8.5 |
| Is a flow declaring only `exports:` a library flow? | Classification is explicit `meta.library: true`, plus a lint | §12.5, §5.2, §14.3 |
| Which step fields are legal on a `uses:` step? | The ones not addressing a response — full table | §12.4 |
| More than one request media type? | Step-level `contentType:`, legal only when ambiguous | §7.5, §14.3 |
| Is an unknown key in `with:` an error? | Yes — `unknown-param`, with a suggestion | §14.3 |
| Where does a flow's `id` come from? | Its path, relative to the scope root | §5.2, §14.7 |
| What is `backoff: exponential`? | `min(delay * 2^(n-1), maxDelay)`, `maxDelay` 30 s, jitter opt-in | §11.1 |
| What happens when a `script:` throws? | The step fails with `script-error`, in all three script positions | §8.2, §14.6 |
| Where do `processEnv` and `envVarOverrides` sit in the chain? | Neither is a rank: `--env-var` merges into `environment`, `process.env` is a namespace | §7.3, §13.2 |
| How do `!file` and `!...` reach the schema? | Resolved to a symbol and a class instance; projected by stripping the tag | §5.4, §17 |
| Does a `uses:` step occupy a concurrency slot? | No — only its internals draw from the pool, or a sub-flow deadlocks at `concurrency: 1` | §9.2 |

### Execution semantics

**An unwritten shared slot in a structured body: `""` or omission?** §11.2 says "an empty string, or
omission for a structured `body` field"; 001-C R4 and R5 both assert `""`. Against a
schema-validated body these differ — `validateRequest` (§10.1) accepts one and rejects the other
whenever the field is typed or required.

**What reason does a step carry when retry exhausts with no `shouldRetry`?** §11.1's default retries
transport errors and 5xx. §14.6 defines `retries-exhausted` purely in terms of the predicate, so a
step with `maxAttempts: 3`, no predicate and three 502s has three arguable reasons. R4k asserts an
exact string per reason.

**Does a cleanup step run when the parent completed before the interrupt?** §9.1 defines `cancelled`
as a *parent's* outcome; §11.3 describes "steps whose `depends` accepts `cancelled`" as a property
of the run. A step declaring bare `status: [cancelled]` whose parent finished `success` satisfies
the second reading and fails the first. R4g's fixture is exactly that shape.

**Which outcome wins when a run both fails and is cancelled?** `RunResult.status` admits one value
and the exit codes differ (1 versus 4). §14.1's "worst outcome" for a multi-flow selection likewise
gives no ordering over `1`, `2` and `4`.

> The engine currently answers **cancelled**, and the CLI's multi-flow reducer answers **the
> numerically highest code**, which orders them `4 > 3 > 2 > 1`. Neither is tested and neither is
> reasoned — they are what the obvious implementation does. A conformance row settling this should
> land with whichever answer the argument picks, since the two disagree: an interrupted run
> containing a genuine failure reports `cancelled` from the engine and `4` from a single-flow CLI
> run, which hides a real regression behind an infrastructure outcome.

**Which attempt's outputs survive a retry?** Presumably the last, but §11.1 does not say — nor
whether outputs are extracted on every attempt so `shouldRetry`'s `ctx` can read them, which decides
whether a predicate can poll on a derived value rather than on `res` directly.

**What is `flow.iteration` outside a dataset?** §7.3 lists it unconditionally; §9.4 defines it only
as a row index. F1 interpolates it into a request body.

**Does a sub-flow inherit its caller's `config:`?** §12.3's table is exhaustive about what is data
and what is ambient configuration, and does not mention the block at all. §9.2 settles `concurrency`
as run-wide, but `failOnStatusCode`, `validateRequest`, `validateSchema`, `strictSchema`,
`failOnUnresolved`, `redactHeaders` and `capturePreviewBytes` are per-flow *defaults for steps* with
no stated answer — a shared login flow declaring `failOnStatusCode: false` invoked from a strict
parent has two defensible readings. §12.3's rule does not decide it, because `config:` is
configuration under either half of "configuration inherits, data is declared".

**Are assertions evaluated on a step that never dispatched?** §10.1 fails a step on
`validateRequest` *before* sending, so there is no response for a `res.*` assertion to address — but
001-C R4j asserts that such a step reports `assertions[]` all passing. Either the array is empty and
R4j needs correcting, or assertions are evaluated against an absent response.
[002](./002-api-flows-ui.md) §9 renders the array either way.

**Which auth modes does a profile accept, and which of them are signing modes?** §6.4 names eight of
`AuthMode`'s twelve members and lists four as signing modes. `oauth1` and `akamai-edgegrid` are
absent from both lists and compute signatures across several request fields, so the partial-override
error §6.4 introduces should cover them; `inherit` has no referent at a profile boundary and needs
either a resolution rule or a validation error. §5.4's schema enum and §14.3's check list both need
the answer. Noted at §13.2's `MaterializedRequest.auth`.

### The format

**What writes a flow file?** §15 mandates `parse(stringify(x)) === x`, a stringifier that preserves
unrecognized fields, and migrate-on-read. Nothing in 001 or 002 writes a flow — 002 §3 and §13 make
the app read-only — so migrate-on-read has no writer to persist through, and whether comments, key
order and formatting survive is unstated for a format whose primary editor is a human.

### CLI and artifacts

**How is a sub-flow's namespaced id written to a capture path?** §14.5 captures internals "under a
namespaced id (`auth/login`)", while §5.3 has step ids become directory names sanitized for Windows.
Read literally the `/` nests, which collides whenever a top-level step is itself named `auth` — one
directory would hold both that step's attempts and the sub-flow's children. `readCapture` takes a
`stepId` without saying which form it expects. The layout is a declared contract and
[002](./002-api-flows-ui.md) §11.2 reads it back, so the two have to agree.

**What does `--dry-run` resolve `{{steps.*}}` to?** §14.1 materializes and validates every step
without running any, so no step output exists. R4h tests `--dry-run` against a mistyped body, and
002 §15 defers the app's dry run on the premise that the engine already supports it.

**What is in `ctx` for a `script:` form?** Assembled piecemeal: `ctx.env` (§8.2), `ctx.steps`
(§9.3), `ctx.env` / `ctx.steps` / `ctx.failures` (§11.1). Whether `row`, `params`, `shared` and
`flow` are present, and whether a script may call `bru.setVar` given §7.3's runtime-vars tier, is
undefined.

**What is the capture layout for iterations, exactly?** §14.5 is a declared contract that says
"dataset iterations nest under a per-iteration subdirectory" without naming the format, and gives
the run directory as `2026-08-05T14-22-01Z-a3f9` in one place and `2026-08-07T10-14-02Z` in
another. 002 §10 parses these names.

### Left to implementation

These do not change a contract:

- Default values for `capturePreviewBytes` and `concurrency` may be tuned once there is real usage
  to measure.
- The exact `did-you-mean` suggestion algorithm for §14.3's schema-aware override checking.

---

## 19. Future work

Deferred deliberately, and **additive** — none of these changes a contract established above, so
adopting one later costs no migration. This list is distinct from its neighbours: §3 excludes things
from the feature's purpose, §17 records decisions taken against, and this section holds work that is
wanted but not now.

| Item | Why not now | What it needs |
|---|---|---|
| **Non-REST protocols** — GraphQL, gRPC, WebSocket, SSE (§3) | The graph, connectors and assertions are protocol-agnostic; only the OpenAPI binding assumes HTTP | An operation-identity equivalent to `operationId` per protocol, so a request is *referenced* rather than duplicated — the premise of goal 1 |
| **Deterministic seeding for generated data** (§7.3) | Generation currently cannot be replayed; §14.5 captures record what was sent, so failures stay diagnosable | A run seed in run metadata and seeded generators, plus `--seed` to replay one |
| **Streaming uploads** (§7.5) | `ReadFile` returns a buffer, which suits fixture-sized payloads | Chunked transfer in the engine and a streaming port variant. Triggered by a real case, not anticipated |
| **Reading a file into flow state mid-run** (§7.4) | `!file` and `bodyFile:` cover selecting and sending a fixture; reading a file *written during the run* had no concrete case | A step form that loads into `steps.*`, and a decision on what it means for a flow to depend on out-of-band state |
| **A validator heuristic for implicit-sequence rewiring** | Finding 2: inserting a conditional branch silently rewires the next step's implicit parent. The second instance arrived in audit — §16's own worked example had it — so the evidence bar this row set is met and only the false-positive rate is still open | A rule narrow enough to be worth the noise. The cheapest form is already specified: §14.3 errors on the non-ancestor reference the rewiring produces, so the heuristic is only needed for a rewiring that stays *valid*. [002](./002-api-flows-ui.md) §5.3 draws the implicit edge, which answers the same problem without a rule |
| **Real-world OpenAPI robustness** | Conformance fixtures are minimal by design (companion §8) | Coverage for `$ref` cycles, vendor extensions, missing `operationId`, and multi-document specs — separate ground from execution semantics |
| **Run retention — clearing runs from the app** (§14.5) | Nothing under `.bruno-runs/` is pruned today, so it grows without bound. A policy that deletes captures should be *visible and chosen*: the directory is what a CI job archives and what a user opens a week later, and a run that disappeared on a default nobody set is indistinguishable from one that was never written | A user-facing way to clear runs — a control in [002](./002-api-flows-ui.md) §10's history that deletes a selected run or suite, and a `bru flow runs clear` for the CLI — before any automatic bound. If an automatic one follows, it needs an explicit opt-in, a unit that is the suite rather than the run (§14.8.5), and a rule for a run still in flight, which is the question the old per-run bound never answered |

Recorded so the reasoning survives: each row is a decision someone made with a reason, not an
oversight to rediscover. An item moves out of this table by being specified, and the row is deleted
rather than left as a stale duplicate.

**Two rows left by that rule:** "the flow UI" and "surfacing captures in the app" are now
[002](./002-api-flows-ui.md). What of the UI is still deferred — the visual builder above all — is
tracked in 002 §15, so it is recorded once rather than in two tables that would drift.
