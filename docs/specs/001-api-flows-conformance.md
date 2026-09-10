# 001-C — API Flows conformance scenarios

**Status:** **Implemented** — companion to [001-api-flows.md](./001-api-flows.md); every scenario
here has a test, and `registry.spec.js` fails if one stops having one
**Owner:** Jake Campbell
**Last revised:** 2026-09-03

Scenarios the spec's behavior was derived from, written to be implemented directly as tests. Start
at §2 for the harness, §3–§6 for the four end-to-end flows, §7 for the regression set, and §9 for
which finding each one guards. The spec's own entry point is its **How to read this** section.

---

## 1. Why this file exists

Four functional flows were walked through end-to-end while `001-api-flows.md` was being written.
They were not illustrations: each one exercised the spec against a real testing shape and **eleven
defects came out of them**, five of which were already sitting in the spec's own worked example.

This file preserves those walkthroughs as executable scenarios so the same defects cannot return.
Each scenario names the spec sections it pins and the finding that produced it. A change to §7.3's
interpolation rule or §9.1's join semantics should break something here; if it doesn't, the coverage
is wrong.

These are **behavioral tests of the engine**, not of the UI. What they deliberately do not cover is
listed in §8.

## 2. Where these tests live

`packages/bruno-max-flow/tests/conformance/` — Jest, per the package's own `jest.config.js`.

The engine takes an injected `ExecuteRequest` port (§13.2) and sends no HTTP itself, which is what
makes these unit tests rather than integration tests:

```ts
type ExecuteRequest = (request: MaterializedRequest, ctx: StepContext) => Promise<ExecutedResponse>;
```

A scenario supplies a **stub port** keyed by operation id, so responses are scripted, ordering is
deterministic, and no network or clock is involved. Retry delays are driven by injected fake timers
so a 30-attempt poll costs no wall-clock time. The `ReadFile` port (§13.2) is stubbed the same way,
so fixture data lives in the test rather than on disk.

**`RunScript` is not stubbed** — the harness supplies a real bruno-js runtime. Several scenarios turn
on what a script actually returns (F4's `find` predicate, F3's derived structured output, the
`shouldRetry` polls), so a stub would assert the engine calls the port and nothing about the behavior
those scenarios exist to pin. This is the one port where fidelity matters more than determinism, and
the scripts are pure functions of their arguments, so it costs nothing in flakiness.

Generated values (`{{$randomUUID}}` and friends) are **not** stubbed. R4c asserts on the *relations*
between generated values — same within an iteration, different across them — which holds for any
generator and needs no seeding hook.

```
tests/conformance/
  harness.js                  # runFlow(flowFile, { responses, vars, files }) -> RunResult + exit code
  flow-yaml.js                # §5.4's projected model — the local tags, resolved
  fixtures/
    specs/                    # minimal OpenAPI documents — user, items, external, ...
                              # one of them writes its schemas as `$ref`s into `components`, because
                              # the rest inline theirs and a fragment only fails on a ref (R4r)
    flows/                    # the .flow.yml files below, verbatim
      regressions/            # the minimal flows of §7, one per row
    datasets/
  f1-role-matrix.spec.js
  f2-order-fulfillment.spec.js
  f3-batch-settlement.spec.js
  f4-partner-acceptance.spec.js
  regressions.spec.js
  capture.spec.js             # R4g2 and R4n — the artifact directory and §14.5's roster, through the write ports
  history.spec.js             # R4o — the runs and the suites read back through 002 §11.2's entries
  parse.spec.js               # R4p — §5.4's tags, merge keys and node positions
  describe.spec.js            # R4q — the graph 002 §11.1 hands the app
  schema.spec.js              # R4m and R11.1 — §5.4's schema, and the pass bru flow validate runs first
  validation.spec.js          # R4h and R8.1-R8.10 — §14.3's checks, grouped by what each one reads
  runtime.spec.js             # R9.1-R9.8 — what a script, an assertion and an event see at run time
  connectors.spec.js          # R10.1-R10.5 — §8.5's files: matching, precedence, suppression, provenance
  collection-auth.spec.js     # R9.13 — the stored-auth → AuthProfile mapping, against materialize.ts directly
  subflow-resolution.spec.js  # R12.1 — §12.2's `uses:` targets, relative and `workspace:`-prefixed
  subflow-exports.spec.js     # R12.2 — §12.1's exports, and the slot-sourced kind
```

The write ports (`WriteFile`, `ListDirectory`) are stubbed as an **in-memory
filesystem** for the same reason `ReadFile` is, and `capture.spec.js` asserts §14.5's layout against
it. That layout is a contract two hosts and 002 §11.2's readers depend on, so it is asserted as a set
of *paths* rather than through a result field — a divergence has to surface here rather than as the
app failing to open a run the CLI wrote.

`runFlow` returns the per-step outcome table, the flow status, and the exit code, because that
triple is what every scenario below asserts on.

**The fixture flows are the artifact.** Keep each `.flow.yml` a real file rather than a string
inside a test — they double as the format's worked examples, and a format change that breaks them
should show up as a parse failure at a path, not a diff inside a template literal.

---

### Which requirements live outside this suite, and which have no test yet

Every `R`/`F` heading in this file is a `describe(...)` of the same name under
`packages/bruno-max-flow/tests/conformance/`, and `registry.spec.js` fails the build when the two
drift apart. That guard exists because they *did* drift: three requirements were written as tests and
never registered here, and two later requirements were then written against ids already in use.

The exceptions are listed rather than allowed to accumulate silently:

| Requirement | Where it is | Why not here |
|---|---|---|
| R4i | `bruno-cli/tests/fork/flow/` — `selection.spec.js`, and `retry.spec.js` / `retry.integration.spec.js` for the retry half | Which flows an invocation runs, in what order, and which of them it runs again is the CLI's: the engine sees one flow at a time and never the invocation around it (§13.2) |
| R4l | `bruno-cli/tests/fork/flow/output.spec.js` | §14.7's console rules are the CLI's own |
| R13.1 | `bruno-cli/tests/fork/flow/output.spec.js` | Same reporter, same reason as R4l — the operation column, `--verbose` previews and TTY behaviour are all read off the CLI's own event handling, not the engine |
| R13.2 | `bruno-cli/tests/fork/flow/output.spec.js`, and `validate.integration.spec.js` for the pass end to end | Same reporter, same reason as R4l — what `validate` prints is the CLI's; the engine's half is `resolveOutputs`, pinned by R10.5 |
| R7.1 | `bruno-cli/tests/fork/flow/auth.integration.spec.js` | §6.4 hands over Bruno's `Auth` and stops there: applying it is each host's own auth code, and only that host's wire shows it was applied |
| R7.2 | `bruno-cli/tests/fork/flow/transport.integration.spec.js` | The engine assembles the parts (§7.5) and a host writes them; what a multipart or binary request looks like on the wire is the host's half |
| R7.3 | `bruno-cli/tests/fork/flow/transport.integration.spec.js` | The engine owns which jar a request uses and the host owns what a jar is (§7.6) — the conformance suite stubs the transport and has no cookies to carry |
| R7.4 | `bruno-cli/tests/fork/flow/transport.integration.spec.js`, and `transport.spec.js` for the certificate half | §8 puts real network behaviour — proxies and certificates — in each host's own tests, for the reason it is not in the engine at all |
| R7.5 | `bruno-cli/tests/fork/flow/sandbox.spec.js`, and `sandbox.integration.spec.js` for the end-to-end proof | §8.2's sandbox selection is a host decision the engine never makes (§13.2's `RunScript`), so only the CLI's own port can show which runtime a script actually ran in |
| R7.6 | `bruno-cli/tests/fork/flow/sandbox.spec.js`, and `sandbox.integration.spec.js` for the end-to-end proof | §14.1's `--sandbox` is a flag on a command the engine has never heard of; R7.5's reason, one layer up |
| R7.7 | `bruno-cli/tests/fork/flow/collection-auth.spec.js`, and `collection-auth.integration.spec.js` for the end-to-end proof | §6.4's implicit `collection` profile is host-supplied by construction — the engine is handed `RunOptions.authProfiles` and never opens a collection to build one, so only a host's own reader can show which credential the collection contributed |
| R7.8 | `bruno-cli/tests/fork/flow/scope.spec.js`, and `scope.integration.spec.js` for the end-to-end proof | Locating a collection root on disk is host discovery (§14.1) the engine never performs — it is handed a scope already resolved (§13.2), so only a host's own directory walk can show it recognises both on-disk formats |
| R13.3 | `bruno-cli/tests/fork/flow/schema.spec.js`, and `schema.integration.spec.js` for the command line itself | The engine owns the schema and pins its contents in `schema.spec.js`; which version an invocation emits and where it lands are §14's, and only the CLI has them |
| R4k | Asserted throughout, by every scenario that names an outcome | §14.6's vocabulary is a property of every reason string in the suite; a dedicated scenario would restate what forty assertions already pin |

**R4d2 is the one requirement with no test anywhere.** R4m was the wider gap and is closed: §5.4's
schema is built (`src/schema/`), and `schema.spec.js` runs it over every fixture flow in this file.
One *row* is still open beside it — R4h's `--dry-run` case, registered as an `it.todo` because 001
§19.1 schedules the flag for v2 and there is nothing yet to run it against.

## 3. F1 — Role matrix

**Pins:** §9.4 dataset iteration · §10.2 assertion context · §10.3 negative tests · §6.4 profiles
resolving per iteration
**Findings:** 1 (assertions could not see `row.*`), 2 (implicit sequence rewired by an inserted
branch), 3 (dataset carrying credentials)

One flow run against three users with different roles, where the three do **not** share an expected
outcome.

```yaml
# fixtures/flows/f1-role-matrix.flow.yml
version: 1

meta:
  name: Product lifecycle by role

apis:
  shop-api: ../specs/shop-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"

authProfiles:
  user-token: { mode: bearer, token: "{{steps.login.token}}" }

dataset: ../datasets/roles.csv

steps:
  - id: login
    operation: shop-api#login
    auth: none
    body:
      email: "{{row.email}}"
      password: "{{testUserPassword}}"
    outputs:
      token: data.access_token

  - id: me
    operation: shop-api#getMe
    auth: user-token
    assert:
      - res.body.data.role eq row.role

  - id: add_product
    operation: shop-api#addProduct
    auth: user-token
    when: row.canCreate eq true
    body:
      name: "Widget {{flow.runId}}-{{flow.iteration}}"
      price: 1299
    outputs:
      productId: data.id
    assert:
      - res.status eq 201

  - id: add_product_denied
    operation: shop-api#addProduct
    auth: user-token
    depends: [me]
    when: row.canCreate eq false
    failOnStatusCode: false
    body:
      name: "Widget {{flow.runId}}-{{flow.iteration}}"
      price: 1299
    outputs:
      leakedProductId: data.id
    assert:
      - res.status eq 403

  - id: get_product
    operation: shop-api#getProduct
    auth: user-token
    depends: [add_product]
    pathParams:
      id: "{{steps.add_product.productId}}"
    assert:
      - res.status eq 200

  - id: cleanup_leak
    operation: shop-api#deleteProduct
    auth: user-token
    depends:
      - on: add_product_denied
        status: [success, failed, skipped, cancelled]
    failOnUnresolved: false                # nothing leaked on a passing run — §11.2
    pathParams:
      id: "{{steps.add_product_denied.leakedProductId}}"
```

`fixtures/datasets/roles.csv` — no comment line; a leading `#` row is data to a CSV parser:

```csv
email,role,canCreate
admin@example.com,admin,true
editor@example.com,editor,true
viewer@example.com,viewer,false
```

### F1.1 Happy path — all three roles behave

Stub `addProduct` to return 201 for admin and editor, 403 for viewer.

| iteration | login | me | add_product | add_product_denied | get_product | cleanup_leak |
|---|---|---|---|---|---|---|
| admin | success | success | success | skipped `condition-false` | success | skipped `unresolved-dependency` |
| editor | success | success | success | skipped `condition-false` | success | skipped `unresolved-dependency` |
| viewer | success | success | skipped `condition-false` | **success** | skipped `unmet-dependency` | skipped `unresolved-dependency` |

Flow status `passed`, exit **0**.

Every skip in that table is a `condition-false` or `unmet-dependency`, and `cleanup_leak` carries
`failOnUnresolved: false` — so `config.failOnUnresolved` (default `true`, §11.2) leaves this run
green. An implementation that fails the flow on *any* skip turns this entire table red, which is
the check that the flag's scope was implemented and not just its name.

Assert specifically that `add_product_denied` is `success` on a 403 — a negative test passing is the
whole point of §10.3, and an implementation that treats 4xx as failure regardless of assertions goes
green on every other test in this file while getting this one wrong.

### F1.2 The role claim is wrong for one row

Stub `getMe` to return `role: "admin"` for the viewer row.

`me` **fails** on that iteration only; admin and editor pass. Flow status `failed`, exit **1**.

This is the regression test for finding 1: an engine whose assertion context lacks `row.*` either
throws on an unresolved identifier or silently compares against `undefined`. Assert the failure
message names the expected and actual role, so a silent-`undefined` implementation cannot pass.

### F1.3 RBAC is broken — the negative test catches it

Stub `addProduct` to return **201** for the viewer row.

`add_product_denied` **fails** (asserted 403, got 201). Flow status `failed`, exit **1**, and
`cleanup_leak` **runs** — the leaked id was produced, so the product created by the bug is deleted.

This pins the §10.3 rule that a negative step declares `outputs:` anyway. Assert the `deleteProduct`
call actually reached the stub port; an implementation that skips cleanup here leaks a resource on
exactly the run that found a bug.

### F1.4 Structural — the inserted branch does not rewire the sequence

A static assertion, no execution: parse the flow and assert `get_product`'s resolved parent is
`add_product`, **not** `add_product_denied`.

Finding 2 was that deleting the explicit `depends: [add_product]` produces a flow that is valid,
runs, and tests the inverse. Guard the file against that edit.

---

## 4. F2 — Order fulfillment with carrier fallback

**Pins:** §9.1 `any` joins + shared slots + cleanup ordering · §11.2 outputs extracted on failure ·
§12 sub-flows · §6.2 multi-service bindings
**Findings:** 4 (cleanup race), 5 (negative-test framing → §10.3)

```yaml
# fixtures/flows/f2-order-fulfillment.flow.yml
version: 1

meta:
  name: Order fulfillment with carrier fallback

apis:
  orders-api: ../specs/orders-v2.yml
  carrier-a:
    source: ../specs/carrier-a-v1.yml
    baseUrl: "{{carrierABaseUrl}}"
    auth: carrier-a-key
  carrier-b:
    source: ../specs/carrier-b-v3.yml
    baseUrl: "{{carrierBBaseUrl}}"
    auth: carrier-b-key

config:
  baseUrl: "{{ordersBaseUrl}}"
  concurrency: 5

authProfiles:
  user-token:    { mode: bearer, token: "{{steps.auth.token}}" }
  carrier-a-key: { mode: apikey, key: X-Api-Key, value: "{{carrierAApiKey}}", placement: header }
  carrier-b-key: { mode: bearer, token: "{{carrierBToken}}" }

shared: [quoteId]

steps:
  - id: auth
    uses: ./f2-login.flow.yml
    with:
      email: "{{testUserEmail}}"

  - id: create_order
    operation: orders-api#createOrder
    auth: user-token
    body:
      customer_id: "{{steps.auth.userId}}"
      items: [{ sku: WIDGET-1, qty: 2 }]
    outputs:
      orderId: data.id

  - id: quote_primary
    operation: carrier-a#createQuote
    body:
      order_ref: "{{steps.create_order.orderId}}"
      service: ground
    outputs:
      quoteId: data.quote.id
    shared: [quoteId]
    assert:
      - res.body.data.quote.amount gt 0

  - id: quote_fallback
    operation: carrier-b#getRates
    depends: [{ on: quote_primary, status: [failed] }]
    body:
      reference: "{{steps.create_order.orderId}}"
    outputs:
      rateId: data.rates[0].id
    shared:
      quoteId: rateId

  - id: book_shipment
    operation: orders-api#bookShipment
    auth: user-token
    depends:
      any:
        - on: quote_primary
        - on: quote_fallback
    pathParams:
      id: "{{steps.create_order.orderId}}"
    body:
      quote_id: "{{shared.quoteId}}"
    assert:
      - res.body.data.order_id eq steps.create_order.orderId

  - id: cancel_order
    operation: orders-api#cancelOrder
    auth: user-token
    depends:
      - on: book_shipment
        status: [success, failed, skipped, cancelled]
    failOnUnresolved: false             # no order to cancel is a valid outcome — §11.2
    pathParams:
      id: "{{steps.create_order.orderId}}"
```

### F2.1 Primary carrier healthy

`quote_primary` succeeds and writes `shared.quoteId = q_a1`; `quote_fallback` skips
`unmet-dependency`; `book_shipment` books with `q_a1`; `cancel_order` runs. Exit **0**.

Assert the `bookShipment` request body carried `q_a1` — the slot resolving to the right branch is
the point, and a run where both branches happen to agree proves nothing.

### F2.2 Both writers write — declaration order decides

Stub `createQuote` to return **200 with `amount: 0`** and a populated `data.quote.id = q_a1`, and
`getRates` to return `r_b7`.

`quote_primary` **fails** its assertion, but a response arrived, so §11.2 extracts its outputs and
it **writes the slot anyway**. `quote_fallback` then runs and writes `r_b7`.

Assert `bookShipment` received **`r_b7`**. Flow status `failed`, exit **1** — the primary carrier
returning a zero quote is a genuine defect and the run is correctly red even though the booking
succeeded.

This is the only scenario where two writers populate one slot, so it is the sole guard on the
declaration-order tiebreak. Run it with `concurrency: 1` and `concurrency: 5`, and with the stub
port delaying carrier-b's response longer than carrier-a's, and assert the same `r_b7` every time —
a completion-order implementation passes at `concurrency: 1` and fails under delay injection.

### F2.3 Cleanup does not race the booking

Instrument the stub port with a call log. Assert `cancelOrder` is dispatched **after**
`bookShipment` resolves, at `concurrency: 5`.

Finding 4 in executable form. An implementation where `cancel_order` depends on `create_order`
passes every assertion above and still voids the order mid-booking; only call ordering catches it.

### F2.4 Sub-flow failure propagates

Stub the login sub-flow's internal step to return 401. Assert the `auth` **step** is `failed`, every
downstream step skips `unmet-dependency`, and the reported failure names the sub-flow's internal step
(`auth/login`) rather than only the `uses` step.

---

## 5. F3 — Batch settlement with privilege escalation

