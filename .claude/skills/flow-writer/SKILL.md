---
name: flow-writer
description: Convert existing API tests (JavaScript, Python, Java, Go, Postman, shell) into
  Bruno API Flow `.flow.yml` files. Use when asked to migrate, port, or rewrite request-based
  tests as flows, or to author a `.flow.yml` from scratch.
---

# Converting API tests into flows

A **flow** is a `.flow.yml` file: a graph of API calls driven by an OpenAPI document, with
declared data paths between steps and assertions on each response. It runs in the Bruno app
and on the command line with `bru flow run`.

This skill is self-contained — it works in a repository that has no Bruno docs in it.

- `references/dsl.md` — the complete `.flow.yml` reference. **Read it before writing any YAML.**
- `references/mapping.md` — source-language patterns and what each becomes. Read it before
  converting anything non-trivial (polling, fixtures, parametrized tests, branches).

## The one precondition

**Every step names an operation in an OpenAPI document**: `operation: payments-api#createPayment`.
A flow cannot send an arbitrary URL. Before converting anything, establish that the API under test
has an OpenAPI document and that you can reach it.

1. Look for one: `openapi.yaml|json`, `swagger.json`, `apispec/`, `docs/api/`, a served
   `/openapi.json`, or a generator in the build (`nest`, `fastapi`, `springdoc`, `tsoa`).
2. Map each request the tests make — method + path — to an `operationId` in that document.
3. If a request has **no** matching operation, or the document has no `operationId` on it, stop
   and report it. Do not invent one: a flow naming an operation the document lacks fails
   validation with `unknown-operation`, and a flow you cannot run is worse than the test you
   replaced.

If there is no OpenAPI document at all, say so and stop. Offer the alternatives — generate one
from the service, or keep the tests as they are — and let the user choose. Do not convert
half the suite into flows that cannot run.

## Procedure

### 1. Survey before converting

Read the test suite and produce a short inventory *first*, before writing YAML:

- Each test file → the journey it exercises, as a sentence.
- The requests it makes, in order, with method and path.
- What it carries between requests (ids, tokens, cursors).
- Shared setup: login, tenant creation, fixture seeding — anything in `beforeAll` / `beforeEach`
  / a `conftest.py` fixture / a `TestBase` superclass.
- Anything that is **not** an HTTP request: database writes, file assertions, clock control,
  message-queue reads, `sleep`s that are not polling.

Show the inventory and the proposed flow files before writing them. One test file is usually one
flow; a suite sharing a login is usually one library flow plus several that use it.

### 2. Choose scope and layout

```
<workspace-or-collection>/flows/
  shared/sign-in.flow.yml         # library: params + exports, meta.library: true
  checkout-happy-path.flow.yml
  checkout-declined-card.flow.yml
```

Workspace scope for journeys crossing services; collection scope for one API. Shared setup
becomes a **library flow** (`meta.library: true`) invoked with `uses:` / `with:`.

### 3. Convert one test, completely

Work one test at a time and finish it — validate and run it — before starting the next. A pile
of half-converted flows is harder to fix than one at a time.

Follow `references/mapping.md`. The mappings that matter most:

| Source | Flow |
|---|---|
| Sequential awaited requests | Steps in order — no `depends:` needed, each step follows the one above |
| `const id = res.body.data.id` used by a later request | `outputs:` on the producer, `{{steps.<id>.<name>}}` in the consumer |
| `expect(res.status).toBe(201)` | `assert: [res.status eq 201]` |
| `beforeEach` login | A library flow, or a first step |
| `test.each` / `@pytest.mark.parametrize` | `dataset:` — one iteration per row |
| A polling `while` loop | `retry:` with `shouldRetry` |
| `if (x) {...} else {...}` | `when:` on each branch, or `depends: status:` |
| `try/finally` cleanup | A step depending on `status: [success, failed, cancelled]` |
| Computation between requests | `outputs: script:` — a function expression |
| A helper the tests share (`lastFour`, a signer, a decoder) | `functions:` — declared once, callable by name from every `script:` (dsl.md) |

### 4. Validate, then run

```bash
bru flow validate flows/checkout-happy-path.flow.yml
bru flow run flows/checkout-happy-path.flow.yml
```

Validation is static and fast; fix every error before running. Then run it against the same
environment the original test used. **A converted test is not converted until it has run and
passed** — the whole point is a flow that does what the test did.

If a run is not possible here (no environment, no credentials), say so explicitly in the report
rather than implying the flows are verified.

### 5. Re-read what you wrote, and take the flow apart

