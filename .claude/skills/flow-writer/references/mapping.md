# Source patterns → flow constructs

Worked conversions. JavaScript (jest/vitest/supertest/axios) and Python (pytest/requests/httpx)
are shown; Java, Go, C# and shell suites follow the same shapes.

Read `dsl.md` for the field reference. This file is about *what maps to what*.

---

## 1. A sequence with data carried between calls

The single most common shape, and the one flows model best.

```js
test('creates and settles a payment', async () => {
  const created = await api.post('/payments', { amount: 9900, currency: 'USD' });
  expect(created.status).toBe(201);

  const id = created.data.data.id;

  const settled = await api.post(`/payments/${id}/settle`);
  expect(settled.status).toBe(200);
  expect(settled.data.data.state).toBe('settled');
});
```

```python
def test_creates_and_settles_a_payment(api):
    created = api.post("/payments", json={"amount": 9900, "currency": "USD"})
    assert created.status_code == 201

    payment_id = created.json()["data"]["id"]

    settled = api.post(f"/payments/{payment_id}/settle")
    assert settled.status_code == 200
    assert settled.json()["data"]["state"] == "settled"
```

```yaml
version: 1

meta:
  name: Creates and settles a payment

apis:
  payments-api: ../apispec/payments-v3.yml

steps:
  - id: create_payment
    operation: payments-api#createPayment
    body:
      amount: 9900
      currency: USD
    outputs:
      paymentId: data.id                 # the `const id = ...` line
    assert:
      - res.status eq 201

  - id: settle_payment                   # no depends: — it follows the step above
    operation: payments-api#settlePayment
    pathParams:
      paymentId: "{{steps.create_payment.paymentId}}"
    assert:
      - res.status eq 200
      - res.body.data.state eq settled
```

**Every local variable that crosses a request boundary becomes an `outputs:` entry.** A variable
used only inside one request's body is just a literal or a `vars:` entry.

---

## 2. Shared setup — `beforeEach`, fixtures, base classes

```js
let token;
beforeAll(async () => {
  const res = await api.post('/auth/login', { email: USER, password: PASS });
  token = res.data.data.access_token;
});
```

```python
@pytest.fixture(scope="session")
def token(api):
    res = api.post("/auth/login", json={"email": USER, "password": PASS})
    return res.json()["data"]["access_token"]
```

Two options, in order of preference:

**A library flow**, when more than one test uses it:

```yaml
# flows/shared/sign-in.flow.yml
version: 1
meta: { name: Sign in, library: true }

apis:
  auth-api: ../../apispec/auth-v1.yml

params:
  email:    { required: true }
  password: { required: false, default: "{{TEST_PASSWORD}}" }

exports:
  token: steps.authenticate.accessToken

steps:
  - id: authenticate
    operation: auth-api#login
    auth: none
    body: { email: "{{params.email}}", password: "{{params.password}}" }
    outputs: { accessToken: data.access_token }
```

```yaml
# in each flow that needs it
apis:
  payments-api:
    source: ../../apispec/payments-v2.yml
    auth: user-token                   # every step on this binding, unless it says `auth: none`

authProfiles:
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

steps:
  - id: sign_in
    uses: ./shared/sign-in.flow.yml
    with: { email: "{{TEST_USER}}" }

  - id: create_payment
    operation: payments-api#createPayment   # no headers, no auth: — it inherits the binding's
```

**Bind the profile to the api, not to each step.** The source attaches a token per request because
that is what a client object does; a flow says it once. A step that must go out unauthenticated —
the login itself, a health probe — says `auth: none`, which is the only place authentication is
mentioned again.

**When either of two branches produces the credential**, the profile reads a slot instead of a step,
and the slot says its writers are alternatives:

```yaml
shared:
  sessionToken: { writers: any }     # readers descend from ONE writer — only one branch runs

authProfiles:
  user-token:
    mode: apikey                     # `Token <t>`, not `Bearer <t>`
    key: Authorization
    value: "Token {{shared.sessionToken}}"
    placement: header
```

Each producing step adds `shared: [sessionToken]` beside the output it already declares. Without
`writers: any` this is a `slot-not-downstream` error: the default rule asks a reader to descend from
*every* writer, which nothing can when the writers exclude each other.

**A first step**, when only this flow needs it — same shape without the indirection.

Credentials themselves stay out of the file: `{{TEST_USER}}` reads the environment, and
`--env-var` overrides it per run.

---

## 3. Assertions

