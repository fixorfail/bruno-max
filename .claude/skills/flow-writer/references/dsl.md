# `.flow.yml` reference

Complete field reference for Bruno API Flows, self-contained so it works in any repository.

> This is a portable twin of `docs/writing-flows.md` in the Bruno fork repo. Both describe one
> engine (`@bruno-max/flow`), which is the source of truth; when either disagrees with the engine,
> the engine wins. Keep them in step when the DSL changes.

---

## Document skeleton

```yaml
version: 1                     # required

meta:
  name: Checkout happy path
  description: What this proves, and anything it needs.
  tags: [checkout, smoke]      # parsed; nothing reads them yet
  library: false               # true = reusable sub-flow, excluded from glob runs

apis:                          # alias -> OpenAPI document; required to send anything
  payments-api: ../../apispec/payments-v3.yml
  ledger-api:
    source: https://api.example.com/openapi.json
    baseUrl: "{{ledgerBaseUrl}}"       # overrides config.baseUrl for this API
    auth: service-account              # default profile for steps using this API
    defaultHeaders: { X-Tenant: "{{tenantId}}" }
    defaultQuery: { version: "2024-01" }

config:
  baseUrl: "{{apiBaseUrl}}"    # default: the document's servers[0]
  failOnStatusCode: true       # status >= 400 fails the step
  failOnUnresolved: true       # an unresolved-dependency skip fails the run
  validateRequest: true        # check the body against the schema before sending
  validateSchema: true         # check the response against the schema
  strictSchema: false          # an undocumented status code fails the step
  concurrency: 5               # max steps in flight
  maxRunDuration: 900000       # ms for the whole run; unset = no limit
  cleanupGrace: 30000          # ms allowed for cleanup steps after a cancel
  retry: { maxAttempts: 3, delay: 1000 }    # flow-wide defaults; a step's retry: overrides
  redactHeaders: [X-Legacy-Key]             # masked in logs and captures
  captureRetainRuns: 10                     # run directories kept before pruning

authProfiles:
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

vars:                          # evaluated ONCE, before any step; referenced bare
  currency: USD
  testEmail: "qa+{{$randomUUID}}@example.com"
  catalog: !file ./fixtures/catalog.json

shared: [chargeId]             # slots any branch can write and anyone can read
shared:                        # …or a mapping, where a slot names its own rule:
  sessionToken: { writers: any }   #   readers descend from ONE writer, not all

dataset: ./fixtures/customers.csv         # one iteration per row

params:                        # library flows only
  tenantId: { required: true }
  region:   { required: false, default: eu }
exports:                       # library flows only — FULL references
  token: steps.sign_in.token

steps: [ ... ]
```

Only `version` and `steps` are required.

## Step

```yaml
steps:
  - id: create_payment                       # required; ^[a-zA-Z_][a-zA-Z0-9_]*$
    name: Create a pending payment           # optional label, shown on the graph node
    operation: payments-api#createPayment    # required — or `uses:`, never both
    auth: user-token                         # an authProfiles name, or `none`

    depends: [sign_in]                       # default: the step above
    when: steps.sign_in.status eq 200        # skip unless true

    body: { amount: 9900 }                   # or bodyFile:, never both
    query: { expand: customer }
    headers: { Idempotency-Key: "{{flow.runId}}" }
    pathParams: { tenantId: "{{tenantId}}" }
    contentType: application/json            # only when the operation declares more than one

    outputs: { paymentId: data.id }
    shared: { chargeId: paymentId }          # publish an output into a slot

    assert:
      - res.status eq 201

    retry: { maxAttempts: 5, delay: 2000, backoff: exponential }

    failOnStatusCode: true                   # these five override config:
    failOnUnresolved: true
    validateRequest: true
    validateSchema: true
    strictSchema: false
    timeout: 30000                           # ms per attempt
    maxDuration: 120000                      # ms for the step including retries
```

## Interpolation

**Bare names** read variables: flow `vars:`, then environment/collection/global variables.
`{{currency}}`, `{{SANDBOX_TOKEN}}`.

**Namespaced names** read run state, and shadow variables of the same name:

| Namespace | Holds |
|---|---|
| `steps.<id>.*` | Another step's declared outputs, plus `status`, `ok`, `skipped`, `duration` |
| `shared.<slot>` | A slot's value |
| `params.<name>` | A library flow's parameters |
| `row.<column>` | The current dataset row |
| `flow.runId` / `flow.name` / `flow.iteration` | The run |
| `process.env.<NAME>` | Process environment, when the host supplies it |
| `res.*` | The response — in `assert:` and `shouldRetry:` only |

Rules:

- **A whole-value reference keeps its type.** `count: "{{steps.cart.count}}"` is the number.
  Embedded (`"order {{x}}"`) is always a string.
- **An unproduced `{{steps.*}}` skips the step** with `unresolved-dependency`. A missing
  `{{shared.*}}` resolves to empty instead.
- **You may only reference a step you depend on**, directly or transitively — otherwise
  `non-ancestor-reference`. Use a slot for values two branches might produce.
- `vars:` may not reference steps: nothing has run when they are evaluated.
- `{{$randomUUID}}`, `{{$randomEmail}}` etc. are Bruno's mock-data functions. In `vars:` they are
  generated once; used in a step, per use.

### `!file` and `!...`

```yaml
vars:
  catalog: !file ./fixtures/catalog.json     # parsed; {{catalog.items}} works
steps:
  - id: upload
    body:
      scan: !file ./fixtures/scan.pdf        # a multipart file part
      invoice: !file
        path: ./fixtures/invoice.pdf
        filename: invoice-2026.pdf           # multipart only
        contentType: application/pdf         # multipart only
      legacy_field: !...                     # drop a spec-seeded key entirely
      nullable_field: null                   # send a literal null
```

Paths are relative to the flow file and confined to the workspace/collection root.

## Bodies

The engine seeds the body from the operation's request schema and layers your `body:` on top, key
by key. Arrays replace wholesale. You usually write only what you change.

| Operation declares | You write | Sent as |
|---|---|---|
| `application/json`, `*+json` | a mapping | JSON |
| `application/x-www-form-urlencoded` | a mapping | form fields |
| `multipart/form-data` | a mapping; `!file` values become uploads | multipart |
| `text/*`, `application/xml`, … | a scalar | raw |
| binary | `body: !file ./x.pdf` or `bodyFile: ./x.pdf` | raw bytes |

`bodyFile:` reads and merges a fixture from disk, then interpolates it.

## Outputs

```yaml
    outputs:
      paymentId: data.id                    # short form: a path into the body
      state:    { from: body, path: data.state }
      location: { from: headers, path: location }
      code:     { from: status }
      total:
        script: |
          (res, ctx) => res.body.data.items.reduce((sum, item) => sum + item.amount, 0)
```

`from` is `body` (default), `headers` or `status`. A leading `$.` is stripped.

Always available on any step without declaring: `steps.<id>.status`, `.ok`, `.skipped`,
`.duration`.

> **`steps.<id>.body` and `.headers` do NOT resolve at run time.** The spec describes them as an
> escape hatch and the validator warns about them, but the engine publishes only declared outputs
> and the four built-ins above. A step reading `{{steps.x.body.y}}` is skipped with
> `unresolved-dependency`. **Always declare an output.**

## Order and conditions

A step with no `depends:` depends on the step immediately above it.

```yaml
    depends: [sign_in]                 # after sign_in succeeds
```

```yaml
    depends: [sign_in, load_catalog]   # after both — a list means `all`
```

```yaml
    depends:
      any: [card_path, wallet_path]    # whichever finishes first
```

```yaml
    depends:
      - on: charge_card
        status: [failed]               # runs only when charge_card failed
```

Statuses: `success` (default), `failed`, `skipped`, `cancelled`. A dependency that did not reach
the required status skips the step with `unmet-dependency`, which is not a failure. Declaring
`depends:` replaces the implicit "step above" edge.

Conditions — several are ANDed, false skips with `condition-false`:

```yaml
    when: steps.sign_in.status eq 200
```

```yaml
    when:
      script: |
        (ctx) => ctx.params.region === 'eu' && !ctx.steps.lookup.skipped
```

### Slots

For a value either of two branches might produce:

```yaml
shared: [chargeId]

steps:
  - id: charge_card
    outputs: { chargeId: data.id }
    shared:  { chargeId: chargeId }        # slot: output  (or `shared: [chargeId]` when equal)
  - id: charge_wallet
    outputs: { walletId: data.id }
    shared:  { chargeId: walletId }
  - id: receipt
    depends: { any: [charge_card, charge_wallet] }
    body: { charge: "{{shared.chargeId}}" }
```

**A reader must descend from every writer** — that is the *join* above, where `receipt` sits below
both branches. The other shape is branches that **exclude** each other, one of which writes and the
steps after it on that same branch read: no reader can descend from every writer there, because only
one writer ever runs. Declare that slot's rule:

```yaml
shared:
  sessionToken: { writers: any }   # descend from one writer, not all
```

`shared: [x]` is the list form and means `writers: all`. Under `any` a reader must still descend from
*a* writer. Use `any` only where the writers genuinely exclude each other — it is a promise you are
making, not something the validator can check.

### A credential every step needs

An auth profile can read a slot, and an api binding can name the profile — so a token produced by
whichever branch ran reaches every request without a single step mentioning a header:

```yaml
apis:
  backend:
    source: ./openapi.yml
    auth: session                    # every step on this binding

authProfiles:
  session:
    mode: apikey                     # bearer | basic | apikey | oauth2 | awsv4 | …
    key: Authorization
    value: "Token {{shared.sessionToken}}"
    placement: header

shared:
  sessionToken: { writers: any }

steps:
  - id: sign_in
    operation: backend#login
    auth: none                       # the step that MAKES the credential sends none
    outputs: { sessionToken: meta.token }
    shared:  [sessionToken]
  - id: whatever_comes_next
    operation: backend#listThings    # no headers: block — the binding carries the session
```

`mode: bearer` sends `Authorization: Bearer <token>`; a scheme like `Token <t>` or `X-Api-Key` is
`apikey` with `key`, `value` and `placement`. A profile's fields are interpolated per step, so the
value is read at the moment each request is built. A step that must go out unauthenticated says
`auth: none`.

## Assertions

`<expression> <operator> <value>`; every entry is evaluated, so you get all failures.

```yaml
    assert:
      - res.status eq 201
      - res.body.data.items length 3
      - res.body.data.state in [pending, settled]
      - res.headers.location matches ^/payments/
      - steps.sign_in.ok                       # no operator: isTruthy
      - expr: res.body.data.label               # long form when the value is ambiguous
        op: eq
        value: "gift card"
```

Operators: `eq` `neq` `==` `!=` `gt` `gte` `lt` `lte` `in` `notIn` `contains` `notContains`
`length` `matches` `notMatches` `startsWith` `endsWith` `between` `isEmpty` `isNotEmpty` `isNull`
`isUndefined` `isDefined` `isTruthy` `isFalsy` `isJson` `isNumber` `isString` `isBoolean` `isArray`

The operator is the first token that is a known operator name, so expressions and values may
contain spaces. Operands beginning with a reserved namespace are references; anything else is a
literal. `{{...}}` works in any operand position.

## Retry and polling

```yaml
    retry:
      maxAttempts: 10          # including the first; default 1
      delay: 2000              # ms before each retry; default 0
      backoff: exponential     # fixed (default) | exponential
      maxDelay: 30000          # cap on one wait; default 30000
      jitter: none             # none (default) | full
      shouldRetry: |
        (res, attempt, ctx) => res.body.state === 'pending'
```

Retry is evaluated **after** the status check, schema validation and assertions, so the predicate
sees the whole outcome — which is what makes polling first-class.

**Without `shouldRetry`, retry fires only on a transport error or a 5xx** — never on a failed
assertion, which means the server answered and the answer was wrong.

## Scripts

All three script fields take a **function expression**; the engine calls what you write.

| Field | Signature |
|---|---|
| `outputs.<name>.script` | `(res, ctx) => …` |
| `when.script` | `(ctx) => …` |
| `retry.shouldRetry` | `(res, attempt, ctx) => …` |

`res` is `{ status, statusText, headers, body, responseTime }` — `undefined` in `shouldRetry` when
the attempt got no response. `ctx` is variables plus the namespaces; in `shouldRetry` it also
carries `ctx.failures`, the assertions that failed. A throw fails the step with `script-error`.