A conversion follows the source line by line, and the source is a *program*: it attaches a token to
every request because that is what a client object does, it threads an id through six calls because
that is what a local variable does. Those become correct YAML that reads like a transcript of the
program rather than a description of the journey — and the difference is invisible while writing,
because each line was right when you wrote it.

So this is a separate pass, with the file open. **Read the flow you wrote, top to bottom, as if
someone else had written it**, and look for what only shows up whole. Re-validate after each change,
and keep the ones that leave the flow saying the same thing.

| What you see | What it usually wants to be |
|---|---|
| The same `headers:` entry on many steps — an `Authorization`, an api key, a tenant header | An `authProfiles:` entry, named by the api binding's `auth:`. The steps that must go out without it say `auth: none` |
| A credential produced on two branches, read from `steps.<branch>.token` on each | One slot, `writers: any`, read once from the auth profile |
| `{{steps.a.x}}` and `{{steps.b.x}}` used for the same logical value in different places | A slot, so the reader stops naming the branch |
| A `script:` whose whole body copies a value — `(res, ctx) => ctx.shared.password` | Delete it: `exports:` and every reference take `shared.<slot>` and `steps.<id>.<output>` directly |
| The same literal in several steps | A `vars:` entry |
| Two identical body blocks | A YAML anchor: `&address` once, `*address` after |
| `retry:` or a flag repeated on most steps | `config:` — a step's own value still overrides it |
| A step whose only job is to fetch what the previous step already returned | An `outputs:` entry on that previous step |
| A `shouldRetry` that reads `res.body…` with no guard | `(res) => !res \|\| …` — a poll is where connections drop, and a transport error hands the predicate `undefined` |

Two rules for this pass. **An optimization that changes what the flow proves is not one** — if
collapsing something drops an assertion or a request the original made, leave it. And **only rewrite
what you can still validate**: run `bru flow validate` after each change, not once at the end, so a
failure names the change that caused it.

Name the collapses in the report — "twelve `Authorization` headers became one auth profile" — because
they are the difference between a converted test and a flow someone will want to edit later.

### 6. Report what did not convert

Always end with this, even when everything converted. For each item: what it was, why it does not
fit, and what you did instead.

The things that genuinely do not fit, and what to do:

| Not convertible | Do this |
|---|---|
| Non-HTTP setup (DB seeding, queue reads, file writes) | Leave it in the original suite, or move it to a fixture the flow reads with `!file` |
| Iterating over a list from a *response* (`for (const id of res.body.ids)`) | Not expressible — a flow's fan-out is static. Keep that test, or assert on the list instead |
| Arbitrary code between requests | Small transforms → `outputs: script:`; a helper used more than once → `functions:`. Anything larger stays in the original test |
| Assertions on things other than the response (logs, DB rows, emails) | Not expressible |
| Tests whose value is the code path, not the API sequence | Do not convert; say why |

Never fake these. A flow with a comment saying "the DB check went here" is a test that silently
stopped checking.

## Rules that catch people out

Read `references/dsl.md` for the full set. These four cause the most rework:

1. **`{{steps.x.body.field}}` does not work.** Declare an output and reference that. Raw response
   access is drawn in the graph and warned about by the validator, and then resolves to nothing at
   run time — the step reading it is skipped with `unresolved-dependency`.
2. **A step may only reference a step it depends on.** Referencing a parallel branch is a
   validation error. If either of two branches might produce the value, declare a `shared:` slot —
   and when those branches *exclude* each other, declare it `writers: any`, because no step can
   descend from every writer when only one of them ever runs.
3. **Every `script:` is a function expression** — `(res, ctx) => …`, not a bare expression. A helper
   two scripts share belongs in `functions:`, where it is in scope by name — copying it into both is
   the duplication this whole exercise removes.
4. **Unknown keys are silently ignored.** A misspelled field does nothing and warns about nothing,
   so check every field against the reference rather than assuming it took effect.

## Style

- One flow per journey, named for the journey: `checkout-declined-card.flow.yml`.
- `meta.description` explains what the flow proves and any environment it needs. It is the only
  prose the file carries — there is no per-step `description:` field, so use `name:` for a step
  label and YAML comments for anything longer.
- Declare outputs even where a raw read would have worked: they are what the graph draws as data
  edges, and they are what makes the flow readable as a diagram.
- Keep assertions at the level the original test had. Converting `expect(res.status).toBe(200)`
  into six assertions about the body is a different test.
- Do not carry over test-framework scaffolding: describes, tags, retry-the-whole-test wrappers.
