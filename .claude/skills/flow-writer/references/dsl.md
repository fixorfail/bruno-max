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
  testId: C1000                # this flow's case id — emitted as a flow-level report's `test_id`
  tags: [checkout, smoke]      # `--grep` and the app's flow search select on them
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

authProfiles:
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

vars:                          # evaluated ONCE, before any step; referenced bare
  currency: USD
  testEmail: "qa+{{$randomUUID}}@example.com"
  catalog: !file ./fixtures/catalog.json

functions:                     # helpers every script: in this flow can call, by name
  use:                         #   library files, in order — .yml is a functions doc, else raw JS
    - ../shared/functions.yml
    - ./lib/text.js
  lastFour: |                  #   …and the flow's own, which win on a name
    (value) => String(value).slice(-4)

shared:                        # slots; the list form means writers: all
  chargeId: { writers: all }   #   readers must descend from EVERY writer
  sessionToken: { writers: any }   #   readers descend from ONE writer, not all

dataset: ./fixtures/customers.csv         # one iteration per row

stages:                        # names for regions of the graph; presentation only
  setup: sign_in               #   a stage name -> the step it BEGINS at, covering steps
  test: create_payment         #   from there to the next stage's step
  teardown: refund

params:                        # library flows only
  tenantId: { required: true }
  region:   { required: false, default: eu }
  apiToken: { required: true, secret: true }   # value masked in the run record
exports:                       # library flows only — FULL references
  token: steps.sign_in.token   # or shared.<slot>, named whole

steps: [ ... ]
```

Only `version` and `steps` are required.

`stages:` is presentation only — it changes no schedule, no status and no capture, and a boundary is
not a barrier. A stage names the step it *begins* at and covers the run of `steps:` up to the next
stage's, so editing steps inside a stage is never an edit to `stages:`. A boundary the run order
contradicts is dropped and reported as a warning rather than the graph rearranging itself:
`unknown-stage-step` (the named step is not a step of this flow), `stage-boundary-order` (it does not
come after the one before it) and `stage-out-of-order` (a step listed above it does not run before
it).

## Step

```yaml
steps:
  - id: create_payment                       # required; ^[a-zA-Z_][a-zA-Z0-9_]*$
    name: Create a pending payment           # optional label, shown on the graph node
    meta:                                    # optional, free-form; rides into reports key for key
      testId: C1234                          #   the one key a reporter knows — JUnit's `test_id`
      owner: payments-team                   #   anything else becomes a property of the same name
    operation: payments-api#createPayment    # required — or `uses:`, never both
    auth: user-token                         # an authProfiles name, or `none`

    depends: [sign_in]                       # default: the step above
    when: steps.sign_in.status eq 200        # skip unless true

    pre:                                     # computed before the request; read as {{pre.*}}
      nonce: |
        () => crypto.randomUUID()

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
| `pre.<name>` | What *this* step computed before its request — step-local, no other step can read it |
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

## Values computed before the request

**`pre:` is `outputs:` one stage earlier.** A step-level mapping of name → script, evaluated before
the request is built, so a request can carry a value it needs — a signature, a timestamp, a nonce —
without a throwaway step that sends a request nobody wanted just to run three lines of JavaScript.

```yaml
    pre:
      nonce: |
        () => crypto.randomUUID()
      issuedAt: |
        () => new Date().toISOString()
    headers:
      Idempotency-Key: "{{pre.nonce}}"
      X-Issued-At: "{{pre.issuedAt}}"
```

Same mapping shape as `outputs:`, same one-value-per-name rule, same `undefined`-means-not-produced
rule. What it does not have is `path:` — there is no response to select from, which is the whole
reason the position exists.

- Signature is `(ctx) => …` and there is **no `res`**, exactly like a `when:` script and for the same
  reason. `functions:` helpers are in scope, unchanged.
- **`pre.*` is step-local, and that is the point.** Read it as `{{pre.<name>}}` inside the step that
  computed it; no other step can address it. To let a value leave the step, promote it with
  `from: pre`. `pre` is a reserved namespace, so a variable of that name is shadowed.
- Pipeline position: `depends` gate → `when:` → `pre:` → materialize → validate request → dispatch →
  `outputs:` → `assert:`.
- **`when:` runs first, so a step about to be skipped computes nothing** — and the consequence is
  that a `when:` condition cannot read a `pre` value.
- **Once per step, not once per attempt.** A retried step re-sends the values its first attempt
  computed. For a timestamp or a nonce that is wrong, and the honest workaround today is
  `maxAttempts: 1` on a step whose value must be fresh. A dataset run is unaffected: each iteration
  executes the step, so each computes its own.