**Pins:** §7.3 typed whole-value interpolation · §8.1 structured outputs · §6.4 lexical profiles and
the ancestor rule
**Findings:** 6 (interpolation stringified everything), 7 (structured outputs unspecified), 8
(withdrawn — §6.4 already covered it)

```yaml
# fixtures/flows/f3-batch-settlement.flow.yml
version: 1

meta:
  name: Batch settlement with privilege escalation

apis:
  auth-api:    ../specs/auth-v2.yml
  billing-api: ../specs/billing-v4.yml
  audit-api:
    source: ../specs/audit-v1.yml
    baseUrl: "{{auditBaseUrl}}"

config:
  baseUrl: "{{billingBaseUrl}}"

authProfiles:
  user-token:     { mode: bearer, token: "{{steps.auth.token}}" }
  elevated-token: { mode: bearer, token: "{{steps.elevate.token}}" }

steps:
  - id: auth
    uses: ./f2-login.flow.yml
    with:
      email: "{{operatorEmail}}"

  - id: get_batch
    operation: billing-api#getOpenBatch
    auth: user-token
    outputs:
      batchId: data.batch.id
      batch:
        script: |
          (res, ctx) => {
            const [, region, sequence] = res.body.data.batch.ref.split('/');
            return { region, sequence, itemCount: res.body.data.batch.items.length };
          }

  - id: elevate
    operation: auth-api#elevate
    auth: user-token
    body:
      scope: settlement:write
    outputs:
      token: data.access_token

  - id: submit_settlement
    operation: billing-api#submitSettlement
    auth: elevated-token
    depends: [get_batch, elevate]
    pathParams:
      id: "{{steps.get_batch.batchId}}"
    body:
      region:   "{{steps.get_batch.batch.region}}"
      sequence: "{{steps.get_batch.batch.sequence}}"
    assert:
      - res.status eq 202

  - id: create_audit_record
    operation: audit-api#createRecord
    auth: user-token
    depends: [get_batch]
    body:
      batch_ref:  "{{steps.get_batch.batchId}}"
      region:     "{{steps.get_batch.batch.region}}"
      item_count: "{{steps.get_batch.batch.itemCount}}"
      label:      "batch {{steps.get_batch.batchId}} ({{steps.get_batch.batch.region}})"
```

Stub `getOpenBatch` with `data.batch.id: "B-42"`, `data.batch.ref: "BATCH-2026-08-06/EU/0042"` and a
12-element `data.batch.items` array. The id is what `batchId` extracts and what the `label`
assertion below embeds, so it has to be pinned here rather than left to the fixture.

### F3.1 Types survive a whole-value reference

Inspect the `createRecord` request body captured by the stub port and assert **on JSON types**, not
on string equality:

```js
expect(body.item_count).toBe(12);              // number, not "12"
expect(typeof body.item_count).toBe('number');
expect(body.region).toBe('EU');                // string stays a string
expect(body.label).toBe('batch B-42 (EU)');    // embedded -> stringified
```

Finding 6. A stringifying implementation passes `region` and `label` and fails only `item_count`, so
the numeric field has to be asserted with `toBe(12)` — `toEqual("12")` and a loose comparison both
let the defect through.

Add a boolean and an array field to the audit operation's schema and assert those too; number is the
common case but not the only one.

### F3.2 One derivation, two consumers

Assert `submit_settlement` and `create_audit_record` both received `region: "EU"`, and that the
`get_batch` output **script ran exactly once**. Counting invocations is what distinguishes a
structured output from three scripts that happen to agree.

### F3.3 The auth token changes mid-flow

Assert the `Authorization` header on each dispatched request: `getOpenBatch` and `createRecord`
carry the login token, `submitSettlement` carries the elevated one, and `elevate` itself carries the
**login** token — the escalation is authorized by the credential being escalated.

### F3.4 Structural — a profile's step reference is a real dependency

Remove `elevate` from `submit_settlement`'s `depends` and assert `bru flow validate` **fails**,
naming `elevated-token` and `steps.elevate`. Without §6.4's ancestor rule this is a 401 at run time
that reads like a credentials problem.

---

## 6. F4 — Partner item acceptance

**Pins:** §6.3 per-step base URL resolution · §8.1 script-form filtering · §11.1 polling and
`retries-exhausted` · §6.2 three bindings with three auth regimes
**Findings:** 9 (`[?]` unusable in a path), 10 (withdrawn — all requests keep a spec), 11
(step-produced base URLs)

```yaml
# fixtures/flows/f4-partner-acceptance.flow.yml
version: 1

meta:
  name: Partner item acceptance

apis:
  user-api: ../specs/user-v3.yml
  items-api:
    source: ../specs/items-v2.yml
    baseUrl: "{{itemsBaseUrl}}"
    auth: none
  external-api:
    source: ../specs/external-v1.yml
    baseUrl: "{{externalBaseUrl}}"
    auth: none

config:
  baseUrl: "{{userBaseUrl}}"

authProfiles:
  user-token:    { mode: bearer, token: "{{steps.login.token}}" }
  partner-token: { mode: bearer, token: "{{steps.exchange_handoff.token}}" }

steps:
  - id: login
    uses: ./f2-login.flow.yml
    with: { email: "{{operatorEmail}}" }

  - id: partnerships
    operation: user-api#listPartnerships
    auth: user-token
    outputs:
      partnershipId:
        script: |
          (res, ctx) => res.body.data.partnerships
            .find((p) => p.status === 'active' && p.role === 'owner')?.id
    assert:
      - steps.partnerships.partnershipId isDefined     # locating it is the requirement

  - id: partnership_details
    operation: user-api#getPartnership
    auth: user-token
    pathParams: { id: "{{steps.partnerships.partnershipId}}" }
    outputs:
      accountId: data.partnership.account.id

  - id: create_item
    operation: user-api#createItem
    auth: user-token
    body:
      account_id:     "{{steps.partnership_details.accountId}}"
      partnership_id: "{{steps.partnerships.partnershipId}}"
    outputs:
      itemId: data.item.id

  - id: await_initiated
    operation: items-api#getItemStatus
    pathParams: { id: "{{steps.create_item.itemId}}" }
    retry:
      maxAttempts: 30
      delay: 2000
      shouldRetry: |
        (res, attempt, ctx) => res.body.data.status !== 'initiated'
    assert:
      - res.body.data.status eq initiated

  - id: handoff
    operation: items-api#getHandoff
    pathParams: { id: "{{steps.create_item.itemId}}" }
    outputs:
      handoffRef: data.handoff.ref

  - id: exchange_handoff
    operation: external-api#createSession
    pathParams: { ref: "{{steps.handoff.handoffRef}}" }
    outputs:
      token: data.session_token

  - id: accept_item
    operation: items-api#acceptItem
    auth: partner-token
    pathParams: { id: "{{steps.create_item.itemId}}" }
    assert:
      - res.body.data.status eq accepted
```

### F4.1 Happy path across three services

Stub `listPartnerships` with three partnerships where exactly one is `status: active, role: owner`,
and `getItemStatus` to return `pending`, `pending`, then `initiated`.

All steps `success`, exit **0**. Assert:

- `getPartnership` received the id of the **matching** partnership, not the first in the array
- `getItemStatus` was called exactly **3** times
- each request went to the base URL of its own binding (three distinct hosts)
- `acceptItem` carried the partner token, while `getItemStatus` and `getHandoff` carried **no**
  `Authorization` header at all — a step-level `auth:` overriding a binding's `auth: none` must not
  leak backwards onto the binding's other steps

### F4.2 No partnership matches

Stub `listPartnerships` with partnerships where none is both active and owner.

The `partnershipId` output is **not produced**, so the step's own assertion
`steps.partnerships.partnershipId isDefined` **fails**. `partnerships` is `failed`, and everything
downstream skips `unmet-dependency`. Flow status `failed`, exit **1**.

Assert the failure is reported against **`partnerships`**, not `partnership_details`. That is the
scenario's whole point: the requirement is that the partnership be *located*, so the step doing the
locating is the one that must go red. Failing one step later reports that the flow could not
proceed instead of why.

Assert no request was dispatched for `getPartnership`. This is the §8.1 rule that a `find()`
returning `undefined` yields no output; an implementation that coerces to `"undefined"` sends a
request to `/partnerships/undefined` and gets a confusing 404 instead.

Then the backstop, as two more cases on the same fixture. **Delete the assertion** and re-run:
`partnerships` now succeeds, `partnership_details` skips `unresolved-dependency`, and
`config.failOnUnresolved` (default `true`, §11.2) still fails the run — exit **1**, reported against
the consumer. Re-run once more with `failOnUnresolved: false` and assert exit **0** with an identical
step table, since the flag must change only the flow's verdict, never which steps ran.

The three together pin the layering: the assertion is how a flow states the requirement, the flag is
what catches a flow that never stated it, and neither changes the schedule.

### F4.3 The poll never settles

Stub `getItemStatus` to return `pending` forever.

`await_initiated` **fails** with reason `retries-exhausted` after exactly **30** attempts, the
failure message names the `state eq initiated` assertion, and every downstream step skips
`unmet-dependency`. Exit **1**.

Assert the attempt count precisely — an off-by-one in the `maxAttempts` cap is invisible at any
other count, and §11.1 makes the cap a hard guarantee rather than a hint.

Then the delay sequence, against the same stub with the `Clock` port's `sleep` recorded. `n`
attempts means `n - 1` sleeps, and the values are exact — jitter is off by default, so there is
nothing to bound rather than assert:

| Retry block | `sleep` receives |
|---|---|
| `maxAttempts: 4, delay: 1000` (default `fixed`) | `1000, 1000, 1000` |
| `maxAttempts: 6, delay: 1000, backoff: exponential` | `1000, 2000, 4000, 8000, 16000` |
| the same with `maxDelay: 5000` | `1000, 2000, 4000, 5000, 5000` |
| `maxAttempts: 12, delay: 5000, backoff: exponential`, no `maxDelay` | every value ≤ `30000`, the default cap |
| `maxAttempts: 1` | `sleep` is never called |
| `backoff: exponential, jitter: full, delay: 1000` | each value within `[0, 2 ** (n - 1) * 1000]` — the only row asserted as a range |
| any of the above | total wall-clock time is zero; the `Clock` port is never allowed to really sleep |

The `maxAttempts: 1` row is worth its line: a delay applied *before* the first attempt rather than
before each retry is a bug that never changes an outcome, only every run's duration.

### F4.4 Per-tenant subdomains

A separate pair of fixture flows for §6.3's step-produced base URL:

```yaml
# fixtures/flows/f4-tenant-parent.flow.yml
apis:
  signup-api: ../specs/platform-v1.yml
  workspace-api:
    source: ../specs/platform-v1.yml
    baseUrl: "https://{{steps.create_workspace.subdomain}}.example.com"

steps:
  - id: create_workspace
    operation: signup-api#createWorkspace
    outputs:
      subdomain: data.workspace.subdomain

  - id: workspace_settings
    operation: workspace-api#getSettings

  - id: session
    uses: ./f4-workspace-session.flow.yml
    with:
      subdomain: "{{steps.create_workspace.subdomain}}"
```

Stub `createWorkspace` to return `subdomain: "acme"`. Assert:

- `createWorkspace` was dispatched to the **spec's** `servers[0].url`
- `getSettings` was dispatched to `https://acme.example.com`
- the sub-flow's own request also reached `https://acme.example.com`, resolved from `params.subdomain`
- two aliases over the same document resolve to two different hosts in one run

Then the structural half: remove `create_workspace` from the graph ahead of `workspace_settings`
and assert `bru flow validate` **fails** on the missing ancestor for a binding-level `{{steps.*}}`
reference (§6.3).

---

## 7. Regressions not owned by a single flow

`regressions.spec.js`. Each is a minimal flow, not a full scenario — they exist because the defect
they guard is invisible in a flow that works.

### R1 — A dead service does not report green

**Finding:** the fail-open default that motivated `failOnStatusCode` (§10.1).

Two steps: one creating a resource, one consuming its output. Stub the first with **500** and an
error body containing no `data.id`, declare **no assertions anywhere**, and set
`config.failOnUnresolved: false`.

Assert the first step is `failed` with reason `unexpected-status`, a message naming the status it
got, and exit **1**.

**The `failOnUnresolved: false` is what makes this a valid test.** Both guards catch this outage:
the status check fails step one, and an unresolved skip on step two would fail the run
independently. Left at the default, the flow exits 1 even if `failOnStatusCode` regresses entirely,
and the test passes while detecting nothing. Disabling the downstream guard isolates the one under
test — and the step-level `reason` assertion, not the exit code, is what carries the check.

Before `failOnStatusCode` this flow exited 0: the 500 passed as `success` because no schema was
declared for it, the missing output skipped the consumer, and nothing was recorded as a failure.

### R2 — Retry does not amplify a non-idempotent failure

**Finding:** the §11.1 default predicate.

A flow with `config.retry.maxAttempts: 3` and one POST step whose assertion fails against a **201**
response. Assert the stub port received exactly **1** dispatch.

Then the same flow with an explicit `shouldRetry` returning `true`: assert **3** dispatches. The
pair pins both halves — the safe default, and that opting in still works.

Two more, for §11.1's rows §18 left open:

| Case | Expected |
|---|---|
| `maxAttempts: 3`, **no** `shouldRetry`, answered `502` every time | 3 attempts, reason `retries-exhausted` — not `unexpected-status`; the default predicate is a predicate, and the 502 survives in `message` |
| a predicate reading `ctx.outputs.state`, over a step whose `outputs:` extract it, ready on attempt 3 | stops at 3 and **succeeds**; the step's published outputs are the last attempt's |
| an `outputs:` entry in that same step whose path matches nothing | **absent** from `ctx.outputs` and from the step's outputs — not present-and-undefined, so a predicate reads it as the missing path off `res` would read |

The first row is the one an implementation gets wrong by reading §14.6's "the retry predicate" as
*an authored* one. The second and third are one step: a predicate that could not see `ctx.outputs`
would spin to the cap, and an absent-versus-undefined mistake makes the third condition always
true.

### R3 — A negative test without the opt-out fails

Two single-step flows against an endpoint stubbed to return 403:

- `assert: res.status eq 403` with **no** `failOnStatusCode: false` → step **failed**
- `failOnStatusCode: false` **without** a status assertion → `bru flow validate` emits the §14.3
  warning

Both halves of §10.3's two-part rule, each asserted alone.

### R4 — Slot and output resolution boundaries

Minimal flows, each asserting one rule:

| Case | Expected |
|---|---|
| `{{shared.x}}` read by a step that is not downstream of every writer | validation **error** (§9.1), naming `writers: any` as the way out |
| the same flow with the slot declared `writers: any` | legal — each branch reads what its own writer filled, including through an api binding's auth profile |
| a `writers: any` slot read by a step with no writer above it at all | still a validation **error**: a read with nothing upstream is reading nothing |
| `{{shared.x}}` declared, never written, read in a body | resolves **empty string**, step runs |
| the same slot read in a field the operation types as an integer | `invalid-request` before dispatch, the schema error naming the field — the proof it is `""` and not an omitted key, which would have validated |
| `{{flow.iteration}}` in a flow with no `dataset:` | resolves to `0` and is typed, not left on the wire as a placeholder |
| a step with bare `status: [cancelled]` whose parent finished `success`, in an interrupted run | **skipped** `unmet-dependency` — `depends` addresses the parent, and declaring `cancelled` buys eligibility for the cleanup window, not a met dependency |
| `{{steps.a.b}}` where the output was never produced | step **skipped** `unresolved-dependency`, its message naming `steps.a.b` |
| `{{shared.x}}` in a sub-flow, written only by the caller | not visible; validation error (§12.3) |
| a caller declaring `failOnStatusCode: false`, over a sub-flow declaring no `config:` at all | the sub-flow's step **passes** a 500 — `config:` is configuration and inherits (§12.3) |
| a strict caller, over a sub-flow declaring `failOnStatusCode: false` itself | the sub-flow's step still **passes** — its own declaration wins, or a library flow means something different at every call site |
| a caller declaring a `baseUrl`, over a sub-flow that declares none and binds its own API | the sub-flow calls its document's `servers[0]`, not the caller's host — the one `config:` key that does not inherit |

The three `config:` rows are one case in three arrangements, and only the set distinguishes the rule
from its two failure modes: not inheriting at all stops a caller's configuration at its own steps,
and inheriting *over* the sub-flow lets a strict caller silently rewrite a shared flow's judgement
about itself. The 500 they use conforms to the operation's documented error schema, so
`failOnStatusCode` is the only rule in play — an error body that also failed `validateSchema` would
pass all three rows for the wrong reason.
| dataset with `parallel: 3`, each row writing the same slot | each iteration reads **its own** value |

The second and third rows are the pair that must not collapse into each other — an unwritten slot is
empty, an unproduced output skips, and an implementation that unifies them breaks either cleanup or
the fallback join.

### R4b — `failOnUnresolved` fires on one reason only

Four minimal flows, one per skip reason, each run with `config.failOnUnresolved` at its default:

| Skip reason | Flow status | Exit |
|---|---|---|
| `unresolved-dependency` | failed | 1 |
| `condition-false` (a `when:` that is false) | passed | 0 |
| `unmet-dependency` (a fallback branch whose primary succeeded) | passed | 0 |
| `run-cancelled` | cancelled | 4 |

Then the two overrides: `config.failOnUnresolved: false` turns row one green, and a step-level
`failOnUnresolved: false` turns it green while the flow-level default stays `true`.

The middle two rows are the ones that matter. A blanket implementation passes row one and the
override cases, and only these reveal that conditional and fallback branches were collateral damage.

**Every skip carries §14.6's message where the engine knows more than the reason does** — which
reference was never produced, which dependency was not met and what it did instead. Row one is the
case that forces it: it is the only way a run fails with no failed step, so the reason alone leaves a
red run whose graph is entirely green and grey, and the message is the only thing that closes it.

**And every run reports `decidedBy` (§13.2), asserted on the same four rows:** row one names the
skipped step, an ordinary failing run names the failed one, the passing rows name nothing, and the
cancelled row names nothing because the interrupt decided it and nothing had failed under it. The
flow-level and step-level opt-outs turn row one green *and* silent, which is the half that catches an
implementation reporting every unresolved skip rather than the ones the rule acted on.

**A fifth row settles what the cancelled row cannot: a run that both fails a step and is then
interrupted.** The same flow, with its first step answered `500` by a response that also aborts the
run: the step is `failed:unexpected-status`, the step after it is `skipped:run-cancelled`, the run is
`cancelled` at exit `4` — and `decidedBy` is `['create']`. Both halves are load-bearing and an
implementation can hold either alone. Reporting `failed` puts an infrastructure outcome behind a test
verdict; reporting `cancelled` with an empty `decidedBy` — which is what the obvious implementation
does, the interrupt being checked before the failures — loses a genuine regression behind an
infrastructure outcome, and is the case 001 §14.6 spends the field on.

