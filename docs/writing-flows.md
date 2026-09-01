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
| Flow | `meta.tags` | Labels for grouping | The properties dialog edits them; **nothing selects on them yet** — `--tags` filtering is specified (001 §14.1) but not implemented |
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

A `.flow.yml` is a file you can edit in anything, and the app never pretends otherwise — but three of
its surfaces exist for the edits you would otherwise make by hand and get subtly wrong. All of them
hang off the flow's row in the **API Flows** sidebar section, on a menu revealed when the pointer is
on the row.

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
| `--global-env name` | Run against a workspace environment — `<workspace>/environments/<name>.yml` |
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

What the command exits with, for a CI job that has to tell these apart:

| Code | Means |
|---|---|
| `0` | Every flow passed |
| `1` | A flow failed |
| `2` | A flow did not validate, so it was not run |
| `3` | The command itself was wrong — a bad path, or a `--global-env` that does not exist |
| `4` | The run was cancelled, including by `--max-run-duration` elapsing |

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
| `script-error` | A `pre:`, `outputs: script:`, `when: script:` or `shouldRetry:` threw | Yes |
| `subflow-failed` | A `uses:` sub-flow failed | Yes |

### What is specified but not built yet

So you do not write a flow that depends on it:

- **Raw `steps.<id>.body` / `.headers` access** — validated and drawn, but does not resolve at run
  time. Declare an output.
- **The document schema** — unknown and misspelled keys are silently ignored.
- **`--tags` filtering** — the properties dialog edits `meta.tags`, and nothing *selects* on them:
  neither `bru flow run` nor the sidebar takes a tag.
- **The implicit `collection` auth profile** (001 §6.4) — no host supplies it; declare your own.
- **Cookie-jar scoping** (001 §7.6) and the provenance half of secret redaction (§14.4). Header-name
  redaction *is* in place, including `config.redactHeaders`.