- **A `pre:` script cannot see a sibling's value.** The scripts share one context, built before
  the first of them runs, so `ctx.pre` is empty in every one of them — computing a nonce on one
  line and signing `ctx.pre.nonce` on the next signs `undefined`, and nothing at run time says so —
  `bru flow validate` warns on a script mentioning `ctx.pre` (`pre-reads-sibling-value`), which is
  the only thing that catches it. Do both halves in a single `pre:` entry, or lift the shared part
  into a `functions:` helper both call.
  Declaration order decides which entries have already run when one throws, not what any of them
  can read.
- **A throw stops the remaining `pre:` scripts** — unlike `outputs:`, where siblings still extract.
  No request is built at all, so the siblings' values have nothing to be for. The step fails with
  `script-error` and the message names the position: `pre.signature threw: …`.
- Nothing is captured. `pre` values are not written to run artifacts, same as `outputs:`.
- A `uses:` step may declare `pre:`, and its values are in scope while `with:` arguments resolve.
  Inside the sub-flow, `pre.*` means that sub-flow's own steps' values, never the caller's.

## Outputs

```yaml
    outputs:
      paymentId: data.id                    # short form: a path into the body
      state:    { from: body, path: data.state }
      location: { from: headers, path: location }
      code:     { from: status }
      nonce:    { from: pre }               # a pre: value, under its own name
      traceId:  { from: pre, path: nonce }  # …or under another
      total:
        script: |
          (res, ctx) => res.body.data.items.reduce((sum, item) => sum + item.amount, 0)
```

`from` is `body` (default), `headers`, `status` or `pre`. A leading `$.` is stripped.

For `from: pre`, `path:` names which computed value to take and **defaults to the output's own
name**, so the ordinary case is one line; naming a value the step does not compute is
`unknown-pre-value`. `shared:` does not change — it publishes an output into a slot whatever the
output's source, so there stays one route out of a step and one place to read what leaves it.

**A `from: pre` output is extracted where every other output is: after the response.** A step whose
request never dispatched produces no outputs at all, `from: pre` included, even though the value was
computed before the attempt — one rule for when outputs exist beats a value that survives a
transport error.

> **The string form is a path, not an interpolation.** `outputs: { x: "{{pre.x}}" }` is read as a
> JSONPath into the response body, selects nothing, and leaves the output unset *silently*. Write
> `{ from: pre, path: x }`. The validator warns with `interpolation-in-output-path`.

Always available on any step without declaring: `steps.<id>.status`, `.ok`, `.skipped`,
`.duration`, and — where the step got a response — `.body` and `.headers`.

`.headers` keys are lower-cased, whatever case the server sent. A declared output named `body` or
`headers` wins over the raw response; the four built-ins above win over a declared output.

> **`.body` and `.headers` resolve, and are still the wrong habit.** They are an escape hatch: not
> drawn as graph edges, not checked before a run, and reported as an `undeclared-dependency` warning
> at the step that reads them. **Declare an output.**

### Connector files

`flows/connectors.yml` — in a collection, in the workspace, or both — gives an operation its default
outputs once. Any step targeting that operation gets them with no `outputs:` block.

```yaml
# flows/connectors.yml
version: 1
apis:
  auth-api: ../apispec/auth-v2.yml
connectors:
  auth-api#login:
    token:  data.access_token
    userId: data.user.id
```

Matching is by the document and `operationId` a reference **resolves to**, not by the alias string —
the connector file's aliases are its own. Layers, later winning: workspace file → collection file →
the step's `outputs:`. A step **extends** what it inherits; a same-named entry overrides, and `!...`
drops one:

```yaml
    outputs:
      state:     !...                 # drop the inherited entry
      paymentId: data.payment.id      # override it
```

`null` is not the removal token — that is `null-output`. Connector-supplied outputs are ordinary
declarations: drawn as data edges, held to the visibility rule, and their paths checked against the
operation's response schema (`unknown-output-path`). A sub-flow resolves its own connector files, not
its caller's. `bru flow validate` prints each step's resolved outputs and which file each came from,
which is how a step's outputs stay findable once they are no longer written on it.

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

`mode` takes any of the twelve Bruno has: `bearer`, `basic`, `apikey`, `wsse`, `awsv4`, `oauth1`,
`oauth2`, `digest`, `ntlm`, `akamai-edgegrid`, `none`, `inherit`.