### R4c — Generated data is stable where it must be

**Pins:** §7.3 `vars:` evaluation timing and generated values.

A flow with `vars: { testEmail: "qa+{{$randomUUID}}@example.com" }`, a signup step and a login step
both sending `{{testEmail}}`, over a two-row dataset.

| Assertion | Why |
|---|---|
| Within one iteration, signup and login sent the **same** address | Lazy per-use evaluation gives two, and the login 404s |
| The two iterations sent **different** addresses | One shared evaluation makes both rows the same identity |
| A step sending `{{$randomUUID}}` inline twice gets **two** values | Binding to a `var:` is what makes it stable, not the generator |
| `count: "{{$randomInt}}"` arrives as a JSON **number** | Bruno's interpolator stringifies mock output (`interpolate/index.ts:41`); the engine must resolve whole-value references itself |
| `vars:` referencing `{{steps.x.y}}` fails validation | Nothing has run when `vars:` are evaluated |

The first two rows are the pair that must both hold — an implementation can satisfy either alone by
picking the wrong evaluation scope, and only running both catches it.

### R4d — File sources

**Pins:** §7.4.

Supply fixtures through a stubbed `ReadFile` port, never on disk.

| Case | Expected |
|---|---|
| `vars: { catalog: !file ./fixtures/catalog.json }`, referenced as `{{catalog.items[0].sku}}` | navigates the parsed structure |
| `bodyFile:` on a step | merges as the inline layer; `{{steps.*}}` inside the file interpolates |
| `bodyFile: "./fixtures/{{steps.pick.variant}}.json"` | path interpolates first, then the file is read |
| `bodyFile:` **and** `body:` on one step | validation error |
| `file: ../../../../etc/passwd` | validation error; the port is **never called** |
| a `bodyFile:` path that does not exist | step fails with a file-read reason, not a crash |

The containment row asserts on the port, not on the outcome — a run that reads the file and then
rejects it has already read it.

### R4c2 — How a bare operand resolves

**Pins:** §10.2, §9.3. One step, one stubbed response, one assertion per row — the rule governs
every `assert:` and every `when:` in the format, so it is asserted directly rather than inferred
from flows that happen to exercise it.

Against a response body of `{ "data": { "state": "settled", "role": "admin", "count": 0,
"active": true } }`, a dataset row of `{ "role": "admin" }`, and a flow var `status: "pending"`:

| Assertion | Resolves to | Outcome |
|---|---|---|
| `res.body.data.state eq settled` | the string `settled` | passes |
| `res.body.data.count eq 0` | the number `0` | passes |
| `res.body.data.active eq true` | the boolean `true` | passes |
| `res.body.data.role eq row.role` | a reference — `row` is a reserved root | passes |
| `res.body.data.state eq status` | the string `status`, **not** the flow var | **fails**, actual `settled` |
| `res.body.data.state eq {{status}}` | the flow var `pending` | fails, and names `pending` as expected |
| `res.body.data.state eq "settled"` | the quoted string | passes |
| `res.body.data.role eq steps.login.role` where `login` is an ancestor with that output | a reference | passes |
| `res.body.data.role eq rowrole` | the string `rowrole` | fails — a root matches only as a whole first segment |
| `when: row.canCreate eq true` on a step | the boolean, per the same rule | the row selects the step |

The fifth row is the load-bearing one. An implementation that resolves any bare word against the
variable scope passes every other row and silently turns a string comparison into a variable lookup
— which is the failure this rule was written to make impossible to hit by accident, since `{{status}}`
is right there for the case that wants it.

### R4d2 — Dataset formats and row typing

**Pins:** §9.4, §10.2's operand rule. F1's `roles.csv` is the fixture; the JSON and YAML variants
carry the same three rows.

| Case | Expected |
|---|---|
| the CSV, JSON and YAML datasets run against F1 unchanged | **identical** iteration outcomes — assert the three step tables match, not merely that each passes |
| CSV cell `true` | boolean `true`; `when: row.canCreate eq true` selects the row |
| CSV cell `1299` | number; `row.price gt 1000` holds |
| CSV cell `02134` | number `2134` — the documented cost of inference, asserted so it is a decision and not a surprise |
| CSV cell `"007"`, quoted | string `007`, digits intact |
| CSV cell `null`, and an empty cell | `null` and `""` respectively — an empty cell is not the null literal |
| JSON row `{ "canCreate": "true" }` | the **string**, which does not satisfy `eq true` — native types are not re-inferred |
| a dataset in a sub-flow | validation error (§12.4) |
| a `.tsv` or `.xml` dataset | validation error naming the three supported formats |

The first row is the one that matters: the three formats exist to be interchangeable, and an
implementation that types CSV by its own rule rather than §10.2's passes every other row here while
making a converted dataset behave differently from the one it replaced.

### R4d3 — A host-supplied dataset

**Pins:** §13.2's `overrides.dataset`, §14.1's `--dataset`, and §7.4's containment. Asserted through
`runFlow` rather than through a command line, because both hosts reach it the same way — 002 §7.2's
panel control and the CLI flag are one field.

| Case | Expected |
|---|---|
| an override against a flow that declares `dataset:` | the override's rows, and the flow's own `parallel:` still governing |
| an override against a flow that declares none | it iterates — the case the option exists for is a flow written against one row set and pointed at another |
| that same flow with no override | one iteration, so the override is what makes it iterate at all |
| an override resolving outside the scope root | refused before the run starts, naming the boundary — §7.4 holds a dataset the way it holds a `!file` |
| the snapshot §14.5 writes | reports the dataset the run **used**, not the one the file declares |

The last two rows are the ones a naive wiring fails. `dataset:` reached the `ReadFile` port without
passing through §7.4's check, which mattered little while the only source was a path committed in
the flow file and matters a great deal once one arrives from a command line. And 002 §5.5 decides
whether to offer an iteration selector from the snapshot's `dataset` field, so a snapshot reporting
the *declared* dataset leaves a flow running rows it has no way to display.

### R4e — Multipart and binary bodies

**Pins:** §7.5. Fixtures come from the stubbed `ReadFile` port; assertions inspect the
`MaterializedRequest` handed to `ExecuteRequest`.

Against an `uploadInvoice` operation declaring `multipart/form-data` with parts `document`
(`format: binary`), `description` (string) and `metadata` (object):

| Case | Expected |
|---|---|
| `document: !file ./fixtures/invoice.pdf`, `description: "Q3"` | two parts; `document` carries the file bytes, `description` a field |
| part filename, not overridden | `invoice.pdf` — the basename |
| `!file` with `filename: signed.pdf` | that filename on the wire |
| content type, no `contentType:` and no spec `encoding` | inferred `application/pdf` from the extension |
| operation declares `encoding.document.contentType: application/x-pdf` | the spec's value wins over extension inference |
| `metadata: { tenant: acme }` | serialized as an `application/json` part, not a flattened string |
| `attachments: [!file a.pdf, !file b.pdf]` | two parts under one name |
| required `document` omitted | validation error naming the part; no request dispatched |
| `!file` on a part of an operation declaring `application/json` | validation error |

And for a `uploadScan` operation declaring `application/pdf`:

| Case | Expected |
|---|---|
| `bodyFile: ./fixtures/scan.pdf` | body is the exact bytes — assert a **byte-for-byte** match against the stub's buffer |
| `body: !file ./fixtures/scan.pdf` | **byte-identical to the previous row** — assert the two `MaterializedRequest`s match, not merely that both succeed |
| `body: !file` carrying `filename:` or `contentType:` on a single-payload operation | validation error; the options are multipart-only |
| the same fixture containing `{{` sequences | bytes unchanged; no interpolation ran |
| capture for both steps | records path, filename, content type and length — and **no file content** |

And for a `createOrder` operation declaring **both** `application/json` and `multipart/form-data`:

| Case | Expected |
|---|---|
| no `contentType:` on the step | validation error `ambiguous-media-type`, listing both types; nothing dispatched |
| `contentType: multipart/form-data` | assembled as parts, per the multipart rules above |
| `contentType: application/json` with the same body | assembled as a JSON structure — assert the two produce **different** wire formats from one body |
| `contentType: application/xml`, which the operation does not declare | validation error |
| `contentType:` on `uploadScan`, which declares one type | validation error — the field is legal only where the operation is ambiguous |
| a body whose only value is a `!file`, on the ambiguous operation, with no `contentType:` | still `ambiguous-media-type` — nothing is inferred from the body's shape |

The last row is the regression test for the rejected alternative: an implementation that guesses
multipart from the presence of a `!file` passes every other row here and silently changes a
request's wire format when someone edits a body value.

The byte-for-byte row is the one that matters most: an implementation that routes a binary body
through the JSON path corrupts it in ways a length check alone will not catch. The `{{` row exists
because a PDF containing those two characters is not unusual, and interpolating it would produce a
file that is subtly wrong rather than obviously broken.

### R4f — Cookie jar scoping

**Pins:** §7.6. The stub `ExecuteRequest` records the `Cookie` header on every dispatch and returns
`Set-Cookie` on demand, so the jar is observable without a real cookie implementation.

| Case | Expected |
|---|---|
| step 1 returns `Set-Cookie: sid=a`; step 2 dispatches | step 2 carries `sid=a` |
| a two-row dataset, each row's login returning a different `sid` | row two **never** sends row one's `sid` |
| the same dataset with `parallel: 2` | still no cross-contamination, on repeated runs |
| a sub-flow step following a login step | carries the caller's `sid` |
| a sub-flow that receives a `Set-Cookie` | the caller's later steps see it |

The parallel row is the one worth running repeatedly — a run-wide jar passes the sequential case and
fails intermittently under concurrency, which is the failure this rule exists to prevent.

### R4g — Whole-run budget

**Pins:** §11.3. Fake timers drive the clock.

A flow with `config.maxRunDuration` shorter than the time its steps consume, and a cleanup step
declaring `status: [cancelled]`:

| Assertion | Why |
|---|---|
| in-flight steps recorded `cancelled`, unstarted ones skipped `run-cancelled` | the timeout takes the cancellation path, not a distinct one |
| the cleanup step **ran** | this is the whole point over a `SIGKILL` from the CI runner |
| flow status `cancelled`, exit **4** | distinguishable from a test failure |
| a cleanup step that never settles is abandoned after `config.cleanupGrace` | an unattended run has no second interrupt to bound it |
| the same flow with no `maxRunDuration` set | runs to completion — the bound is off unless asked for |

### R4g2 — Run identity is written before the run, not after

**Pins:** §14.5, §13.2's `WriteFile`. Against the capture directory rather than
the run result — which in a conformance run is the in-memory filesystem the write ports were stubbed
with, so the layout is asserted without touching disk.

| Assertion | Why |
|---|---|
| every path passed to `WriteFile` | computed by the engine, inside the scope root, and refused before the port is called if it would escape — the host is never asked to make that judgement |
| twelve runs already under the capture root | all twelve still there afterwards — nothing prunes, and there is no port that could (§3) |
| the same flow run twice through two different port stubs | identical path sets, so the CLI and app cannot produce different layouts |
| `run.json` exists once the first step has started, carrying `runId`, the flow's path and `startedAt` | a run in progress must be attributable to its flow; the app lists it while it is still going |
| `summary.json` does not exist until the run ends | the two files answer different questions and are written at different times |
| after a run aborted before completion, `run.json` is present and `summary.json` absent | this is the interrupted state, and it is legible rather than corrupt |
| an interrupted run's existing step captures parse | the captures are the only record of what happened |
| `run.json` names the flow even when the run produced no steps at all | a flow that failed validation still occupies a directory |
| a retried step writes one `attempt-N.json` per attempt, each carrying that attempt's own request, response, assertions and validation | §14.5's unit is the attempt, and a file per attempt is what lets a poll be read one call at a time |
| a skipped step and a `uses:` container write no directory at all | listing the run directory is how 002 §10 enumerates the steps that were attempted |
| a sub-flow internal | nests as `auth/login/`, one directory per segment |
| a top-level step legally named `auth__login`, beside a sub-flow's `auth/login` | two directories, not one — the case that rules flattening out, since `_` is legal anywhere in an id and neither spelling looks wrong |
| a segment that is a Windows device name, at any depth — `con/login`, `auth/nul` | escaped where it sits, `con_/login` and `auth/nul_`; sanitizing the flattened whole misses both |
| a segment over 64 characters | truncated with a hash of *that segment*, so one long name is the same directory wherever it is nested |
| a flow with a `dataset:` versus one without | `iteration-<n>/` appears only for the first — an always-present level a reader must skip is worse than none |
| the `<n>` of each `iteration-<n>/` | equals that iteration's `IterationResult.index`, so a reader holding one never derives the other |
| a run directory's name | `<startedAt>-<id>`: fractional seconds dropped, `:` replaced with `-`, and four lowercase hex |
| a suite id minted in an alphabet that is not hex — base36, uppercase, empty, or a path fragment | still names a directory matching `SUITE_DIRECTORY`; slicing four characters off the id instead makes the run invisible to `listRuns`, which is the regression this row exists for |
| `RUN_DIRECTORY` against a suite name, and `SUITE_DIRECTORY` against a run name | both reject — the patterns are disjoint, not merely unequal, so a suite is never listed or pruned as a run |
| `--no-capture` | no path is passed to `WriteFile` at all, and the run's result is otherwise identical |
| `flow.json` and `flow.yml` exist once the first step has started | the flow the run executed has to survive the file being edited afterwards; a run that dies still has to be readable against what it ran |
| `flow.json`'s node ids are the steps the run reported | the snapshot is the graph a viewer draws, so it has to be the graph that ran, not a re-description of the file later |
| `run.json`'s `flowHash` is the digest of `flow.yml` | the manifest is what `listRuns` reads per run; a hash that did not match its own snapshot would report every run as edited |
| a run whose flow cannot be described | still runs, still records everything else, and simply has no snapshot — recording history must not be able to fail a run |
| `run:start` | carries the same description the snapshot holds, so a consumer watching a run draws the flow being executed rather than the file, which can be edited while it runs |
| `--no-capture` | `run:start` carries no description either: a run that records nothing has nothing to report |

Killing the run for the third row means terminating without the cancellation path of §11.3 — a
`SIGKILL` equivalent, not a signal the engine handles, since a clean cancel writes its summary.

### R4h — Request validation

**Pins:** §10.1 `validateRequest`. Against an operation whose `requestBody` declares
`item_count: integer`.

| Case | Expected |
|---|---|
| `item_count: "{{steps.x.count}}"` resolving to a number | dispatched |
| the same field forced to a string | step `failed`, reason `invalid-request`, **`ExecuteRequest` never called** |
| `validateRequest: false` on that step | dispatched unvalidated |
| operation declaring no `requestBody` schema | dispatched; the check is not applicable |
| a multipart step with a `format: binary` part | dispatched; binary parts are not checked |
| `--dry-run` over a flow with a mistyped body | reports the failure offline, sends nothing — **`it.todo`**, see below |

The never-called row is the important one — a check that validates after dispatch has already made
the call it was meant to prevent.

**The `--dry-run` row is registered as an `it.todo` rather than left out.** 001 §19.1 schedules the
flag for v2 and `bru flow run` rejects it today, so the case has nothing to run against — but the
requirement is not in doubt, only its subject. A todo keeps the row in the runner's own output, where
the shortfall is counted every time the suite runs; deleting it would make the table and the suite
agree by removing the disagreement rather than by fixing it, which is the failure mode §2's registry
guard exists to catch. It is the only `it.todo` in the suite, and it is expected to become an `it` on
the same commit as the flag.

### R4i — Multi-flow run ordering, and re-running what failed

**Pins:** §14.1 and §14.2, over §14.5's roster.

Four flows in a directory, two of them appending to the same stubbed collection.

| Assertion | Why |
|---|---|
| flows execute one at a time — no two overlap in the call log | concurrent flows make a suite's result scheduling-dependent |
| execution order matches **path sort**, not directory-read order | reproducibility across machines and filesystems |
| `config.concurrency: 5` in two flows never yields more than 5 in flight overall | the budget bounds steps within a flow, never spans them |
| `--bail` stops after the first failing flow; without it all four run | §14.2's worst-outcome exit code needs the rest to have run |

**A retry is a selection too**, and it is the one selection the CLI does not compute from the command
line: `--retry-failed` reads §14.5's roster of the newest suite and re-runs what it says did not
pass. That makes the roster's format a CI contract rather than an artifact — a rerun is only as
honest as the record it selects from, which is why the writer is asserted in `capture.spec.js` and
the reader in R4o.

| Assertion | Why |
|---|---|
| the invocation writes its roster, naming a flow that never opened a run directory and giving it no `runDir` | an `invalid` flow fails validation before anything is created for it, so it is in the roster or it is nowhere |
| `--retry-failed` re-runs the flows the newest suite recorded as `failed`, `cancelled` or `invalid`, in path order, into a suite of its own that names the one it re-ran in `retryOf` | a selection that dropped `invalid` would shrink on every retry, and a retry that edited the suite it re-ran would destroy the record of what CI actually saw |
| a suite named as a bare directory name inside the capture root, or as a path, and a capture root moved by `--capture-dir` | the three ways a CI job addresses a suite it kept |
| a flow the roster names that is no longer on disk | skipped, and still counted as retried — a deleted flow is not a failure to report |
| the newest suite passed entirely | *nothing to retry*, exit 0, and no second suite: an invocation that ran nothing has nothing to record |
| a scope with no suite in it, or a named directory that is not a suite | exit 3 — a usage error, raised from the capture root before a request is sent |
| `--retries 1` over a flow that fails then passes | the invocation is green, the roster records `attempt: 2` and `flaky: true`, and the report counts one flaky flow |
| the same flow with no `--retries` | one attempt, exit 1, and **no** `attempt` or `flaky` field anywhere |
| `--retries 2` over a flow that never passes | exits on the final outcome, `attempt: 3`, not flaky |

The flaky rows are the pair that has to be asserted together. A retry loop that marked every flow it
ran `flaky` would be indistinguishable from a correct one on any suite that used it, and one that
marked none would turn a green invocation into a claim that nothing had gone wrong — which is the
whole reason §14.8 records the attempt count beside the outcome.

### R4j — The engine boundary

**Pins:** §13.2. These assert the contract two hosts build against, so a divergence shows up here
rather than as the CLI and app behaving differently.

