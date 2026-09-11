# 004 — Per-API rate limiting

**Status:** **Accepted; implemented.** The five decisions are settled and recorded in §2–§6, and all
of them are built — the engine's limiter, the DSL, the connector-file default, and `--no-rate-limit`.
§9 holds what is still open, none of it blocking.
**Owner:** Jake Campbell
**Last revised:** 2026-09-10

A flow can declare how fast it is willing to call an API, and the run does not exceed it. This spec
is about where that number lives, what it is keyed on, and what the run does when two files disagree.

## 1. Where we start

**Nothing bounds the rate.** `config.concurrency` bounds how many requests are *in flight*
(001 §9.2), `dataset.parallel` multiplies iterations, and 003's `--flows N` multiplies flows — the
worst case is `N × concurrency` requests at once, with no floor on how close together they go out.

**The only tool an author has is a retry predicate.** 001 §8.2's example is literally
`shouldRetry: (res) => res.status === 429` — which answers *the server said no*. Nothing answers
*don't make it say no*.

**Time is already injected.** `Clock` (001 §13.2) is how retry delays and `maxRunDuration` are
driven, and the conformance harness supplies a virtual one. Any waiting a limiter does has to go
through it, or it is untestable and uncancellable.

**A binding already resolves to a document.** `resolveSpecSource` is what `SpecLoader` caches on and
what the app's watcher watches, so there is already one canonical string per bound API.

## 2. Decision one — whose limit

| Option | What it means |
|---|---|
| **A. Per run** | One set of buckets per `runFlow`, shared by its steps, sub-flows and iterations. `--flows 4` runs four sets, and the aggregate is four times the declared rate. |
| **B. Per process** | One set shared by every flow in the invocation, so `--flows N` no longer multiplies. Needs a registry outside the run. |
| **C. Per run, with an opt-in shared cap** | A per-run default and a suite-wide ceiling on top. |

**Decided: A.** This is a *client-side politeness limit*, and its most important property is that a
flow means the same thing wherever it is invoked — run alone, run in a selection of forty, invoked
as a sub-flow, or opened in the app. A bucket shared across flows would make one flow's pacing
depend on what else happened to be running beside it, which is the same non-reproducibility 003 §3
rejects elsewhere.

It also keeps the multiplication honest rather than hidden: as with `N × concurrency`, the worst
case is `N ×` the declared rate, and it is written down (here) rather than quietly handled. A user
who needs an absolute ceiling has `--flows 1`, which is the default.

## 3. Decision two — keyed on what

| Option | What it means |
|---|---|
| **A. The alias** | `apis.partner-api` is one bucket. Flow-local: a sub-flow calling the same service under another name gets a second allowance. |
| **B. The resolved document** | `resolveSpecSource(binding.source, flow.file)` is the key. Two aliases for one file are one bucket. |
| **C. The resolved origin** | Parse `baseUrl` and key on the host. |

**Decided: B**, which is `connectors.ts`'s identity argument one layer up — an operation's default
outputs are matched by the document a binding resolves to, "because aliases are flow-local, so keying
on them would silently miss every flow that named the spec differently." A rate limit has exactly
that shape and exactly that failure.

C was rejected because the engine parses no URLs today and `baseUrl` is interpolated per step, so a
key derived from it can change between iterations — and because an OpenAPI document *is* the unit a
service publishes a rate limit for. Two environments of one service described by one document share
a bucket under B; that is the conservative direction, and `--no-rate-limit` covers the case where it
is wrong.

Two consequences worth stating. A binding that declares no `rateLimit:` is still paced when another
binding in the same run declared one for the same document — a sub-flow is not a way around its
caller's limit. And spec sources are not normalized beyond path resolution, so the same remote
document fetched under two different query strings is two buckets, exactly as it is two spec loads.

## 4. Decision three — declared, or discovered

