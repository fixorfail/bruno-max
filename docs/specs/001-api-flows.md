# 001 — API Flows

**Status:** Draft — open questions in §18 block acceptance
**Owner:** Jake Campbell
**Last revised:** 2026-08-12

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
| **§5** | File format — layout, a step, and the JSON Schema (§5.4) |
| **§6** | Resolving an `operation:` — bindings, base URLs, auth profiles |
| **§7** | Building a request — seeding, merging, interpolation, files, multipart, cookies |
| **§8** | Connectors — declared outputs, scripts, connector files, visibility |
| **§9** | Control flow — dependencies, joins, shared slots, concurrency, conditions, datasets |
| **§10** | Automatic validation, assertions, negative tests |
| **§11** | Retry, failure propagation, cancellation, run budget |
| **§12** | Sub-flows — interface, isolation, library flows |
| **§13** | Engine package, the host boundary, app integration, **fork isolation manifest (§13.4)** |
| **§14** | CLI — flags, exit codes, validate, redaction, capture, vocabulary, console output |
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
  tags: [checkout, smoke]

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
  captureRetainRuns: 10           # run directories kept before pruning

authProfiles:                  # named, reusable auth configs — see §6.4
  user-token:
    mode: bearer
    token: "{{steps.auth.token}}"

vars:                          # flow-scoped values; referenced bare as {{currency}} — see §7.3
  currency: USD                # evaluated once before any step runs
  testEmail: "qa+{{$randomUUID}}@example.com"    # generated once, stable across steps
  catalog: !file ./fixtures/catalog.json         # loaded from disk — see §7.4

shared: [chargeId]             # cross-branch value slots; see §9.1

dataset: ./fixtures/customers.csv   # optional; see §9.4

steps:    [ ... ]              # the graph — see §9
```

A **library flow** additionally declares `params:` and `exports:` — see §12.1. They are omitted
here because their presence changes how a flow is discovered (§12.5), so the canonical structure
above is an ordinary runnable flow.

`version` is required and exists so the parser can migrate older files on read rather than
forcing users to edit them by hand.

### 5.3 A step

```yaml
steps:
  - id: create_payment                        # required, unique within the flow
    name: Create a pending payment            # optional human label
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

**A step `id` matches `^[a-zA-Z_][a-zA-Z0-9_-]*$`** and is unique within its flow. The constraint is
not stylistic: an id is addressed as `{{steps.<id>.field}}`, so anything containing a dot or a space
is unreachable, and ids become directory names under `.bruno-runs/` (§14.5), where separators and
Windows reserved device names are hazards. Rejecting those at authoring time beats a step that runs
but cannot be referenced.

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
and `!file` (§7.4) — that have no JSON equivalent. The schema therefore describes the document
**after tag resolution**, where each tag has become a known marker value the schema can name in a
`oneOf` beside the ordinary types a field accepts.

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
    defaultHeaders:                               # applied to every step targeting this API
      X-Tenant-Id: "{{tenantId}}"
      X-Client: bruno-e2e
    defaultQuery:
      api_version: "2026-01"
```

`defaultHeaders` and `defaultQuery` remove the cross-cutting values that would otherwise be
repeated on every step of every flow — a tenant id or API version that the vendor's spec examples
will never supply. They are a merge layer beneath the step's inline values (§7.2), so any step can
override one, and `null` drops it for that step.

Paths are resolved **relative to the flow file**. This lets a flow reference the workspace's
`apispec/` directory (where the existing API Spec feature stores documents) without hardcoding an
absolute path, and lets a flow span multiple APIs — the reason the reference is alias-qualified
rather than a bare `operationId`.

Remote sources (`https://…`) resolve through the existing `renderer:fetch-api-spec` /
`swagger-fetch` path in the app and a direct fetch in the CLI, with an on-disk cache. Referencing
a remote spec means a network dependency at run time; teams that want hermetic CI should vendor
the spec into the repo.

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