## Datasets

```yaml
dataset: ./fixtures/customers.csv
```

```yaml
dataset:
  source: ./fixtures/customers.json
  parallel: 3          # iterations in flight; default 1
```

`.csv`, `.json`, `.yml`/`.yaml`. Each row is one iteration of the whole flow, columns under
`row.`. Iterations are independent — no state carries between them.

## Sub-flows

Library flow:

```yaml
version: 1
meta: { name: Sign in, library: true }

params:
  email:    { required: true }
  password: { required: false, default: "{{DEFAULT_PASSWORD}}" }

exports:
  token: steps.authenticate.accessToken     # a full reference, not <step>.<output>

steps:
  - id: authenticate
    operation: auth-api#login
    body: { email: "{{params.email}}", password: "{{params.password}}" }
    outputs: { accessToken: data.token }
```

Caller:

```yaml
  - id: sign_in
    uses: ./shared/sign-in.flow.yml
    with:
      email: "{{testEmail}}"
```

Its exports read like any step's outputs: `{{steps.sign_in.token}}`. A step declares `operation:`
or `uses:`, never both. Recursion is refused.

## Running

```bash
bru flow validate flows/checkout.flow.yml    # or a directory
bru flow run flows/checkout.flow.yml
```

| Option | Does |
|---|---|
| `--env-var name=value` | Override one variable (repeatable) |
| `--param name=value` | Supply a library flow's param (repeatable) |
| `--concurrency n` | Override `config.concurrency` |
| `--max-run-duration ms` | Bound the run; elapsing cancels it and exits 4 |
| `--bail` | Stop after the first failing flow |
| `--no-capture` | Do not write `.bruno-runs/` artifacts |
| `--capture-dir path` | Write captures elsewhere |
| `--verbose` / `--quiet` / `--silent` | Reporter volume |

## Diagnostics

| Code | Meaning |
|---|---|
| `parse-error` | The YAML did not parse; nothing else is checked |
| `invalid-step-id` | Not a valid identifier — letters, digits, `_`, not starting with a digit |
| `unknown-dependency` | `depends:` names a step that does not exist |
| `cyclic-dependency` | A dependency cycle, or a sub-flow invoking itself |
| `body-and-body-file` | Both `body:` and `bodyFile:` |
| `operation-and-uses` | Both `operation:` and `uses:` |
| `unresolved-alias` | An `apis:` document did not load, or a step names an unbound alias |
| `unknown-operation` | No such `operationId` in the bound document |
| `unknown-step-reference` | `{{steps.x…}}` names a step that does not exist |
| `non-ancestor-reference` | References a step this one does not depend on — use a slot |
| `invalid-var-reference` | A `vars:` entry references a step |
| `undeclared-slot` | Reads a slot no `shared:` block declares |
| `slot-not-downstream` | Reads a slot written off this step's branch — declare it `writers: any` if the writers are alternatives |
| `unknown-auth-profile` | `auth:` names an undeclared profile |
| `unknown-param` / `missing-param` | `with:` passes an undeclared param, or omits a required one |
| `undeclared-dependency` *(warning)* | Reads `steps.x.body…` rather than a declared output |

## Step outcomes

| Reason | Failure? |
|---|---|
| `condition-false`, `unmet-dependency`, `run-cancelled` | No |
| `unresolved-dependency` | Yes, unless `failOnUnresolved: false` |
| `assertion-failed`, `unexpected-status`, `invalid-request`, `schema-validation-failed` | Yes |
| `transport-error`, `max-duration-exceeded`, `retries-exhausted` | Yes |
| `file-read-failed`, `script-error`, `subflow-failed` | Yes |

## Specified but not built

Do not write a flow that depends on these:

- **`steps.<id>.body` / `.headers` at run time** — declare an output instead.
- **The implicit `collection` auth profile** — declare your own profile.
- **The document schema** — unknown and misspelled keys are silently ignored.
- **`--tags` filtering** and **`meta.description` display** — both recorded, neither surfaced.
- **`config.capturePreviewBytes`** — parsed, unread.