| Source | Flow |
|---|---|
| `expect(res.status).toBe(201)` | `- res.status eq 201` |
| `assert res.status_code == 201` | `- res.status eq 201` |
| `expect(body.state).toBe('settled')` | `- res.body.data.state eq settled` |
| `expect(body.items).toHaveLength(3)` | `- res.body.data.items length 3` |
| `expect(body.id).toBeDefined()` | `- res.body.data.id isDefined` |
| `expect(list).toContain('x')` | `- res.body.data.list contains x` |
| `expect(loc).toMatch(/^\/payments\//)` | `- res.headers.location matches ^/payments/` |
| `assert body["state"] in ("a", "b")` | `- res.body.data.state in [a, b]` |
| `expect(res.ok).toBe(true)` | Usually nothing — `failOnStatusCode` already fails on >= 400 |

Keep the assertion set the original had. A test that only checked the status becomes a step that
only checks the status; `validateSchema` is already on, so the response shape is checked anyway.

Assertions on **things other than the response** — a database row, a log line, an email — have no
flow equivalent. Report them; do not silently drop them.

---

## 4. Polling loops

```js
let state = 'pending';
for (let i = 0; i < 30 && state === 'pending'; i++) {
  await sleep(2000);
  const res = await api.get(`/payments/${id}`);
  state = res.data.data.state;
}
expect(state).toBe('settled');
```

```python
for _ in range(30):
    time.sleep(2)
    res = api.get(f"/payments/{payment_id}")
    if res.json()["data"]["state"] != "pending":
        break
assert res.json()["data"]["state"] == "settled"
```

```yaml
  - id: await_settlement
    operation: payments-api#getPayment
    pathParams:
      paymentId: "{{steps.create_payment.paymentId}}"
    retry:
      maxAttempts: 30
      delay: 2000
      shouldRetry: |
        (res) => res.body.data.state === 'pending'
    assert:
      - res.body.data.state eq settled
```

The loop bound becomes `maxAttempts`, the sleep becomes `delay`, the loop condition becomes
`shouldRetry`, and the assertion after the loop stays an assertion. Retry is evaluated *after*
assertions, so the last attempt's failure is what fails the step (`retries-exhausted`).

Exponential backoff in the source (`delay *= 2`) becomes `backoff: exponential`.

---

## 5. Parametrized tests

```js
test.each([
  { tier: 'free',    limit: 10 },
  { tier: 'premium', limit: 100 }
])('enforces the $tier limit', async ({ tier, limit }) => { ... });
```

```python
@pytest.mark.parametrize("tier,limit", [("free", 10), ("premium", 100)])
def test_enforces_the_limit(api, tier, limit): ...
```

```yaml
dataset: ./fixtures/tiers.csv        # tier,limit
                                     # free,10
                                     # premium,100
steps:
  - id: create_account
    operation: accounts-api#createAccount
    body: { tier: "{{row.tier}}" }
    assert:
      - res.body.data.limit eq row.limit    # `row` is a reserved root: a bare reference
```

One iteration per row, independent of each other. `.json` and `.yml` datasets work the same way
and are better when a row holds nested values.

**CSV cells are typed, not strings** — `10` arrives as the number 10, `true` as a boolean — so
`eq` (which is strict `===`) compares them against a JSON response without coercion.

**Only convert to a dataset when the cases run the same sequence.** Parametrized tests that branch
internally are separate flows.

---

## 6. Branches

```js
const res = await api.post('/charges', { method });
if (res.status === 402) {
  const retry = await api.post('/charges', { method: 'fallback' });
  expect(retry.status).toBe(201);
} else {
  expect(res.status).toBe(201);
}
```

Two shapes, depending on what decides the branch.

**An expected alternative path** — the source treats both outcomes as a pass, so the first step
must not fail the run. Turn off `failOnStatusCode` and branch on the status it returned:

```yaml
  - id: charge_card
    operation: payments-api#createCharge
    body: { method: "{{row.method}}" }
    failOnStatusCode: false            # a 402 is an expected outcome here, not a failure
    outputs: { chargeId: data.id }

  - id: charge_fallback
    operation: payments-api#createCharge
    when: steps.charge_card.status eq 402
    body: { method: fallback }
    outputs: { chargeId: data.id }
```

Note what `failOnStatusCode: false` does to the *other* branch: with it off, `depends: status:
[failed]` would never fire, because the 402 step succeeded. The two mechanisms do not compose —
pick by what the source meant.

**A genuine failure you react to** — `depends: status:`. Use this when the source expected the step
to succeed and something else runs when it does not. The failing step still fails the run, which is
usually what you want for a cleanup or a diagnostic step:

```yaml
  - id: capture_diagnostics
    operation: payments-api#getChargeDiagnostics
    depends:
      - on: charge_card
        status: [failed]
```