| Case | Expected |
|---|---|
| `variables` supplied as separate tiers | resolution follows §7.3's order — assert an `environment` value losing to an `envVarOverrides` one, and winning over `collectionVars` |
| `--global-env <name>` | the workspace's `environments/<name>.yml` fills `globalEnvironment`, disabled variables left out; a name matching no file exits 3 **before** any request goes out |
| a library flow run directly, with a param left out | its declared `default` is used, resolved against the run's environment — the same value the flow gets when a `uses:` step invokes it and omits the same param |
| a `shouldRetry` that throws | the **step** fails `script-error`, naming what threw; the run finishes, and the predicate is not asked again. An attempt that had already failed keeps its own reason (§14.6) |
| a run stopped while a step is polling | the poll stops there — no further attempt, no further delay — and the step is `cancelled` with reason `run-cancelled`; steps below it report the stop rather than an unmet dependency |
| an error escaping a step | `run:end` is still emitted, as a failed run carrying a `run-failed` diagnostic, **before** `runFlow` rejects |
| a step whose `maxDuration` elapses mid-poll | it stops there — the next attempt is never scheduled, however far `maxAttempts` still is — and fails `max-duration-exceeded`, naming the budget; the flow's other steps still run, and each attempt was bounded by whatever was left of the budget |
| a step that settles inside its `maxDuration`, and one with none set | judged on its own outcome — the budget reports nothing, and unset it bounds nothing |
| an operation whose schemas are `$ref`s into `components` — including a ref inside a ref | validates through them, both directions: a conforming response passes, one the referenced schema forbids fails `schema-validation-failed` at the offending path, and a request body does the same |
| a schema the validator will not compile | the **step** fails `schema-validation-failed`, saying the schema could not be compiled; the run still ends |
| a `oneOf` whose branches both accept the response | the failure says how many matched, so it reads as the document being ambiguous rather than the response being wrong |
| a consumer whose `onEvent` throws | the run completes unaffected; the flow's status is unchanged |
| an `onEvent` that mutates the event object | execution is unaffected — events are observational |
| every emitted event | survives `structuredClone`, and carries no response body or file content |
| a secret-valued variable appearing in a request | masked in the event, not only in reporters |
| ordering | each `step:start` precedes its `step:end`; both fall inside their `iteration:*` pair; `run:end` is last |
| `concurrency: 5` | events from different steps interleave — consumers keyed on adjacency break, so assert only the per-`id` ordering above |
| `RunResult` | carries no exit code field |
| `signal` aborted mid-run vs. `maxRunDuration` elapsing | identical step tables and identical event sequences (§11.3) |
| a `clock` port with a controlled `sleep` | a 30-attempt poll completes with no real delay, and `sleep` was called 29 times — with the values F4.3 pins |
| a flow invoking a sub-flow | `IterationResult.steps` is **flat**: the `uses:` step appears with `kind: 'subflow'` and each internal step alongside it with a namespaced id — assert no `StepResult` nests another |
| the same run's events | `step:start` and `step:end` fire for internal steps too, each inside the container's own pair; a host can therefore draw the expansion live |
| a step that fails request-schema validation and also declares assertions | `validation.request.valid` is false with a path-keyed error list, `assertions[]` is **empty**, and `reason` is `invalid-request` — one outcome does not overwrite the other, and an assertion that never ran reports no verdict |
| the same step with capture disabled | `validation` is unchanged; it travels in the result, not the capture |
| an `apis:` entry naming an `https://` source | `ReadSpec` is called with the source string verbatim; the engine never inspects the scheme, and the graph resolves |
| `run:start` on a capturing run | carries `captureDir`, equal to `RunResult.captureDir`; absent when capture is disabled — a consumer can open a *running* step's capture without waiting for `run:end` |
| a profile authored `{ mode: bearer, token: x }` | `MaterializedRequest.auth` is `{ mode: 'bearer', bearer: { token: 'x' } }` — Bruno's `Auth`, per-mode nested, not the flat authored form (§6.4) |
| the same for `apikey`, `basic` and `oauth2` | the fields land under `apikey` / `basic` / `oauth2`, and `mode: none` stays `{ mode: 'none' }` with no sibling key |
| a profile naming a field the mode does not define | it is carried under the mode's key unchanged; the engine renames nothing and drops nothing |

The structured-clone row is the one that catches an otherwise invisible break: an event carrying a
`Buffer` or a class instance works in the CLI, where the consumer is in-process, and fails only in
the app, where every event crosses IPC.

The auth rows exist because the flat-versus-nested distinction is invisible in a host that wrote its
own adapter and fatal in one that did not. Both hosts are supposed to hand this object to code they
already have — `setAuthHeaders` in the app — and that code reads `auth.bearer.token`.

### R4k — Reason and status vocabulary

**Pins:** §14.6.

One minimal flow per reason in the table, asserting the exact string on `StepResult.reason` — these
are consumed by CI and cannot be renamed once shipped.

Plus the first-failure rule: a step receiving a **500** that would *also* fail three assertions
reports `unexpected-status` alone, with `attempts: 1`. A step reporting a list of reasons, or the
last rather than the first, turns one problem into five in the output.

**`script-error` in all three positions** (§8.2), each asserted alone against a 200 response:

| Case | Expected |
|---|---|
| an `outputs:` script that throws | step **fails**, `reason: script-error`, message names `outputs.<name>` and carries the thrown message |
| the same step's other declared outputs | still extracted and present on the `StepResult` |
| a `when:` script that throws | step **fails** — assert the reason is `script-error` and **not** `condition-false`, and that no request was dispatched |
| a `shouldRetry` that throws on attempt 2 of 10 | step fails with `script-error` at `attempts: 2`; assert it is **not** `retries-exhausted` and that no further attempt was made |
| a throwing output on one dataset row | that iteration fails, the others pass, and the run's cleanup steps still run |
| a step returning **500** whose output script also throws | `unexpected-status` — the earlier check in §14.6's order wins |
| an output script returning `undefined` | unchanged from §8.1: the step **succeeds**, the output is not produced, consumers skip `unresolved-dependency` |

The last two rows are the boundary. One separates a throw from an earlier failure, the other
separates a throw from the `undefined` case it must not collapse into — an implementation that
catches script errors and returns `undefined` passes every scenario in this file except that row.

### R4l — Console output properties

**Pins:** §14.7. These are CLI-level tests, not engine tests — run `bru flow run` with a stubbed
engine and capture stdout.

Assert **properties, never exact text**. §14.7 is deliberately not a stable format; pinning its
wording would make every phrasing improvement a failing test, and the real contract is the exit code
and the reporters.

| Property | Why it is contractual |
|---|---|
| no ANSI escape sequences when stdout is not a TTY | a colour code in an archived CI log is corruption |
| `NO_COLOR` set, on a TTY | still no escapes — the convention is honoured, not just the flag |
| a secret-valued variable used in a request | masked in stdout, and in `--verbose` previews (§14.4) |
| a failing run | names the failed step id, its §14.6 reason, and its capture path |
| a failure whose block expands nothing else | its §14.6 message appears |
| a skipped step with a message | it appears on that step's line — a skip gets no failure block |
| a run failed by a step with no failure block | §13.2's `decidedBy` step is named, with its reason and message, **under `--quiet` too** |
| a run failed by a step that has a block | no second mention of it |
| a failing assertion | expected and actual both appear |
| default output | contains no response body; `--verbose` contains a truncated one |
| `--silent` | writes nothing to stdout on both a passing and a failing run |
| `--quiet` | writes the summary and failure blocks, no per-step lines |
| summary ordering at `concurrency: 5`, run repeatedly | steps listed in **declaration** order every time, though the live lines may differ |
| `--no-unicode` | status markers are ASCII |
| a run with a step that never settles, killed externally | the completed steps' lines were already flushed — the stall is localisable |

The last row is what live output exists for, and it fails silently in any implementation that
buffers until the run ends.

### R4m — The document schema

**Pins:** §5.4, §5.3's id pattern.

| Case | Expected |
|---|---|
| every `.flow.yml` fixture in this file | validates against the schema |
| `assertt:` in place of `assert:` | schema violation; `bru flow validate` reports it as a **warning** |
| the same file under `--strict` | exit 2 |
| `status: [suceess]` | schema violation — enum |
| `retry: { maxAttempts: 0 }` | schema violation — positive integer |
| both `operation:` and `uses:`; both `body:` and `bodyFile:` | schema violation, without needing the graph |
| all three `depends` shapes — list, `all:`, `any:` | all valid |
| `id: my.step`, `id: 2fa` or `id: my-step` | schema violation on the §5.3 pattern; the last reports `invalid-step-id` suggesting `my_step` |
| `id: my_step` and `id: _internal2` | valid |
| duplicate step ids | reported |
| an `authProfiles` entry whose `mode:` is `berer` | schema violation, the node being `authProfiles.<name>.mode` |
| each of the eleven modes a profile may declare, `akamai-edgegrid` and `oauth1` among them | all valid, with the fields under the mode left to Bruno's own union (§5.4) |
| an `authProfiles` entry whose `mode:` is `inherit` | schema violation — the twelfth member of Bruno's union has no referent at a profile boundary, and `auth: collection` is what it would have meant (§6.4) |
| a `uses:` step carrying `assert:`, `outputs:`, `shared:`, `maxDuration` | all valid (§12.4) |
| a `uses:` step carrying `retry:`, `timeout:`, `body:`, `validateSchema:` or `auth:` | schema violation, one per field — not a silent no-op |
| `with:` naming a param the sub-flow does not declare | `unknown-param`, with a did-you-mean suggestion |
| an `outputs:` entry set to `!...` | valid — suppresses an inherited connector entry (§8.5) |
| an `outputs:` entry set to `null` | **passes** the schema, which cannot tell it from a projected `!...`; `bru flow validate` errors — `null` is not the removal token (§5.4, §8.5) |
| a document containing `!file` and `!...` | validates — the schema describes the **projected** model, in which a tag is stripped to the node beneath it (§5.4) |
| a `body:` value that is literally `{ $file: ./x.pdf }` or `{ $drop: true }` | ordinary data: sent as an object, never read as a tag. §5.4 resolves the tags to a symbol and a class instance precisely so a hostile body cannot forge one |
| a v1 fixture from §15's golden set | validates against the v1 schema |

Two negative controls, because they define the schema's boundary: a flow whose `operation:` does not
exist in the bound document, and one with a cyclic `depends`, must both **pass** the schema and fail
only at §14.3. A schema that rejects them has grown semantic knowledge it cannot keep correct.

### R4n — Redaction

**Pins:** §14.4, and §14.5's rule that the artifact directory is redacted exactly as reporter output
is. Asserted against the capture rather than stdout, because that is the copy a CI job uploads.

| Case | Expected |
|---|---|
| a step with an `Authorization:` header written straight into the flow file | `••••` in the capture — the case provenance cannot catch, which is why the denylist exists |
| `config.redactHeaders: [X-Legacy-Key]` | masked alongside the built-ins, and the built-ins still masked |
| a repeated response header on the list (`Set-Cookie`) | every value masked, not just the first |
| a header not on the list | untouched; a denylist that quietly became an allowlist would empty every capture |
| the mask itself | a fixed `••••` whatever the secret's length — a length-preserving mask leaks the size |
| `FlowContext.redactHeaders` at the dispatch port | the run's configured list, so a host reporting a request on a surface of its own (002 §8.5) masks the set the capture masks rather than the built-ins alone |
| a host reporting `ExecutedResponse.requestHeaders` | those headers are what the capture records, masked on the same terms — a header the host added (auth, content type) is no more exempt than a declared one |
| a value from a `secret: true` environment entry, used in a query param and echoed back in an error body | masked in both, by provenance rather than by name |
| the same value promoted into a shared slot (§9.1) | still masked — tracking is by value, so promotion carries it for free |

Provenance tracks by **value**, through §13.2's `RunOptions.secrets` — the values a host knows are
secret, unioned with the auth-profile credentials and `secret: true` params the engine resolves for
itself. Tracking by value rather than by name is what carries a secret into a shared slot for free.

One host supplies nothing, and the reason is worth recording: `bruno-filestore`'s environment parser
writes `value: ''` for every `secret: true` entry, so a secret's value never reaches `bru` at all —
even one hand-written into the file. Under the CLI the provenance half therefore covers the
credentials and params the engine derives, and nothing from the environment.

**The CLI's half is asserted end to end**, in `bruno-cli/tests/fork/flow/redaction.integration.spec.js`,
because only a real invocation can show which values reached the tracker: one run passes a
`secret: true` param, an `--env-var` used as a bearer credential, and the same `--env-var` value in
an ordinary body field, then reads the captures back.

| Case | Expected |
|---|---|
| a param the flow declares `secret: true`, passed as `--param` | masked — the engine derives it, so the host supplying no `secrets` does not matter |
| an `--env-var` an auth profile resolves to | masked everywhere it surfaced, the body field carrying the same value included |
| an `--env-var` in an ordinary body field | **not** masked — the negative is the decision, not an oversight (§14.4) |

That last row is the one worth having. An `--env-var` was typed on a command line the shell already
recorded, and a CLI that promoted every one to a secret would blank ordinary values out of every
report — so the test asserts the value is *present*, which also stops the other two rows from
passing vacuously against an empty capture.

### R4o — Reading a run back

**Pins:** §14.5's layout — the run directory and the suite around it — through 002 §11.2's
`listRuns`, `readRun`, `readCapture`, `listSuites` and `readSuite`. These live here rather
than in 002-C because the thing under test is the **round trip**: the reader is correct exactly when
it recovers what the writer wrote, and 002-C §8 hands engine semantics to this file. 002-C's U4 rows
assert the *app* renders what comes back.

| Case | Expected |
|---|---|
| a finished run, listed | one entry, `state: 'complete'`, with `status` and `summary` from `summary.json` and `runId` / `flow` / `startedAt` from `run.json` |
| a directory with `run.json` and no `summary.json`, for a run the engine is not executing | `state: 'interrupted'`, and **no** `status` — an interrupted run has no outcome and a reader must not synthesize one |
| the same shape while `runFlow` is executing it | `state: 'running'`; the two are distinguishable only because the engine knows which runs it owns |
| several runs | newest first, by `startedAt` rather than by directory name |
| a run inside a suite directory, and one written at the top level | both listed; the first names its suite by basename and the second names none, because 002 §10 is one history over runs of both shapes |
| a run whose `run.json` recorded an `origin` | reported by `listRuns` and by `readRun` alike, and absent from both for one that recorded none — who ran it is a fact the manifest carries, never one a reader infers |
| `flow:` supplied | runs of other flows in the same scope are excluded, and the filter works on an entry that has no `summary.json` |
| a capture root that does not exist | an empty list, not a throw — no run has happened yet |
| a directory not matching the run-directory naming, or one missing `run.json` | skipped; a run that cannot be attributed to a flow is not listed as one |
| `readCapture` over every attempt a retried step wrote | each returns that attempt's own request, response, assertions and validation |
| `readCapture` with and without `iteration` | resolves the nested and the flat layout respectively (§14.5) |
| a step id needing sanitizing — a sub-flow's `auth/login` | resolves, because the reader computes the segment the writer did rather than its own |
| a binary response body | `readCapture` returns `kind: 'binary'` naming the sibling; the reader does not inline it |
| `readRun` over a run that recorded a snapshot | returns the description and the source it ran from, so a viewer draws the flow as it was rather than as it is |
| `readRun` given step ids that are not the run's | still finds the run's own captures — the ids come from the snapshot, which is what keeps a renamed step's captures reachable |
| `readRun` over a run with no snapshot | no description, and the caller's `stepIds` are used exactly as before |
| `listRuns` with `flow:` supplied | each entry reports `flowChanged` against the file as it is now: `false` for the run just made, `true` for one recorded against different text, and **undefined** for a run with no recorded digest — unknown is not unchanged |
| `readRun` or `readCapture` given a `dir` outside `<scopeRoot>/.bruno-runs` — a sibling directory, a `..` climb, or the right `dir` with the wrong `scopeRoot` | refused with the §7.4 message, and **the port is never called**: the reads log is unchanged. 002 §11.2's containment for history reads, on the two readers the renderer names a directory for |
| `readSuite` given a `dir` outside the scope | fails as "not a suite directory", never as "outside the scope" — deliberately uncontained, because `--capture-dir` (§14.1) can put a suite anywhere and its `dir` is one the CLI's own user typed |

The binary-body row is the one that keeps the split honest: a reader that resolved the sibling and returned
its bytes would put a 2 MB payload in every step-pane open, which is what "storage is split" exists
to prevent.

**The suite is the same round trip one level up**, and it has two writers rather than one: a host
writes §14.5's `suite.json` when it owns an invocation, and every other suite has its roster rebuilt
from the run directories inside it. Both are read through one shape (002 §11.2), so both are
asserted against the same reader here — the rebuild in `history.spec.js` beside the cases above, the
written manifest in `capture.spec.js` beside the writer that produces it.

| Case | Expected |
|---|---|
| a single run of one flow | the suite of one it minted, its roster naming the flow by §5.2's id and the `meta.name` of the run's own `flow.yml` snapshot, and marked `partial` |
| the same, with the snapshot gone | the flow named by its file stem — a rebuilt line names a flow exactly as a written roster would, which is what lets a rerun match the two |
| a suite holding a `suite.json` | the manifest wins and `partial` is absent: it names the flow that never ran, with no `runDir`, which is the whole reason the file exists |
| a roster a host wrote, read back | returned whole — `retryOf`, `exitCode`, `origin`, and R4i's `attempt` and `flaky` included; the writer and this reader are two halves of one format |
| several suites | newest first by `startedAt`, not by directory name — the name's timestamp is truncated, so two suites started in the same second would sort by their id suffix |
| a suite holding two runs of one flow, and no manifest | one roster line, the last attempt's outcome and directory (§14.8) |
| a run with no `summary.json` inside a suite | left out of the rebuilt roster and still dating the suite: nobody recorded an outcome, and calling it `cancelled` would put a flow in a roster a rerun then acts on |
| a directory holding only a report, or an unreadable manifest | not listed — nothing in it is attributable to a flow, and nothing in it dates the suite |
| a scope where nothing has run | an empty list, exactly as `listRuns` answers |
| `readSuite` over a suite | precisely what the listing says about that directory |
| `readSuite` over a directory that is not one | throws, where `listSuites` skips: a caller naming a directory has named something, and an empty roster would report a mistyped path as an invocation that ran nothing |

`partial` is the row every other row depends on. A rebuilt roster cannot name a flow that never
opened a run directory, so the difference between it and a written one is invisible in the result
unless the result says so — and 002 §4.1's rerun is offered over both, which is only defensible
because the reader is explicit about which it is holding.

### R4p — What the parse guarantees

**Pins:** §5.4's projected model, and §13.2's `Diagnostic.line` / `column`. Separate from R4m, which
is about the JSON Schema; this is about what reading the file produces before any schema sees it.