**A flow in a collection inherits the collection's auth by default.** Resolution is first-match-wins:
the step's `auth:`, the binding's `auth:`, the collection's own configured auth, then none. So the
common collection flow declares no `authProfiles:` at all, and `auth: none` marks the one step that
must not carry those credentials. A workspace-scoped flow has no collection, so `auth: collection`
there is `unknown-auth-profile`.

A header the step declares beats the profile for that header alone — except under a signing mode
(`awsv4`, `digest`, `ntlm`, `oauth1`, `akamai-edgegrid`, `wsse`), where the signer overwrites what you
wrote or the handshake is skipped; `bru flow validate` warns `signed-header-override`. An OAuth2 token
fetch that fails fails the step as `transport-error` rather than sending the request unauthenticated.

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

**`req.*` is the request as sent** — `req.method`, `req.url` (query string included), `req.headers`,
`req.body` (a `urlencoded` body as an object; absent for multipart and binary). Assertions only: a
`when:` runs before the request exists, and reading `req.*` or `res.*` there is
`condition-reads-response`.

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

`ctx` also groups two of those flat variables so a script can say where a value came from:
**`ctx.env`** is the environment tiers the run was given (global environment, collection variables,
the selected environment, `--env-var` on top) and **`ctx.vars`** is this flow's own resolved `vars:`.
Additive — `ctx.env.x` and `ctx.x` are the same value — and a script's only: `{{...}}` has no `env.`
or `vars.` prefix. The two are disjoint: `ctx.env` holds only the environment tiers, `ctx.vars` only
the flow's `vars:`. A variable actually *named* `env` or `vars` is shadowed in a script and reachable
only as `{{env}}`; `bru flow validate` warns `shadowed-reserved-name`.

`bru flow run --sandbox safe|developer` selects the sandbox, `safe` (QuickJS) by default — `bru run`'s
own flag. In the app it follows the collection's security setting, and a workspace-scoped flow, which
has no collection, gets `safe`. Write against plain JavaScript and what you are handed.

### A shared library

Anything the same flow — or several flows — needs twice goes in `functions:`, and every script
position above can call it **by name**. No import at the call site: the library is composed into the
same program the script is evaluated in.

```yaml
functions:
  use:
    - ../shared/functions.yml   # a library document: a functions: block of its own
    - ./lib/text.js             # raw source: whatever it declares is in scope

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

- **`use:` is explicit** — nothing is picked up by convention, so what a flow's scripts can call is
  readable from the flow.
- **`.yml`/`.yaml` is a library document; any other extension is raw JavaScript.** Put a dozen
  helpers in one `.js` file rather than naming each one in YAML.
- **Order is `use:` first, depth-first, then the flow's own definitions; the last word on a name
  wins**, so a flow overrides a helper its library declares.
- **A name must be a JavaScript identifier**, and one called `res` or `ctx` shadows what the script
  is handed — `bru flow validate` reports both, and lists what resolved and where it came from.
- **A library does not cross a `uses:` boundary.** A sub-flow declares its own.

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
  password: { required: false, default: "{{DEFAULT_PASSWORD}}", secret: true }

exports:
  token: steps.authenticate.accessToken     # a full reference, not <step>.<output>

steps:
  - id: authenticate
    operation: auth-api#login
    body: { email: "{{params.email}}", password: "{{params.password}}" }
    outputs: { accessToken: data.token }
```

An export may also name a **whole slot**, which is how a value two exclusive branches might produce
leaves the flow — there is no step below both to point at:

```yaml
shared:
  chargeId: { writers: any }
exports:
  chargeId: shared.chargeId       # whichever branch ran; no sub-path — shared.chargeId.id is an error
```

Exports resolve after the flow ends, so every writer has settled. An unwritten slot exports `''` and
the caller runs; a step output that was never produced is absent and the caller's step skips.

Caller:

```yaml
  - id: sign_in
    uses: ./shared/sign-in.flow.yml
    with:
      email: "{{testEmail}}"
```

Or from the workspace root, which is what a collection flow reaching a shared library should use
rather than a `../../../` chain:

```yaml
  - id: sign_in
    uses: workspace:flows/shared/sign-in.flow.yml
    with: { email: "{{testEmail}}" }
```

Either form has to stay inside the flow's collection or workspace, or it is `path-outside-scope`.

Its exports read like any step's outputs: `{{steps.sign_in.token}}`. A step declares `operation:`
or `uses:`, never both. Recursion is refused.