A profile body is the **existing Bruno `Auth` shape** (the `mode` union in
`bruno-schema-types/src/common/auth.ts`). Every mode Bruno already supports — bearer, basic,
oauth2, apikey, awsv4, digest, ntlm, wsse — works unchanged, and OAuth2 profiles reuse the
existing token cache and `clear-oauth2-cache` handling. Flows introduce no new auth mechanics.

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
global environment  ->  collection vars  ->  environment  ->  flow vars:
   ->  oauth2 credential vars  ->  runtime vars (bru.setVar)  ->  --env-var
```

This mirrors the order in `bruno-electron/src/ipc/network/interpolate-vars.js`, so a variable
resolves identically whether it is read by a request or by a flow. `{{process.env.VAR}}` keeps
working as it does today.

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

`row.*` and `params.*` stay namespaced even though a human named their contents, because both are
**inputs crossing a boundary** — a dataset column entering an iteration, an argument entering a
sub-flow. Keeping them explicit means a call site shows what it passes rather than relying on
ambient resolution.

`steps`, `row`, `params`, `shared`, and `flow` are reserved at the top level. A variable in any
scope with one of those names is shadowed, and `bru flow validate` reports it as a warning.

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

Without this rule nothing typed can reach a JSON body at all. YAML forces the quotes — bare
`item_count: {{...}}` is a syntax error, because `{` opens a flow mapping — so *every* value
crossing from a step output into a structured body would arrive as a string, and a numeric field
would break on the first request. The rule is not an ergonomic nicety; it is what makes outputs
usable as request data.

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

**The engine does not touch `fs`.** File reads go through an injected port alongside
`ExecuteRequest` (§13.2), so each host keeps its own path handling and conformance scenarios stub
fixtures instead of writing them to disk.

### 7.5 Multipart and binary bodies

**The operation's declared media type decides how a body is assembled.** Nothing on the step selects
it, because the spec already says what the endpoint accepts — the same argument that keeps base URLs
and content types off the step everywhere else.

| Declared media type | Body assembled from |
|---|---|
| `application/json`, `application/x-www-form-urlencoded`, `*+json` | the merged structure (§7.2), interpolated |
| `multipart/form-data` | one part per key of the merged structure |
| anything else (`application/pdf`, `application/octet-stream`, …) | the raw bytes of a single `!file` or `bodyFile:` |

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

This is the one case where `bodyFile:` is not parsed and merged (§7.4). The media type is what
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
override, and `null` suppresses an inherited one.

Connector-supplied outputs are declarations like any other: they satisfy §8.4's visibility rule,
are drawn as graph edges, and their paths are checked against the operation's response schema by
`bru flow validate`.

**The cost is locality.** A step's available outputs are no longer visible by reading the step,
which cuts against §8's premise that data paths are explicit. That is why `bru flow validate` and
`--dry-run` both print each step's *resolved* outputs and where each was declared — the
information stays discoverable even though it is no longer inline.

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

The dialect is shared with `assert`, and so is most of the context. Both address `steps.*`, `row.*`,
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
index as `{{flow.iteration}}`. CSV and JSON are supported, following the data-file handling the
existing collection runner already implements.

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

Business-logic checks on top of the schema. These reuse Bruno's existing assertion operators and
are evaluated by the existing `AssertRuntime` — flows do not introduce a second assertion
dialect.

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
      shouldRetry: |
        (res, attempt, ctx) => res.body.state === 'pending'
```

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

**A flow that declares `params:` is a library flow.** It is excluded from directory and glob runs,
so `bru flow run flows/` in CI never fires `login.flow.yml` standalone and reports a spurious
missing-param failure.

It remains directly runnable when named explicitly, which is what keeps it testable in isolation:

```
bru flow run flows/shared/login.flow.yml --param email=qa@example.com
```

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
type ExecuteRequest = (request: MaterializedRequest, ctx: StepContext) => Promise<ExecutedResponse>;
type ReadFile      = (path: string, ctx: FlowContext) => Promise<Buffer>;
type ListDirectory = (path: string, ctx: FlowContext) => Promise<string[]>;
type RunScript     = (source: string, args: unknown[], ctx: FlowContext) => Promise<unknown>;
type Clock         = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
```

Each host supplies its own implementation and keeps its existing auth, cookie, proxy, and
certificate handling.

`ReadFile` covers §7.4's sources and `dataset:`, and exists for the same reason: the engine stays
free of `fs`, each host keeps its own path and permission handling, and conformance scenarios supply
fixtures in memory rather than on disk. Scope-root containment (§7.4) is enforced by the engine
before the port is called, so no host can forget it.

`ListDirectory` exists only for enumerating past runs under `.bruno-runs/` (§14.5), which the engine
reads back rather than only writes — see 002 §11.2. It carries the same containment rule: a
directory outside the scope root is refused before the port is called.

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

#### The entry API

Two entry points execute and validate. Three more are **read-only** — `describeFlow`, which returns
the resolved graph, and `listRuns` / `readCapture`, which read `.bruno-runs/` back. They exist for
the app and are specified in [002](./002-api-flows-ui.md) §11.1 and §11.2 rather than here, because
nothing in this document consumes them; they are named here so the boundary's readers know the
package's surface is five functions and not two.

```ts
declare function runFlow(options: RunOptions): Promise<RunResult>;
declare function validateFlow(options: ValidateOptions): Promise<Diagnostic[]>;

type RunOptions = {
  entry: string;                       // path to a .flow.yml, resolved by the host
  scope: { workspaceRoot: string; collectionRoot?: string };
  ports: {
    executeRequest: ExecuteRequest;
    readFile: ReadFile;
    listDirectory: ListDirectory;
    runScript: RunScript;
    clock?: Clock;
  };

  variables: {                         // one field per §7.3 tier — NOT a merged map
    globalEnvironment?: Vars;
    collectionVars?: Vars;
    environment?: Vars;
    processEnv?: Vars;
    envVarOverrides?: Vars;            // --env-var
  };

  params?: Vars;                       // --param, for a library flow (§12.5)
  overrides?: { concurrency?: number; maxRunDuration?: number; dataset?: string };
  signal?: AbortSignal;
  onEvent?: (event: FlowEvent) => void;
};
```

**Variables arrive as tiers, not as a merged map.** §7.3's precedence chain is a flow semantic and
belongs to the engine; *finding* each tier — locating `bruno.json`, resolving `--env` across
collection, workspace and global scopes (§14.1) — is host knowledge. Handing over a pre-merged map
would move the ordering into two hosts and let them disagree about which scope wins, which is the
one thing this package exists to prevent.

**One flow per call.** Selecting flows from a directory, path ordering, and `--bail` (§14.1) are the
CLI's, because they are about a *suite*; the engine's unit is a flow and its iterations.

**Cancellation is an `AbortSignal`** — Ctrl-C and `SIGTERM` in the CLI, a stop control in the app.
`maxRunDuration` is enforced by the engine against `Clock`, because §11.3 requires the timeout and
the signal to take the identical path.

```ts
type RunResult = {
  runId: string;
  status: 'passed' | 'failed' | 'cancelled';
  iterations: IterationResult[];
  summary: { total: number; passed: number; failed: number; skipped: number; cancelled: number };
  diagnostics: Diagnostic[];           // validation warnings that did not stop the run
  captureDir?: string;
};

type IterationResult = {
  index: number;
  row?: Vars;
  status: 'passed' | 'failed' | 'cancelled';
  steps: StepResult[];
};

type StepResult = {
  id: string;                          // sub-flow steps namespaced: "auth/login"
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  reason?: StepReason;                 // §14.6
  attempts: number;
  durationMs: number;
  assertions: { expr: string; passed: boolean; expected?: unknown; actual?: unknown }[];
  outputs: Record<string, unknown>;
  capturePath?: string;
};
```

`RunResult` carries **no exit code**. Mapping an outcome to 0–4 is §14.2's, and the app has no use
for it — an engine that returned one would be encoding a CLI concern into the shared package.

`validateFlow` returns diagnostics and never dispatches; the same call backs `bru flow validate`
(§14.3) and the app's inline authoring feedback, so the two cannot drift.

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
  | { type: 'run:start';       runId: string; flow: string; iterationCount: number }
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

**Events are small and structured-clone-safe.** They carry ids, statuses and durations; bodies and
uploaded files are not included, only the `capturePath` that holds them (§14.5). In the app the
engine runs in the Electron main process and the UI in the renderer, so every event crosses IPC —
attaching response bodies would put each payload through serialization twice for data the UI can
fetch when a step is opened.

Ordering is guaranteed: `step:start` precedes its `step:end`, both sit inside their
`iteration:start`/`iteration:end`, and `run:end` is last. Under `concurrency > 1` events from
different steps interleave, so consumers key on `id` and `index` rather than assuming adjacency.

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
| `packages/bruno-cli/package.json` | add engine dependency | 1 |
| `packages/bruno-electron/package.json` | add engine dependency | 1 |
| `bruno-electron/src/index.js` | `require` + call `registerFlowIpc` | 2 |
| `bruno-app/…/RequestTabPanel/index.js` | delegate to the fork pane registry | 2 |
| `bruno-app/…/RequestTabs/RequestTab/SpecialTab.js` | delegate to the fork tab-label registry | 1 |
| `bruno-app/…/providers/ReduxStore/index.js` | spread fork reducers into the map | 1 |
| `bruno-app/…/components/Sidebar/index.js` | spread fork sidebar sections | 1 |
| `bruno-app/…/slices/tabs.js` | concat fork tab types into **two** separate constants — see below | 2 |
| `.gitignore` | ignore `.bruno-runs/` (§14.5) | 1 |

`tabs.js` is the least comfortable entry and the manifest should say why. It holds two lists:
`NON_CLOSABLE_TAB_TYPES`, a module-level export that a fork constant can be concatenated into
cleanly; and `nonReplaceableTabTypes`, a `const` declared **inside a reducer body**, which cannot be
extended from outside and forces an edit within a function upstream is more likely to churn. If that
edit proves painful across merges, the fallback is to stop extending the local list and have the
fork registry post-process the tab in its own reducer instead.

Everything else — the engine, the renderer components, the Redux slice, the IPC handler, the CLI
command — lives in files upstream does not have.

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
| `--env-var k=v` | Override a single variable (repeatable) |
| `--param k=v` | Supply a declared `params` value (repeatable); for running a library flow directly |
| `--dataset <path>` | Override the flow's dataset |
| `--concurrency <n>` | Override `config.concurrency` |
| `--max-run-duration <ms>` | Bound the whole run; elapsing takes the cancellation path and exits 4 (§11.3) |
| `--tags` / `--exclude-tags` | Filter flows by `meta.tags`, matching `bru run`'s existing tag filtering |
| `--bail` | Stop after the first failing flow when several were selected |
| `--reporter-json <path>` | Existing reporters, reused unchanged |
| `--reporter-junit <path>` | |
| `--reporter-html <path>` | |
| `--strict` | Promote §14.3's warnings to errors (exit 2) |
| `--show-sensitive` | Disable masking **for stdout only**; never affects reporter files or captures (§14.4) |
| `--verbose` / `--quiet` / `--silent` | Console detail level (§14.7) |
| `--no-color` / `--no-unicode` | Disable ANSI colour or box-drawing glyphs (§14.7) |
| `--no-capture` / `--capture-dir <path>` | Disable capture, or relocate it (§14.5) |
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
- Every `required` param is satisfied at each call site
- No `retry:` on a `uses:` step; no `dataset:` in a sub-flow
- Every `exports` entry references a real internal step output
- Every connector-file entry resolves to a real operation, and its paths check against that
  operation's response schema (§8.5)
- Every `auth:` reference names a declared profile; a workspace-scoped flow never relies on the
  implicit `collection` profile
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
- `!file` appears only where the operation accepts one: a `multipart/form-data` part, or a
  single-payload media type via `bodyFile:` (§7.5). Its `filename:` and `contentType:` options are
  multipart-only
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

**Storage is split.** Reporters carry a truncated inline preview for quick reading; the
untruncated payload is written to an artifact directory:

```
.bruno-runs/
  2026-08-05T14-22-01Z-a3f9/
    run.json
    summary.json
    verify_ledger/
      attempt-1.request.json
      attempt-1.response.json
    await_settlement/
      attempt-1.response.json
      ...
      attempt-10.response.json
```

```json
"capture": {
  "response": {
    "status": 200,
    "preview": "{\"entries\":[...",
    "truncated": true,
    "originalSize": 2101440,
    "full": ".bruno-runs/2026-08-05T14-22-01Z-a3f9/verify_ledger/attempt-1.response.json"
  }
}
```

Previews truncate at `config.capturePreviewBytes` (default 8 KB). **Binary bodies are never
previewed** — the capture records content-type and size, and the full body is written with an
appropriate extension. Dataset iterations nest under a per-iteration subdirectory.

#### `run.json` and `summary.json`

**`run.json` is written when the run starts; `summary.json` when it ends.** The first carries
identity — `runId`, the flow's path, and `startedAt`; the second carries the outcome.

The split matters because a directory named for a timestamp and a short id says nothing about which
flow produced it. With only the end-of-run file, a run's identity does not exist until it finishes,
so **a run in progress and a run that died cannot be attributed to a flow at all** — the first is not
an edge case, it is every run while it is being watched (002 §10 lists both). Writing identity up
front costs one small file and makes the directory self-describing from its first moment.

An interrupted run — `run.json` present, `summary.json` absent — is a real state and not a corrupt
one: the process was killed, or the machine lost power, which §11.3 covers for the cases the engine
can see and cannot cover for the ones it cannot. Such a run has **no status**, and a reader must not
synthesize one; the captures that exist are the record of what happened.

**Uploaded files are captured by reference, not by content** (§7.5): source path, filename, content
type and byte length. Copying them in would put the fixture corpus into every run's artifact, and
unlike a response body the content is already in the repository — the reference is the more useful
record anyway, since it names which fixture was sent.

**Redaction (§14.4) applies to the artifact directory exactly as it does to reporter output.**
This is the more important of the two: `.bruno-runs/` is precisely the thing a CI job uploads as a
build artifact, and `--show-sensitive` never affects files.

**Retention is bounded.** Capturing every step of every run accumulates without limit otherwise.
The last `config.captureRetainRuns` runs are kept (default 10) and older directories are pruned at
the start of a run. `--no-capture` disables capture entirely for pipelines that want minimal
artifacts, and `--capture-dir` relocates the output.

**Location.** `.bruno-runs/` is written at the **root of the scope that owns the flows being run** —
the collection root for a collection-scoped run, the workspace root for a workspace-scoped one. It
is never placed relative to the current working directory, so the same command produces the same
layout wherever it is invoked from. `--capture-dir` overrides it.

`.bruno-runs/` must be added to that scope's `.gitignore` on creation — captured payloads are run
output, not source, and they contain response data that has no business in a repository.

**This is a different file from §13.4's manifest entry, and both are needed.** The manifest ignores
`.bruno-runs/` in *this repository*, which covers runs against the collections living here. A
collection or workspace a user opens from anywhere else has its own root and its own repository, and
only the on-creation write reaches it.

Step ids appear in filesystem paths, so they are sanitized and length-limited per
`.claude/rules/cross-platform.md` before use — Windows path limits and reserved device names
(`CON`, `PRN`, `AUX`, …) apply.

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
| `subflow-failed` | failed | A step inside an invoked sub-flow failed (§12.4) |
| `unmet-dependency` | skipped | No parent outcome satisfied `depends` (§9.1) |
| `condition-false` | skipped | `when:` evaluated false (§9.3) |
| `unresolved-dependency` | skipped | A referenced output was never produced (§11.2) |
| `run-cancelled` | skipped | The run stopped before the step started (§11.3) |

A step that failed carries exactly one reason — the **first** check to fail, in §10's evaluation
order: request validation, then status, then response schema, then assertions. Reporting the first
is what makes a failure actionable; a 500 that also fails four assertions is one problem, not five.

Request validation leads because §10.1 runs it **before dispatch**: a step that fails it never
sends, so it has no status to be judged on and `invalid-request` and `unexpected-status` are never
candidates for the same step.

**Diagnostic codes** (§13.2's `Diagnostic.code`) are `kebab-case` and name the rule rather than the
occurrence — `unknown-operation`, `cyclic-dependency`, `non-ancestor-reference`,
`unresolved-alias`, `path-outside-scope`, `signing-mode-field-override`. The full set follows
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
  ✓ void_payment         DELETE /payments/{id}    77ms

  verify_ledger · assertion-failed
    res.body.data.balance eq 9900
      expected  9900
      actual    8900
    capture  .bruno-runs/2026-08-07T10-14-02Z/verify_ledger/

  1 failed · 4 passed · 1 skipped · 2.3s
```

`✓` success, `✗` failed, `○` skipped, `⊘` cancelled — with an ASCII fallback (`+ x - !`) when the
terminal cannot render them or `--no-unicode` is given, because a Windows console printing mojibake
is worse than a plain character.

The operation, not the URL, identifies a step: it is what the flow file names, and a resolved URL
carrying interpolated ids is both long and noisy in a column. Attempt counts appear only when
greater than one — a retry is worth seeing, and "1 attempt" on every line is not.

**The failure block is the point.** For each failure: the step, its reason (§14.6), the specific
assertion with expected and actual, and the capture path. Bodies are *not* inlined — they are in the
capture, and a 200 KB response in a terminal buries the one line that mattered. Only failures get a
block; a passing step is one line.

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
| `fs` inside the engine | Breaks the §13.2 separation that keeps the CLI and app from diverging, and forces conformance fixtures onto disk. |
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
above. A subsequent audit against the conformance companion raised the following, which are **not**
resolved. They are recorded rather than answered because each is a decision with a real trade, and
several are contradictions between two sections that both read as deliberate — picking a side
silently would discard whichever argument was right.

Each names what breaks while it stays open.

### The engine boundary (§13.2)

**Who writes `.bruno-runs/`?** Every port is read-only, §7.4 states the engine never touches `fs`,
and §17 rejects `fs` inside the engine. §14.5 nonetheless requires creating the run directory,
writing `run.json` at start, per-attempt request and response files, `summary.json` at the end,
**pruning** older directories, and the `.gitignore` entry. Either a `WriteFile` / `DeleteDirectory`
pair joins the port set under §7.4's containment rule, or capture writing belongs to each host — and
then the CLI and app can produce different layouts, which §14.5's contract forbids. R4g2 tests the
writer and cannot be implemented until this is settled.

**How does a remote OpenAPI document reach the engine?** §6.2 resolves `https://` sources "through
the existing `renderer:fetch-api-spec` / `swagger-fetch` path in the app and a direct fetch in the
CLI, with an on-disk cache". The engine resolves operations and has no fetch port; 002 §11.1's
`describeFlow` takes `readFile` alone. Either spec loading is a port nobody has declared, or the
engine fetches and §13.1's isolation is narrower than stated. The cache's location, TTL,
invalidation and offline behavior are undefined either way.

**Does `StepResult` carry schema-validation outcomes?** It carries `assertions[]` and a single
`reason`. [002](./002-api-flows-ui.md) §9 renders a **Validation** tab for request- and
response-schema results and states they arrive in `StepResult`; 002-C U4.10 asserts they survive
capture being disabled. A step can fail one schema check while passing several assertions, and one
`reason` cannot express that. Adding a field is additive under §15.

**Do sub-flow internal steps appear in `IterationResult.steps` and in the event stream?**
`StepResult.id` is documented as namespaced (`auth/login`), which implies yes, but nothing says it.
§14.7 renders a sub-flow as one line by default and expands it under `--verbose`; 002 §5.4 and
002-C U1.8 need the internals present to draw them. Whether `step:start` / `step:end` fire for them
determines whether the app can render an expanded sub-flow live or only from a capture.

### The expression dialect (§9.3, §10.2)

**How does a bare word in an expression resolve?** §10.2 uses bare unquoted *literals*
(`res.body.data.state eq settled`, `tier eq premium`) and bare *references*
(`res.body.data.role eq row.role`, `eq steps.add_product.productId`) with no rule separating them.
`res.body.x eq status` cannot be read by inspection. This governs every `assert:` and every `when:`
in the format, and F1.2, F2.1 and F4.1 all turn on it.

**Are dataset values typed?** §9.4 says only that CSV and JSON are supported. F1's
`when: row.canCreate eq true` requires a CSV cell holding `true` to satisfy a boolean comparison —
so rows are typed, or inferred, or compared loosely, and the whole F1.1 outcome table depends on
which. JSON datasets carry types natively, which makes the two formats behave differently unless
this is stated.

**Should `-` be legal in a step id?** §5.3's pattern admits `my-step`, addressed as
`steps.my-step.status` inside an expression dialect where `-` reads as an operator. §5.3 excludes
dots and spaces for exactly this class of reason and does not mention hyphens. R4m tests `my.step`
and `2fa` only.

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

**Which attempt's outputs survive a retry?** Presumably the last, but §11.1 does not say — nor
whether outputs are extracted on every attempt so `shouldRetry`'s `ctx` can read them, which decides
whether a predicate can poll on a derived value rather than on `res` directly.

**What happens when a `script:` throws?** §8.2 outputs, §9.3 conditions and §11.1's `shouldRetry`
all run user JS. §8.1 specifies only the returning-`undefined` case. §14.6's table has no
`script-error`, so a throw currently has no defined outcome, reason, or effect on the step.

**What is `backoff: exponential`?** No base, multiplier, cap or jitter. §16 uses it; F4.3 asserts
exactly 30 attempts against the `Clock` port and R4j asserts `sleep` was called 29 times — neither
is writable without the delay sequence.

**What is `flow.iteration` outside a dataset?** §7.3 lists it unconditionally; §9.4 defines it only
as a row index. F1 interpolates it into a request body.

### The format

**Can a raw binary body come from `body: !file`?** §7.5's media-type table says "the raw bytes of a
single `!file` **or** `bodyFile:`"; §14.3 permits `!file` only as a multipart part or "a
single-payload media type **via `bodyFile:`**", which rejects it.

**What removes an inherited connector entry?** §8.5 uses `null`; §7.2 gives `null` its ordinary
meaning of a literal JSON null and reserves `!...` for deletion. One token, two meanings, one file.

**Is a flow declaring only `exports:` a library flow?** §12.5 keys the classification on `params:`
alone, and it governs glob exclusion (§14.1) and the sidebar mark (002 §4.1).

**Which step fields are legal on a `uses:` step?** §12.4 bars `retry:` and defines `when:`.
`assert:`, `outputs:`, `shared:`, `failOnStatusCode`, `validateRequest`, `validateSchema`, `timeout`
and `maxDuration` are neither permitted nor barred, and several are meaningless without a response.
§5.4 makes `operation` XOR `uses` a schema rule, so the schema needs the answer.

**How is a body assembled when an operation declares more than one request media type?** §7.5 says
"**the** operation's declared media type decides" and puts nothing on the step to select one. An
operation offering both `application/json` and `multipart/form-data` is ordinary.

**Do datasets accept YAML?** §9.4 supports CSV and JSON; §7.4's `!file` supports JSON, YAML and CSV.

**Is an unknown key in `with:` an error?** §14.3 checks that required params are satisfied and says
nothing about arguments the sub-flow does not declare — the typo case.

**What writes a flow file?** §15 mandates `parse(stringify(x)) === x`, a stringifier that preserves
unrecognized fields, and migrate-on-read. Nothing in 001 or 002 writes a flow — 002 §3 and §13 make
the app read-only — so migrate-on-read has no writer to persist through, and whether comments, key
order and formatting survive is unstated for a format whose primary editor is a human.

### CLI and artifacts

**What does `--dry-run` resolve `{{steps.*}}` to?** §14.1 materializes and validates every step
without running any, so no step output exists. R4h tests `--dry-run` against a mistyped body, and
002 §15 defers the app's dry run on the premise that the engine already supports it.

**Where does a flow's `id` come from?** §14.7's `bru flow list` prints `checkout-happy-path` and
`login`. The format has no `id:` field and `meta.name` is a sentence. `--tags` filtering and 002
§4.1's sidebar both need a stable identity.

**Where does `processEnv` sit in §7.3's chain?** §13.2 says `RunOptions.variables` carries "one
field per §7.3 tier", but the chain has no processEnv tier — §7.3 says only that
`{{process.env.VAR}}` keeps working, and `interpolate-vars.js` nests it under a `process.env` key
rather than flattening it. `envVarOverrides` as a distinct final tier has no upstream analogue
either; the CLI folds `--env-var` into the environment.

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

- Default values for `capturePreviewBytes`, `captureRetainRuns` and `concurrency` may be tuned
  once there is real usage to measure.
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
| **A flow-shaped reporter** | Flows reuse Bruno's existing JSON/JUnit/HTML reporters (§14.1), which describe a list of requests, not a graph | A report carrying the DAG, per-step outcomes and skip reasons. Worth doing once real runs show what people look for first |
| **Deterministic seeding for generated data** (§7.3) | Generation currently cannot be replayed; §14.5 captures record what was sent, so failures stay diagnosable | A run seed in run metadata and seeded generators, plus `--seed` to replay one |
| **Streaming uploads** (§7.5) | `ReadFile` returns a buffer, which suits fixture-sized payloads | Chunked transfer in the engine and a streaming port variant. Triggered by a real case, not anticipated |
| **Reading a file into flow state mid-run** (§7.4) | `!file` and `bodyFile:` cover selecting and sending a fixture; reading a file *written during the run* had no concrete case | A step form that loads into `steps.*`, and a decision on what it means for a flow to depend on out-of-band state |
| **A validator heuristic for implicit-sequence rewiring** | Finding 2: inserting a conditional branch silently rewires the next step's implicit parent. The second instance arrived in audit — §16's own worked example had it — so the evidence bar this row set is met and only the false-positive rate is still open | A rule narrow enough to be worth the noise. The cheapest form is already specified: §14.3 errors on the non-ancestor reference the rewiring produces, so the heuristic is only needed for a rewiring that stays *valid*. [002](./002-api-flows-ui.md) §5.3 draws the implicit edge, which answers the same problem without a rule |
| **Real-world OpenAPI robustness** | Conformance fixtures are minimal by design (companion §8) | Coverage for `$ref` cycles, vendor extensions, missing `operationId`, and multi-document specs — separate ground from execution semantics |

Recorded so the reasoning survives: each row is a decision someone made with a reason, not an
oversight to rediscover. An item moves out of this table by being specified, and the row is deleted
rather than left as a stale duplicate.

**Two rows left by that rule:** "the flow UI" and "surfacing captures in the app" are now
[002](./002-api-flows-ui.md). What of the UI is still deferred — the visual builder above all — is
tracked in 002 §15, so it is recorded once rather than in two tables that would drift.