| Case | Expected |
|---|---|
| `!file ./x.json` and the mapping form `!file { path, filename, contentType }` | both project to the same value with identity, so a step cannot tell which spelling was used |
| an ordinary mapping `{ path: ./x.pdf }` in a body | **not** a file reference — §5.4 resolves the tags to a class instance and a symbol precisely so a hostile body cannot forge one by shape |
| `!...` | the removal symbol, distinct from `null` (§8.5) |
| a `<<:` merge key over an anchor | resolved, so the step carries the merged fields and no literal `<<` |
| an empty document | an empty flow, not a crash |
| a document with a syntax error | reported as `parse-error` diagnostics carrying the line, and the model is **empty** rather than the partial tree the parser recovered — recovery is for an editor drawing squiggles, and running it would send requests the file does not describe |
| `runFlow` over that document | refuses; `bru flow validate` reports it and exits 2 first (§14.3) |
| every step | carries a 1-based line and column pointing at its own node |
| a diagnostic naming a step | carries that step's line and column |
| a diagnostic that names no step — an unresolvable `apis:` entry, a bad `vars:` reference | anchors to that node instead, because 002 §6 puts these in the gutter and one with no line has nowhere to land |
| an unquoted whole-value reference, `token: {{ token }}` | `parse-error` at that value (§7.3), and an empty model — quoted, the same document parses and the value is the reference text |
| any parse, valid or not | **nothing is written to the host's console** (§13.1) — assert `process.emitWarning` is never called |

**The unquoted-reference row is the second one that earns its place.** It is not a YAML syntax error
and the parser will not raise it: the document is a well-formed mapping whose key is a mapping, so
without this check the file parses, the flow runs, and the request carries `{"{ token }": null}`.
The console row is its other half — the parser's own advisory for that construct goes to
`process.emitWarning`, which prints over the CLI's output and into an Electron log nobody reads,
which is how the defect stayed a piece of terminal noise rather than a diagnostic.

**The merge-key row is the one that earns its place.** It is invisible in every fixture and changes
the meaning of a committed file if it regresses: a flow sharing step config through an anchor would
silently gain a `<<` field rather than the fields it names, and every assertion about the step would
still pass.

### R4q — The described graph

**Pins:** 002 §11.1 and §5.3, over §9.1's graph. Here rather than in 002-C for R4o's reason: which
edges exist and what rank a node gets are statements about the engine's own graph, and 002-C §8
hands those to this file. U1.1–U1.10 assert the *drawing* of what comes back.

| Case | Expected |
|---|---|
| a flow with no `depends` | every consecutive pair joined by a `'sequence'` edge, and every node at a distinct rank — the linear case is the common one and must degenerate to a column |
| the same flow with a step inserted in the middle | the chain rewires A → B → C; nothing else moves |
| an explicit `depends` | `'depends'`, not `'sequence'` — the two are the same relationship by the time the graph exists, and only file order distinguishes them |
| `depends: [{ on: x, status: [failed] }]` | a `status` of `['failed']` on the edge; a default `[success]` edge carries **no** `status` at all, so a renderer labels only what it is given |
| a step with an `any:` join | `join: 'any'` on its incoming edges; switching the fixture to `all:` changes it |
| a declared output consumed downstream | one `'data'` edge named for the output, `declared: true` |
| the same output interpolated three times in one body | still **one** edge — a data path, not an occurrence count |
| `{{steps.other.body.id}}` (§8.3's raw access) | a `'data'` edge with `declared: false`, **and** an `undeclared-dependency` warning; the graph and the validator agree or neither is trustworthy |
| `{{steps.other.status}}` and the rest of §8.3's built-ins | **no** data edge — always-available metadata is not a data path |
| a shared slot with two writers and one reader | two `'slot-write'` edges and one `'slot-read'`, and no edge from either writer to the reader |
| `slots` | each slot's writers and readers by id, whatever order they appear in the file |
| rank | longest path from a root, so a step below two branches of unequal length sits under the longer one |
| a `uses:` step | one node with `kind: 'subflow'`, plus the sub-flow's own steps under namespaced ids, each carrying `parent` |
| a sub-flow's first internal step | rank 0 — ranks are relative to the flow being drawn (002 §5.2) |
| a resolved step | `operation` carries the method and the path template, not the `alias#operationId` the file wrote |
| markers | `conditional` for `when:`, `retryMaxAttempts` only above 1, `allowsErrorStatus` for `failOnStatusCode: false`, `usesSharedSlot` for either direction |
| every node | a `position`, and the `diagnostics` are the set `validateFlow` returns for the same file |
| a flow that does not parse, and one whose `apis:` entry does not resolve | both still return — an id, a name, the parse error or the binding error in `diagnostics`, and as much of the graph as could be built (002 §6) |
| `apis` | the bindings the file declares, in file order, each with its §6.2 `color` where it declares one — declared rather than called, because it is what the file says |
| an `apis` binding whose `color` is not a hex colour | an `invalid-api-color` **warning** and nothing else; the flow still describes, still validates and still runs |
| `stages:` naming three steps the schedule allows | `stages` in file order, each resolved to the rank whose column its rule is drawn before |
| the same flow with the block deleted | identical `nodes` and `edges`, and `stages: []` — a label that moved a node would not be a label |
| a boundary at a step that is not a step of this flow, a sub-flow's internal step included | dropped from `stages`, with an `unknown-stage-step` **warning**; a namespaced id is not addressable from the caller (§12) |
| two boundaries where the second does not come after the first, naming the same step included | the second dropped, `stage-boundary-order` — it describes no run of steps |
| a boundary whose column is shared by a step listed above it | dropped, `stage-out-of-order`, **naming the step that crosses it** — no vertical line passes through the middle of a column |

The `color` and `stages` rows are the only presentation in this file, and they are here for the
reason §6.2 gives: the thing being labelled lives in the file, so the file is where the label is
said, and both hosts read it from the same place. The warning rows are what separate a typo from an
omission — a viewer draws neither.

The dropped-boundary rows are what keep §5.5 from lying. The alternative to suppressing an
undrawable rule is rearranging the graph until it fits, which would put a step on the far side of a
boundary it actually runs level with — a claim about execution order made by something that was
supposed to be a name.

The built-in-metadata row is the one that keeps the feature honest. If `{{steps.x.status}}` drew a
data edge, every step in a flow with a status check would appear to consume data from its
predecessor, and "data paths are named and drawable" would stop meaning anything.

### R4r — A spec whose schemas are `$ref`s

**Pins:** §10.1.

| Case | Expected |
|---|---|
| a response schema that is `$ref: '#/components/schemas/X'` | validates against the referenced definition, rather than failing to compile |
| a schema referencing another that references a third | resolves through the chain |
| a `$ref` naming a definition the document does not have | the **step** fails `schema-validation-failed`, and the run ends normally with every other step reported |

A schema lifted out of an OpenAPI document is a fragment of it, and `#/components/schemas/X` resolves
against the root of whatever is handed to the validator. Given the fragment alone it cannot resolve
the first `$ref` it meets, refuses to compile, and — before this was pinned — took the whole run with
it. Every other fixture in this file inlines its schemas, which is exactly why nothing caught it: the
gap was in the fixtures, not in the assertions.

### R4s — A slot written by alternatives

**Pins:** §9.1.

| Case | Expected |
|---|---|
| `shared: { x: { writers: any } }` written by one of two mutually exclusive branches | the reader below the branch that ran reads it, with no undeclared-dependency warning |
| the same declared `writers: all` | `validate` warns — no reader can descend from every writer, because only one ever runs |
| a reader that descends from neither branch | the ordinary unresolved-slot answer, unchanged by the declaration |

`all` is the join shape: several branches may run, so a reader must descend from every writer or the
read races a branch still in flight. `any` is the *alternative* shape, and it is not a weaker `all` —
it is the case where descending from every writer is impossible by construction. The auth token of a
flow that reaches its API two ways is that case, which is to say nearly every flow anyone writes.

### R4t — A script library reaches every script

**Pins:** §8.6.

| Case | Expected |
|---|---|
| a flow declaring `functions:` and calling one from an `outputs.*.script` | the value the function returns — the library is in scope by name, with no import at the call site |
| a `use:` entry naming a library document that itself `use:`s a `.js` file | a function defined in the flow calls one defined two files away; one scope, assembled depth-first |
| a name the flow declares and its library also declares | the flow's, the way a step's `outputs:` overrides an inherited connector (§8.5) |
| a `use:` entry that does not resolve | an `unresolved-function-library` **error** from `validate`, before anything runs |
| a function name that is not a JavaScript identifier | an `invalid-function-name` error |
| a function named `res` or `ctx` | a `function-shadows-script-argument` **warning**, and no error |
| a flow with no `functions:` block | unchanged — the script the host is handed is the source as written |
| `bru flow validate` on a flow that has one | each resolved function and the file it was declared in, one line each — a name that was overridden appears once, with the declaration that won; a raw source file is listed as itself |
| the same, on a flow with no library | nothing printed |

The last row is the one that keeps the feature honest: composition is invisible to the hosts (§13.2),
so a flow that declares no library must reach `RunScript` byte-for-byte as it did before, or "no new
execution environment" (§8.2) stops being a statement anyone can check.

The two error rows are why this is validated rather than left to run time. A library is composed into
*every* script the flow runs, so one unreadable file or one unquoted name is every script position
failing at once, reported as `script-error` against whichever step happened to run first — a message
that names neither the file nor the name.

### R4u — A required param a host never supplied stops the run

**Pins:** §12.5, and §11.2's rule about what a miss is.

| Case | Expected |
|---|---|
| a library flow run directly, with a required param unsupplied | the run is **refused**, naming the param |
| the event stream | nothing — refused before `run:start`, and nothing dispatched |
| several params missing | every one named, not just the first |

`validate` already refuses the same omission at a `uses:` call site, where the `with:` keys are in the
file. This is the other way in, and it can only be checked at the moment a host supplies values. Left
unchecked, `{{params.email}}` reached the wire verbatim: an unsupplied param resolves to `undefined`,
which is a `params` miss rather than a `steps.*` miss, so §11.2 skips nothing and reports nothing —
leaving the API's rejection of a literal `{{...}}` as the only evidence the run was never viable.

### R4v — A run records what it was started with

**Pins:** §14.5, §14.4, and §12.5's declared params. [002](./002-api-flows-ui.md) §5.6 is the reader.

| Case | Expected |
|---|---|
| a host supplying some params and not others | the record carries the supplied values and the declared defaults for the rest |
| a param declared `secret: true` | masked in the record, at the same width whatever its length |
| the same param on the wire | the **real** value — masking is a property of what is written down, not of what is sent |
| each iteration's resolved `vars:` | recorded as the run used them, not re-derived afterwards |
| a sub-flow's `vars:` | not recorded — the entry flow's are what a reader opened |
| `run:start` | reports the params too, so a host that never reads the capture still has them |
| capture disabled | the params still reach `run:start` |

The secret rule is why this is declared rather than inferred. §14.4's header denylist cannot decide
it: a header name is not the author's to choose and a param name is, so the flow says which of its
inputs are secret instead of the engine guessing from the spelling.

### R4w — A value computed before the request reaches it

**Pins:** §8.7, and §8.2's throw rule.

| Case | Expected |
|---|---|
| a step declaring `pre:` and interpolating `{{pre.<name>}}` into a header | the computed value on the wire |
| another step interpolating `{{pre.<name>}}` | its **own** `pre:` values, or nothing — `pre.*` is step-local and names no other step's |
| `outputs: { x: { from: pre } }`, and `{ from: pre, path: y }` | the pre value under its own name, and under another; `path` defaults to the output's name |
| `outputs: { x: "{{pre.y}}" }` | the output is **unset** — a string output is a JSONPath, selects nothing, and §8.1 makes that an ordinary answer; `validate` warns on a `{{...}}` in an output path |
| a `from: pre` output on a step whose request never dispatched | no outputs at all, `from: pre` included — outputs exist after a response or not at all |
| a `pre:` script calling a §8.6 library function | resolves, with no change to how the library is composed |
| a `pre:` script that returns `undefined` | the value is **not set** (§8.1), and a reference to it is an unresolved dependency — §11.2's skip, not an empty string |
| a `pre:` script that throws | the step fails `script-error`, the message names `pre.<name>`, the **remaining `pre:` scripts do not run**, and no request is sent |
| a step whose `when:` is false | no `pre:` script runs at all |
| a `when:` condition referencing a `pre` value of its own step | unresolved — `when:` runs first, and the spec says so rather than the order being discovered |
| a name declared in both `pre:` and `outputs:` | both stand — they are separate namespaces, and neither shadows the other |
| a step that retries | the **same** computed values on every attempt — materialization is once per step (§8.7), and this is asserted so the limitation cannot regress into a surprise |
| a dataset run | each iteration computes its own values |
| a `uses:` step declaring `pre:` | the values publish before `with:` is resolved, and can be passed in |
| a `pre` value promoted with `from: pre` and listed in `shared:` | the slot is fed exactly as any output-fed slot is — `shared:` publishes outputs and is unchanged by this section |
| a `pre:` name listed in `shared:` **without** being promoted | nothing is published; `shared:` names outputs, and `validate` reports the unknown output |
| a flow declaring no `pre:` anywhere | interpolation and the request reaching the port are byte-for-byte what they were |

The retry row is the one that reads like a bug and is the specification. The motivating case is a
signature over a nonce, which is exactly the value a retry must recompute — §8.7 records why it does
not, and a test asserting the current answer is what makes changing it a deliberate act rather than
an accident.

The last row is R4t's argument one position along: a position that changed what a flow without it
sends would make "no new execution environment" (§8.2) unverifiable.

### R4x — A run that fails on its own always ends

**Pins:** §13.2's event stream, §14.6.

| Case | Expected |
|---|---|
| an engine failure that is not a step's — a binding whose OpenAPI document is not there | `run:end` is emitted **before** the failure reaches the caller |
| the same run's result | the cause said as a diagnostic on the result, not only as a rejection |
| an operation a loaded spec does not declare | the **step** fails, and the run reports every other step normally |

A host resolves its promise at `run:start` and watches the stream from there, so a run that rejects
without a `run:end` leaves it with a run that is running forever and a Cancel with nothing to cancel
— which is what the app showed for any error escaping a step.

### R4y — A capture that could not be written says so

**Pins:** §14.5.

| Case | Expected |
|---|---|
| an attempt file the filesystem refuses | reported against the **run**, and the run's own outcome is unchanged |
| the step it happened under | judged on its own outcome, with no capture path to point at |
| a run whose captures were all written | says nothing — silence is reserved for the ordinary case |

An artifact write must never fail a run: a flow that passed did pass, whatever the disk did
afterwards. Swallowed *silently*, though, the step is left with no request and no response to show
and nothing saying why, which reads as a step that never sent anything.

### R4z — `meta:` is read and rewritten without disturbing the file

**Pins:** §5.2, §5.1's round-trip rules; [002](./002-api-flows-ui.md) §4.4 is the reader.

| Case | Expected |
|---|---|
| a flow declaring `name`, `description`, `tags` and `library` | all four, read back as written and trimmed |
| a flow declaring none, and one declaring `library: false` / `tags: []` | the same answer for both — `Boolean(meta.library)` is what the engine runs on, so `false` and absent are one state |
| a flow carrying a `!file` fixture (§5.4) | its `meta:` reads normally, the way `readFlowMeta` already handles the tags |
| text that does not parse | no properties, and **no write** — a document that could not be read is not one to rewrite |
| writing a name into a flow with comments, anchors, a merge key and both `!file` spellings | only the `meta:` line changes; every other byte survives, tags included |
| clearing `description`, `tags` or `library` | the key is **deleted**, not written as its default — the same rule the create form writes a new flow by |
| writing into a flow with no `meta:` block | the block is created **directly after `version:`**, not appended below `steps:` |
| a flow with no `meta:` given nothing to say | the text, unchanged — no empty block appears |

The round-trip row is the one that keeps this honest, and it fails in a way nothing else would catch:
§5.4's tags resolve to values with identity (R4p), and re-emitting a document parsed that way writes
`!file "[object Object]"` — so an edit to a flow's *name* silently destroys its fixtures. Reading and
writing need different tag sets for that reason, and only a byte comparison over a file carrying both
`!file` spellings says so.

One documented exception, asserted rather than left to surface in a diff: the serializer re-emits a
trailing comment one space after its value, so padding used to align a column of them collapses.
Nothing the format carries meaning in is affected.

### R9.1 — A slot written by two branches resolves by declaration order

**Pins:** §9.1's *last writer in declaration order wins*.

Two branches that both run and both write one slot, joined by a reader that descends from both. The
scenario withholds the **first-declared** writer's response until the second-declared writer's
`step:end` has been emitted, so the writer declared first is the one that finishes last:

| Case | Expected |
|---|---|
| the first-declared writer finishes last | the reader still reads the **second-declared** writer's value |
| the second-declared writer finishes last | the same value — the schedule does not change the answer |

F2.2's fixture cannot tell the two rules apart: its fallback's `depends` orders the two writes
against each other, so there completion order *is* declaration order. This one is the race. A
completion-order implementation passes F2.2 and fails the first row here, which is the row that says
a loaded CI machine and a laptop resolve the same flow to the same value.

### R9.2 — What a script's `ctx` carries

**Pins:** §8.2's `ctx.env`, §8.7's `ctx.vars`, §11.1's `ctx.env` / `ctx.steps` / `ctx.failures`.

| Case | Expected |
|---|---|
| `ctx.env.<name>` in a `pre:`, an output, a `when:` and a `shouldRetry` script | the host's environment value — §7.3's tiers, merged |
| `ctx.vars.<name>` in the same four positions | the flow's own `vars:` entry, as this iteration resolved it |
| `ctx.<name>` — the guide's flat form | still resolves; the named halves are additive |
| `ctx.env.<a flow var>` and `ctx.vars.<an environment variable>` | `undefined` — the two halves are disjoint |
| the keys of `ctx` that are not a variable, in a `pre:` and a `when:` script | exactly `env`, `vars` and §7.3's namespaces — `steps`, `row`, `params`, `shared`, `flow`, `pre`, `process` — and nothing else |
| the same, in an output script | the set above plus `req` and `res` (§10.2), since a request has gone out |
| the same, in `shouldRetry` | the set above plus `failures` (§11.1) and neither `req` nor `res` — the response is that script's own first argument |

The disjointness row is a reading rather than a quotation: §8.7's sample puts the flow var under
`vars` and the credential under `env`, and nothing in 001 says whether `env` also holds the merged
chain. It is pinned so a change to that reading is a failing test and not a silent one. The key-set
rows close §18's question of whether `row`, `params`, `shared` and `flow` belong in `ctx`: they do,
because the context is built over the same namespaces an assertion addresses, and the set is pinned
so that a later addition is a deliberate spec change rather than a side effect of how the context
happens to be built.

### R9.3 — An assertion addresses the request as sent

**Pins:** §10.2's `req.*` — a reserved root that resolved to nothing.

| Case | Expected |
|---|---|
| `req.method`, `req.url`, `req.headers[...]`, `req.body.<field>` | the request as it went out — resolved URL with its query string, upper-case method, the body's value |
| a header the step wrote as `X-Trace` | addressable as `req.headers['x-trace']`, and `req.headers['X-Trace']` is `undefined` — names are lower-cased, as `steps.<id>.headers` are (§8.3) |
| the host reported `requestHeaders` (§13.2) | `req.headers` is that set, lower-cased on the same terms — the auth header and content type the host added are addressable, as they are in the capture, whichever case the host spelled them in |
| a header the request did not carry | the assertion fails as an ordinary failed assertion with `actual: undefined`; nothing throws |

`req.body` is the value for a JSON, text or urlencoded body and absent for a multipart or raw one,
whose content is a file (§7.5) rather than something an assertion compares. Header names are
lower-cased because HTTP does not distinguish `X-Trace` from `x-trace` and nothing tells a flow which
spelling the host chose: one form addresses a header whichever side wrote it, which is the rule
`steps.<id>.headers` already follows.

### R9.4 — A `step:end` carries a capped, masked preview

**Pins:** §5.2's `capturePreviewBytes`, §14.5's *storage is split*, §14.7's `--verbose` previews.

| Case | Expected |
|---|---|
| a step that sent a request | its `step:end` carries `preview.request` — the request line, the headers the host wrote, and a textual body — and `preview.response`, the response body |
| a body longer than `config.capturePreviewBytes` | the preview is cut at that many **bytes** — never mid-character — while the attempt file beside it holds the whole body and carries no `preview` / `truncated` field |
| no `capturePreviewBytes` set | the cut is at 8192 |
| a secret-valued variable in the request, or a denylisted header | masked in the preview exactly as in the capture — masked **before** the cut, so a truncated secret leaves no prefix behind |
| a binary response | `preview.response` is absent — §14.5 never previews one |
| a step that sent nothing | no `preview` at all |

The preview is the reporter's inline copy §14.5 describes; the attempt file is unchanged by it. It
travels on the event rather than in `StepResult` so `summary.json` and `RunResult` stay free of
bodies, which is the size argument §13.2 makes for the stream.

### R9.5 — A stopped run announces its cleanup window

**Pins:** §11.3's grace window, 002 §7.1's cleanup state.

| Case | Expected |
|---|---|
| `maxRunDuration` elapses with a cleanup step declared | exactly one `run:cleanup` event, after `run:start`, before the cleanup step's `step:start`, and `run:end` still last |
| its `deadline` | when the run stopped plus `config.cleanupGrace`, on the run's clock — the same instant the engine abandons cleanup at |
| the host's signal aborts the run instead | the identical event, for §11.3's reason that the two take one path |
| a run that was never stopped | no `run:cleanup` |
| a stopped run with no cleanup-eligible step — none whose `depends` accepts `cancelled` | no `run:cleanup`; the stop goes straight to `run:end`, with the in-flight step `cancelled` and the rest skipped `run-cancelled` |
| the only cleanup step is inside a sub-flow that is still running when the run stops | the event is emitted, and that step runs |

Emitted the first time the scheduler acts on the stop rather than from the abort listener: a signal
can fire after the last step has finished, and an announcement after `run:end` would break §13.2's
ordering guarantee for a window nothing can use. And only when there is a step for the window: it is
a state 002 §7.1 shows, and a run with nothing eligible would have the control read "cleaning up" over
a run that is simply over. Whether one exists is asked of the flows in flight — the entry flow and
every sub-flow that has started — since a sub-flow the stop reaches first is skipped whole.

### R9.6 — A run reports its own duration

**Pins:** 002 §8.4's elapsed time; §14.5's `summary.json` carrying the outcome.

| Case | Expected |
|---|---|
| a run whose only time is four 1000 ms retry delays on the injected clock | `RunResult.duration` is 4000 — `run:start` to `run:end`, on §13.2's clock |
| the same run's `summary.json` | carries the same `duration` |
| a run cancelled by its budget | the duration covers the cleanup window as well as the steps |

Run-level rather than derived from the steps: under `concurrency > 1` step durations overlap, and
no sum of them is the elapsed time a summary line shows. `IterationResult` gains nothing — §13.2
declares no per-iteration duration.

### R9.7 — A cleanup step is dispatched with a live signal, bounded by the grace window

**Pins:** §11.3's cleanup exception and its grace window; §13.2's `StepContext.signal`.

| Case | Expected |
|---|---|
| a cleanup step scheduled after the run stopped, against a port that answers its signal | the request goes out and the step is `success` — the signal it was handed is not already aborted |
| a cleanup request still pending when `stoppedAt + cleanupGrace` arrives | aborted at that instant, and the step is `cancelled · run-cancelled` |
| the window the run announced | `run:cleanup.deadline` is the same instant the abort fires at |

The signal a cleanup dispatch receives cannot be the run's own: §11.3 schedules the step *after* the
stop, so the run's signal is aborted before the request is built and handing it over cancels the very
work the window exists to let finish. The window is the bound instead, which is also what keeps
§11.3's promise that an unattended run cannot hang in cleanup — the deadline holds against a host
that never returns, not only against a scheduler that checks between steps.

### R9.8 — A request in flight when the run is cancelled is `cancelled`

**Pins:** §11.3's "in-flight requests are aborted and their steps recorded as `cancelled`"; §14.6's
status vocabulary.

| Case | Expected |
|---|---|
| a step whose request is pending when the run is cancelled | `cancelled · run-cancelled`, not `failed · transport-error` |
| the steps that had already settled | keep the verdicts they reached; the cancel renames nothing behind it |

A host reports an abort and a dropped connection identically — a rejected promise — so only the side
that owns the signal can tell them apart, and §13.2 puts that side in the engine. Without it
`cancelled` was reachable only from a retry delay, which made it a property of polling steps rather
than of cancellation.

### R9.9 — Request validation reaches urlencoded and multipart bodies

**Pins:** §10.1's request schema check and the three cases it is *not* applicable to.

| Case | Expected |
|---|---|
| a urlencoded body whose fields resolve to the declared types | dispatched, and the fields flattened to strings for the wire |
| a urlencoded field that breaks the schema | `failed · invalid-request`, nothing sent, the field named in the message |
| a multipart body's non-binary part breaking the schema | the same, naming the part |
| the `format: binary` part beside it | never checked, and never reported missing from `required` |
| `validateRequest: false` on the step | dispatched unchecked, as for a JSON body |

§10.1 lists exactly three things the check does not apply to — an operation with no `requestBody`
schema, `format: binary` parts, and raw binary bodies — so a form body is inside it. What the check
runs against is the body **before** §7.5 encoded it: a urlencoded field is a string on the wire
whatever the schema declares, and validating the encoded form would fail every request the operation
types as anything but a string.

### R9.10 — A host supplies the implicit `collection` profile

**Pins:** §6.4's implicit `collection` profile and its place in the resolution order; §13.2's
`RunOptions.authProfiles`.

| Case | Expected |
|---|---|
| `auth: collection` on a binding or a step, with the host supplying `authProfiles.collection` | the request carries that profile, resolved to Bruno's `Auth` exactly as a declared one is (R4j); `{{...}}` in its fields resolves against the run's environment |
| the flow's own `authProfiles:` declares `collection` too | the flow's wins |
| a sub-flow using `collection`, where the caller declared one | the caller's — inherited ahead of the host's, as any inherited profile is |
| the credential the host's profile resolved to | masked wherever it later appears (§14.4), as a declared profile's is |
| no host profile supplied — a workspace-scoped run | `failed · invalid-request`, `no auth profile named collection`, nothing sent: exactly what it was before the field existed |
| no `auth:` on the step and none on its binding, with the host supplying `authProfiles.collection` | that profile — §6.4's third rank, which is what makes a collection flow that "declares no `authProfiles` at all" authenticate exactly as the collection does |
| `auth: none` on a step in that same flow | `mode: 'none'` — the opt-out, and the only thing a step that must *not* carry the collection's credentials has to write |
| no `auth:` anywhere and no host profile — a workspace-scoped run | `mode: 'none'`: with no collection there is no default to fall to, and the fourth rank is reached |

The resolution order is therefore four ranks, not three: the step's `auth:`, the binding's, the
implicit `collection` profile, then `none`. The third exists because the common collection flow
names no profile anywhere, and reading that as "send nothing" would make a flow authenticate
differently from every request in the collection around it.

A named profile is found in one of three places, in this order: the flow's own `authProfiles:`
block, the profiles inherited from the flow that invoked it (§12.3), then what the host supplied.
The host's are last because they are the ambient default — the collection's configured auth, which
§6.4 says a collection flow calling one API never spells out — and anything a file says is a
decision over a default. A host profile carries no declaring flow, so §6.4's lexical rule has no
scope to resolve it in; it resolves where it is used.

### R9.11 — The dispatch port receives the scope the request was interpolated against

**Pins:** §13.2's `StepContext.variables`; §7.4's file sources, which is where a host's own proxy and
certificate configuration is interpolated for `bru run`.

| Case | Expected |
|---|---|
| `ctx.variables` at dispatch | one map holding §7.3's chain flattened, the flow's `vars:` as this iteration resolved them, and every namespace as a key — `steps`, `row`, `params`, `shared`, `flow`, `pre`, `process` |
| `pre` in it | the dispatching step's own computed values (§8.7), and empty for a step that computed none |
| a host interpolating its own template against it | the same string the request body resolved to from the same `{{...}}` — it is the scope the request was built from, not one rebuilt for the host |

`bru run` interpolates a collection's proxy URL and certificate paths against the request's
variables, and a host running a flow could do the same only by rebuilding §7.3's chain from
`RunOptions.variables` — which is precedence, which is the engine's (§13.2). The map is what
`{{...}}` reads, handed over rather than re-derived, so the request and what surrounds it resolve
the same way.

### R9.12 — A `uses:` step announces how many steps its sub-flow runs

**Pins:** §14.7's `sub-flow (2 steps)`; §13.2's `step:start`.

| Case | Expected |
|---|---|
| a `uses:` step's `step:start` | carries `steps`, the number of steps the sub-flow declares — a nested `uses:` inside it counting as one |
| an operation step's `step:start` | no `steps` key at all |

The count is what §14.7's line prints while the container is still in flight, and `step:end` cannot
supply it: that event arrives only once every internal has, which is after the line was needed. It is
the sub-flow's *own* step count rather than the flattened total, because that is what the line
describes — one flow, invoked as one step — and what a reader would count by opening the file.

### R7.1 — Every §6.4 auth mode reaches the wire

**Pins:** §6.4. CLI-level, against a server that records what arrived — §2's table says where.

§6.4's claim is that flows introduce no auth mechanics of their own: the engine resolves a profile to
Bruno's `Auth` (R4j) and each host applies it with the code it already has. Only the wire can show
that it did, so one flow declares a profile per mode and every case asserts the header the mode
produces on the request the server received.

| Mode | Expected on the wire |
|---|---|
| `bearer`, `basic` | `Authorization`, the scheme and the encoding `bru run` sends |
| `apikey`, both placements | the named header, or the named query parameter on the URL |
| `wsse` | an `X-WSSE` username token carrying a digest, a nonce and a timestamp |
| `awsv4` | an `AWS4-HMAC-SHA256` credential scoped to the profile's region and service |
| `oauth1` | an `OAuth` header naming the consumer key |
| `oauth2` (`client_credentials`) | one request to the profile's `accessTokenUrl`, and the token it returned placed by the profile's `tokenPlacement` and `tokenHeaderPrefix` |
| `digest`, `ntlm` | **two legs** — the unauthenticated request that drew the 401, then the answer to the challenge |
| `akamai-edgegrid` | an `EG1-HMAC-SHA256` signature naming the client token |

The challenge modes are the reason this cannot be asserted from the resolved `Auth` alone. Their
interceptors read the challenge off a *rejected* 401, and a flow's request is dispatched with every
status resolving because §10.1 leaves the judgment to the engine — so a host that forgot the
exception would send one unauthenticated request, report the 401 as the step's result, and look
exactly like an API that refused a valid credential.

One further case, which is §6.4's per-field override rather than a mode: a step declaring
`Authorization` itself keeps its own value, and the profile does not replace it. The engine hands
the step's headers and the resolved profile over separately precisely so that a host can tell which
of the two a value came from; folding them the other way would silently discard a pre-signed token.

### R7.2 — Multipart and binary bodies are sent as the engine assembled them

**Pins:** §7.5. CLI-level — §2's table says where.

| Case | Expected on the wire |
|---|---|
| a multipart body with a `!file` part, a text field and a number | one part per key, with the boundary in `Content-Type` |
| the file part's `filename:` override | the name the flow gave it, not the fixture's own |
| the file part's content type | the one the engine resolved (§7.5's four steps), not one re-derived from the path |
| a binary body from `bodyFile:` | the file's bytes, unaltered, under the operation's media type |

