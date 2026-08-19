# Writing flow files

A **flow** is a `.flow.yml` file describing a sequence of API calls: what to send, in what order,
what to carry from one response into the next, and what must be true for the run to pass. Flows run
in the Bruno app (the **API Flows** sidebar section) and on the command line with `bru flow run`.

This is the authoring guide — the field-by-field reference for people writing these files. It
describes what the engine **actually accepts today**; where the design spec promises more than is
built, that is called out inline.

> A portable copy of this reference lives in `.claude/skills/flow-writer/references/dsl.md`, for
> converting tests in repositories that do not have this file. Both describe one engine, which is
> the source of truth; `packages/bruno-max-flow/tests/conformance/guide.spec.js` checks both against
> it. Change the DSL and you change all three.

The specs themselves are
[`001-api-flows.md`](./specs/001-api-flows.md) (semantics and format) and
[`002-api-flows-ui.md`](./specs/002-api-flows-ui.md) (the app), and they are written for
implementers rather than authors.

---

## Contents

- [Where flow files live](#where-flow-files-live)
- [A first flow](#a-first-flow)
- [Documenting a flow](#documenting-a-flow)
- [The document](#the-document)
- [A step](#a-step)
- [Values and interpolation](#values-and-interpolation)
- [Request bodies](#request-bodies)
- [Outputs: moving data between steps](#outputs-moving-data-between-steps)
- [Order, conditions and branching](#order-conditions-and-branching)
- [Assertions](#assertions)
- [Retry, polling and timeouts](#retry-polling-and-timeouts)
- [Scripts](#scripts)
- [Datasets: running a flow per row](#datasets-running-a-flow-per-row)
- [Sub-flows and library flows](#sub-flows-and-library-flows)
- [Running a flow](#running-a-flow)
- [Validating a flow](#validating-a-flow)
- [Reference tables](#reference-tables)

---

## Where flow files live

A flow lives in a `flows/` directory in one of two places:

| Location | Scope | Use it for |
|---|---|---|
| `<workspace>/flows/` | The workspace | Journeys spanning several services or collections |
| `<collection>/flows/` | One collection | Journeys belonging to a single API |

Subdirectories are fine: `flows/checkout/happy-path.flow.yml` works, and the folder structure is
yours to organize.

**A flow's identity is its path**, with `.flow.yml` removed —
`flows/shared/login.flow.yml` is `flows/shared/login`. There is deliberately no `id:` field: a
second source of identity can disagree with the filename, and everything that names a flow (the
sidebar, the CLI, run history) already names it by path. Renaming the file is just a rename.

Flows appear in the sidebar as soon as they exist on disk — nothing has to be imported or opened
first.

---

## A first flow

The smallest useful flow: bind an OpenAPI document, call two operations, carry a value between
them, and assert the result.

```yaml
version: 1

meta:
  name: Checkout happy path
  description: Creates a payment and confirms it appears in the ledger.

apis:
  payments-api: ../../apispec/payments-v3.yml

steps:
  - id: create_payment
    operation: payments-api#createPayment
    body:
      amount: 9900
      currency: USD
    outputs:
      paymentId: data.id
    assert:
      - res.status eq 201

  - id: read_payment
    operation: payments-api#getPayment
    pathParams:
      paymentId: "{{steps.create_payment.paymentId}}"
    assert:
      - res.body.data.state eq settled
```

Three things are happening implicitly, and they are the three rules worth internalizing early:

1. **`read_payment` runs after `create_payment`** because a step with no `depends:` depends on the
   step directly above it. A plain list is a plain sequence.
2. **The request is built from the OpenAPI operation**, not from scratch. The method, path, URL and
   any schema-derived defaults come from `createPayment`; your `body:` is an override layered on top.
3. **`outputs:` is what makes data flow visible.** `paymentId: data.id` reads `data.id` out of the
   response body and publishes it under a name the next step can reference — and the app draws it as
   an arrow between the two nodes.

---

## Documenting a flow

Where prose goes, and what each field is actually used for today:

| Where | Field | Purpose | Used by |
|---|---|---|---|
| Flow | `meta.name` | Human title | The graph title and `FlowDescription.name`; falls back to the filename |
| Flow | `meta.description` | What the flow does and why | **Recorded, not yet surfaced** — for the reader of the file |
| Flow | `meta.tags` | Labels for grouping | **Recorded, not yet surfaced** — `--tags` filtering is specified (001 §14.1) but not implemented |
| Step | `name` | Human label for one step | Shown on the graph node beside the id |
| Anywhere | `# comment` | Everything else | Nothing reads them; they survive in the file |

```yaml
meta:
  name: Checkout happy path
  description: |
    Creates a payment, settles it, and verifies the ledger entry.

    Runs against the sandbox tenant. `SANDBOX_TOKEN` must be set in the
    environment, and the fixture in ./fixtures/ is shared with the refund flow.
  tags: [checkout, smoke]

steps:
  - id: create_payment
    name: Create a pending payment      # shown on the node
```

**There is no per-step `description:` field.** A step has `name` for the label and YAML comments for
anything longer:

```yaml
  - id: settle_payment
    name: Settle the payment
    # The sandbox settles asynchronously, so this polls rather than assuming
    # the first response is final. 30 attempts at 2s covers the worst case
    # we have seen (~40s) with room to spare.
    operation: payments-api#settlePayment
```

> **Unknown keys are silently ignored.** The document schema (001 §5.4) is not implemented yet, so
> `descriptoin:` — or a step-level `description:`, or any other key the engine does not know —
> parses fine and does nothing. Nothing warns you. Until the schema lands, treat a field that
> appears to have no effect as probably misspelled, and check it against the tables below.

---

## The document

Every top-level key, with its default. Only `version` and `steps` are needed to run anything.

```yaml
version: 1                     # required

meta:
  name: Checkout happy path
  description: Creates a payment and settles it.
  tags: [checkout, smoke]
  library: false               # true = a reusable sub-flow, excluded from glob runs

apis:                          # alias -> OpenAPI document (path or URL)
  payments-api: ../../apispec/payments-v3.yml
  ledger-api:
    source: ../../apispec/ledger-v1.yml
    baseUrl: "{{ledgerBaseUrl}}"       # overrides config.baseUrl for this API
    auth: service-account              # default auth profile for steps using this API
    defaultHeaders:                    # merged into every request to this API
      X-Tenant: "{{tenantId}}"
    defaultQuery:
      version: "2024-01"

config:
  baseUrl: "{{apiBaseUrl}}"    # default: the OpenAPI document's servers[0]
  failOnStatusCode: true       # status >= 400 fails the step
  failOnUnresolved: true       # an unresolved-dependency skip fails the run
  validateRequest: true        # check the body against the schema before sending
  validateSchema: true         # check the response against the schema
  strictSchema: false          # an undocumented status code fails the step
  concurrency: 5               # max steps in flight at once
  maxRunDuration: 900000       # ms for the whole run; unset = no limit
  cleanupGrace: 30000          # ms allowed for cleanup steps after a cancel
  retry:                       # flow-wide retry defaults; a step's own retry: overrides
    maxAttempts: 3
    delay: 1000
  redactHeaders: [X-Legacy-Key]   # masked in logs and captures, on top of the built-in list
  captureRetainRuns: 10           # run directories kept before the oldest are pruned

authProfiles:                  # named auth configs, referenced by steps and api bindings
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

vars:                          # flow-scoped values, referenced bare: {{currency}}
  currency: USD
  testEmail: "qa+{{$randomUUID}}@example.com"
  catalog: !file ./fixtures/catalog.json

shared: [chargeId]             # slots that any branch can write and any branch can read

dataset: ./fixtures/customers.csv   # run the whole flow once per row

params:                        # library flows only — see Sub-flows
  tenantId:
    required: true
exports:                       # library flows only
  token: steps.sign_in.token

steps:
  - id: ...
```

`config.capturePreviewBytes` appears in the spec but is not read by anything yet.

### `apis:` — binding OpenAPI documents

Every request comes from an operation in an OpenAPI document, so a flow that sends anything binds at
least one:

```yaml
apis:
  payments-api: ../../apispec/payments-v3.yml     # short form: just the source
  ledger-api:
    source: https://api.example.com/openapi.json  # or a URL
    baseUrl: https://sandbox.example.com
```

Paths are relative to the flow file. A step then names an operation as `alias#operationId`:

```yaml
    operation: payments-api#createPayment
```

**The base URL is resolved first-match-wins**: the binding's `baseUrl`, then `config.baseUrl`, then
the document's own `servers[0]`.

### `authProfiles:` — naming credentials once

Profiles are written flat and referenced by name. `mode` selects the scheme; the remaining fields
belong to that scheme:

```yaml
authProfiles:
  none:
    mode: none
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"
  service-account:
    mode: oauth2
    grantType: client_credentials
    clientId: "{{clientId}}"
    clientSecret: "{{clientSecret}}"
```

A step picks a profile first-match-wins: the step's `auth:`, then the API binding's `auth:`, then no
authentication. `auth: none` opts a single step out. Profile fields are interpolated when the step
runs, so `token: "{{steps.sign_in.token}}"` picks up a token an earlier step produced.

> 001 §6.4 describes an implicit `collection` profile, letting a collection-scoped flow inherit the
> collection's own configured auth. **No host supplies it yet** — `auth: collection` fails validation
> with `unknown-auth-profile` unless you declare a profile of that name yourself. Write the
> credentials as a profile for now.

### `vars:` — flow-scoped values

Evaluated **once**, before any step runs, which is what makes a generated value stable across the
whole flow:

```yaml
vars:
  currency: USD
  testEmail: "qa+{{$randomUUID}}@example.com"   # one address, used by every step
  catalog: !file ./fixtures/catalog.json        # parsed JSON/YAML from disk
```

They are referenced **bare** — `{{currency}}`, not `{{vars.currency}}` — and sit in the same scope
chain as Bruno's environment variables, which they shadow.

---

## A step

```yaml
steps:
  - id: create_payment                       # required; unique; letters, digits, _ (no - or .)
    name: Create a pending payment           # optional label
    operation: payments-api#createPayment    # required — or `uses:` for a sub-flow, never both
    auth: user-token                         # optional; an authProfiles name, or `none`

    depends: [sign_in]                       # optional; default is "the step above"
    when: steps.sign_in.status eq 200        # optional; skip this step unless true

    body:                                    # inline overrides — or `bodyFile:`, never both
      amount: 9900
      currency: "{{currency}}"
      legacy_field: !...                     # drop a key the spec seeded
    query:
      expand: customer
    headers:
      Idempotency-Key: "{{flow.runId}}"
    pathParams:
      tenantId: "{{tenantId}}"
    contentType: application/json            # only when the operation declares more than one

    outputs:                                 # publish values for later steps
      paymentId: data.id
      state: data.state

    shared:                                  # publish an output into a slot
      chargeId: paymentId

    assert:
      - res.status eq 201
      - res.body.data.amount eq 9900

    retry:
      maxAttempts: 5
      delay: 2000
      backoff: exponential
      shouldRetry: |
        (res, attempt, ctx) => res.status === 429

    failOnStatusCode: true                   # these five override the config: values
    failOnUnresolved: true
    validateRequest: true
    validateSchema: true
    strictSchema: false
    timeout: 30000                           # ms per attempt
    maxDuration: 120000                      # ms for the step including all retries
```

**Step ids must be valid identifiers** — a letter or underscore, then letters, digits and
underscores. `create-payment`, `create.payment` and `2nd_call` are all rejected, because ids are read
in expressions where `-` and `.` mean something else. The validator suggests the underscored form.

---

## Values and interpolation

`{{...}}` resolves in two ways depending on what the first segment is.

**Bare names** read the variable chain — flow `vars:`, then the environment, collection and global
variables the host supplies:

```yaml
      currency: "{{currency}}"
      token: "{{SANDBOX_TOKEN}}"
```

**Namespaced names** read state the run produces. These names are reserved; a variable with one of
these names is shadowed by the namespace:

| Namespace | Holds |
|---|---|
| `steps.<id>.*` | Another step's declared outputs and built-in metadata |
| `shared.<slot>` | A slot's value (see [Slots](#slots-when-branches-must-share-a-value)) |
| `params.<name>` | A library flow's parameters |
| `row.<column>` | The current dataset row |
| `flow.runId`, `flow.name`, `flow.iteration` | The run itself |
| `process.env.<NAME>` | Process environment, when the host supplies it |
| `res.*` | The response — **in `assert:` and `shouldRetry:` only** |

Two behaviours are worth knowing precisely:

**A whole-value reference keeps its type.** A scalar that is exactly one `{{...}}` resolves to the
referenced value itself, so numbers stay numbers and objects stay objects:

```yaml
      item_count: "{{steps.cart.count}}"     # the number 12, not the string "12"
      customer: "{{steps.lookup.customer}}"  # the whole object
      label: "order {{steps.cart.id}}"       # embedded: always a string
```

**A `{{steps.*}}` reference that was never produced skips the step** with reason
`unresolved-dependency` rather than sending a request with a hole in it. A missing `{{shared.*}}`
slot resolves to empty instead — a declared slot nobody wrote is a known-empty value, not a mistake.

**A step may only reference a step it depends on**, directly or transitively. Reading a step that
runs in a parallel branch is a validation error (`non-ancestor-reference`), not a race you find out
about later — if two branches might each produce the value, that is what a [slot](#slots-when-branches-must-share-a-value)
is for. And `vars:` may reference no step at all: nothing has run when they are evaluated
(`invalid-var-reference`).

### Generated values

`{{$name}}` calls Bruno's mock-data functions — `{{$randomUUID}}`, `{{$randomEmail}}`, and the rest
of the set available elsewhere in Bruno. In `vars:` they are generated once; used directly in a step
they are generated per use.

### `!file` — load a value from disk

```yaml
vars:
  catalog: !file ./fixtures/catalog.json     # parsed, so {{catalog.items}} works

steps:
  - id: upload
    body:
      scan: !file ./fixtures/scan.pdf        # a file part in a multipart body
      invoice: !file
        path: ./fixtures/invoice.pdf
        filename: invoice-2026.pdf           # multipart only
        contentType: application/pdf         # multipart only
```

Paths are relative to the flow file and confined to the scope root — a flow cannot read outside its
workspace or collection.

### `!...` — drop a key

The engine seeds a request body from the operation's schema, so a key you never wrote can still be
present. `!...` removes one:

```yaml
    body:
      legacy_field: !...       # send the request without this key at all
      nullable_field: null     # send it as a literal JSON null
```

`null` and `!...` are different: `null` sends `null`, `!...` sends nothing.

---

## Request bodies

**You do not write the whole body.** The engine builds it from the operation's request schema and
layers your `body:` on top, key by key — so a step usually declares only what it changes. Arrays are
replaced wholesale rather than merged element-by-element.

The body kind follows the operation's media type:

| Operation declares | You write | Sent as |
|---|---|---|
| `application/json` (or any `*+json`) | a mapping | JSON |
| `application/x-www-form-urlencoded` | a mapping | form fields |
| `multipart/form-data` | a mapping; `!file` values become file parts | multipart |
| anything else (`text/plain`, `application/xml`, …) | a scalar | the raw value |
| a binary payload | `body: !file ./x.pdf` or `bodyFile: ./x.pdf` | raw bytes |

```yaml
    # multipart: each key is a part, !file makes it an upload
    body:
      scan: !file ./fixtures/scan.pdf
      metadata:                            # an object part is sent as JSON
        pages: 3
```

`bodyFile:` is the same idea as `body:` but read from disk — useful for a large fixture:

```yaml
    bodyFile: ./fixtures/large-order.json   # merged and interpolated like an inline body
```

A step declares `body:` **or** `bodyFile:`, never both. When the operation declares more than one
request media type, set `contentType:` to choose; otherwise the single declared type is used.

---

## Outputs: moving data between steps

`outputs:` declares what a step contributes. Three forms:

```yaml
    outputs:
      paymentId: data.id                    # short form: a path into the response body
      state:
        from: body                          # body (default) | headers | status
        path: data.state
      location:
        from: headers
        path: location
      code:
        from: status                        # the status code itself; no path
      total:
        script: |                           # compute it, when a path will not do
          (res) => res.body.data.items.reduce((sum, item) => sum + item.amount, 0)
```

> **Every `script:` is a function expression, not a bare expression.** The engine calls what you
> write — `(${your script})(...args)` — so `res.body.total` on its own throws, and
> `(res) => res.body.total` works. See [Scripts](#scripts) for the arguments each one receives.

A leading `$.` is accepted and stripped, so `$.data.id` and `data.id` are the same path.

Another step then reads it by name:

```yaml
      paymentId: "{{steps.create_payment.paymentId}}"
```

**Alongside declared outputs, every step publishes built-in metadata** under the same id:

| Reference | Value |
|---|---|
| `steps.<id>.status` | The HTTP status code |
| `steps.<id>.ok` | `true` when the step succeeded |
| `steps.<id>.skipped` | `true` when the step was skipped |
| `steps.<id>.duration` | Milliseconds the step took |

### Declared outputs, not raw response access

001 §8.3 describes `steps.<id>.body.…` and `steps.<id>.headers.…` as a permitted escape hatch —
warned about by the validator, drawn as a dashed edge in the graph, but usable.

> **That escape hatch is not implemented at run time.** A step publishes its declared outputs and
> the four built-ins above, and nothing else. `{{steps.create.body.data.id}}` resolves to nothing,
> so the step reading it is **skipped with `unresolved-dependency`** — the validator warns, the graph
> draws the edge, and then the run does not do it. Declare an output instead:
>
> ```yaml
>   - id: create
>     outputs:
>       thingId: data.id            # then use {{steps.create.thingId}}
> ```

Declaring outputs is the intended style regardless: they are what the graph draws as data edges, and
what the step-detail pane shows with their values after a run.

---

## Order, conditions and branching

### The implicit sequence

A step with no `depends:` depends on **the step immediately above it in the file**. A plain list is a
plain sequence, and an author who never writes `depends:` never has to think about the graph. The app
draws these edges in a muted style, because they are not in the file.

### `depends:` — explicit order

```yaml
    depends: [sign_in]                    # after sign_in succeeds
```

A list means *all of them*, so this waits for both:

```yaml
    depends: [sign_in, load_catalog]
```

The long forms, when you need `any`:

```yaml
    depends:
      all: [sign_in, load_catalog]        # every one of them
```

```yaml
    depends:
      any: [card_path, wallet_path]       # whichever finishes first
```

By default a dependency must have **succeeded**. To depend on another outcome — a fallback branch,
say — name the statuses:

```yaml
    depends:
      - on: charge_card
        status: [failed]                  # runs only when charge_card failed
```

Valid statuses are `success`, `failed`, `skipped`, `cancelled`. A step whose dependencies did not
reach the required status is skipped with `unmet-dependency`, which is not a failure.

Declaring `depends:` explicitly on a step also means it **no longer** waits for the step above it —
the two are alternatives, not additions.

### `when:` — conditions

One condition, several conditions, or a script — three forms of the same field:

```yaml
    when: steps.sign_in.status eq 200
```

```yaml
    when:
      - steps.sign_in.ok
      - "{{tier}} eq premium"
```

```yaml
    when:
      script: |
        (ctx) => ctx.params.region === 'eu' && !ctx.steps.lookup.skipped
```

Several conditions are ANDed. A step whose condition is false is skipped with `condition-false` —
again not a failure. Conditions use the same operator vocabulary as assertions.

### Slots: when branches must share a value

Two branches that might each produce a value cannot reference each other — only one of them runs. A
slot is a named place either can write and anyone can read:

```yaml
shared: [chargeId]                    # declare the slot

steps:
  - id: charge_card
    outputs:
      chargeId: data.id
    shared:
      chargeId: chargeId              # slot: output

  - id: charge_wallet
    outputs:
      walletChargeId: data.id
    shared:
      chargeId: walletChargeId

  - id: receipt
    depends:
      any: [charge_card, charge_wallet]
    body:
      charge: "{{shared.chargeId}}"   # whichever branch ran
```

`shared: [chargeId]` on a step is shorthand for `chargeId: chargeId`. Reading a slot no `shared:`
block declares is a validation error; reading a declared slot nobody wrote resolves empty.

---

## Assertions

`assert:` entries are `<expression> <operator> <value>`:

```yaml
    assert:
      - res.status eq 201
      - res.body.data.amount eq 9900
      - res.body.data.items length 3
      - res.body.data.state in [pending, settled]
      - res.headers.location matches ^/payments/
      - res.body.data.note isEmpty
      - steps.sign_in.ok                    # no operator: isTruthy
```

The operator is the first token that is a known operator name, so expressions and values may contain
spaces. The long form is available when a value would be ambiguous:

```yaml
    assert:
      - expr: res.body.data.label
        op: eq
        value: "gift card"
```

Operands starting with a reserved namespace (`res`, `steps`, `shared`, `params`, `row`, `flow`,
`process`, `req`) are read directly; anything else is treated as a literal, and `{{...}}` works in
any operand position.

A failing assertion fails the step with reason `assertion-failed`. Every assertion is evaluated —
you get all the failures, not just the first.

**Full operator list:**

`eq` · `neq` · `==` · `!=` · `gt` · `gte` · `lt` · `lte` · `in` · `notIn` · `contains` ·
`notContains` · `length` · `matches` · `notMatches` · `startsWith` · `endsWith` · `between` ·
`isEmpty` · `isNotEmpty` · `isNull` · `isUndefined` · `isDefined` · `isTruthy` · `isFalsy` ·
`isJson` · `isNumber` · `isString` · `isBoolean` · `isArray`

---

## Retry, polling and timeouts

Retry is evaluated **after** the status check, schema validation and assertions — so the predicate
sees the step's whole outcome, which is what makes polling a first-class pattern:

```yaml
    retry:
      maxAttempts: 10          # total attempts including the first; default 1
      delay: 2000              # ms before each retry; default 0
      backoff: exponential     # fixed (default) | exponential
      maxDelay: 30000          # ms cap on one wait; default 30000
      jitter: none             # none (default) | full
      shouldRetry: |
        (res, attempt, ctx) => res.body.state === 'pending'
```

**Without `shouldRetry`, retry fires only on a transport error or a 5xx** — never on a failed
assertion or a schema mismatch, which mean the server answered and the answer was wrong. That is what
makes a flow-wide `config.retry` safe to set even when some steps are not idempotent.

`delay` is the wait *before* each retry, so `maxAttempts: n` waits `n - 1` times. With
`backoff: exponential` each wait doubles, capped by `maxDelay`.

Put flow-wide defaults in `config.retry:`; a step's own `retry:` overrides them field by field.

Two separate bounds on time:

```yaml
    timeout: 30000        # ms for one attempt
    maxDuration: 120000   # ms for the step including every retry and the waits between
```

And `config.maxRunDuration` bounds the whole run, iterations included.

---

## Scripts

Three fields take JavaScript, and all three take a **function expression** — the engine calls what
you write, so a bare expression throws:

| Field | Signature | Returns |
|---|---|---|
| `outputs.<name>.script` | `(res, ctx) => …` | The output's value |
| `when.script` | `(ctx) => …` | Truthy to run the step |
| `retry.shouldRetry` | `(res, attempt, ctx) => …` | Truthy to retry |

`res` is the response, as:

```js
{ status, statusText, headers, body, responseTime }
```

In `shouldRetry` it is `undefined` when the attempt got no response at all (a transport error), so
guard it: `(res) => !res || res.status >= 500`.

`ctx` is everything an expression can see, flattened — variables plus the namespaces (`steps`,
`shared`, `params`, `row`, `flow`, `process`) and `res`. In `shouldRetry` it also carries
`ctx.failures`, the assertions that failed on this attempt.

Scripts run in Bruno's sandbox, the same one request scripts use. A script that throws fails the step
with reason `script-error`; the remaining outputs are still extracted, because diagnosing the throw
needs the response it threw on.

## Datasets: running a flow per row

```yaml
dataset: ./fixtures/customers.csv
```

Or with parallelism:

```yaml
dataset:
  source: ./fixtures/customers.csv
  parallel: 3          # iterations in flight at once; default 1
```

`.csv`, `.json` and `.yml` / `.yaml` are supported. Each row becomes one **iteration** of the whole
flow, with the row's columns under `row.`:

```yaml
    body:
      email: "{{row.email}}"
      tier: "{{row.tier}}"
```

Iterations are independent: state does not carry between them, and each gets its own captures.

---

## Sub-flows and library flows

A **library flow** is a flow meant to be called by others. It declares its inputs and outputs and
marks itself so glob runs skip it:

```yaml
# flows/shared/sign-in.flow.yml
version: 1

meta:
  name: Sign in
  library: true

params:
  email:
    required: true
  password:
    required: false
    default: "{{DEFAULT_PASSWORD}}"

exports:
  token: steps.authenticate.accessToken     # a full reference, not <step>.<output>

steps:
  - id: authenticate
    operation: auth-api#login
    body:
      email: "{{params.email}}"
      password: "{{params.password}}"
    outputs:
      accessToken: data.token
```

A caller invokes it with `uses:` and `with:`, and reads its exports like any other step's outputs:

```yaml
steps:
  - id: sign_in
    uses: ./shared/sign-in.flow.yml
    with:
      email: "{{testEmail}}"

  - id: create_payment
    operation: payments-api#createPayment
    auth: user-token                       # a profile using {{steps.sign_in.token}}
```

A step declares `operation:` or `uses:`, never both. Passing a param the sub-flow does not declare,
or omitting a required one, is a validation error. Recursion is refused.

In the app a library flow is marked `library` in the sidebar, and running one directly requires
supplying its parameters.

---

## Running a flow

In the app, open it from the **API Flows** sidebar section and use the run control; the graph shows
each step's progress, and selecting a node opens its request, response, assertions and validation.

On the command line:

```bash
bru flow run flows/checkout.flow.yml       # one flow
bru flow run flows/                        # every flow in a directory
```

The options you are most likely to want:

| Option | Does |
|---|---|
| `--env-var name=value` | Override one variable (repeatable) |
| `--param name=value` | Supply a library flow's declared param (repeatable) |
| `--concurrency n` | Override `config.concurrency` |
| `--max-run-duration ms` | Bound the whole run; elapsing cancels it and exits 4 |
| `--bail` | Stop after the first failing flow |
| `--no-capture` | Do not write `.bruno-runs/` artifacts |
| `--capture-dir path` | Write captures somewhere other than `<scope>/.bruno-runs` |
| `--verbose` / `--quiet` / `--silent` | How much the reporter prints |

Each run writes a directory under `.bruno-runs/` holding the flow as it was, every request and
response, and the outcome — which is what the app's run selector reads back later.

## Validating a flow

```bash
bru flow validate flows/checkout.flow.yml
bru flow validate flows/                   # a whole directory
```

The app runs the same check whenever a flow is opened or changes on disk, and shows the results
above the graph — errors and warnings anchored to the line that caused them. A flow with errors
still opens; that is when you most want to look at it.

What it reports:

| Code | Meaning |
|---|---|
| `parse-error` | The YAML did not parse. Nothing else is checked — the file could mean anything |
| `invalid-step-id` | An id that is not a valid identifier; the message suggests the underscored form |
| `unknown-dependency` | `depends:` names a step that does not exist |
| `cyclic-dependency` | Steps depend on each other in a cycle, or a sub-flow invokes itself |
| `body-and-body-file` | A step declares both `body:` and `bodyFile:` |
| `operation-and-uses` | A step declares both `operation:` and `uses:` |
| `unresolved-alias` | An `apis:` document could not be loaded, or a step names an alias nothing binds |
| `unknown-operation` | The operation id is not in the bound document |
| `unknown-step-reference` | `{{steps.x…}}` names a step that does not exist |
| `non-ancestor-reference` | `{{steps.x…}}` names a step this one does not depend on — use a slot |
| `invalid-var-reference` | A `vars:` entry references a step; nothing has run when `vars:` are evaluated |
| `undeclared-slot` | `{{shared.x}}` reads a slot no `shared:` block declares |
| `unknown-auth-profile` | `auth:` names a profile that is not declared |
| `unknown-param` / `missing-param` | `with:` passes a param the sub-flow does not declare, or omits a required one |
| `undeclared-dependency` *(warning)* | A step reads `steps.x.body…` rather than a declared output — see [the note above](#declared-outputs-not-raw-response-access) |

---

## Reference tables

### Defaults

| Setting | Default | Scope |
|---|---|---|
| `failOnStatusCode` | `true` | config, overridable per step |
| `failOnUnresolved` | `true` | config, overridable per step |
| `validateRequest` | `true` | config, overridable per step |
| `validateSchema` | `true` | config, overridable per step |
| `strictSchema` | `false` | config, overridable per step |
| `concurrency` | `5` | config |
| `cleanupGrace` | `30000` ms | config |
| `captureRetainRuns` | `10` | config |
| `maxRunDuration` | unset | config |
| `retry.maxAttempts` | `1` | config or step |
| `retry.delay` | `0` ms | config or step |
| `retry.backoff` | `fixed` | config or step |
| `retry.maxDelay` | `30000` ms | config or step |
| `retry.jitter` | `none` | config or step |
| `dataset.parallel` | `1` | flow |
| `meta.library` | `false` | flow |
| `depends` | the step above | step |

### Skip and failure reasons

A step that does not run reports why. These are the ones you will see on a graph node:

| Reason | Means | A failure? |
|---|---|---|
| `condition-false` | `when:` was false | No |
| `unmet-dependency` | A dependency did not reach the required status | No |
| `run-cancelled` | The run was cancelled before this step ran | No |
| `unresolved-dependency` | A `{{steps.*}}` reference was never produced | Yes, unless `failOnUnresolved: false` |
| `assertion-failed` | An `assert:` entry failed | Yes |
| `unexpected-status` | Status >= 400 with `failOnStatusCode` | Yes |
| `invalid-request` | The body failed `validateRequest` — nothing was sent | Yes |
| `schema-validation-failed` | The response did not match the schema | Yes |
| `transport-error` | The request never got a response | Yes |
| `max-duration-exceeded` | `timeout:`, `maxDuration:` or `config.maxRunDuration` elapsed | Yes |
| `retries-exhausted` | The last attempt still failed | Yes |
| `file-read-failed` | A `!file` / `bodyFile:` path could not be read, or resolves outside the scope | Yes |
| `script-error` | An `outputs: script:`, `when: script:` or `shouldRetry:` threw | Yes |
| `subflow-failed` | A `uses:` sub-flow failed | Yes |

### What is specified but not built yet

So you do not write a flow that depends on it:

- **Raw `steps.<id>.body` / `.headers` access** — validated and drawn, but does not resolve at run
  time. Declare an output.
- **The document schema** — unknown and misspelled keys are silently ignored.
- **`--tags` filtering** — `meta.tags` is parsed and stored, and nothing reads it.
- **`meta.description`** — recorded, not yet displayed anywhere.
- **`config.capturePreviewBytes`** — parsed, unread.
- **The implicit `collection` auth profile** (001 §6.4) — no host supplies it; declare your own.
- **Cookie-jar scoping** (001 §7.6) and the provenance half of secret redaction (§14.4). Header-name
  redaction *is* in place, including `config.redactHeaders`.
