# 006 — Step loops

**Status:** **Implemented** in `bruno-max-flow`, in the console of `bru flow run`, and in the run
view of the app (002). The builder (005) does not edit a `loop:` block yet, and it leaves one as it
is. §12 holds that item.
**Owner:** Jake Campbell
**Last revised:** 2026-10-01

A step can carry a `loop:` block. The engine then builds the request again for each value, with a
new `loop.*` namespace in scope. The loop ends when an `until` condition is true or the values end.
This spec says what a loop does, what it publishes, and when it fails.

## How to read this

| If you are… | Read |
|---|---|
| **Writing a flow with a loop** | §2 the block · §3 the iteration · §4 what the step publishes |
| **Implementing or changing the engine** | §3–§8 in order, then §10 for the checks |
| **Reading a failed loop in a report** | §4 · §5 · §9 |
| **Reviewing a change** | §11 first. If the option is there, the argument was made |

**The contracts** are the parts that other things depend on:

| Contract | Where | Consumed by |
|---|---|---|
| The `loop:` block and the `loop.*` namespace | §2, §3 | Committed flows, editors |
| `steps.<id>.matched`, `iterations`, `count`, `index` | §4 | Flows that decide on a loop |
| The reason `loop-max-reached`, and `StepResult.loop` | §4, §9 | Reporters, CI |
| The capture layout `<step>/iteration-<n>/attempt-<n>.json` | §8 | CI artifacts, readers of a run |
| The event `step:iteration` | §8 | The console, hosts |
| The diagnostic codes of §10 | §10 | `--strict`, editors |

---

## 1. Where we start

**A step sends one request, and a retry sends it again.** Four facts of the engine make this so:

- `executeFlow` runs `pre:` one time for a step, after `when:`.
- `materialize` builds the request one time for a step.
- Each attempt sends the same materialized request.
- `wantsRetry` gives `shouldRetry` the number of the attempt and the outputs of the attempt. The
  request cannot read them.

`retry:` can wait for a condition. It cannot change what it sends. A flow that must send a different
request for each value has no way to say so.

The functional tests of a partner API have five loops that a flow cannot express. Each one was found
when the tests were converted to flows.

| The loop | What it needs |
|---|---|
| `retrieve_or_create_partner`: GET each vendor until one has a partner member. If none has one, create a vendor. | A list, a stop at the first match, and a "no match" result |
| `find_intl_matching_partnership`: read vendor pages from the last to the first. For each candidate, call the matching API until one matches. | A cursor (`links.prev`), then a list with a stop condition |
| `get_ledger_objects_for_line_items`: read ledger-object pages until enough items match a filter. | A cursor (page + 1), and results collected across pages |
| `test_create_non_usd_international_vendor`: one ledger RPC for each match. Every call must pass. | A list, every item, no stop |
| `test_ledger_object_search_paging`: several requests for each ledger object key. | A list, and a sub-flow for each item |

The flows use workarounds now. They read the first candidate, or one large page. This makes them
weaker than the tests that they replace. `tests/conformance/fixtures/flows/loops/` holds one flow for
each loop. Each flow validates with no diagnostic and runs (L10.1).

## 2. The loop block

A step has an optional `loop:` block. It is valid on an `operation:` step and on a `uses:` step.

```yaml
- id: find_vendors
  operation: Backend#listPartnerships
  query: { partnership_type: vendors }
  outputs:
    candidateIds:
      script: |
        (res) => res.body.data
          .filter((p) => !(p.attributes.is_customer && p.attributes.is_vendor))
          .map((p) => p.id)

- id: find_vendor_with_member
  operation: Backend#getPartnership
  loop:
    over: "{{steps.find_vendors.candidateIds}}"
    as: vendorId
    until: |
      (res, ctx) => getIncludedPartnershipMembers(res).length > 0
    max: 25
  pathParams:
    pk: "{{loop.vendorId}}"
  outputs:
    partnershipId: data.id

- id: create_vendor
  operation: Backend#createPartnership
  when: steps.find_vendor_with_member.matched eq false
```

A cursor loop uses `start:` and `next:` in place of `over:`. This loop reads the pages of vendors
from the last to the first:

```yaml
- id: search_vendor_pages
  operation: Backend#listPartnerships
  loop:
    start: "{{steps.list_vendors.lastPage}}"
    next: |
      (previous, ctx) => previous.prevPage || null
    as: page
    until: |
      (res, ctx) => ctx.outputs.candidate != null
    max: 50
  query:
    is_vendor: true
    page[number]: "{{loop.page}}"
  outputs:
    prevPage:
      script: "(res) => parseInt(decodeURIComponent(res.body.links.prev || '').split('page[number]=')[1], 10) || null"
    candidate:
      script: "(res) => pickCandidate(res.body.data)"
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `over` | A list, or one whole reference to a list | One of `over` / `start` | The values, one for each iteration. The reference is usually a declared output. |
| `start` | A value, or a reference | One of `over` / `start` | The first value of a cursor loop. |
| `next` | A function `(previous, ctx) => value \| null` | With `start`, and only with it | The next value. `previous` holds the outputs of the last iteration. `null` or `undefined` ends the loop. |
| `as` | An identifier | No. The default is `value` | The name of the value in scope: `{{loop.<as>}}`. |
| `until` | A function `(res, ctx) => boolean` | No | Stops the loop at the first iteration where it returns true. On a `uses:` step, `res` holds the exports of the sub-flow. |
| `max` | An integer from 1 to 1000 | **Yes** | The largest number of iterations. A loop always has a bound. |
| `concurrency` | An integer | No. The default is 1 | The number of iterations in flight. §6 gives the limits. |

**`over` is one whole reference, or a list.** A string with text around a reference (`"ids {{x}}"`)
is always a string, so `over` refuses it (`loop-over-not-a-list`). A list that is written in the
file can hold references. They resolve one by one, as any list in a body does.

**A reference to an empty list is a list.** `@usebruno/query` returns `undefined` for an empty array.
The interpolator then reports the reference as never produced, and that is right for a body. A loop
over no values runs no iteration, so `over` and `start` resolve through `interpolateLoopSource`. It
reads an empty list as a list. An output that is declared as a path and selects an empty array is
still not produced (§8.1). Use a `script:` output where a list can be empty, as in the example above.

**A loop is not a step of its own.** The step keeps its `operation:` or `uses:`, its `outputs:`,
`assert:`, `pre:` and `retry:`. The loop repeats them. §11 gives the reasons.

## 3. The iteration

`when:` and `depends:` apply one time, to the whole loop. The engine then does these steps for each
iteration, in order:

1. **Get the value.** For a list, take the next item. For a cursor, take `start` for the first
   iteration, and `next(previous, ctx)` after it. If there is no value, the loop ends.
2. **Put `loop.*` in scope** (below).
3. **Run `pre:` again.** A throw fails the step with `script-error`, as it does for a step with no
   loop. The step sends no request for that iteration.
4. **Build the request again.** This is `materialize()` with `loop.*` in scope.
5. **Send the request.** `retry:` applies to this iteration only. It keeps its meaning: the same
   request again (001 §11.1).
6. **Check the iteration.** Status, schema, assertions and outputs are the checks of a step with no
   loop.
7. **Fail the step if the iteration failed.** A status, assertion or script failure ends the loop.
   Retries that ran out do the same. The step result names the iteration and its value (§9).
8. **Stop if `until` returns true.** The step succeeds, and this iteration is the match.
9. **Stop if `max` iterations have run.** §4 gives the result.

**In scope during an iteration:**

| Name | Value |
|---|---|
| `loop.<as>` | The value of the iteration |
| `loop.index` | The number of the iteration. It starts at 0 |
| `loop.previous` | The outputs of the iteration before. It is `undefined` for the first one |

`ctx.loop` holds the same three values in a script. `as: index` or `as: previous` loses to the
built-in. `loop` is a reserved root (001 §7.3, §10.2), so a variable with that name is shadowed.
`{{loop.previous.x}}` in the first iteration stays as it is written, as any name that nothing
defines does. Guard it in `pre:`.

**In `next`, `ctx.loop` is the iteration that just ended.** This is how a cursor adds one to
itself: `(previous, ctx) => ctx.loop.page + 1`. In `until`, `ctx.outputs` holds the outputs of the
iteration, as it does in `shouldRetry`.

**A reference that no step produced ends the loop before any request.** The scope that can miss a
reference does not change between iterations, because no step publishes before the loop ends. So
the miss happens in the first iteration, and the loop has sent nothing. The step is skipped with
`unresolved-dependency`, as a step with no loop is (001 §11.2). The message names the iteration.
A value of `over` that is not a list fails the step with `invalid-request`.

## 4. What a looped step publishes

A looped step always publishes `matched`, `iterations` and `count`. Its declared outputs depend on
how the loop ended.

| How the loop ends | Step status | Declared outputs (`steps.<id>.<name>`) | Built-ins |
|---|---|---|---|
| With `until`: `until` is true | success | From the matching iteration | `matched: true`, `index` is its `loop.index` |
| With `until`: the values end, or `max` runs, with no match | success | Absent | `matched: false` |
| Without `until`: the values end | success | Absent | `matched: true`, `iterations` lists the outputs of each iteration in index order |
| An iteration fails | failed | Absent | `matched: false`. §9 gives the index and the value |
| Without `until`: `max` runs before the values end | failed, reason `loop-max-reached` | Absent | `matched: false` |

`count` is the number of iterations that ran. `iterations` is also present with `until`, for
diagnosis. A built-in wins over a declared output of the same name.

**A loop with no match is a success, and not a skip.** The next step decides with
`when: steps.<id>.matched eq false`. `depends: status: [skipped]` cannot tell a branch that was not
needed from a gate that stopped the run. A skipped loop would also spread `unmet-dependency` to the
steps that must run.

**A reader of a declared output of a loop with `until` can find it absent.** The reader gets
`unresolved-dependency`, as for any output that was not produced. `bru flow validate` warns when the
reader has no `when:` on `matched` (`loop-output-unguarded`, §10). A loop with no `until` publishes
no declared output at all, so a read of one always skips the reader. A `shared:` entry and an
`exports:` entry that name one are reads too: the slot is never written, and the export is never
produced. `bru flow validate` warns of all three (`loop-output-never-published`, §10). Read
`iterations` for those. A read of `iterations` counts as
a read of every output that the loop declares, so `unused-output` stays quiet.

**`shared:` publishes from the matching iteration only.** With no match, it writes nothing.

**`StepResult.loop` carries the summary.** It holds `count`, `of` (the largest number of iterations
that the source allows, when it can say), `matched`, and the `index` and `value` of the deciding
iteration. The deciding iteration is the match or the failure. `attempts` is the total number of
requests of all iterations. Each iteration sends one request unless `retry:` repeats it. The result
holds the assertions and the validation of the deciding iteration. It does not hold `iterations`,
because a loop of 1000 iterations would make every report large. The captures hold each request.

## 5. Failure, cancellation and budgets

**A failed iteration ends the loop.** The step fails with the reason of the iteration:
`unexpected-status`, `assertion-failed`, `script-error`, `retries-exhausted` and the others of
001 §14.6. The message begins with `loop.index 2 (value "abc") failed:`. The index is the one that
a script and a capture directory use.

**`max` is a bound.** A loop with `until` that runs `max` iterations without a match is a loop with
no match, and it succeeds with `matched: false`. A loop without `until` succeeds only if the values
also ended. For a cursor, this means that `next` returned `null` after the last iteration. If the
values have not ended, the step fails with `loop-max-reached`. The engine calls `next` one more time
to find out, and it does not call it for a loop with `until`.

**`maxDuration` bounds the whole loop. `timeout` bounds one attempt.** An iteration receives the
time that remains. It never starts a new budget. The engine also checks the budget before each
iteration. When the budget ends, the step fails with `max-duration-exceeded`.

**The rate limiter takes one token for each request.** This is the behavior of a retry (004 §7). A
loop of five iterations takes five tokens. Each iteration takes a place in the budget of the run
(001 §9.2) for the time of its own request. The loop holds no place between two iterations.

**A cancelled run stops a loop between two iterations**, and also in an attempt, as 001 §11.3 does
for a poll. The step reports `cancelled` with `run-cancelled`. A step that the run stopped before its
first request is `skipped`, as 001 §11.3 says. A cleanup step keeps looping during the grace window.

## 6. Concurrency

`concurrency` above 1 runs iterations in parallel, up to that number. It applies to `over` and does
not apply to `until`, because a stop condition needs the iterations in order. It does not apply to
`start`, because `next` needs the outputs of the iteration before. `bru flow validate` refuses both
(`loop-concurrency-with-until`, `loop-concurrency-with-cursor`). A run refuses them too.

- **Each iteration draws from the run-wide budget** (001 §9.2). The number of requests in flight is
  the lower of `concurrency` and what the budget allows.
- **`loop.previous` is `undefined`** in every iteration, because no iteration waits for another.
- **`iterations` is in index order,** whatever order the requests finish in.
- **The first failure aborts the requests in flight** and stops the start of new iterations. The step
  reports the lowest index of the iterations that failed. An iteration that the loop itself aborted
  is not a failure and is not counted.

## 7. Sub-flows

On a `uses:` step, each iteration invokes the sub-flow. Its `with:` values are built again with
`loop.*` in scope. 001 §12.3 does not change: the sub-flow sees its `params`, and it does not see
the `loop` of its caller. A `{{loop.x}}` in a sub-flow is `loop-reference-outside-loop`.

`until` is asked about the exports of the sub-flow. `res.total` is the export `total`. The outputs
of the step are the exports of the matching iteration. 001 §12.4 refuses `retry:` on a `uses:` step,
so an iteration of a sub-flow does not retry.

**The steps inside the sub-flow are named by the iteration that ran them:**
`auth/iteration-2/login`. Without this, the steps of two iterations would share one id and one
capture directory. A step id cannot contain `-`, so the segment cannot be the id of a step.

## 8. Captures and events

Each request is written to `<step>/iteration-<index>/attempt-<n>.json`. The attempts of an iteration
start again at 1. The file holds `loopIteration`. The directory of a looped step nests below the
step, and the directory of a dataset iteration nests above it. A step with no `loop:` keeps its
paths.

`StepResult.capturePath` is the directory of the step. `readCapture` takes `loopIteration`.
`readRun` lists a looped step as captured, although its own directory holds no attempt file.

**`step:iteration` announces each iteration,** before its first attempt:
`{ id, index, iteration, of?, value }`. `index` is the iteration of the run, as on every step event.
`iteration` is `loop.index`. `of` is `min(length of the list, max)`. A cursor has no `of`. The
engine masks `value` as it masks every value that a run reports (001 §14.4).

**`step:attempt` names its iteration** (`iteration`, `loop.index`) for a step with `loop:`. Under
`concurrency` the attempts of several iterations interleave, and the number of the attempt cannot say
whose it is. **`StepResult.loop.attemptsPerIteration`** gives the requests of each iteration, in the
place of its `loop.index`. It is present only where an iteration retried. Without it, each iteration
sent one request. A reader that opens one iteration needs both to know how many attempts it has.

## 9. Reporting

- **The console** shows `iteration 3/8` on the line of the step, and `iteration 3` for a cursor. A
  TTY row shows the iteration that is in flight. The failure block names `loop.index` and the value
  where the message does not (an assertion failure).
- **The reporters** (001 §14.8) carry the message, which names the iteration. The JSON reporter
  carries `loop`. The JUnit `attempts` property counts only the requests beyond one for each
  iteration, because those are the retries.
- **`describeFlow` marks a looped step** with `markers.loopMaxIterations`. The graph stays static:
  the loop repeats inside one node. `over:` and `start:` draw a data edge from the step that they
  name.
- **The builder (005) lists `loop` as a key that it does not edit.** The editor shows it as "not
  editable here". A patch that does not name `loop` leaves its bytes as they are (L11.2).
- **The app (002) shows iterations as it shows attempts** (002 §8.2, §9). The node says
  `iteration 3/8` while the loop runs and after it ends, and `iteration 3` for a cursor. Where an
  iteration retries, it says `iteration 3/8 · attempt 2/3`. The footer marks the node `loop 25`.
  The step pane has an iteration selector before the attempt selector on its header. It opens on the
  iteration that decided the step, and the attempt selector then offers the attempts of that
  iteration. While the loop runs, the pane follows the newest attempt that has a capture. A `uses:`
  step that loops has no iteration to choose, because its requests are the steps in its sub-flow.

## 10. Validation

`bru flow validate` reports these. Each has a case that triggers it and a clean file beside it
(L9). The first nine are new codes.

| Code | Severity | When |
|---|---|---|
| `loop-source-missing` | error | `loop:` has neither `over` nor `start`, or has both |
| `loop-next-missing` | error | `start` without `next`, or `next` without `start` |
| `loop-max-missing` | error | `max` is absent, is not an integer, or is outside 1 to 1000 |
| `loop-concurrency-with-until` | error | `concurrency` above 1 together with `until` |
| `loop-concurrency-with-cursor` | error | `concurrency` above 1 together with `start` |
| `loop-reference-outside-loop` | error | `{{loop.*}}`, or a `loop.` operand, in a step with no `loop:` |
| `loop-over-not-a-list` | error | `over` is a literal that is not a list, or a string with text around a reference |
| `loop-output-unguarded` | warning | A step reads a declared output of a loop with `until`, and has no `when:` on `matched` |
| `loop-output-never-published` | warning | A step reads a declared output of a loop with no `until`, or a `shared:` or `exports:` entry names one. No guard can help, because the loop publishes none |

The rules that exist already extend to loops:

- **`unknown-function`** covers the `next` and `until` scripts.
- **`unknown-step-reference`, `non-ancestor-reference` and `unknown-output-reference`** apply to
  `over` and `start`, as to any reference. `matched`, `iterations`, `count` and `index` are built-ins
  of a step with a loop, and they are not outputs. A step with no loop does not have them.
- **`unused-output`** does not report the four names of a loop. It counts a read of `iterations` as
  a read of every declared output. It counts `previous.<name>` in `next` and `outputs.<name>` in
  `until` as reads, because a cursor loop declares an output for this reason. The scan reads text.
  A script that destructures `previous` is not found, and 001 §8.2 has the same limit for `ctx.steps`.
- **`unknown-property`** reports a key that the loop does not have, with the near miss. The schema
  gives the shape of each key. The rules between keys are the codes above. `over`, `start` and `max`
  have no type in the schema, so a bad `max` gives one diagnostic and not two.
- **`shadowed-reserved-name`** covers a `vars:` entry named `loop`.

## 11. Decisions and rejected alternatives

**Where the loop is written.**

| Option | What it means |
|---|---|
| **A. A `loop:` block on a step** | The step repeats. Its `outputs:`, `assert:` and `retry:` apply to each iteration. |
| **B. A new step kind (`foreach:`)** | A step that holds steps. |
| **C. `dataset:` for steps** | The values come from a file, and a step reads `row`. |

**Decided: A.** B needs a second place for everything that a step already has, and it makes the
graph nest. C ties the values to a file, and the five loops take their values from responses.
Each iteration of A is a step that the engine already knows how to run. The graph keeps one node.

**Where the stop condition is written.**

| Option | What it means |
|---|---|
| **A. `until` on the loop** | The loop asks, after each iteration. |
| **B. Reuse `shouldRetry`** | The predicate that retries also steps to the next value. |

**Decided: A.** `retry:` sends the same request again. A loop sends a different one. A predicate
that did both would make `retry:` mean two things, and a poll inside a loop could not exist.

**Whether a loop with no match is a success or a skip.**

**Decided: a success with `matched: false`.** §4 gives the reason. The cost is that a reader of a
declared output must guard on `matched`, and `loop-output-unguarded` is the check for it.

**Where an iteration is captured.** The path is `<step>/iteration-<n>/`. A dataset iteration is
`iteration-<n>/<step>/`. The two are different things, and a loop that repeats a step must stay next
to that step. The names are the same word on purpose: a reader who knows one knows the other.

**What names the steps in a sub-flow.** The alternatives were the same id for each iteration (two
results with one id, and one capture directory that the second iteration overwrites), and an id
with the number at the end (it does not nest, and `readCapture` cannot find it). The number goes
between the step and the inner id, so a path and an id agree.

**What `index` means on the event.** `step:iteration` has `iteration` for `loop.index`. `index` is
already the iteration of the run on `step:start`, `step:attempt` and `step:end`. A second meaning on
a fourth event would make every consumer read the event type before it reads the field.

**Whether concurrency may go with `until` or a cursor.** It may not. A stop condition needs the
iterations in order. A cursor needs the outputs of the iteration before. Both could be run in order
and the setting ignored, but a setting that does nothing, and says nothing, is worse than an error.

**Where the budget is held.** Each iteration takes its own place in the budget of the run. The other
choice was one place for the whole loop. That would hold a place for a loop that waits for its
scripts, and a loop of 1000 iterations would block the steps beside it for a long time.

## 12. Settled, and still open

- **The value of an iteration in the app.** The selector says `Iteration 3`, and the title says
  `loop.index 2`. It does not say the value, because only the deciding iteration has one in a stored
  run (`StepResult.loop.value`). Naming each iteration by its value needs the values in the result,
  and 1000 values in every report is the cost.
- **Iterations inside a looped `uses:` step in the app.** The steps of its sub-flow have ids such as
  `auth/iteration-2/login`, and no node of the graph has one. The container shows its summary.
- **Editing a `loop:` in the builder (005).** The builder keeps the block. It does not edit it.
- **A `shared:` entry on a loop with `until`.** With no match, the loop writes no slot, and the slot
  resolves empty (001 §11.2). The flow can intend this, so there is no check for it.
- **`as:` is not checked.** `as: index` loses to the built-in with no diagnostic.
- **`loop.previous` with `concurrency`** is `undefined` by design. A flow that needs both has no way
  to say it.

## 13. Implementation status

| Part | Where | State |
|---|---|---|
| The block, and `NormalizedStep.loop` (§2) | `document.ts`, `schema/v1.ts` | **done** |
| `loop` as a reserved root (§3) | `interpolate.ts` | **done** |
| The iteration, the results and the budget (§3–§5) | `run.ts` — `executeLoop`, `loop.ts` | **done** |
| `until` (§3) | `step.ts` — `loopUntilMatches` | **done** |
| Concurrency (§6) | `run.ts` — `iterateTogether` | **done** |
| Sub-flows (§7) | `run.ts` — `executeSubflow` | **done** |
| Captures, readers and the event (§8) | `capture.ts`, `history.ts`, `types/result.ts` | **done** |
| The console (§9) | `bruno-cli/src/fork/flow/output.js` | **done** |
| The description and the builder (§9) | `describe.ts`, `edit.ts` | **done** |
| The run view of the app (§9) | `bruno-app/src/fork/flows` — `slice.js`, `FlowGraph`, `StepDetail`; `bruno-electron/src/ipc/flow` | **done** |
| The checks (§10) | `validate/shape.ts`, `validate/scripts.ts`, `references.ts` | **done** |

`loops.spec.js` asserts what went to the wire, in order. A loop that built its request one time and
sent it three times passes every assertion on a result, and fails the first assertion on a path.
`loops-validation.spec.js` is the second half. `006-step-loops-conformance.md` lists the scenarios.

## 14. Upstream touchpoints

**None.** Every file that this spec changes is fork-owned: `packages/bruno-max-flow`,
`packages/bruno-cli/src/fork/flow`, `packages/bruno-app/src/fork/flows`,
`packages/bruno-electron/src/ipc/flow`, the docs, and the flow-writer skill. This is the result that
`.claude/rules/architecture.md` asks a manifest to show.

## 15. Non-goals

- **A loop with no bound.** `max` is required, and 1000 is the upper limit.
- **A loop across steps.** A loop repeats one step. A sequence of steps repeats as a `uses:` step.
- **Nesting a loop in a loop** in one step. A `uses:` step whose sub-flow has a loop does it.
- **Pausing between iterations.** `retry.delay` is the only wait that the engine has. A pause step is
  a separate decision.