**`secret: true` on a param keeps its *value* out of the run record.** Every run writes down what it
was started with, so a graph can show a past run its own inputs; a secret param is masked there and
in every report and event, and the mask is not length-preserving. The value is still sent to the API
in full — the flag governs what is reported, not what is requested. Mark any param that carries a
credential. There is no equivalent on `vars:`: a run records the entry flow's `vars:` as each
iteration resolved them and does not mask them, so a credential written directly into `vars:` is
recorded verbatim. Pass it as a secret param, or read it from the environment.

## Running

```bash
bru flow validate flows/checkout.flow.yml    # or a directory
bru flow run flows/checkout.flow.yml
```

| Option | Does |
|---|---|
| `--global-env name` | Run against a workspace environment — `<workspace>/environments/<name>.yml` |
| `--dataset path` | Run each selected flow over this file instead of the one it declares — and over one it declares none |
| `--strict` | Promote validation warnings to errors; a warning then exits 2 |
| `--sandbox safe\|developer` | Which sandbox flow scripts run in; `safe` by default |
| `--env-var name=value` | Override one variable (repeatable) |
| `--param name=value` | Supply a library flow's param (repeatable) |
| `--grep pattern` | Run only the selected flows the pattern matches |
| `--grep-invert pattern` | Drop the selected flows it matches; excluding wins |
| `--concurrency n` | Override `config.concurrency` |
| `--max-run-duration ms` | Bound the run; elapsing cancels it and exits 4 |
| `--bail` | Stop after the first failing flow |
| `--retry-failed [suite]` | Re-run the flows a past suite did not pass |
| `--retries n` | Re-run flows that did not pass, up to `n` more times |
| `--no-capture` | Do not write `.bruno-runs/` artifacts |
| `--capture-dir path` | Write captures elsewhere |
| `--reporter-junit` / `--reporter-junit-flows` / `--reporter-json` / `--reporter-html` | Write a report; the path is optional |
| `--verbose` / `--quiet` / `--silent` | Reporter volume |

`--grep` is a case-insensitive regular expression, tried whole against each of the flow's terms —
its path-relative id, `meta.name`, each `meta.tags` entry, `meta.testId`, and every step's `id`,
`name` and `meta:` value. There is no separate tag filter: `--grep '^smoke$'` is the exact-match
form. Exit codes are `0` pass, `1` a flow failed, `2` a flow did not run, `3` a bad command, `4`
cancelled.

`bru flow schema [--out <path>] [--format-version <n>]` emits the JSON Schema for the flow document,
for an editor's YAML language server; without `--out` it goes to stdout. Register the local tags too,
or the editor flags every valid `!file` and `!...`:
`"yaml.customTags": ["!file scalar", "!file mapping", "!... scalar"]`.

A collection's proxy and client certificates apply to a flow's requests exactly as they do to a
request's, and a `{{variable}}` in a proxy host or a certificate path, domain or passphrase is
resolved per request against that step's variables. A collapsed sub-flow's console line reads
`sub-flow (N steps)`. Piped output is never coloured, `FORCE_COLOR` included.

## Diagnostics