| Option | What it means |
|---|---|
| **A. The declared limit only** | The bucket is what the file says. A 429 is an ordinary status the author may retry. |
| **B. Honour `Retry-After`** | A 429 with the header pauses that API for the stated interval, and is retried by default. |
| **C. Adaptive** | 429s shrink the effective rate; successes restore it. |

**Decided: A.** A limit discovered from rejections is a limit you only find by being rude first, and
both B and C make a run's rate depend on what the server did the last time — two identical
invocations would pace differently. B additionally changes a default: 001 §11.2 does not retry a 429
unless the flow asks, and a spec about pacing is the wrong place to alter what gets retried.

Nothing here forecloses B. `shouldRetry` already expresses it per step today.

## 5. Decision four — where it is authored

**Decided: on the binding, with a connector file as the shared default.**

```yaml
apis:
  partner-api:
    source: ../apispec/partner-v1.yml
    rateLimit:
      requests: 100     # required, a whole number of at least 1
      per: minute       # second | minute | hour — default second
      burst: 10         # default 1, which is strict even spacing
```

The binding is where 001 §6.2 already puts everything that is true of an API rather than of a step —
`baseUrl`, `auth`, `defaultHeaders`, and `color` on the same argument that "the binding is the thing
being coloured." A rate is the same kind of fact.

`flows/connectors.yml` takes the identical key in its own `apis:` block, so a team declares a
service's rate once for every flow under the scope — the same problem §8.5's connectors exist for,
and matched on the same identity. **A flow's own declaration wins outright**; layer order
(workspace → collection) decides only which default applies.

`requests`/`per` rather than a bare number: APIs publish "100 per minute", and a `requestsPerSecond`
of `1.6667` is a worse spelling of the same fact with no room for a burst allowance. The shape is a
token bucket, so `burst` is the bucket's capacity — at its default of 1 the flow opens at the rate
and stays there, which is what an author means by "no faster than N per minute".

## 6. Decision five — two files, two rates

Within one run, two flows can bind one document and ask for different rates.

| Option | What it means |
|---|---|
| **A. First to dispatch wins** | Whichever step got there first creates the bucket. |
| **B. Strictest wins** | The bucket takes the longer interval, and at equal intervals the smaller burst. |
| **C. Refuse** | A disagreement is a validation error. |

**Decided: B**, and `bru flow validate` emits a `conflicting-rate-limit` **warning** either way.

A is scheduling-dependent — which step reaches dispatch first depends on network timing, so two runs
of one flow would pace differently. C makes a disagreement about politeness block a run, which is
disproportionate; under `--strict` it would fail CI. B is order-independent, never exceeds either
declared limit, and is the answer a politeness limit wants.

Buckets are therefore registered as each flow is *read*, not at first dispatch, so the merge has
seen every declaration before anything goes out.

## 7. Where the token is taken

**Immediately before the request, inside the step's concurrency slot, on every attempt.**

- **Not at the top of the attempt**: 001 §10.1's request validation runs first and can refuse
  without sending, and a token spent there would pace a request that never went out.
- **Not before the concurrency budget**: a token taken early and then queued behind `concurrency`
  would let tokens clump and dispatch in a burst. The guarantee only exists at the wire.
- **Every attempt, retries included.** A poll that ignored its limit while retrying would break it
  exactly when the API is already saying it is under strain.

**The tradeoff, recorded rather than fixed:** a step waiting for a token holds one of
`config.concurrency`'s slots, so a heavily limited API can head-of-line-block steps bound for
another. This is the shape that already exists — the budget wraps the whole retry loop including
§11.1's delays, so a long poll holds a slot today (001 §9.2). A per-document queue outside the
budget would fix it, at the cost of a second scheduler and the sub-flow deadlock hazard §9.2 argues
about. Not now; see §9.

**A wait the run has no time for is refused rather than served.** §11.3's deadline is polled at
scheduling points, so a `requests: 1, per: hour` bucket would otherwise sleep an hour past a run
that had already run out of time. The limiter is given whatever remains of the step's `maxDuration`
and the run's `maxRunDuration`, sleeps that much, and declines — the step then ends on its budget,
having sent nothing. A cleanup step is the exception: it runs after the run has stopped, so the
grace window bounds it instead.