The filename row is what rules out the obvious reuse. `bru run` builds its multipart bodies with
`utils/form-data`'s `createFormData`, which takes file *paths*, reads them itself and derives each
part's name from the path — and §7.5 gives all three to the engine, which has already read the file
through the `ReadFile` port and applied the `filename:` override. A host that reached for the
existing helper would send `tmp-3f9a.csv` where the flow said `september-invoice.csv`, which §7.5
notes servers routinely key validation and storage on.

### R7.3 — A cookie jar per run, per iteration

**Pins:** §7.6. CLI-level — §2's table says where.

| Case | Expected |
|---|---|
| a step whose response sets cookies, followed by another step | the later request carries them |
| two dataset iterations, each logging in | each carries **its own** session, never the other's |
| the first request of a run | no `Cookie` header — the jar starts empty |

Per-iteration isolation is the rule §7.6 calls load-bearing, and the failure it prevents is a
passing test: under one run-wide jar a role matrix's second row sends the first row's cookie, the
server answers as the wrong user, and the flow reports three identities tested when it tested one.
The engine mints the jar id, so what this pins on the host side is that two ids never resolve to one
jar — which is exactly what reusing `utils/cookies`' process-wide jar would do.

### R7.4 — The collection's proxy and certificates apply

**Pins:** §7.6's *ambient configuration of the transport*, and §6.2's scopes.

| Case | Expected |
|---|---|
| a collection whose `bruno.json` pins a proxy | the request reaches the proxy, with the API's absolute URL on the request line, and never the API directly |
| a client certificate whose domain matches the request | looked for at the path the collection names, resolved against the collection |
| the same certificate and a request to another host | not consulted |
| a proxy written as `{{variable}}` | resolved against the run's variables before the agent is built, so the request reaches the host the variable names |
| a certificate whose `certFilePath` / `keyFilePath` is written as `{{variable}}` | resolved the same way, against the variables that step resolved |
| a certificate whose `domain` is written as `{{variable}}` | resolved before the match, so the certificate is consulted for the host the variable names rather than for the literal `{{apiHost}}` |
| a workspace-scoped flow, with no collection config to read | dispatched normally |

A flow declares none of this and a collection configures all of it, which is what §7.6 means by
ambient: a proxy and a certificate are properties of how a host reaches an API, not of the flow that
calls it. The consequence worth pinning is the negative one — a flow and a `bru run` in the same
collection must not reach the same API by different routes, and only the proxy seeing the request
says so.

The three interpolation rows are the same argument applied to the config's own text (§7.4). A team
whose proxy or certificate directory differs between staging and production writes it as a variable,
and a host that matched on the literal `{{apiHost}}` would consult no certificate at all and report
nothing — a request that quietly went out unauthenticated by the transport's own standard.

### R7.5 — A script runs in the sandbox a plain request in this collection would get

**Pins:** §8.2. CLI-level — §2's table says where.

| Case | Expected |
|---|---|
| an `outputs:` script | its return value, computed with no access to `node:vm`'s globals — `require`, `process` |
| the same script, throwing | the step fails with `script-error`, carrying the script's own message |

§8.2's promise is "no new security posture": a flow script runs in the same sandbox mode a plain
request in this collection would. `bru run` derives that mode from its own `--sandbox` option,
default `safe` (QuickJS), and `bru flow run` now takes the same flag with the same default (§14.1) —
R7.6 is the one that pins the flag, and this is the unflagged default it falls back to. What this
pins is the CLI's `runScript` port reaching QuickJS's value-returning entry point rather than the
`node:vm` sandbox it used unconditionally before — a script that could reach `require` there could
read or write anything the CLI process could, regardless of what the collection asked for.

### R7.6 — `--sandbox` selects that mode, exactly as `bru run`'s does

**Pins:** §8.2 and §14.1's `--sandbox` row. CLI-level — §2's table says where.

| Case | Expected |
|---|---|
| no flag | QuickJS — `require` and `process` are undefined to a script (R7.5) |
| `--sandbox safe` | the same, so naming the default cannot change the sandbox an unflagged run got |
| `--sandbox developer` | `node:vm` — the script is given `require`, and still returns its own value and rejects with its own error |
| a value that is neither | a usage error, exit 3, the two values named, no flow read — where `bru run` would read it as `developer` |
| an `action` the command does not have | exit 3 likewise: yargs' own validation exited 1, a failed flow's code, until the command mapped it |
| `--sandbox developer` through a whole run | a step's `outputs:` script sees `require` in the run's JSON report |

The `develper` row is the one worth stating: §8.2's promise is about parity on the two sandboxes a
request can actually be given, and the flow flag keeps that — same values, same default. It is
deliberately stricter on a third value, because `bru run`'s reading of one is that a typo runs the
scripts unsandboxed, silently, and a flag that can do that in a CI line is the failure direction
§8.2 exists to rule out. Refusing is loud and costs nothing a request had.

### R7.7 — The collection's own auth is what `auth: collection` sends

**Pins:** §6.4's implicit `collection` profile. CLI-level — §2's table says where.

| Case | Expected |
|---|---|
| a collection-scoped flow declaring no `authProfiles:`, a step `auth: collection` | the collection's own credential on the wire |
| the same, resolved from the binding's `auth:` rather than the step's | the same credential; a step's `auth: none` still overrules it |
| a collection whose credential reads `{{authToken}}` | interpolated against the run's variables — the host attaches no lexical scope, so the using step's is what it resolves in |
| a collection whose auth is `none`, `inherit`, or absent | a `none` profile: `auth: collection` resolves, and sends nothing |
| a collection root file that is missing or does not parse | the same `none` profile — reading a collection's auth never fails a run |
| a workspace-scoped flow, step `auth: collection` | `unknown-auth-profile`, exit 2, nothing sent |
| each mode of Bruno's `AuthMode` the collection can store | flattened from `{ mode, <mode>: { … } }` to the profile shape §6.4 authors, Akamai's `akamaiEdgegrid` key included |