| Code | Meaning |
|---|---|
| `parse-error` | The YAML did not parse; nothing else is checked |
| `schema-violation` | A field of the wrong type, a value outside the set it accepts, or an unknown `version:` |
| `unknown-property` *(warning)* | A key the format does not have, with a did-you-mean on a near miss |
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
| `signed-header-override` *(warning)* | A step sets a header its signing-mode profile computes — `awsv4`, `digest`, `ntlm`, `oauth1`, `akamai-edgegrid`, `wsse` |
| `unknown-param` / `missing-param` | `with:` passes an undeclared param, or omits a required one |
| `unknown-pre-value` | An output takes `from: pre` naming a value the step does not compute |
| `unresolved-function-library` | A `functions.use:` entry did not resolve, or climbs outside the scope root |
| `invalid-function-name` | A `functions:` name is not a JavaScript identifier — it becomes a declaration |
| `invalid-api-color` *(warning)* | An `apis:` binding's `color:` is not `#rgb` or `#rrggbb` |
| `invalid-step-meta` *(warning)* | A step's `meta:` is not a mapping, so nothing it says reaches a report |
| `function-shadows-script-argument` *(warning)* | A function named `res` or `ctx`, which every script is handed |
| `pre-reads-sibling-value` *(warning)* | A `pre:` script reads `ctx.pre`, which is empty in every one of them |
| `interpolation-in-output-path` *(warning)* | An output path contains `{{…}}` — it is a path into the response, not an interpolation, and selects nothing |
| `status-opt-out-without-assertion` *(warning)* | `failOnStatusCode: false` with no `res.status` assertion — the step accepts any status, including the 500 it did not mean |
| `undeclared-dependency` *(warning)* | Reads `steps.x.body…` rather than a declared output |
| `duplicate-step-id` | Two steps share an id; the second overwrites the first |
| `invalid-depends` | A `depends:` mapping without exactly one non-empty `all:` or `any:` |
| `invalid-dependency-status` | A `depends.status` that is not `success`, `failed`, `skipped` or `cancelled` |
| `unknown-output-reference` | `{{steps.x.y}}` where `x` produces no `y` |
| `invalid-shared-entry` | A step's `shared:` names an undeclared slot, or an output the step does not produce |
| `unknown-export` | An `exports:` entry does not name an internal step's output or a declared slot, or reaches into a slot with a sub-path |
| `unknown-operator` | An operator the dialect does not have — the line is then asserted for truthiness and always passes |
| `condition-reads-response` | A `when:` reading `res.*` or `req.*`, which do not exist before the request is built |
| `unknown-field` | An inline `body`, `query` or `pathParams` key the operation's schema does not have |
| `unexpected-content-type` | `contentType:` on an operation declaring a single request media type |
| `unknown-media-type` | `contentType:` names a media type the operation does not declare |
| `ambiguous-media-type` | The operation declares several request media types and the step names none |
| `file-not-allowed` | `!file` where the media type does not take one |
| `missing-binary-body` | A raw payload operation with no `body: !file` and no `bodyFile:` |
| `missing-binary-part` | A `format: binary` part written as text, or a required one left out |
| `binary-file-options` | `filename:` or `contentType:` on a raw binary body — multipart-only |
| `misplaced-drop` | `!...` outside a step's `body`, `query`, `headers` or `pathParams` |
| `path-outside-scope` | A `!file`, `bodyFile:` or `dataset:` path that climbs out of the scope root |
| `missing-file` | A path that names no file that exists |
| `ambiguous-operation` | The bound document declares that `operationId` twice |
| `unresolved-subflow` | A `uses:` target that did not resolve |
| `invalid-subflow-field` | A field a `uses:` step may not carry — `retry:`, `body:`, `auth:` and the rest |
| `subflow-dataset` | `dataset:` in a sub-flow; only a top-level flow iterates |
| `shadowed-reserved-name` *(warning)* | A `vars:` or `params:` entry named for one of the reserved namespaces, or named `env` or `vars`, which every script reads as `ctx.env` and `ctx.vars` |
| `required-param-without-library` *(warning)* | A `required` param with no `default` in a flow not marked `meta.library: true` |
| `unused-output` *(warning)* | An output nothing in the flow reads |
| `unused-slot` *(warning)* | A declared slot nothing reads |
| `slot-without-writer` *(warning)* | A declared slot no step publishes into |
| `unreachable-step` *(warning)* | A step nothing can make eligible |
| `null-output` | An output written `name: null`, in a step or a connector file — `!...` is the removal token, `null` drops nothing |
| `invalid-connector-entry` | A `connectors.yml` entry that is not a mapping of outputs |
| `unknown-output-path` | A `connectors.yml` output path the operation's response schema does not have |

Two codes come from a *run* rather than from validation, so no amount of checking the file predicts
them: `capture-write-failed` *(warning)*, a step whose capture could not be written — the verdict
still stands, but that step has nothing to open afterwards — and `run-failed`, something escaping the
engine, which reports the run as failed with no steps at all.

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

- **`--dry-run`** — specified, scheduled for v2 (001 §19.1), not a flag; `bru flow run` rejects it
  as unknown. There is no `--env` either: on the command line a collection environment's values come
  from `--env-var` or the process environment. `bru flow validate` already prints the resolved-outputs
  listing `--dry-run` was also going to.
- **A scope's `.env` under `bru flow run`** — the app reads it, the CLI does not. Pass `--env-var` or
  set the process environment in CI.
- **Secret provenance under `bru flow run`** — the app tells the engine which values are secret and
  they are masked by value everywhere; the CLI does not, so under `bru` masking is by header name
  only (`config.redactHeaders`).

And one omission that is deliberate rather than pending: **a step's `headers:` are not checked against
the operation**, and will not be. `body:`, `query:` and `pathParams:` are. OpenAPI documents declare
header parameters rarely and never exhaustively, so the check would fire on correct flows.