**On a value** — `when:`:

```yaml
  - id: verify_premium
    when: steps.create_account.tier eq premium
```

When both branches produce the same value the rest of the flow needs, declare a slot
(`shared:`) — a step cannot reference a branch it does not depend on. If the readers are *inside*
the branches rather than below both, declare the slot `writers: any`; the default rule wants every
writer upstream of every reader, which is impossible when only one branch runs. §2 shows the case
this comes up in most: a session token produced either way.

---

## 7. Cleanup — `afterEach`, `try/finally`

```js
afterAll(async () => { await api.delete(`/payments/${id}`); });
```

A step that depends on every outcome of the step it cleans up after:

```yaml
  - id: delete_payment
    operation: payments-api#deletePayment
    depends:
      - on: settle_payment
        status: [success, failed, cancelled]
    pathParams:
      paymentId: "{{steps.create_payment.paymentId}}"
```

Include `cancelled` so cleanup still runs when the run is cancelled; `config.cleanupGrace`
(default 30s) is how long those steps get after a cancel.

---

## 8. Computation between requests

```js
const total = res.data.data.items.reduce((sum, i) => sum + i.amount, 0);
await api.post('/invoices', { total });
```

```yaml
  - id: read_cart
    operation: shop-api#getCart
    outputs:
      total:
        script: |
          (res) => res.body.data.items.reduce((sum, item) => sum + item.amount, 0)

  - id: create_invoice
    operation: billing-api#createInvoice
    body: { total: "{{steps.read_cart.total}}" }
```

Small transforms fit an output script. Anything longer — building a payload from three responses,
signing a request, deriving state — is a sign the test is doing more than exercising the API, and
belongs where it is.

---

## 9. Request shapes

| Source | Flow |
|---|---|
| `api.post(url, json)` | `body:` (the operation supplies method and path) |
| `?expand=customer` | `query: { expand: customer }` |
| `/payments/{id}` | `pathParams: { paymentId: "{{...}}" }` — never string-build the URL |
| `headers: { 'Idempotency-Key': uuid() }` | `headers: { Idempotency-Key: "{{$randomUUID}}" }` |
| `Authorization: Bearer ${token}` | An `authProfiles` entry + `auth:` on the step |
| `files={'scan': open('scan.pdf','rb')}` | `body: { scan: !file ./fixtures/scan.pdf }` |
| `data=urlencode(...)` | `body:` as a mapping; the operation's media type decides the encoding |
| A large inline JSON payload | `bodyFile: ./fixtures/order.json` |
| `timeout=30` | `timeout: 30000` (ms) |

**Never build a URL by hand.** A flow addresses an operation, and the path comes from the OpenAPI
document; `pathParams:` fills its placeholders.

You usually write **less** body than the source did: the engine seeds the body from the request
schema, so only the fields the test actually varies need to appear.

---

## 10. What has no equivalent

Report these; do not approximate them.

| Source | Why not |
|---|---|
| `for (const id of res.body.ids) await api.delete(...)` | Fan-out over a *response* value. A flow's graph is static — `dataset:` iterates a file, not a response |
| DB seeding / direct SQL, queue publishes, filesystem setup | A flow only sends HTTP |
| Assertions on logs, DB rows, emails, metrics | Same |
| Mocked or stubbed HTTP (nock, responses, WireMock) | A flow calls a real service |
| `jest.useFakeTimers()`, clock control | No equivalent |
| Tests asserting client-library behaviour (retries, serialization) | The subject is the client, not the API |
| Randomized/property-based tests | No generator; a `dataset:` of fixed rows is a different test |

For each, say what it was and what you did: left in place, replaced by a fixture, or dropped with
the user's agreement.

---

## Conversion checklist

Per test converted:

- [ ] Every request maps to a real `operationId` in a bound OpenAPI document
- [ ] Every cross-request value is a declared `outputs:` entry, not `steps.x.body…`
- [ ] Every original assertion is present, or reported as not convertible
- [ ] Setup shared by several tests is a library flow, not copy-paste
- [ ] Polling is `retry:` + `shouldRetry`, not a step repeated by hand
- [ ] Cleanup depends on `[success, failed, cancelled]`
- [ ] Credentials come from variables, never literals in the file
- [ ] The optimization pass has been run over the finished file, and the collapses are in the report
- [ ] No `headers:` entry repeats across steps that an api binding's `auth:` could carry
- [ ] Every `shouldRetry` survives being handed `undefined` — a transport error gives it no response
- [ ] `bru flow validate` is clean
- [ ] `bru flow run` passes against the same environment the test used
- [ ] Anything that did not convert is in the report