§6.4 says a collection flow "declares no `authProfiles` at all and authenticates exactly as the
collection does", and the engine cannot make that true on its own: it resolves `authProfiles`
alongside the flow's own and never opens `collection.bru`, because what a collection *is* is host
knowledge (§13.2). So each host reads its own collection root and hands the profile over, and the
row worth stating is the empty one — a collection that configures no auth still supplies a profile,
`mode: none`, rather than leaving `auth: collection` to fail for some collections and not others
depending on whether anyone had filled the auth in. The workspace row is the other direction: no
collection means no profile at all, so the reference stays unresolved instead of quietly sending an
unauthenticated request.

### R7.8 — A yml-format collection scopes exactly like a `.bru` one

**Pins:** §5.1's containment boundary and §14.1's discovery. CLI-level — §2's table says where.

| Case | Expected |
|---|---|
| a flow under a directory holding `opencollection.yml` and no `bruno.json` | scoped to that directory as its collection root, exactly as a `bruno.json` directory would be |
| the same flow, a step naming `auth: collection` | the yml collection's own credential reaches the wire, not `unknown-auth-profile` |
| the same scope, §14.5's capture root and the ports' `collectionPath` | both the yml collection's directory, not an ancestor workspace |
| a directory holding both `bruno.json` and `opencollection.yml` | the same root either way — scope detection only asks whether a directory is *a* collection root; which root file a reader goes on to open is `getCollectionFormat`'s own precedence (`yml` first), unchanged by this |
| a flow with no collection above it at all | still `unknown-auth-profile`, exit 2 — untouched by recognising the second format |

Bruno collections come in two on-disk formats, and `bru run` locates either one's root the same way
(`getCollectionFormat`, `utils/collection.js`). `bru flow run`'s own scope detection did not: it
walked up for `bruno.json` alone, so a yml collection with no `bruno.json` beside it was invisible to
it and every flow under it scoped to the nearest ancestor workspace instead — `auth: collection`
unresolved, §7.4's containment boundary drawn one level too high, and the capture root and
`collectionPath` both pointed at the wrong directory. The fix reads the same predicate `bru run`
already uses rather than inventing a second one, so the two commands agree about what a collection
is for the same tree.

### R13.1 — Verbose previews, the operation column, and TTY in-place updates

**Pins:** §14.7 — the sample's operation column, the `--verbose` row of the verbosity table, and
the TTY/CI table's in-flight-row, cursor-control and colour rows. CLI-level tests, not engine ones,
for R4l's reason: §14.7's console rules are the CLI's own. Properties only, never exact text, for
the same reason R4l gives — §14.7 is deliberately not a stable format.

| Property | Why it is contractual |
|---|---|
| a `step:start` naming an operation | shown on that step's line |
| a `step:start` naming none | it is a `uses:` step (§5.3), and the column reads `sub-flow (N steps)` from that event's `steps` — never the id, which would print the same word twice in adjacent columns |
| a `step:start` naming none and carrying no `steps` | the column reads `sub-flow` — an older engine still leaves the kind worth naming |
| a passing step's `step:end.preview`, default verbosity | not shown — bodies are inlined only under `--verbose` |
| the same, under `--verbose` | the request and response preview both appear, exactly as given |
| a preview cut short before it arrived | printed exactly as given — never re-truncated, completed, or otherwise reshaped |
| a `step:end` with no `preview` | nothing extra is printed for it, `--verbose` or not |
| a step with passing assertions, under `--verbose` | each one appears |
| a TTY, a `step:start` | an in-flight line appears before that step's `step:end` |
| the same step's `step:end` | the in-flight line is rewritten in place, with cursor control — never appended a second time |
| two in-flight steps that complete out of the order they started | each rewrite lands on its own row, not the other's |
| not a TTY | no in-flight line ever appears, and no cursor control appears in the output of a passing or a failing run alike |
| `FORCE_COLOR` set on a TTY, `NO_COLOR` also set | colour — `FORCE_COLOR` wins |
| `FORCE_COLOR` set and not a TTY | still no colour, and no escape sequence of any kind — an archived CI log is not a TTY that happened to have the variable set (R4l) |

The not-a-TTY row is the one a naive `FORCE_COLOR` implementation gets wrong: the variable's usual
meaning elsewhere is "colour this even though nothing is watching," and §14.7's own TTY/CI table
gives the CI column exactly one rule — never — with no exception carved out for it.

### R8.0 — A step's own budget

**Pins:** §11.1's `maxDuration`.

| Case | Expected |
|---|---|
| a poll whose budget elapses before `maxAttempts` is spent | `failed`, reason `max-duration-exceeded`, and the attempt that would not fit is never scheduled |
| the rest of the flow | runs; the budget bounds the step and not the run, which is §11.3's separate bound |
| a poll that settles inside its budget | judged on what it settled as, not on the clock |

`maxAttempts × (timeout + delay)` is the wall clock a poll can otherwise take, and on the schedules
polls actually use that is tens of minutes — so a flow that set the bound and got nothing was a flow
with no bound at all.

### R8.1 — The graph a document declares

**Pins:** §5.3's uniqueness, §9.1's join shapes and status vocabulary.

| Case | Expected |
|---|---|
| a well-formed flow | **no diagnostics at all** — the case that catches a check firing on correct files |
| two steps sharing an id | `duplicate-step-id`; the second otherwise overwrites the first's state and captures |
| a `depends:` mapping carrying neither `all:` nor `any:` | `invalid-depends` |
| a `depends:` mapping whose list is empty | `invalid-depends` — it normalizes to an unconditional root that runs *first* |
| `status: [succeeded]` | `invalid-dependency-status`, listing the four outcomes; a near miss carries a did-you-mean |
| a cycle | `cyclic-dependency` once, and `unreachable-step` for every step it leaves unrunnable |

The empty-join row is the expensive one: a join emptied by a bad edit does not fail, it runs before
everything it was meant to wait for.

### R8.2 — Names that have to resolve

**Pins:** §8.1, §9.1's write side, §12.1's exports.

| Case | Expected |
|---|---|
| `{{steps.x.tokne}}` where `x` declares `token` | `unknown-output-reference`, with the did-you-mean |
| a `uses:` step's export read as `{{steps.auth.token}}` | accepted — a sub-flow's exports are the invoking step's outputs (§12.2) |
| an `exports:` entry naming an output no step produces | `unknown-export` |
| a step's `shared:` publishing an output it does not produce | `invalid-shared-entry` |
| a step's `shared:` publishing into a slot nothing declares | `invalid-shared-entry` |

### R8.3 — Expressions parse and their operators exist

**Pins:** §10.2's triple, §9.3's rule that a condition precedes the request.

| Case | Expected |
|---|---|
| `res.status equals 201` | `unknown-operator` — the operator is not found, so the whole line is asserted for truthiness and passes every time |
| `{ expr, op: equalTo, value }` | `unknown-operator` |
| a bare expression, with and without `isDefined` | accepted |
| `when: res.status eq 201` | `condition-reads-response` |

### R8.4 — Inline overrides against the operation schema

**Pins:** §7.1's structural drift.

| Case | Expected |
|---|---|
| overrides naming what the schema declares | no diagnostics |
| a top-level body field the schema has no property for | `unknown-field`, with the did-you-mean |
| a field under a `$ref`'d object | `unknown-field` — a schema lifted out of a document is a fragment of it, and nearly every real one is a `$ref` |
| a field on an array's items | `unknown-field` |
| a key under an `additionalProperties: true` object | accepted |
| a query parameter the operation declares none of | accepted — `parameters:` is optional and routinely omitted, so the document's silence is not evidence of a typo |
| a query parameter beside ones it does declare | `unknown-field` |
| a `pathParams:` key the template does not name | `unknown-field` — it substitutes into nothing |

### R8.5 — Media types, files and parts

**Pins:** §7.5.

| Case | Expected |
|---|---|
| a step selecting one of two declared media types, supplying its part as `!file` | no diagnostics |
| `contentType:` on an operation declaring one | `unexpected-content-type` |
| `contentType:` naming an undeclared type | `unknown-media-type` |
| two declared types and no `contentType:` | `ambiguous-media-type` |
| a `format: binary` part written as a plain string | `missing-binary-part` — §5.4's row where the schema and validation see the same characters and must disagree |
| a required binary part nobody supplied | `missing-binary-part` |
| `!file` in a JSON body | `file-not-allowed` |
| `filename:` on a raw binary body | `binary-file-options` |
| a single-payload media type with no file at all | `missing-binary-body` |

### R8.6 — Paths, and the tags that name them

**Pins:** §7.4's containment, §5.4's tags, §7.2's removal token.

| Case | Expected |
|---|---|
| `!file`, `bodyFile:` and `dataset:` paths inside the scope root | no diagnostics |
| a `bodyFile:` climbing out of it | `path-outside-scope` |
| a `dataset:` naming nothing on disk | `missing-file` |
| a path carrying `{{...}}` | left alone — §7.4 resolves it when the step materializes |
| `!file` carrying a fourth option | `parse-error`, at the line — dropped in silence, `filenmae:` uploads under the wrong name |
| `!...` in a step's `body` | accepted |
| `!...` in `vars:` | `misplaced-drop` — there is no seeded key to remove and it reads as `null` |

### R8.7 — What a `uses:` step may carry

**Pins:** §12.4's table.

| Case | Expected |
|---|---|
| a call site carrying only the legal fields | no diagnostics |
| `retry:` on the step | `invalid-subflow-field` — replaying a sequence replays every side effect it committed |
| `auth:`, `body:`, `timeout:` | one `invalid-subflow-field` each |
| `dataset:` in the sub-flow | `subflow-dataset`, reported against the **sub-flow's** file |
| a `uses:` target that is not there | `unresolved-subflow`, and the rest of the document still checked |
| a misspelled `with:` key | `unknown-param`, with the did-you-mean |

### R8.8 — Declared and never used

**Pins:** §14.3's three lints. All warnings: a value nothing consumes is legal, and is nearly always
the other half of a typo reported somewhere else.

| Case | Expected |
|---|---|
| an output nothing reads | `unused-output` *(warning)* |
| a declared slot nothing writes | `slot-without-writer` *(warning)* |
| a declared slot nothing reads | `unused-slot` *(warning)* |

### R8.9 — Reserved names and the library flag

**Pins:** §7.3's namespaces, §12.5's lint.

| Case | Expected |
|---|---|
| `vars: { flow: ... }` | `shadowed-reserved-name` *(warning)* — the namespace shadows it and nothing at run time says so |
| a required param with no default, `library:` unset | `required-param-without-library` *(warning)* |
| the same flow marked `library: true` | silent |
| the same flow with the param supplied through `ValidateOptions.params` | silent — the check sees what the run it is validating would supply |

### R8.9b — `bru` in a flow script

**Pins:** §8.2, §14.3's `bru-unavailable`.

`bru` is not in a flow script's scope in either sandbox or either host, so a script reaching for it
throws `ReferenceError` mid-run. The warning exists so `bru flow validate` says so first, and names
what a flow uses instead.

| Case | Expected |
|---|---|
| `bru.setVar` in a `shouldRetry` predicate | `bru-unavailable` **warning**, its message naming `outputs:` and `shared:` |
| the same in an `outputs:` script, a `when:` script, a `pre:` script, and a `functions:` entry | one warning each — an author porting a `.bru` script writes it wherever that script had it, so a check wired into one position and not the others reports the tidy cases and misses the rest |
| a script that reads `ctx` and never mentions `bru` | nothing |
| a script naming `ctx.brunoRef` or `ctx.bru_key` | nothing — the match is on a member access, not on the three letters |

A warning rather than an error because the match is textual: `bru` inside a string or a comment is
not a call, and refusing to run a flow over a substring would be worse than the throw it replaces.

### R8.10 — Which operation a reference names

**Pins:** §6.1's fallback and its normalization, §6.5's duplicate.

| Case | Expected |
|---|---|
| `api#POST /orders/{orderId}/refund` against a document with no `operationId` | resolves; no diagnostics |
| the same, described | the graph's node carries that method and path |
| a trailing slash, doubled slashes, an origin, a query, a lowercase method | all resolve to the same operation |
| a method+path matching nothing | `unknown-operation` |
| an `operationId` the document declares twice | `ambiguous-operation` — an index built by assignment keeps the last, and the step calls the other endpoint |

§6.1 asks for a **committed corpus asserted by both** the engine and `openapi-sync.js`. The engine's
half is the row above; the other half is
`packages/bruno-electron/src/ipc/openapi-sync.spec.js` (002-C U5.14), which asserts the same rows
against that file's own `normalizeUrlPath`, reached through its existing `NODE_ENV=test` export
block. Drift is now a failing test on one side or the other rather than a flow that silently cannot
resolve an operation openapi-sync matches fine.

### R8.11 — Names a script's context shadows

**Pins:** §8.2's `ctx.env` and `ctx.vars`, which §7.3's namespace table does not carry. Neither is an
interpolation namespace — `{{env}}` resolves to a variable of that name like any other — so the
warning is about the *script* half: the context puts both objects above its flat spread of
variables, and a variable so named is reachable from a request and invisible to every script that
would read it.

| Case | Expected |
|---|---|
| `vars: { env: ... }` | `shadowed-reserved-name` *(warning)* — naming `ctx.env`, which is the environment tiers |
| `params: { vars: ... }` | `shadowed-reserved-name` *(warning)* — naming `ctx.vars`, which is the flow's own `vars:` |
| `vars: { flow: ..., env: ... }` | two warnings under one code, each with its own reason: §7.3's namespace shadows `flow` in `{{...}}` too |
| a variable named neither | silent |

### R8.12 — An export nothing at the call site reads

**Pins:** §14.3's decision *not* to report one, and the check that covers what it would have caught.

| Case | Expected |
|---|---|
| a caller reading `{{steps.<uses>.<export>}}` | silent |
| the same caller with that read removed | silent — no diagnostic of any code |
| a read naming an export the sub-flow does not declare | `unknown-output-reference`, an **error**, against the step that reads it |

A library's `exports:` are declared for callers it has not met, so a flow reading three of six is
what a shared library is *for*. Warned about, that fires at nearly every call site and is dismissed
at nearly every one — and a warning everybody learns to scroll past devalues the ones beside it,
which is the cost this row exists to refuse. It is §8.5's rule for connector-supplied outputs with a
different noun: a declaration made once for every consumer is not evidence against a consumer that
uses part of it.

The third row is why nothing is lost. The failure the warning could have caught alone is a typo, and
a typo names an output the sub-flow does not export — reported as an error, at the position it was
typed, rather than as a warning against the `uses:` step some lines above.

### R8.13 — A header a signing mode computes

**Pins:** §14.3's signing-mode bullet and §6.4's rule behind it, defined here as the step's own
`headers:` against the headers its resolved profile computes. Which of the two wins is the *host's*
and not the flow's, and the hosts do not agree: `aws4` deletes an `Authorization` it finds and signs
over what is left, while the digest interceptor answers no challenge at all for a request that
already carries one. Either way the request goes out as something nobody wrote, and the API answers
401 — which reads as a credentials problem rather than as the configuration one it is.

A **warning**, not the error §6.4 states: §6.4's own per-field override is the documented way to hand
one call a pre-signed token, and only these modes collide with it.

| Case | Expected |
|---|---|
| an `awsv4` step carrying `X-Request-Id` | silent — a header the mode computes nothing for is not this check's business |
| the same step setting `Authorization` | `signed-header-override` *(warning)* |
| `x-amz-date` and `X-Amz-Security-Token`, in either case | one warning each — a name is case-insensitive on the wire |
| a `bearer` profile and an `Authorization` header | silent — §6.4's per-field override |
| a `digest` profile and an `Authorization` header | warned, and told what it actually does: the handshake is skipped, so the profile authenticates nothing |
| a `wsse` profile setting `X-WSSE` and `Authorization` | one warning, for `X-WSSE` — `wsse` computes no `Authorization` |
| an `oauth1` profile with `placement: query` and an `Authorization` header | silent — the signature is not in the header |

The modes are `awsv4`, `digest`, `ntlm`, `oauth1`, `akamai-edgegrid` and `wsse`, and each one's
headers are read off the signer that writes them rather than off a list: `aws4/aws4.js`,
`digestauth-helper.js`, `ntlm.ts`, `oauth1-request-authorization.ts`, `edgegrid-helper.js` and
`prepare-request.js`'s `wsse` branch.

### R12.1 — A `uses:` target's `workspace:` prefix, and the containment it still answers to

**Pins:** §12.2's prefix, §7.4's containment applied to it. Engine-level, `run`, `describe` and
`validate` each asserted against the same fixture, since all three resolve a `uses:` target
themselves and are expected to agree by construction.

| Case | Expected |
|---|---|
| a collection-scoped flow's `uses: workspace:flows/shared/login.flow.yml` | resolves from the workspace root; `run`, `describe` and `validate` agree |
| a plain relative `uses:` path to a sibling in the same collection | resolves against the invoking file, unprefixed — the prefix leaves this case unchanged |
| a plain relative `uses:` path climbing out of the collection's own scope root | `path-outside-scope`, and the same refusal at run time before the sub-flow is read |
| a `workspace:` path climbing out of the workspace root | `path-outside-scope`, and the same refusal at run time before the sub-flow is read |

Without the prefix, a collection-scoped flow's scope root is the collection itself (§7.4) — the same
boundary a `!file` or `bodyFile:` answers to — so `workspace:` only widens where a `uses:` target may
resolve *to*, never what it may resolve *outside of*. Both escaping paths are validation and run-time
errors before anything is read, which is what keeps a workspace-level shared flow from becoming a way
to name any path on disk.

### R12.2 — A slot leaves the flow through `exports:`

**Pins:** §12.1's second export root, `shared.<slot>`, and §11.2's empty-slot rule carried across
§12.2's boundary.

The fixture is a library with two branches that exclude each other — one `when:` per branch, on the
same param — and **no join step**. Only one branch ever runs, so no step descends from both writers
and there is no `steps.<step>.<output>` in the file that names the value either produced. Nothing
inside the flow reads the slot; the boundary is its only reader.

| Case | Expected |
|---|---|
| the first branch's condition holds | the caller reads its value off the invoking step, as an ordinary output |
| the second branch's condition holds | the same export carries the other branch's value |
| neither condition holds | the export is `''`, and the caller's step **runs** rather than skipping |
| `bru flow validate` over the library and over the caller | no diagnostics at either end — in particular not `unused-slot`, which the export is a read for |
| the library described | the exports panel reports the source the file wrote, `shared.chargeId` |

