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
- [Values computed before the request](#values-computed-before-the-request)
- [Request bodies](#request-bodies)
- [Outputs: moving data between steps](#outputs-moving-data-between-steps)
- [Order, conditions and branching](#order-conditions-and-branching)
- [Assertions](#assertions)
- [Retry, polling and timeouts](#retry-polling-and-timeouts)
- [Scripts](#scripts)
- [Datasets: running a flow per row](#datasets-running-a-flow-per-row)
- [Sub-flows and library flows](#sub-flows-and-library-flows)
- [Editing a flow in the app](#editing-a-flow-in-the-app)
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
| Flow | `meta.description` | What the flow does and why | The app's [flow properties dialog](#flow-properties), and the reader of the file |
| Flow | `meta.testId` | A test-management case id for the flow as a whole | Carried into reports as `test_id` (see [Reports](#reports)) |
| Flow | `meta.tags` | Labels for grouping | `--grep` and the app's flow search select on them (see [Picking flows with a pattern](#picking-flows-with-a-pattern)); the properties dialog edits them. There is no separate `--tags` flag — a pattern reads tags among everything else, and `--grep '^smoke$'` is the exact-match form |
| Step | `name` | Human label for one step | Shown on the graph node beside the id |
| Anywhere | `# comment` | Everything else | Nothing reads them; they survive in the file |

```yaml
meta:
  name: Checkout happy path
  description: |
    Creates a payment, settles it, and verifies the ledger entry.

    Runs against the sandbox tenant. `SANDBOX_TOKEN` must be set in the
    environment, and the fixture in ./fixtures/ is shared with the refund flow.
  testId: C1000                        # this flow's own case id — see Reports
  tags: [checkout, smoke]

steps:
  - id: create_payment
    name: Create a pending payment      # shown on the node
```

`meta.testId` is a case id for the flow as a whole, distinct from a step's own `testId` under
[`meta:`](#a-step) — the flow's shows up as `test_id` on a flow-level report, a step's on the step's
own testcase (see [Reports](#reports) for both).

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

authProfiles:                  # named auth configs, referenced by steps and api bindings
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

functions:                     # helpers every script: position can call — see Scripts
  use: [./scripts/text.js]
  lastFour: |
    (value) => String(value).slice(-4)

vars:                          # flow-scoped values, referenced bare: {{currency}}
  currency: USD
  testEmail: "qa+{{$randomUUID}}@example.com"
  catalog: !file ./fixtures/catalog.json

shared: [chargeId]             # slots that any branch can write and any branch can read

dataset: ./fixtures/customers.csv   # run the whole flow once per row

stages:                        # names for regions of the graph — presentation only
  setup: sign_in               # a stage name -> the step it begins at
  test: create_payment
  teardown: refund

params:                        # library flows only — see Sub-flows
  tenantId:
    required: true
exports:                       # library flows only
  token: steps.sign_in.token

steps:
  - id: ...
```

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

### `stages:` — naming regions of the graph

A graph of fifteen steps is read in parts — what is being set up, what is under test, what is being
cleaned up — and nothing in `steps:` says where one part ends. `stages:` draws those lines:

```yaml
stages:
  setup: sign_in                # everything from sign_in up to create_payment
  test: create_payment          # …up to refund
  teardown: refund              # …to the end
```

**A stage names the step it *begins* at, not the steps it contains.** It covers the run of `steps:`
from there to the next stage's step, and anything before the first boundary belongs to no stage. That
is the whole point of the shape: adding, removing or reordering steps *inside* a stage is not an edit
to `stages:`, so the two halves of the file cannot quietly disagree. Mapping order is the order the
regions appear in.

**It changes nothing about what the flow does.** No schedule, no status, no capture — a stage
boundary is not a barrier, and the first step of a stage still depends on the step above it unless
its `depends:` says otherwise. Deleting the block leaves an identical run. It lives in the file
rather than in the app's settings because where a flow's setup ends is a fact about *this flow* that
a teammate opening it should see too.

**A boundary the schedule contradicts is dropped, and `bru flow validate` says so.** A rule is drawn
before its first step's column, which needs everything above the boundary to actually run before it —
so a cleanup step that depends on an early step runs early, shares that column, and no line can pass
between them. The rule is suppressed rather than the graph rearranging itself to look tidy, and you
get a warning: `unknown-stage-step` when the named step is not a step of this flow (a step inside a
`uses:` sub-flow is not addressable from here), `stage-boundary-order` when a boundary does not come
after the one before it, and `stage-out-of-order` for the schedule case above. Warnings, not errors —
they decide how a graph is drawn and never what a flow does.

---

## A step

```yaml
steps:
  - id: create_payment                       # required; unique; letters, digits, _ (no - or .)
    name: Create a pending payment           # optional label
    meta:                                    # optional; free-form, carried into reports unchanged
      testId: C1234                          #   TestRail-style case id — emitted as JUnit's `test_id`
      owner: payments-team                   #   any other key just rides along as its own property
    operation: payments-api#createPayment    # required — or `uses:` for a sub-flow, never both
    auth: user-token                         # optional; an authProfiles name, or `none`

    depends: [sign_in]                       # optional; default is "the step above"
    when: steps.sign_in.status eq 200        # optional; skip this step unless true

    pre:                                     # values computed before the request is built
      requestedAt: |
        () => new Date().toISOString()

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

**`meta:` is free-form** — put whatever a reporter or a dashboard should know about this step under
it, and it rides into every report unchanged, key for key. `testId` is the one key a built-in
reporter treats specially: it is what the JUnit report (see [Reports](#reports)) emits as the
testcase property `test_id`, which is the property TestRail's importer reads. Any other key you add
— `owner`, a ticket link, whatever your team wants — becomes its own property alongside it.

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
| `pre.<name>` | A value **this** step computed before its request (see [below](#values-computed-before-the-request)) |
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

## Values computed before the request

Some values a request needs cannot be written down — a signature over the payload, a timestamp, a
nonce. `pre:` is a step-level mapping of name to script, evaluated **before the request is built**,
so the step can carry such a value without a throwaway step that sends a request nobody wanted just
to run three lines of JavaScript:

```yaml
functions:
  use:
    - ./scripts/signing.js                   # declares sign()

vars:
  webhookSecret: "{{PARTNER_SECRET}}"

steps:
  - id: create_order
    operation: payments-api#createOrder
    outputs:
      orderId: data.id

  - id: charge
    operation: payments-api#createPayment
    pre:
      requestedAt: |
        () => new Date().toISOString()
      signature: |
        (ctx) => sign(ctx.webhookSecret, ctx.steps.create_order.orderId)
    headers:
      X-Timestamp: "{{pre.requestedAt}}"
      X-Signature: "{{pre.signature}}"
    body:
      amount: 9900
```

**It is `outputs:` one stage earlier.** The same mapping shape, the same one-value-per-name rule, and
the same rule that a script returning `undefined` simply did not produce its value. What it does not
have is `path:` — there is no response to select from, which is the whole reason the position exists.

The script signature is `(ctx)` and there is **no `res`**, exactly as in a `when:` script and for the
same reason: nothing has been sent. `functions:` helpers are in scope unchanged.

**A `pre:` script cannot read a sibling `pre` value**, whatever the order they are written in. The
`ctx` all of them are handed is built once, before the first one runs, and its `pre` is empty — so
`ctx.pre.nonce` in the second entry is `undefined` even though the first entry produced a nonce. It
fails silently at run time: the signature is computed over nothing and the request goes out wrong
with no error anywhere. `bru flow validate` is what catches it, warning on any `pre:` script that
mentions `ctx.pre` — `pre-reads-sibling-value`.

Compute both halves in one entry — returning an object is fine, `{{pre.name.field}}` reads into it —
or lift the shared part into a `functions:` helper both entries call:

```yaml
    pre:
      signed: |
        (ctx) => {
          const nonce = crypto.randomUUID();
          return { nonce, signature: sign(ctx.webhookSecret, nonce) };
        }
    headers:
      X-Nonce: "{{pre.signed.nonce}}"
      X-Signature: "{{pre.signed.signature}}"
```

Declaration order still matters, but only for which entries have run when one of them throws — see
below. It never makes an earlier value visible to a later script.

**`pre.*` is step-local, and that is the point.** No other step can address it. Publishing these
values into `steps.<id>.*` beside the outputs was the obvious alternative and was rejected:
`{{steps.charge.x}}` would then mean either a pre-request computation or a post-response extraction,
with nothing at the call site to say which.

Where it sits in the step's pipeline:

> depends gate → `when:` → `pre:` → materialize the request → validate it → dispatch → `outputs:` →
> `assert:`

Two consequences follow from that order, and both are worth holding.

**`when:` runs first, so a skipped step computes nothing** — and therefore a `when:` condition cannot
read a `pre` value. The condition is the cheaper question and the one that can make the rest
unnecessary.

**`pre:` runs once per step, not once per attempt.** A retried step re-sends the values its first
attempt computed, which for a timestamp or a nonce is wrong. There is no field to change that today;
the honest workaround is `maxAttempts: 1` on a step whose value must be fresh. A dataset run is
unaffected — each iteration executes the step, so each computes its own values.

**A throw stops the remaining `pre:` scripts.** This is the one place it differs from `outputs:`,
where a script that throws still lets its siblings extract: there the response they extract from
exists and is what you need to diagnose the throw, whereas here no request is built at all, so the
siblings' values have nothing to be for. The step fails with `script-error` and the message names the
position — `pre.signature threw: …`.

Nothing is captured. `pre` values are not written to run artifacts, the same as `outputs:`.

A `uses:` sub-flow step may declare `pre:` too, and its values are in scope while the `with:`
arguments resolve. Inside the sub-flow, `pre.*` means that sub-flow's own steps' values and never the
caller's.

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
        from: body                          # body (default) | headers | status | pre
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

### `from: pre` — letting a computed value leave the step

A value from [`pre:`](#values-computed-before-the-request) is step-local, so a later step that needs
it — the correlation id you generated and now want to look up by — takes the same route out of the
step as everything else, an output:

```yaml
    pre:
      correlationId: |
        () => crypto.randomUUID()
    outputs:
      correlationId: { from: pre }                       # same name
      traceId:       { from: pre, path: correlationId }  # under another
    shared: [correlationId]                              # unchanged
```

`path:` names which `pre` value to take and **defaults to the output's own name**, so promoting one
under the name it already has is `{ from: pre }` and nothing else. Naming a value the step does not
compute is a validation error, `unknown-pre-value` — at run time it would extract `undefined` and the
output would simply be missing.

`shared:` does not change at all: it publishes an *output* into a slot, as always. One route out of a
step, one place to read what leaves it.

**A `from: pre` output is extracted where every other output is — after the response.** So a step
whose request never dispatched produces no outputs at all, `from: pre` included, even though the
value itself was computed before the attempt. One rule for when a step has outputs beats a single
value that survives a transport error.

> **The string form is a path, not an interpolation.** `outputs: { x: "{{pre.x}}" }` looks like it
> should work and does not: it is read as a path into the response body, selects nothing, and leaves
> the output unset with no error at run time. This is the mistake the shape invites, so `bru flow
> validate` warns about it — `interpolation-in-output-path`. Write `x: { from: pre }`.

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

Header names are matched in lower case, whatever case the server sent them in — you cannot know
that from the flow file, so `{{steps.create.headers.x-request-id}}` is the form that always works.
A step that declares an output called `body` or `headers` keeps its own: the declaration wins, so
naming an output after a built-in never silently hands you the raw response instead.

Declaring outputs is still the intended style: they are what the graph draws as data edges, what the
step-detail pane shows with their values after a run, and what the validator can check before one.
Raw access is warned about for that reason — `undeclared-dependency`, pointing at the step that
reads it — and the warning is the whole of the cost:

```yaml
  - id: create
    outputs:
      thingId: data.id            # then use {{steps.create.thingId}}
```

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

#### `writers:` — how many writers a reader must sit below

**The default is that a reader descends from *every* writer**, which is the shape above: `receipt`
sits at the join below both branches, so both writers are its ancestors whichever one actually ran.
`shared: [chargeId]` is the list form of that rule, spelled out as `writers: all`.

The other shape is branches that **exclude** each other, where the steps that read a value sit on
the same branch that wrote it. No reader can descend from every writer there, because only one
writer ever runs — so say so:

```yaml
shared:
  sessionToken: { writers: any }    # descend from one writer, not all
  chargeId: { writers: all }        # the default, written out
```

Under `any` a reader must still descend from *a* writer; what it drops is the requirement to
descend from all of them. Reading a slot none of whose writers is upstream is `slot-not-downstream`
either way.

Use `any` only where the writers genuinely exclude each other. It is a promise you are making about
the shape of the flow, not something the validator can check for you — declaring it on writers that
can both run buys a slot whose value depends on which finished last.

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
`pre`, `process`, `req`) are read directly; anything else is treated as a literal, and `{{...}}`
works in any operand position.

A failing assertion fails the step with reason `assertion-failed`. Every assertion is evaluated —
you get all the failures, not just the first.

**A step that opts out of the status check should assert a status.** `failOnStatusCode: false` says
the status is yours to judge, and on its own it accepts *any* status at all — including the 500 the
step did not mean to accept. Pair it with the assertion that says what you actually expect:

```yaml
    failOnStatusCode: false
    assert:
      - res.status in [200, 404]      # 404 is a legitimate answer here; 500 is not
```

The validator warns when the opt-out stands alone — `status-opt-out-without-assertion`.

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

Four fields take JavaScript, and every one of them takes a **function expression** — the engine calls
what you write, so a bare expression throws:

| Field | Signature | Returns |
|---|---|---|
| `outputs.<name>.script` | `(res, ctx) => …` | The output's value |
| `when.script` | `(ctx) => …` | Truthy to run the step |
| `retry.shouldRetry` | `(res, attempt, ctx) => …` | Truthy to retry |
| [`pre.<name>`](#values-computed-before-the-request) | `(ctx) => …` | A value the request can carry |

`res` is the response, as:

```js
{ status, statusText, headers, body, responseTime }
```

In `shouldRetry` it is `undefined` when the attempt got no response at all (a transport error), so
guard it: `(res) => !res || res.status >= 500`.

`ctx` is everything an expression can see, flattened — variables plus the namespaces (`steps`,
`shared`, `params`, `row`, `flow`, `pre`, `process`) and `res`. In `shouldRetry` it also carries
`ctx.failures`, the assertions that failed on this attempt.

`pre:` is handed no `res` for the same reason `when:` is not: it runs before anything is sent.

Scripts run in Bruno's sandbox, the same one request scripts use. A script that throws fails the step
with reason `script-error`; the remaining outputs are still extracted, because diagnosing the throw
needs the response it threw on.

### `functions:` — a shared library

**Anything two scripts need is a function, and `functions:` is where it goes.** It is a top-level
block: `use:` lists library files, and every other key defines a helper — a name, and a function
expression producing it.

```yaml
functions:
  use:
    - ../shared/functions.yml     # a library document: a functions: block of its own
    - ./scripts/text.js           # raw JavaScript: whatever it declares is in scope

  lastFour: |
    (value) => String(value).slice(-4)

steps:
  - id: charge
    operation: payments-api#createPayment
    outputs:
      tail:
        script: |
          (res) => lastFour(res.body.data.card)
    assert:
      - res.status eq 201
```

**It is a prelude, not a module system.** The library's source is composed into the same program the
call site is evaluated in, so a helper is in scope **by its name** and nothing is imported, injected
as an argument, or reached through an object. That is what makes one library usable from every script
position — `outputs.script`, `when.script`, `shouldRetry`, `pre:` — without any of them changing
shape, and it is why a library works identically in the app and under `bru`.

**`use:` is explicit; nothing is picked up by convention.** What a flow's scripts can call is readable
from the flow itself, which is the property that would be lost if a directory could contribute
functions on its own. The app lists raw helpers under
[`flows/scripts/`](#flowsscripts--where-raw-helpers-live), and that convention still changes nothing
about resolution — a script is reached by `use:` and by nothing else.

**The extension decides what an entry is.** `.yml` or `.yaml` is a library document, read for a
`functions:` block of its own — so libraries nest. Any other extension is raw JavaScript, composed as
written, which is how a dozen helpers live in one `.js` file rather than being named one by one in
YAML.

**Order is `use:` first, depth-first, then the flow's own definitions, and the last word on a name
wins** — so a flow overrides a helper the library it uses declares, rather than colliding with it.
Paths resolve **against the file that named them**, not against the flow that included it: a library
including another library is written from where it sits. A file already included is skipped rather
than read again, so two libraries that include each other are a diamond and not a cycle error.

Two things `bru flow validate` reports, both because they would otherwise fail obscurely:

- **A name must be a JavaScript identifier** (`invalid-function-name`). It becomes a declaration, so
  `last-four` composes into a program that does not parse — and a syntax error in the prelude fails
  every script in the flow at once, naming none of them.
- **A helper called `res` or `ctx` shadows what every script is handed**
  (`function-shadows-script-argument`). A warning rather than an error: shadowing is legal and an
  author who means it is not wrong, but nobody means it by accident twice.

**A library does not cross a `uses:` boundary.** A sub-flow declares its own `functions:`, so what
its scripts can call is readable from the sub-flow rather than from whichever flow happened to call
it.

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

### Pointing a flow at different rows

`--dataset` runs a flow over a file other than the one it declares:

```bash
bru flow run flows/signup.flow.yml --dataset rows/eu.csv
```

It also works on a flow that declares **no** `dataset:` at all — a flow written for one row set and
pointed at another by CI is the case the flag exists for. A `parallel:` the flow declares still
applies, since that is a statement about whether the steps can safely overlap rather than about the
rows. The path is read relative to where you typed the command, and — like every other fixture path —
has to stay inside the collection or workspace the flow belongs to.

One `--dataset` covers every flow the command selected, so it is a flag for one flow or for a set
that reads the same columns, not for a directory of unrelated ones.

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
    secret: true                            # keep the value out of the run record

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

A required param with no `default` must be supplied — by a caller's `with:`, by `--param` on the
command line, or in the app's inputs panel. A run started without one is refused before anything is
dispatched, rather than putting the literal `{{params.email}}` on the wire.

`secret: true` marks a param whose *value* must not be written down. Every run records what it was
started with, so the graph can show a past run its own inputs; a secret param is masked in that
record before it is serialized, and is entered in the app as a password field. It is still sent to
the API in full — the flag governs what is reported, not what is requested.

A run also records the entry flow's `vars:` as each iteration resolved them, so reading a past run
shows the value it used rather than the expression that produced it — which is the difference
between `{{$guid}}` and the id the requests actually carried. **Var values are not masked**: unlike a
param there is no way to declare one secret, so a credential put directly in `vars:` is written to
the run record.

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

## Editing a flow in the app

A `.flow.yml` is a file you can edit in anything, and the app never pretends otherwise — but the
**API Flows** sidebar section carries a handful of surfaces for the edits you would otherwise make by
hand and get subtly wrong. Two places to look for them: the `+` on the section header starts a new
flow, and a menu appears on a row when the pointer is on it, carrying `Edit Yaml`, `Flow Properties`
and `Duplicate` for a flow and `Rename` for a script. Fixture rows carry no menu — there is nothing
about a data file the app knows better than you do.

### Creating and duplicating a flow

The header's `+` opens a form rather than writing a blank file, because a blank `.flow.yml` cannot be
written without answering questions the file itself will not prompt you for: where it goes, what it
is called, what it is for, whether it is a library, and which OpenAPI documents it binds. The last is
the one worth having a form for — picking specs from the workspace's loaded documents writes an
`apis:` block with an alias per spec, slugged from the spec's filename rather than its title (a title
is prose, and `Payments API v2 (beta)#createOrder` is not something you want to type in every step),
and each `source:` written relative to the new file's own directory rather than to the workspace.

**The flow's name and its file name are separate fields, and the file name defaults from the name.**
Leave it blank and you get the name in kebab-case, which is right about nine times in ten; the
`.flow.yml` extension is the form's to add. Nothing here offers to add a step — that is the graph and
the [YAML editor](#the-raw-yaml-editor) below, and a form that started inventing steps would be
guessing.

**`Duplicate` on a flow's row is the same form, opened over the flow you picked.** It arrives filled
in from that flow's `meta:`, with `copy` on the end of the name rather than `copy of` in front so the
duplicate sorts next to its original. The spec picker is replaced by a note, because a duplicate
binds whatever its source binds: what gets written is the source file's own text with `meta:`
swapped, so the steps, the comments, the anchors and the `!file` tags all survive and the copy still
diffs cleanly against the original. It refuses to open over an unsaved YAML editor for the reason the
properties dialog does — it reads the file on disk, and duplicating a flow you are ten minutes ahead
of hands you a copy silently missing those ten minutes.

### Flow properties

**Two different things carry a flow's name, and this is where both are changed.** The sidebar lists a
flow by `meta.name`, which is prose; the file it lives in is what a directory listing shows and what
another flow's `uses:` points at. `Properties`, the second item on the row menu, edits the `meta:`
block and the filename together:

| Field | Writes |
|---|---|
| Flow Name | `meta.name` — required, because the sidebar lists the flow by it |
| File Name | the file, renamed in place; the `.flow.yml` extension is the form's, not yours |
| Description | `meta.description` |
| Test ID | `meta.testId` — optional, carried into reports as `test_id` |
| Tags | `meta.tags`, as one comma-separated line |
| Library | `meta.library` |

**A cleared field is written as an absence.** `description: ''`, `tags: []` and `library: false` all
mean to the engine exactly what the missing key means, so clearing one deletes it rather than
writing an empty value — which is what keeps edit-and-undo leaving the file it started as.

**Everything outside `meta:` survives the write**, so a property edit stays a diff a reviewer can
read: your steps, comments and formatting are not reserialized around it. One cosmetic exception is
unavoidable — padding that lined up a column of trailing comments collapses to a single space.

**The file does not move.** A flow's directory decides its scope — which environment tier it resolves
against, and whose auth it can inherit — so relocating it would change what the flow *does* from a
box labelled with what it is called. Moving a flow stays a filesystem operation; the sidebar re-reads
it either way.

**A rename does not rewrite `uses:` references.** A flow's identity is its path, so every other flow
naming the old one stops resolving, and `bru flow validate` is what tells you. Rewriting files you
did not open, on a guess about which paths meant this one, is the alternative — and it is worse.

The dialog refuses to open over a raw YAML editor with unsaved changes. It edits the text on disk,
which a dirty editor is already ahead of; save or discard first.

### The raw YAML editor

`Edit Yaml` on the same menu opens the file as text, with the graph above it redrawing from the draft
as you type. It is deliberately not what you get by opening a flow — it is for the edit the other
surfaces do not cover, and for reading what a generated flow actually says. Saving follows the app's
own auto-save preference, and auto-save writes only a draft that parses: a half-typed line would
otherwise reach a file the watcher is reporting and a run may be about to execute.

**A clean editor follows the file when it changes on disk** — a branch switch, another tool, a save
from elsewhere. **A dirty one keeps what you typed** and says the two diverged: *"Unsaved changes —
the file also changed on disk"*. Saving from there overwrites the file, which may be exactly what you
mean; choosing for you is what an editor must not do, and saying nothing is what would make the
overwrite silent.

### `flows/scripts/` — where raw helpers live

`functions: use:` takes a raw `.js` file from anywhere, which in practice means helpers end up
wherever the author put them. `flows/scripts/` is the conventional home for them, and the sidebar
lists what is in it:

```
workspace/
  flows/
    checkout.flow.yml
    scripts/
      text.js               # listed under Scripts
      money/format.js       # nested, also listed
```

**The convention changes nothing about resolution.** A script is reached by `use:` and by nothing
else — putting a file in the folder does not make any flow see it:

```yaml
# checkout.flow.yml — the folder saves nobody from writing this
functions:
  use:
    - ./scripts/text.js
```

Only `.js`, and only under that directory, is listed; subdirectories are listed too. Clicking one
opens it in a JavaScript editor tab that behaves like the YAML editor above, except that its
auto-save is gated on the file *parsing*. The stakes are higher there than for a flow: a script is
composed into every script position of every flow that names it, so a half-typed line saved to disk
fails all of them at once.

A script row's menu holds one item, `Rename`. It stays inside `flows/scripts/`, and like a flow's
rename it does not follow the `use:` entries that named it — `bru flow validate` reports the break as
`unresolved-function-library`.

**One trap the folder makes tempting:** `require` resolves against the collection or workspace root,
not against the requiring file. Two scripts sitting side by side in `flows/scripts/` therefore cannot
require each other by a relative path:

```js
require('./money/format')          // ✗ resolved from the scope root, not from scripts/
require('lodash')                  // ✓ bare names are unaffected
```

Composition between scripts is `use:`'s job, and `use:` *does* resolve relative to the file that named
it — a `.yml` library document listing several `.js` files is the shape that works.

### `flows/fixtures/` — where data files live

`!file`, `bodyFile:` and `dataset:` read a path relative to the flow, so a fixture can sit anywhere;
`flows/fixtures/` is the conventional home, and the sidebar lists what is under it in a `Fixtures`
bucket of its own, below the scripts. Any extension and any depth — a fixture has no single one,
since 001 §7.4 reads JSON, YAML and CSV as data and anything at all as an upload.

Clicking one opens it as text in the same editor a script gets, syntax-coloured by extension.
**Auto-save is not gated on it parsing**, unlike a script's: a fixture corpus is JSON, YAML, CSV and
whatever else an operation takes, so for most of them there is no question to ask, and gating only
the ones that happen to be JSON would be a rule that surprises you exactly when it fires. A fixture
that does not parse fails the flows reading it, at the step that read it, naming the file.

There is no menu on a fixture row: nothing here has a `meta:` to edit, and there is deliberately no
rename, because a fixture is named by the path written into every flow that reads it and nothing
would rewrite those. Rename one on disk and the flows that named it fail with `file-read-failed` —
this is not something `bru flow validate` catches, since nothing resolves fixture paths before a run.

As with `flows/scripts/`, the folder is a listing convention and nothing more — it changes no
resolution rule, and a file put there is still reached only by a flow that names its path.

---

## Running a flow

In the app, open it from the **API Flows** sidebar section and use the run control; the graph shows
each step's progress, and selecting a node opens its request, response, assertions and validation.

On the command line:

```bash
bru flow run flows/checkout.flow.yml       # one flow
bru flow run flows/                        # every flow in a directory
bru flow run a.flow.yml,b.flow.yml         # several, in one argument
```

Paths can be separated by spaces or by commas, so a whole selection fits in one shell word — useful
in a CI `command:` line or an npm script, where assembling several arguments is awkward. The one
casualty is a `.flow.yml` whose filename actually contains a comma: there is no way to escape it, so
name its directory instead.

The options you are most likely to want:

| Option | Does |
|---|---|
| `--global-env name` | Run against a workspace environment — `<workspace>/environments/<name>.yml` |
| `--dataset path` | Run each selected flow over this dataset file instead of the one it declares — see [Datasets](#datasets-running-a-flow-per-row) |
| `--strict` | Treat validation warnings as errors: a flow that warns does not run, and the command exits 2 |
| `--env-var name=value` | Override one variable (repeatable) |
| `--param name=value` | Supply a library flow's declared param (repeatable) |
| `--grep pattern` | Run only the flows the pattern matches — see [Picking flows with a pattern](#picking-flows-with-a-pattern) |
| `--grep-invert pattern` | Drop the flows the pattern matches |
| `--concurrency n` | Override `config.concurrency` |
| `--max-run-duration ms` | Bound the whole run; elapsing cancels it and exits 4 |
| `--bail` | Stop after the first failing flow |
| `--retry-failed [suite]` | Re-run the flows a past suite did not pass — see [Re-running what failed](#re-running-what-failed) |
| `--retries n` | Re-run flows that did not pass, up to `n` more times, before the command finishes |
| `--no-capture` | Do not write `.bruno-runs/` artifacts |
| `--capture-dir path` | Write captures somewhere other than `<scope>/.bruno-runs` |
| `--reporter-junit` / `--reporter-json` / `--reporter-html path` | Write a report — see [Reports](#reports) below |
| `--verbose` / `--quiet` / `--silent` | How much the console output prints |

`--global-env` is the only environment file the command selects — there is no `--env` beside it, so
a collection's own environment is not selectable from the command line and the collection tier is
empty under `bru`. Supply those values with `--env-var` or from the process environment; the app's
run control selects a collection environment normally.

Each run writes a directory holding the flow as it was, every request and response, and the outcome —
which is what the app's run selector reads back later. Every run opens its own **suite** to hold it:
a suite of one for a single flow, whether that's a run from the app or `bru flow run` against one
file, and a suite of many — plus the reports above — when `bru flow run` selects several. See
[Reports](#reports) for the layout either way. A suite `bru flow run` opens also gets a `suite.json`
listing what the command selected and how each flow went — including the flows that never ran
because they did not validate, which have no directory of their own. That list is what
[`--retry-failed`](#re-running-what-failed) reads. `listRuns` reads every suite, so the app's history
shows a CLI run exactly as it shows one of its own; it also still reads a run directory written flat,
from before this layout existed, as an older entry. Nothing under `.bruno-runs/` is ever deleted for
you — it grows by one suite every run, so clearing it out is yours to do when you want the space
back.

Every run also records which environment it used — `--global-env` here, whatever the run control's
environment selector had chosen in the app. The app shows it as a small badge next to a run's result,
so you can tell at a glance which environment a graph you're looking at ran against; the JUnit report
carries the same information as suite properties (see [Reports](#reports) below).

What the command exits with, for a CI job that has to tell these apart:

| Code | Means |
|---|---|
| `0` | Every flow passed — including one that only passed on a `--retries` attempt, and including a `--grep` that matched nothing |
| `1` | A flow failed |
| `2` | A flow did not validate, so it was not run |
| `3` | The command itself was wrong — a bad path, a `--global-env` that does not exist, a `--grep` that is not a valid regular expression, or a `--retry-failed` naming something that is not a past run |
| `4` | The run was cancelled, including by `--max-run-duration` elapsing |

### Picking flows with a pattern

`--grep` runs only the flows whose text matches, and `--grep-invert` drops the ones that do:

```bash
bru flow run flows/ --grep 'smoke|checkout'      # only these
bru flow run flows/ --grep-invert slow           # everything except these
bru flow run flows/ --grep smoke --grep-invert flaky
```

Both take a **regular expression** and both are case-insensitive, so `SMOKE` finds a flow tagged
`smoke` — tags and case ids get typed in whatever case the tracker uses, and an exact-case miss is an
empty run that looks like a working one. When the two are combined, excluding wins: a flow matching
both patterns is dropped.

The pattern is tried against everything a flow says about itself:

| Matched | From |
|---|---|
| The flow's path within its workspace or collection | e.g. `flows/checkout/refund.flow.yml` |
| `meta.name`, every entry in `meta.tags`, `meta.testId` | the flow's own [`meta:`](#documenting-a-flow) |
| Each step's `id` and `name` | [A step](#a-step) |
| Every value under a step's `meta:`, however deeply nested | a step's own [`meta:`](#a-step) — case ids, and any other custom key |

Two things it does **not** match. **Keys are never matched, only values** — `--grep testId` finds
nothing, rather than every flow that happens to declare one. And the **absolute path is not
searched**: only the part below the workspace or collection root, so `--grep jake` cannot select your
entire workspace by way of your home directory.

`--grep` narrows what the paths you gave already selected; it never goes looking for flows elsewhere.
It also cannot pull in a [library flow](#sub-flows-and-library-flows), since running `flows/` skipped
those before the pattern was applied. It works the same way over `--retry-failed`, where it narrows
the past run's list.

If nothing matches, that is not an error: the command tells you how many flows the paths selected and
that the pattern kept none, and exits `0`. A pattern that is not a valid regular expression *is* an
error, and it is refused before any flow runs (exit `3`) rather than after ten minutes of requests.

To see what a pattern selects without running it, swap `run` for `list` — see
[Listing what would run](#listing-what-would-run).

In the app, the **search box** at the top of the API Flows section filters the list on exactly the
same fields, and the **play button** in that section's header runs the flows the search is showing as
one suite. The box takes text rather than a regular expression — `payments (v2)` is read literally —
but what it looks in is the same, so a flow you can find in the sidebar is a flow `--grep` can
select. That does mean a flow can match on a tag or a step name its sidebar row does not show.

### Listing what would run

`bru flow list` prints the flows a `bru flow run` with the same arguments would execute, and sends
nothing. It is how you check a pattern before you spend a CI job on it:

```bash
bru flow list flows/                             # what a run of this directory would do
bru flow list flows/ --grep 'smoke|checkout'     # what the pattern actually selects
bru flow list                                    # the whole collection or workspace
```

```
id        kind     steps  tags             file
checkout  flow         6  checkout, smoke  flows/checkout.flow.yml
refunds   flow         4  refunds          flows/refunds.flow.yml
login     library      1  —                flows/shared/login.flow.yml

3 flows · 1 library
```

The selection is the run's, so everything above applies unchanged: the same paths, spaced or
comma-separated, the same default of the current directory, the same `--grep` and `--grep-invert`.
Nothing about running is accepted — no environments, no `--param`, no reporters — and nothing is
written to `.bruno-runs/`, because nothing ran. `--silent`, `--no-color` and `--no-unicode` work as
they do for a run.

A [library flow](#sub-flows-and-library-flows) is listed and marked `library` when you name it, and
absent when you name only the directory holding it — the same two behaviours a run has, which is the
point: what the listing shows is what would run. The `id` column is the last segment of the flow's
path, widened to as much of the path as tells two flows apart when a segment alone does not; `file`
always carries the whole path.

It exits `0`, or `3` for the same up-front mistakes a run refuses — a path that does not exist, a
`--grep` that is not a valid regular expression. A pattern that matched nothing is not one of those:
it says how many flows the paths selected, and exits `0`.

### Re-running what failed

Two flags, for two different moments.

`--retries` re-runs flows **inside the same command**. Once every selected flow has run, any that
did not pass run again, up to `n` more times:

```bash
bru flow run flows/ --retries 2
```

The **last** attempt is the flow's result, so a flow that failed and then passed counts as a pass
and the command exits `0` — which is the whole point of a retry. It is not swept under the carpet:
every attempt reaches the reports, including the one that failed, and the flow is marked **flaky**
in all of them — a `flaky` property and a note naming the attempt it passed on in the JUnit files, a
`Flaky` badge in the HTML, a `flaky` field and a `summary.flows.flaky` count in the JSON. So look
for flakes in your reports rather than in your build history.

`--retry-failed` re-runs a **past command's** failures, as a new run of its own:

```bash
bru flow run --retry-failed                                    # the newest run in this scope
bru flow run --retry-failed suite-2026-08-05T15-01-09Z-c02e    # a particular one
```

It picks up everything that did not pass — failures, cancellations, and flows that did not
validate — and runs only those. Paths you pass alongside it say only *where* to look for past runs;
the flows themselves come from that run's own list. A flow that has since been deleted or renamed is
skipped with a warning. If the run you named passed completely, the command says so and exits `0`.

The retry is a new suite directory with its own reports and never touches the one it re-ran, so both
records survive; what ties them together is the name of the original, recorded in the retry's
`suite.json` and in its reports. In the app the same thing is **Rerun failed flows** in the API Flows
section's three-dot menu, which shows how many flows it is about to run.

> `--retries` is not a step's `retry:` ([Retry, polling and
> timeouts](#retry-polling-and-timeouts)). That one re-sends **one request** inside a running flow,
> which is how you poll. These two re-run **whole flows**, replaying every side effect the earlier
> attempt already caused — so neither is on by default.

### Reports

For CI, or for importing results into a test-management tool, ask for one of the three built-in
reporters. The ordinary way is to name one with no path:

```bash
bru flow run flows/ --reporter-junit
```

Everything that invocation produces lands together, in one directory named for it:

```
.bruno-runs/
  suite-2026-09-02T12-40-04Z-a3f9/     # this invocation
    report-junit.xml
    2026-09-02T12-40-05Z-b71c/         # flows/checkout.flow.yml's own run
      run.json
      ...
    2026-09-02T12-40-07Z-9e02/         # flows/refunds.flow.yml's own run
      run.json
      ...
```

The report sits right beside the run directories it describes — open `report-junit.xml`, see a step
failed, and that step's full request and response are in the sibling folder next to it, not somewhere
else in `.bruno-runs/` you have to go find. That `suite-<startedAt>-<id>/` directory (or under
`--capture-dir`, if you passed one) is created and `.gitignore`d before the run starts, even under
`--no-capture`, so it's there to collect either way. `--reporter-json` and `--reporter-html` default
the same way, to `report.json` and `report.html` alongside `report-junit.xml`, and all three can run
together in one invocation. Because the folder name changes every run, a CI job that wants the JUnit
file back generally globs for it — `.bruno-runs/suite-*/report-junit.xml` — rather than hardcoding
one run's path.

Give one an explicit path instead when you want the file somewhere else — a build directory a CI job
already collects, say:

```bash
bru flow run flows/ --reporter-junit reports/flows.xml --reporter-html reports/flows.html
```

Either way, each reporter writes a single file covering **every** flow selected by the command, not
one file per flow, and prints `Wrote <name> report to <path>` when it finishes, unless `--silent`.

> Put a bare `--reporter-junit` / `-json` / `-html` **after** the flow paths on the command line — as
> a plain string flag it otherwise swallows the very next argument as its output path, so
> `bru flow run --reporter-junit flows/` runs nothing: `flows/` became the JUnit path, not a flow to
> run. `--reporter junit` (the long form, with the module name spelled out) doesn't have this
> problem, because `--reporter` always takes one explicit value.

The JUnit file has one `<testsuite>` per flow (per dataset row, if the flow has one), with the flow's
`meta.tags` and a few other identifying facts as suite properties, and one `<testcase>` per step:

```xml
<testsuite name="checkout" tests="3" failures="0" errors="0" skipped="0" time="2.341" timestamp="2026-09-02T09:14:03">
  <properties>
    <property name="flow" value="checkout"/>
    <property name="name" value="Checkout happy path"/>
    <property name="tags" value="checkout,smoke"/>
    <property name="status" value="passed"/>
    <property name="host" value="cli"/>
    <property name="globalEnvironment" value="staging"/>
  </properties>
  <testcase name="create_payment" classname="checkout" time="0.412">
    <properties>
      <property name="test_id" value="C1234"/>
      <property name="owner" value="payments-team"/>
      <property name="name" value="Create a pending payment"/>
    </properties>
  </testcase>
</testsuite>
```

That `test_id` property is where a step's `meta.testId` (see [above](#a-step)) ends up — it is the
property TestRail's own JUnit importer reads to match a result back to a case, so tagging steps with
their case ids is what lets a `bru flow run` in CI update TestRail directly. Every other key under a
step's `meta:` rides along the same way — `owner` above came from `meta: { owner: payments-team }` on
that step — so a report can carry whatever your team's tooling wants without waiting on this format
to grow a field for it. The flow's `tags` gives you the coarser grouping: filter or group runs by
whatever `meta.tags` a flow carries.

`host` and `globalEnvironment` record where the run came from and which environment it used — `host`
is always `cli` here, since these come from `bru flow run`, and `globalEnvironment` is whatever
`--global-env` named (see below). A run from the app records the same properties with `host: app`,
so a JUnit file lets a CI failure and an app run be told apart at a glance, and it can carry a third,
`environment`, naming the collection environment its run control had selected. `bru flow run` never
writes that one: it has no flag for a collection environment, so a CLI report saying nothing about
one is saying that none was chosen rather than that it forgot.

`--reporter-junit-flows` writes a second JUnit shape: one `<testcase>` per **flow** instead of per
step, all inside a single `<testsuite name="bru flow run">` for the whole invocation:

```xml
<testcase name="checkout" classname="checkout" time="2.341">
  <properties>
    <property name="test_id" value="C1000"/>
    <property name="status" value="passed"/>
    <property name="host" value="cli"/>
  </properties>
</testcase>
```

That `test_id` is the flow's own `meta.testId` (see [above](#documenting-a-flow)) — a case id for the
flow as a whole, not a step's. A failed flow's `message` names whichever step (or steps) decided the
outcome, so you still know where to look without one case per step. Pick `--reporter-junit` for a
case per step, the shape TestRail-style case ids and per-step dashboards want; pick
`--reporter-junit-flows` for a case per flow, the shape a tracker that only cares about whole flows
wants. Both can run in the same invocation.

### Custom reporters

`--reporter` also accepts your own module, in addition to or instead of the built-ins. **Unlike a
built-in, a custom module has no default location, so `=<path>` is required** — `--reporter
./reporters/slack.js` with nothing after it is rejected before any flow runs, not left to fail
partway through:

```bash
bru flow run flows/ --reporter ./reporters/slack.js=out.txt --reporter-option channel=#qa
```

A reporter module exports a factory that returns whichever hooks it wants — all of them are optional:

```js
// reporters/slack.js
const fs = require('fs');

module.exports = ({ outputPath, options }) => {
  const lines = [];
  return {
    onFlowEnd(record) {
      const owners = (record.result?.iterations[0]?.steps ?? [])
        .map((s) => s.meta?.owner)
        .filter(Boolean);
      const mark = record.outcome === 'passed' ? '✓' : '✗';
      lines.push(`${mark} ${record.name}${owners.length ? ` (${owners.join(', ')})` : ''}`);
    },
    onSuiteEnd(suite) {
      const { passed, total } = suite.summary.flows;
      const text = [`${passed}/${total} flows passed`, ...lines].join('\n');
      fs.writeFileSync(outputPath, text);
      // post `text` to Slack channel `options.channel` here, if you want
    }
  };
};
```

`outputPath` is whatever followed `=` in `--reporter`, resolved to an absolute path; `options` holds
every `--reporter-option key=value` pair, so the same module can be reused with different settings
per invocation. `record.result.iterations[0].steps[i].meta` is a step's `meta:` block exactly as
written in the flow — reach into it for whatever key your own reporter cares about.

**A reporter is arbitrary code, and it runs unsandboxed in your own process** — unlike a flow's
`script:` blocks, which run sandboxed. For that reason `--reporter` only ever comes from the command
line: it cannot be declared in a `.flow.yml`, `bruno.json` or `workspace.yml`, and the app never loads
one. Only name a reporter you trust, the same way you'd only run a script you trust.

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
| `slot-not-downstream` | Reads a slot written off this step's branch — declare it `writers: any` if the writers are alternatives |
| `unknown-auth-profile` | `auth:` names a profile that is not declared |
| `unknown-param` / `missing-param` | `with:` passes a param the sub-flow does not declare, or omits a required one |
| `unknown-pre-value` | An output takes `from: pre` naming a value the step does not compute |
| `unresolved-function-library` | A `functions.use:` entry did not resolve, or climbs outside the scope root |
| `invalid-function-name` | A `functions:` name is not a JavaScript identifier — it becomes a declaration |
| `undeclared-dependency` *(warning)* | A step reads `steps.x.body…` rather than a declared output — see [the note above](#declared-outputs-not-raw-response-access) |
| `interpolation-in-output-path` *(warning)* | An output path contains `{{...}}` — it is a path into the response, not an interpolation, and selects nothing |
| `status-opt-out-without-assertion` *(warning)* | `failOnStatusCode: false` with no `res.status` assertion, so the step accepts any status |
| `function-shadows-script-argument` *(warning)* | A function named `res` or `ctx`, which every script is handed |
| `pre-reads-sibling-value` *(warning)* | A `pre:` script reads `ctx.pre`, which is empty in every one of them — the sibling's value is not visible |
| `invalid-api-color` *(warning)* | An `apis:` binding's `color:` is not `#rgb` or `#rrggbb` |
| `invalid-step-meta` *(warning)* | A step's `meta:` is not a mapping, so nothing it says reaches a report |

Two more codes exist that `bru flow validate` can never show you, because they are facts about a run
rather than about the file. They arrive in the run's own diagnostics — on the console, and in the
reports (§14.8) — and are listed here so a code you are shown is always a code you can look up:

| Code | Meaning |
|---|---|
| `capture-write-failed` *(warning)* | A step's capture could not be written. The run carries on and its verdict stands — a flow that passed did pass, whatever the disk did — but that step has no request or response to open afterwards, and this is what says why |
| `run-failed` | The run itself broke: something escaped the engine rather than a step failing. The run reports `failed` with no steps and this message, which is the only account of what happened |

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
| `script-error` | A `pre:`, `outputs: script:`, `when: script:` or `shouldRetry:` threw | Yes |
| `subflow-failed` | A `uses:` sub-flow failed | Yes |

### What is specified but not built yet

So you do not write a flow that depends on it:

- **The document schema** — unknown and misspelled keys are silently ignored.
- **`bru flow run` reading a scope's `.env`** — the app does and the CLI does not, so a variable a
  flow resolves in the app can be missing in CI. Set it in the environment, or pass `--env-var`.
- **`--dry-run`** (001 §14.1) — specified and argued for, scheduled for v2 (001 §19.1), not a flag
  today. `bru flow run` rejects it as unknown rather than ignoring it, so a CI line using it fails
  loudly instead of quietly running without it.
- **`bru flow schema`** (001 §14, §5.4) — the command takes `run`, `validate` and `list` only. There
  is no generated JSON Schema to point an editor at yet, which is the same reason unknown keys go
  unwarned above.
- **The implicit `collection` auth profile** (001 §6.4) — no host supplies it; declare your own.
- **Cookie-jar scoping** (001 §7.6) and the provenance half of secret redaction (§14.4). Header-name
  redaction *is* in place, including `config.redactHeaders`.