**Reporting keeps the two apart.** `StepResult.rateLimitWaitMs` sits beside `durationMs` rather than
being taken out of it — the step's wall time already includes retry delays, and removing one kind of
waiting and not the other would leave one field meaning two things. `StepCapture.durationMs` is
net of the wait, because that number answers "how long did the API take". `bru flow run` prints
`+250ms paced`; the app shows it beside the step's duration.

## 8. The escape hatch

`--no-rate-limit` (and `overrides.rateLimit = { enabled: false }`) ignores every declared limit, for
the run pointed at a local mock that has nothing to be polite about.

There is deliberately **no flag that imposes or tightens a rate**. A limit is a property of the
service and belongs in a file that is read the same way by every host; a flag that changed it would
be a second place to look for what a run actually did.

## 9. Settled, and still open

- **Head-of-line blocking (§7).** Worth revisiting only with a flow that actually suffers it: a
  heavily limited API beside a fast one, at a concurrency high enough to matter.
- **`Retry-After` (§4).** Deliberately out, and cheap to add later as an opt-in on the binding.
- **A workspace-wide limit.** `flows/connectors.yml` is already scope-wide; nothing asks for one
  above it yet.
- **Showing the limit in the graph.** `FlowDescription.apis` could carry the effective rate, but it
  is built from the entry flow only and no surface consumes it yet.

## 10. Implementation status

| Part | Where | State |
|---|---|---|
| `rateLimit:` on a binding (§5) | `bruno-max-flow` — `schema/v1.ts`, `document.ts` | **done** |
| The bucket, keyed on the resolved document (§3) | `bruno-max-flow/src/ratelimit.ts` | **done** |
| Run-scoped, registered at flow load (§2, §6) | `run.ts` — `RunState.limiter`, `loadFlow` | **done** |
| Strictest-wins merge (§6) | `ratelimit.ts` — `register` | **done** |
| The token, taken before each dispatch (§7) | `run.ts` — the `dispatch` closure | **done** |
| A wait bounded by the run's remaining time (§7) | `ratelimit.ts` — `maxWaitMs` | **done** |
| Connector-file defaults (§5) | `connectors.ts` — `apisWith` | **done** |
| `invalid-rate-limit`, `conflicting-rate-limit` (§6) | `validate.ts`, `validate/connectors.ts` | **done** |
| `--no-rate-limit` (§8) | `bruno-cli/src/fork/flow/index.js` | **done** |
| `+Nms paced` in the console and the app (§7) | `fork/flow/output.js`, `FlowTabPane/StepDetail` | **done** |

`ratelimit.spec.js` is the one to read before touching any of it: every assertion is on the sequence
of durations the run asked the injected clock for, because a bucket that did nothing and a bucket
that paced perfectly send the same requests in the same order and differ only in what was waited
between them. `rate-limit.integration.spec.js` does the same against a real server and a real clock,
where the assertions are lower bounds — a loaded machine is always slower than the schedule, never
faster, which is the whole guarantee.

## 11. Upstream touchpoints

**None.** Every file this spec changes is fork-owned — `packages/bruno-max-flow`,
`packages/bruno-cli/src/fork/flow`, `packages/bruno-app/src/fork/flows`. `bru flow` already
auto-registers through `commandDir`, and `bruno-electron` forwards `overrides` opaquely, so neither
host needed an edit. This is the outcome `.claude/rules/architecture.md` asks a manifest to
demonstrate: a feature that owns its own format and its own package costs nothing at the next merge.

## 12. Non-goals

- **Server-side rate limiting, or verifying that an API enforces its own.** Bruno is a client.
- **Sharing a limit across processes or machines.** §2's per-run scope is the whole of it.
- **Adaptive or discovered rates.** §4.