The third row is the decision in this requirement. §11.2 has a `steps.*` reference that resolved to
nothing skip its reader — the step did not do what it was for — and an unwritten slot resolve empty,
because that is a value the run *knows* is empty. Both rules cross the boundary unchanged rather
than being reconciled there: an export whose producing step was skipped is absent and skips the
caller's step, and an export whose slot nobody wrote is `''` and does not. A caller cannot see the
slot, so the alternative — omitting it — would make "no branch ran" indistinguishable at the call
site from a library that failed, and a fallback branch that legitimately writes nothing would skip
work the author meant to run.

### R10.1 — A connector file supplies an operation's outputs

**Pins:** §8.5's premise, and its claim that a connector-supplied output is a declaration like any
other — §8.4's visibility, 002 §5's data edge, §14.3's checks.

The fixture is a workspace with a collection inside it: `flows/connectors.yml` at each root, and a
collection flow whose steps declare no `outputs:` at all.

| Case | Expected |
|---|---|
| a step targeting a covered operation, with no `outputs:` block | its `StepResult.outputs` carries the file's entries, extracted from the response |
| a later step interpolating `{{steps.x.<connector output>}}`; an auth profile reading one | resolves — the value reaches the request, exactly as a declared output's does |
| `bru flow validate` over that flow | **no diagnostics at all** — not `unknown-output-reference`, not `undeclared-dependency`, and not `unused-output` for the entries nothing reads |
| the same flow described | the node's `outputs` lists them; each one read draws a `data` edge with `declared: true` |
| a reference to a name no layer supplies | `unknown-output-reference`, as for an inline output |

The `unused-output` row is a decision rather than a consequence: a connector file declares an
operation's defaults for *every* flow that targets it, and most flows read a few of them. Warning
on the rest would fire in every flow the file serves, so the check is scoped to the step's own block.

### R10.2 — Matching is by resolved spec identity

**Pins:** §8.5's rule that an entry applies by the document an alias resolves to, never by the alias;
§6.1's fallback identity.

| Case | Expected |
|---|---|
| the workspace file, the collection file and the flow each bind the one document under a different alias | every entry applies |
| a step addressing the operation as `api#GET /things/{id}` (§6.1) | the entry declared as `api#getThing` applies |
| a second document declaring the same `operationId`, bound in the flow's place | nothing applies — the node's `outputs` is empty and every read of one is `unknown-output-reference` |

### R10.3 — Resolution order, and what removes an inherited entry

**Pins:** §8.5's order — workspace file → collection file → the step's own `outputs:` — with `!...`
as the removal token and `null` refused; §12.3's rule that a sub-flow's connectors resolve from its
own scope.

| Case | Expected |
|---|---|
| the collection file redeclares an entry's output with another path | the collection's path wins |
| the collection file adds an output the workspace file did not name | inherited alongside the workspace's |
| the collection file writes `role: !...` | `role` is not published, and a step reading it is `unknown-output-reference` |
| a step's `outputs:` writing `thingId: !...`, redeclaring `title`, adding `own` | the run publishes `title` (the step's path), `own`, and the entries it did not touch — and not `thingId` |
| a step reading the entry it suppressed | `unknown-output-reference` |
| `name: null` in a step's `outputs:` | `null-output`, anchored to the step's line |
| `name: null` in a connector file | `null-output`, anchored to the connector file and its line — `null` is not the removal token there either |
| a library flow under the workspace's `flows/`, invoked from a collection whose file suppresses `role` | its `exports: { role: steps.login.role }` resolves — the workspace file alone applies to it (§12.3) — and the parent reads `steps.auth.role` |
| a scope root with no `flows/connectors.yml` | the steps inherit nothing; no diagnostic names the missing file |

### R10.4 — A connector file is checked against the documents it binds

**Pins:** §14.3's row — every entry resolves to a real operation, and its paths check against the
operation's response schema (§8.5).

Every diagnostic here carries `file: <the connector file>` and a line in it, and no `stepId`: the
thing to fix is in the file the diagnostic names, not in the flow being validated.

| Case | Expected |
|---|---|
| `nope#getThing:` where the file's `apis:` binds no `nope` | `unresolved-alias` |
| `api#getWidget:` where the document has no such operation | `unknown-operation` |
| an entry naming an `operationId` the document declares twice | `ambiguous-operation` (§6.5) |
| `api#getThing: data.id` — a scalar where a mapping of outputs belongs | `invalid-connector-entry` |
| `thingName: data.nmae` against a `200` whose schema has `data.name` | `unknown-output-path`, with the did-you-mean |
| a path bruno-query selects by value — a filter, a wildcard | not checked; no diagnostic |
| a connector file that does not parse | `parse-error` against that file, and nothing else in it is checked |
| a run over a flow whose collection file has an unresolved entry | the run proceeds; the entry supplies nothing, and the other layers apply unchanged — what the run ignores is exactly what `validate` names |

### R10.5 — Where each output was declared

**Pins:** §8.5's answer to the locality it costs, and §14.1's — each step's *resolved* outputs and
where each was declared, inline, collection connector file or workspace connector file.

`resolveOutputs` (§13.2, beside `resolveFunctions`) lists them over the flow as written.

| Case | Expected |
|---|---|
| a step redeclaring `title`, suppressing `thingId`, adding `own`, inheriting `thingName` | `[title:inline, thingName:collection, own:inline]` — in the order first declared, whichever layer had the last say, and each with the file it came from |
| a step declaring nothing over both files | `[thingId:workspace, title:collection, thingName:collection]` |
| a `uses:` step | an empty list — its outputs are its sub-flow's exports, not declarations of its own |

### R11.1 — The schema pass inside `bru flow validate`

**Pins:** §14.3's ordering, and §5.4's versioning read from the command's side rather than the
document's. R4m is what the schema decides about a file; this is what `bru flow validate` then does
with that verdict, which is a separate claim and fails separately.

| Case | Expected |
|---|---|
| a `version:` this build ships no schema for | `schema-violation` naming the versions it does describe — a document is never validated against nothing |
| a document that both violates the schema and names an operation the bound document does not declare | both reported. The pass is not a gate: a mistyped key that halted validation would hide every real error under it, and only a document that did not *parse* has no model to read |
| a violation of a rule §14.3 names for itself — `invalid-step-id`, `invalid-subflow-field`, `invalid-dependency-status`, `operation-and-uses`, `body-and-body-file` | reported once, under that name, by the check that owns it. The schema states it as well, because an editor runs the schema and nothing else — but the code is what a `--strict` list or a host filtering its gutter addresses (§14.6), and two spellings of one mistake makes neither addressable |

### R13.2 — `bru flow validate` prints where each output was declared

**Pins:** §8.5's answer to the locality a connector file costs, and §14.3's pass printing it — R10.5
is what `resolveOutputs` resolves, this is what the command then does with it, which is a separate
claim and fails separately. CLI-level tests, not engine ones, for R4l's reason: §14.7's console rules
are the CLI's own. Tested elsewhere — `bruno-cli/tests/fork/flow/output.spec.js` for the reporter's
properties, `bruno-cli/tests/fork/flow/validate.integration.spec.js` for the pass end to end.
Properties only, never exact text, for the same reason R4l gives.

| Property | Why it is contractual |
|---|---|
| a step whose outputs a connector file supplied | every name is printed with the layer that had the last say and that layer's file — the names appear nowhere in the flow, so this is the only place a reader can see them |
| the step's own `outputs:` entries | printed beside them as `inline`, so which half a name came from is answerable rather than merged into one list |
| a step that resolved no outputs | no row for it — a `uses:` step declares none of its own (§12), and rows saying so would be most of the listing in a flow that composes sub-flows |
| a flow whose every step resolved none | nothing printed at all, not a heading over an empty listing |
| not a TTY | no escape sequence of any kind, `FORCE_COLOR` set or not (R4l) |
| `--quiet` or `--silent` | nothing — a listing is neither a failure nor a summary |

Under `validate` and not `run` for the reason §8.6's library listing is: what a step publishes and
who declared it is an authoring question, asked while reading a flow rather than while watching one
execute, and a run has the whole event stream to print without a preamble in front of it.

### R13.3 — `bru flow schema` emits §5.4's document schema

**Pins:** §5.4, and §14's `bru flow schema` block. CLI-level — §2's table says where. The schema's
*contents* are the engine's and are pinned by its own `schema.spec.js`; what is contractual here is
which version comes out, where it goes, and what an unemittable request does.

| Case | Expected |
|---|---|
| no flags | the current format version's schema on stdout, parseable as JSON with nothing else in it |
| that output | ends with a newline — a file an editor reads is read whole |
| `--format-version <n>` for a version this build carries | that version's schema, since §5.4 has one schema per version and a v1 fixture is validated against v1's |
| `--format-version` for a version it does not | exit 3 (§14.2), naming the versions it does carry, and nothing on stdout |
| `--format-version` given something non-numeric | the same refusal — yargs makes it `NaN`, which is no more emittable |
| `--out <path>` | written there, with the directories it names created, and stdout says where |
| `--out` at a path that cannot be written | exit 3, rather than a half-written file |
| `--silent` | nothing on stdout (§14.7), and `--out` still written — the flag governs stdout, and a file the invocation was told to produce is not stdout |
| `--quiet` | the schema, unchanged — §14.7's `--quiet` drops step lines and failure detail, and this command prints neither |

The refusal is the row that earns its place. A schema is normally consumed by a tool that will not
read stderr, so a version this build does not carry has to stop the command before anything
downstream reads an empty or truncated file — an editor silently validating against nothing is worse
than one told there is no schema.

### R8.14 — The implicit collection profile at validate time

**Pins:** §6.4's implicit `collection` profile against `bru flow validate`, closing the gap §14.3's
own bullet names: the check knew nothing about a flow's scope, so `auth: collection` was reported
`unknown-auth-profile` from either scope — the right outcome for a workspace-scoped flow, the wrong
one for a collection-scoped flow, which never declares the profile itself because supplying it is
the host's job at run time (`RunOptions.authProfiles.collection`, `materialize.ts`).

A scope's `collectionRoot` (`ValidateOptions.scope`) is what `validate` can know that a run's own
host input cannot yet answer: whether there is a collection at all to inherit a profile from.
Whether the host actually passes one through `RunOptions.authProfiles` stays a run-time question —
`materialize.ts` still raises `unknown-auth-profile` there if it did not (R9.10).

| Case | Expected |
|---|---|
| `auth: collection` on an `apis:` binding, in a scope with a `collectionRoot`, no `authProfiles:` declared | no diagnostic |
| `auth: collection` on a step directly, in the same scope | no diagnostic |
| the same flow in a workspace-only scope (no `collectionRoot`) | `unknown-auth-profile`, naming that this scope has no collection to inherit an auth profile from |
| a flow that declares its own `authProfiles.collection` | that profile wins in either scope — resolution order (§6.4) is unchanged |
| `auth:` naming any other profile no `authProfiles:` block declares | `unknown-auth-profile`, worded as before — this rule narrows only the `collection` case |

### R9.13 — One mapping from a collection's stored auth to its profile

**Pins:** §13.1 — the engine exists so the CLI and the app cannot diverge — over §6.4's implicit
`collection` profile, whose shape each host had been translating for itself.

Bruno stores a collection's auth nested under a key named for its mode (`{ mode: 'bearer', bearer:
{ token } }`); an `AuthProfile`'s fields are flat. Both hosts read a collection root off disk, and
both had a copy of the flattening — including the one key that is not the mode string. A mode one
copy flattens and the other does not is a collection that authenticates under `bru flow run` and
silently does not in the app, which is the class of divergence §13.1 exists to make impossible. The
mapping is `collectionAuthProfile(auth)`, exported from `@bruno-max/flow` beside the `resolveAuth`
that nests it back; what stays each host's is finding the block — which file holds it, in which
format, and what to do when it will not parse.

| Case | Expected |
|---|---|
| every mode `AuthMode` names — `bearer`, `basic`, `apikey`, `awsv4`, `digest`, `ntlm`, `wsse`, `oauth2`, `oauth1`, `akamai-edgegrid` | `{ fields: { mode, ...that mode's own fields } }`, with the mode's key gone rather than left beside them |
| `akamai-edgegrid` | read from `akamaiEdgegrid` — the one key that is not the mode string |
| a credential written `{{authToken}}` | carried over as written; §6.4 resolves it in the using step's scope |
| the profile's `scope` | absent: nothing declared this profile, so §6.4's lexical rule has no scope to carry |
| auth that is `none`, `inherit`, absent, or not an auth block at all | `{ fields: { mode: 'none' } }` — §6.4's promise holds for a collection that authenticates with nothing |
| a mode whose own block is missing or is not a mapping | that mode alone, with no fields invented |
| both hosts | import it; neither keeps a flattening of its own, and each host's existing spec passes against the shared mapping unchanged |

### R5 — Unresolved variables never reach the wire

Assert that a declared-but-unwritten `shared` slot interpolated into a body sends `""` and **not**
the literal `{{shared.x}}`. Bruno's interpolator leaves unresolved placeholders in place
(`packages/bruno-common/src/interpolate/index.ts:121`), which is correct for a user variable and
wrong for engine state (§11.2).

### R6 — Exit codes

One assertion per code, since CI contracts depend on them (§14.2): `0` pass, `1` step failure, `2`
invalid file, `2` again for warnings under `--strict`, `3` usage error, `4` cancelled. Plus
`bru flow validate` returning only `0`/`2`/`3`, never `1`.

---

## 8. Not covered here

Items deferred as *features* live in the spec's §19; this section lists what these scenarios do not
exercise, which is a different question — some of it because the feature is deferred, some because
it belongs in another test suite.

- **The UI.** Owned by [002-C](./002-api-flows-ui-conformance.md), which tests the app against
  [002](./002-api-flows-ui.md). A scenario here that could only fail because the *app* is wrong is
  misfiled, and the reverse holds there.
- **Real network behavior** — proxies, certificates, cookies, redirects. Those live in each host's
  `ExecuteRequest` implementation, not the engine, and belong in the host's own tests.
- **Reporter output formats.** §14.5's capture layout deserves its own tests once the format
  stabilizes.
- **Console output beyond the rules in R4l.** §14.7 is explicitly not a stable format, so asserting
  on its exact text would make every wording change a test failure. What R4l pins is the handful of
  properties that are contractual — no ANSI off a TTY, redaction, deterministic summary ordering.
- **Performance under large graphs.** Concurrency *correctness* is covered by F2.2 and R4;
  throughput is not a conformance question.
- **Real OpenAPI documents.** Fixtures are minimal by design. Parsing real-world specs — vendor
  extensions, `$ref` cycles, missing `operationId` — is separate ground and should not be entangled
  with execution semantics.

## 9. Finding traceability

| # | Finding | Scenario |
|---|---|---|
| 1 | Assertions could not reference `row.*` | F1.2 |
| 2 | Inserted branch silently rewires the implicit sequence | F1.4 |
| 3 | Dataset cannot safely carry credentials | F1 fixture (no password column) |
| 4 | Cleanup raced the steps still using the resource | F2.3 |
| 5 | Negative-test framing → §10.3 | F1.1, F1.3, R3 |
| 6 | Interpolation stringified every value | F3.1 |
| 7 | Structured outputs unspecified | F3.2 |
| 8 | *Withdrawn* — §6.4 already specified lexical profiles | F3.3, F3.4 |
| 9 | `[?]` unusable in a declarative path | F4.1, F4.2 |
| 10 | *Withdrawn* — all requests keep a spec | F4.1 (three bindings) |
| 11 | Base URLs produced by a step | F4.4 |
| — | Fail-open status default | R1 |
| — | Retry amplifying non-idempotent failures | R2 |
| — | Skipping to a green exit on unmatched data (`failOnUnresolved`) | F4.2, F1.1, R4b |
| — | A run had no identity until it finished (§14.5 `run.json`) — found while writing [002](./002-api-flows-ui.md) | R4g2 |
| — | §14.5's per-attempt layout could not hold what `readCapture` returns — found implementing it | R4g2 |
| — | Merge-key resolution was inherited from a library default, not decided — found choosing a parser for §5.4's positions | R4p |
| — | A syntax error stopped being an error once the parser recovered from it instead of throwing | R4p |
| — | Normalization erased whether an edge was declared, so `depends: [previous]` and no `depends:` became indistinguishable — found implementing 002 §5.3 | R4q |
| — | §8.3's `undeclared-dependency` warning was specified and never implemented | R4q |
| — | §14.4 had no scenario at all, so the denylist and the provenance half were equally untested | R4n |
| — | 002 §7.2 asked the main process to resolve an environment it has no access to, and a file read would have silently emptied every secret — found implementing the Electron host | 002-C U5.1, U5.2 |
| — | 002 §11.3 declared the IPC channel *names* a contract and pinned none of their payloads | 002-C U5 |
| — | Registering a fork tab's *label* was not enough — `RequestTab`'s `specialTabs` list decides whether a type is special at all, and one missing from it renders "Not found" | 002-C U5.7 |
| — | The step pane asked `readCapture` for `iteration: 0` on a flow with no `dataset:`, which §14.5 writes unnested — the read failed and the pane reported it as "nothing was sent" | 002-C U4.1 |
| — | 002 §4.2 hooked quit at `main:start-quit-flow`, which fires when quit is *initiated* — a dismissed confirmation left the run aborted and the watcher closed. Found reviewing what to verify manually | 002-C U5.8 |
| — | A flow tab carried no `collectionUid`, and every tab in the app belongs to a collection — the strip renders per collection, pathname dedupe needs one, the snapshot groups by one. Opening a flow errored the app — found in manual verification | 002-C U5.7 |
| — | 002 §10 could not render a past run: `listRuns` reports counts and `readCapture` one attempt, so no entry point returned a stored run's per-step outcomes — found building the run selector | R4o |
| — | §14.5's capture directory name is a lossy encoding of the step id (`/`→`__`, device suffix, hash truncation), so `capturedSteps` could not be recovered by walking the tree as 002 §11.2 first assumed | R4o |
| — | An auth profile reached `ExecuteRequest` in the flat form it was authored in rather than Bruno's nested `Auth`, so the one shape §6.4 promises hosts could reuse was the one shape they could not — found running a flow through the app's `setAuthHeaders` | R4j |
| — | §6.4's third resolution rank was specified and never built: a collection flow naming no profile anywhere sent `none`, so it authenticated differently from every request in the collection around it — found wiring the hosts' `authProfiles` | R9.10 |
| — | Both hosts had their own copy of the stored-auth → `AuthProfile` flattening, including the one key that is not the mode string, so a mode one copy handled and the other did not was a collection that authenticated under `bru flow run` and silently did not in the app | R9.13 |
