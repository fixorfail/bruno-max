# 006-C — Step loops conformance scenarios

**Status:** **Implemented** — companion to [006-step-loops.md](./006-step-loops.md). Every scenario
has a test. `loops-registry.spec.js` asserts that each one cites its `L…` id.
**Owner:** Jake Campbell
**Last revised:** 2026-10-01

These are the scenarios that the behavior of a loop was derived from. Start at §2 for where the
tests live. Each later section holds one family of scenarios, in the order of the iteration. Each
scenario names the sections of 006 that it pins.

---

## 1. Why this file exists

A loop has cheap wrong implementations that pass a casual look:

- A loop that builds the request one time and sends it again for each value passes every assertion
  on a result. It fails the first assertion on a path.
- A loop that publishes a skip for "no match" passes its own tests. It breaks the step that must run
  because nothing matched.
- A loop that gives each iteration a new `maxDuration` passes a test with one slow iteration. It
  fails a test where each iteration fits and the loop does not.
- A loop that writes every iteration to `<step>/attempt-1.json` passes a test with one iteration.
  The second iteration overwrites the first.

Each scenario names the sections of 006 that it pins. A change to the rule of §4 or the layout of §8
must break something here.

## 2. Where these tests live

```
packages/bruno-max-flow/tests/conformance/
  fixtures/specs/loops-v1.yml           # the service that the loop flows bind
  fixtures/flows/loops/                 # one flow for each loop of 006 §1, and the sub-flow
  loops.spec.js                         # L1–L8, L10, L11
  loops-validation.spec.js              # L9
  loops-registry.spec.js                # each scenario below cites its id

packages/bruno-cli/tests/fork/flow/output.spec.js    # L12

packages/bruno-electron/src/ipc/flow/index.spec.js   # L13.1
packages/bruno-app/src/fork/flows/
  slice.spec.js                                      # L13.2
  FlowTabPane/StepDetail/index.spec.js               # L13.3
  FlowTabPane/FlowGraph/index.spec.js                # L13.4
```

**The fixtures are real files and are the artifact.** Each of the five loops of 006 §1 is a
`.flow.yml`. A loop that a flow cannot express is a fixture that cannot be written. `fixtures.spec.js`
checks that each of them resolves, and `harness.js` builds one route index from all specs. So the
paths of `loops-v1.yml` all begin with `/loops`.

**A case that needs a flow with one line changed uses `variant()`.** The assertion is then on the
difference from the committed file. This is the rule of 001-C §2 and of `loops-validation.spec.js`.

**Assertions are on the wire.** The tests read `run.calls` in the order that the requests went out.
They read the paths, the bodies and the headers, and the layout of the capture. A result alone does
not show that a request was built again.

---

## 3. L1 — The request is built again

### L1.1 — A request is built again for each value

A list of three ids sends three requests with three different paths. The flow is the first loop of
006 §1.

*Pins 006 §3 steps 4 and 5.* The test that every other test stands on.

### L1.2 — `pre:` runs again for each iteration and sees `loop.*`

`pre:` computes a label from `ctx.loop`, and the request carries it in a header. The headers are
`v1-0`, `v2-1`, `v3-2`. The script runs three times, and its context holds `loop.index` 0, 1 and 2.

*Pins 006 §3 steps 2 and 3.*

---

## 4. L2 — Stopping, and what the step publishes

### L2.1 — `until` stops at the first match

The second candidate has members. The loop sends two requests and no more. The outputs of the step
are the outputs of the match. `StepResult.loop` is `{ count: 2, of: 3, matched: true, index: 1,
value: 'v2' }`. The step that is guarded on `matched: false` is skipped with `condition-false`.

*Pins 006 §3 step 8, §4.*

### L2.2 — No match is a success, and the next step decides

No candidate has members. The loop succeeds with `matched: false` and publishes no output. The step
guarded on `matched eq false` runs. The step guarded on `matched eq true` is skipped with
`condition-false`. No step gets `unmet-dependency`.

*Pins 006 §4, the paragraph on a success and not a skip.*

### L2.3 — A list with no values runs no iteration

The list is empty. With `until`, the loop succeeds with `matched: false` and `count: 0`, and the
create step runs. Without `until`, it succeeds with `matched: true`. The loop sends nothing.

*Pins 006 §2, the paragraph on an empty list, and §4.* The list comes from a `script:` output,
because a path output that selects an empty array is not produced.

### L2.4 — Without `until`, every value runs

All three values run, and `matched` is `true`. `steps.call_each.iterations` holds each output in
index order. The declared output `result` is absent, so a reader of `steps.call_each.result` is
skipped with `unresolved-dependency`. An assertion on `steps.call_each.count` passes.

*Pins 006 §4.*

### L2.5 — `shared:` publishes from the match only

With a match, the slot holds the output of the matching iteration. With no match, the slot is
unwritten, and it resolves to an empty string (001 §11.2).

*Pins 006 §4.*

---

## 5. L3 — Failure and bounds

### L3.1 — A failed iteration fails the step and ends the loop

The second of three calls returns 500. The step fails with `unexpected-status`. The third value is
not sent, and the step after the loop is skipped. The message names `loop.index 1 (value "acct-2")`.
`StepResult.loop` holds the index and the value. A failed assertion reports the assertions of the
iteration that failed.

*Pins 006 §3 step 7, §5.*

### L3.2 — A script that throws fails the step and names the iteration

An `until` that throws, a `next` that throws, and a `pre:` that throws each fail the step with
`script-error`. The message names the iteration and the position. A `pre:` that throws sends no
request.

*Pins 006 §3 step 3, §5.*

### L3.3 — With `until`, `max` is a bound and a loop at `max` has not matched

Three candidates and `max: 2` with no match: success, `matched: false`, `count: 2`. The third value
is not sent.

*Pins 006 §5.*

### L3.4 — Without `until`, a loop at `max` with values left has not finished

Three values and `max: 2`: the step fails with `loop-max-reached` after two requests. Three values
and `max: 3`: the step succeeds.

*Pins 006 §4, §5.*

### L3.5 — A source that cannot be read ends the loop before any request

A reference to an output that nobody produced skips the step with `unresolved-dependency`. The
message names the reference. The run fails and `decidedBy` names the step. A value of `over` that is
not a list fails the step with `invalid-request` and sends nothing.

*Pins 006 §3, the paragraph on a reference that no step produced.*

### L3.6 — A loop that nobody validated is refused

A loop with no `max` fails with `invalid-request` and sends nothing.

*Pins 006 §3, and `loopShapeError`.*

---

## 6. L4 — Cursors

### L4.1 — A cursor follows the API from one value to the next

`start` is `lastPage`, and each `next` is the `links.prev` of the page before. The pages that the API
is asked for are 3 and 2, in that order, and page 1 is not read. The loop that follows reads the
candidates of the match and stops at the first that matches.

*Pins 006 §2, §3 step 1.* This is the second loop of 006 §1.

### L4.2 — A cursor ends where `next` returns `null`

No page has a candidate. The pages 3, 2 and 1 are read, and the step succeeds with
`matched: false`. The loop that follows is skipped with `condition-false`. A `start` that resolves to
`null` runs no iteration.

*Pins 006 §2.*

### L4.3 — `loop.previous` carries values from one iteration to the next

Each iteration adds its matches to the list of the iteration before. The loop stops when it has three
matches, and the fourth page is not read. `next` adds one to `ctx.loop.page`, and `ctx.loop` is the
iteration that just ended. `loop.previous` is `undefined` in the first iteration. A loop that ends
at the last page, with fewer matches than it wants, succeeds with `matched: false`.

*Pins 006 §3, the table of scope and the paragraph on `next`.* This is the third loop of 006 §1.

### L4.3a — `loop.iterations` lists the iterations that finished, for `pre:` and the request

A loop of three calls reads `loop.iterations` in `pre:`, in a header and in the body. Iteration n
sees n items: the outputs of iterations 0 to n-1, in index order. Iteration 0 sees `[]`.
`loop.previous` is `undefined` in iteration 0, and after it is the last item of `loop.iterations`.

*Pins 006 §3, the table of scope and the paragraph on `loop.iterations`.*

### L4.3b — An empty `loop.iterations` is a value, and not a missing reference

A whole-value `{{loop.iterations}}` in iteration 0 resolves to `[]`, and the step is not skipped. An
embedded `n={{loop.iterations}}` resolves to `n=[]`. An assertion operand `loop.iterations` reads
the same list in every iteration. A reference to a name that nothing defines stays as it was:
`{{loop.previous.matches}}` in iteration 0 stays as it is written.

*Pins 006 §3, the paragraph on the first iteration.*

### L4.3c — `until` and `next` see the iterations up to the one that just ended

In iteration n, `until` and `next` see iterations 0 to n in `loop.iterations`. `ctx.outputs` in
`until` is iteration n alone. `loop.previous` in both is the iteration before iteration n, as it was
before `loop.iterations` existed.

*Pins 006 §3, the paragraph on `loop.iterations` and the paragraph on `next`.*

### L4.3d — A cursor stops on a total across all the pages so far

`start` is 1 and `next` adds one to `ctx.loop.page`. `until` adds the matching items of every page so
far, and stops at 3. The pages hold 2, 0, 1 and 5 matching items. No single page reaches 3. The loop
stops on page 3 with `matched: true`, and page 4 is not sent. With a count that no page total reaches,
the loop reads the last page and ends with `matched: false`.

*Pins 006 §3.* This is the third loop of 006 §1, with the stop condition of the backend helper
`get_ledger_objects_for_line_items`.

### L4.3e — Iterations that run together have no `loop.iterations`

With `concurrency: 3`, `loop.iterations` is `undefined` in every iteration, as `loop.previous` is. A
`pre:` that reads its length fails the step with `script-error`. A reference in the request stays as
it is written, for both names. There is no diagnostic for either name.

*Pins 006 §6.*

### L4.3f — `as: iterations` loses to the built-in, as `as: previous` does

A loop with `as: iterations` has the list of earlier outputs in `loop.iterations`, and not the value.
`bru flow validate` reports the same for `as: iterations` and for `as: previous`.

*Pins 006 §3, the paragraph on the scope names, and §12.*

### L4.4 — A cursor that has not ended at `max` has not finished

An API that never ends and `max: 3`. With `until`, the step succeeds with `matched: false`. Without
it, the step fails with `loop-max-reached`. A cursor that ends at exactly `max` succeeds.

*Pins 006 §5.*

---

## 7. L5 — Retry, budgets, pacing and cancellation

### L5.1 — `retry:` inside a loop retries only the current iteration

The second call returns 503 once. The requests are `acct-1`, `acct-2`, `acct-2`, `acct-3`. There is
one sleep. `attempts` is 4, and `count` is 3. `loop.attemptsPerIteration` is `[1, 2, 1]`, and it is
absent where no iteration retried. An iteration whose retries run out fails the step with
`retries-exhausted` at that index.

*Pins 006 §3 step 5.*

### L5.2 — `maxDuration` bounds the whole loop

Each iteration costs 1000 ms of the harness clock. With 2000 ms, the second iteration meets the end
of the budget. With 2500 ms, the third does. One iteration alone would fit in both. A `uses:` loop
whose sub-flow spends time without a budget of its own fails before the third iteration starts, with
`count: 2`. A budget that is enough for the whole loop lets it finish.

*Pins 006 §5.*

### L5.3 — The rate limiter takes one token for each request

Five iterations against a limit of one request for each second sleep four times for a second each.
`rateLimitWaitMs` of the step is 4000.

*Pins 006 §5, 004 §7.*

### L5.4 — Cancellation stops a loop between iterations

The run is cancelled during the second call. The third value is not sent. The step is `cancelled`
with `run-cancelled`, the run is `cancelled`, and the step after the loop is skipped with
`run-cancelled`.

*Pins 006 §5.*

---

## 8. L6 — Concurrency

### L6.1 — `concurrency` runs iterations in parallel up to its number

Five values and `concurrency: 3` keep three requests in flight, and no more. `iterations` is in
index order when the calls finish in the reverse order.

*Pins 006 §6.*

### L6.2 — The first failure aborts the iterations in flight

With four values and `concurrency: 2`, the second fails while the first waits. The first request is
aborted, and the step reports the second index. The third and fourth values are never started, and
the aborted request is not counted as a failure. If two iterations fail, the step reports the lower
index.

*Pins 006 §6.*

---

## 9. L7 — Sub-flows

### L7.1 — A loop on a `uses:` step invokes the sub-flow for each value

`with:` is built again with `loop.key`, so the requests go to `key-1` and then `key-2`. `until` is
asked about the exports, and the third key is never invoked. The steps inside the sub-flow are
`search_each_key/iteration-0/page_1` and the others. Without `until`, every key runs. An iteration
whose sub-flow fails fails the step with `subflow-failed`, and the message names the iteration and
the inner step. A sub-flow that reads `{{loop.key}}` gets the text as it is written, because the
loop of its caller does not reach it.

*Pins 006 §7, 001 §12.3.* This is the fifth loop of 006 §1.

---

## 10. L8 — Captures and events

### L8.1 — Each request is captured under its iteration

The layout holds `call_each/iteration-0/attempt-1.json` for each iteration. The attempts of an
iteration start again at 1. The capture holds `loopIteration`. `capturePath` is the directory of the
step. `readRun` lists the step as captured. The steps of a sub-flow are under
`search_each_key/iteration-0/`. A step with no `loop:` keeps its path.

*Pins 006 §8, 001 §14.5.*

### L8.2 — `step:iteration` announces each iteration

The event holds the iteration, the total and the value. A cursor has no total. The total is capped
at `max`. `step:attempt` names its iteration for a looped step and for no other. A value that the run
knows is secret is masked in the event, in the message and in `StepResult.loop`.

*Pins 006 §8, 001 §14.4.*

---

## 11. L9 — Validation

Each rule has failing cases and the clean file beside them. `loops-validation.spec.js` is built as
`validation.spec.js` is.

### L9.1 — `loop-source-missing`

A loop with neither `over` nor `start` is an error, and so is a loop with both. A loop with one of
them is clean. The diagnostic is anchored at the loop block.

*Pins 006 §10.*

### L9.2 — `loop-next-missing`

`start` without `next` is an error, and so is `next` without `start`. A loop with both, or with
neither, is clean.

*Pins 006 §10.*

### L9.3 — `loop-max-missing`

A `max` that is absent, a string, 0, a negative number, 1001, a fraction or `null` is an error. A
`max` of 1, 25 or 1000 is clean.

*Pins 006 §2, §10.*

### L9.4 — `loop-concurrency-with-until`, and `loop-concurrency-with-cursor`

`concurrency` above 1 beside `until` is an error. So is `concurrency` above 1 beside `start`.
`concurrency` of 1 beside `until` is clean, and so is `concurrency` above 1 on a list with no
`until`.

*Pins 006 §6, §10.*

### L9.5 — `loop-reference-outside-loop`

`{{loop.x}}` in a body, a `loop.` operand in an assertion, and a `loop.` operand in a `when:` are
errors in a step with no loop. So is a reference in a sub-flow to the loop of its caller. A step
with a loop that reads `loop.*` is clean, and so is the word "loop" in other text.

*Pins 006 §3, §7, §10.*

### L9.6 — `loop-over-not-a-list`

A string that is not a reference, a number, a mapping, and a string with text around a reference are
errors. The message says why the last one is a string. A list, and one whole reference, are clean.

*Pins 006 §2, §10.*

### L9.7 — `unknown-function` reaches `next` and `until`

A helper that an `until` or a `next` calls, and that nothing declares, is a warning. It is anchored at
the script. A helper that `functions:` declares is clean.

*Pins 006 §10.*

### L9.8 — `loop-output-unguarded`

A reader of a declared output of a loop with `until` that has no `when:` on `matched` is a warning.
A `when:` about something else does not guard it. Each reader is reported once. A guard in the
`when:` of a script counts. A built-in, and a loop with no `until`, are clean.

*Pins 006 §4, §10.*

### L9.9 — The built-ins are not unused outputs

`matched`, `iterations`, `count` and `index` that a step declares are not reported as unused. A read
of `iterations` counts as a read of every output. A read by `next` or `until` counts as a read. An
output that nothing reads is still reported.

*Pins 006 §10.*

### L9.10 — The built-ins are references of a looped step, and of no other

`steps.x.matched`, `count`, `index` and `iterations` are accepted for a step with a loop. The same
names on a step with no loop are `unknown-output-reference`.

*Pins 006 §4, §10.*

### L9.11 — `over` and `start` are reads of the steps they name

A step that is not there is `unknown-step-reference`. A step that is not an ancestor is
`non-ancestor-reference`. An output that the step does not produce is `unknown-output-reference`.

*Pins 006 §2, §10.*

### L9.12 — The document schema

A key that the loop does not have is `unknown-property` with the near miss. A `next` that is not text
and a `concurrency` that is not a whole number are `schema-violation`. A loop on a `uses:` step is
accepted. A var named `loop` is `shadowed-reserved-name`.

*Pins 006 §10, 001 §5.4.*

### L9.13 — `loop-output-never-published`

A reader of a declared output of a loop with no `until` is a warning. No guard on the reader can
make the output appear, so a `when:` does not clear it. Each reader is reported once. A `shared:`
entry of the loop step that names a declared output is a warning, one for each entry, anchored at
the entry. An `exports:` entry that names one is a warning too, and it covers the outputs of a
sub-flow that a looped `uses:` step exports. A read of `iterations`, `count` or `matched` is clean.
So is a read of a declared output that has the name of a built-in, because the built-in wins. A loop
with an `until`, and a step with no loop, are clean. A loop with an `until` is the subject of L9.8.

*Pins 006 §4, §10.*

---

## 12. L10 and L11 — The five loops, and the surfaces

### L10.1 — The five loops of 006 §1 can be written as flows

The five flows and the sub-flow validate with no diagnostic. Three of them run to a pass here. The
other three run in the scenarios above.

*Pins 006 §1.* This is the acceptance test of the spec.

### L11.1 — The description marks a looped step and draws what it reads

`markers.loopMaxIterations` is the `max` of the step and is absent on every other step. `over:` is a
data edge from the step that produced the list. `matched` is a built-in and has no edge.

*Pins 006 §9.*

### L11.2 — The builder leaves a loop as it was

The empty edit returns the bytes of the file. A patch of another key leaves the bytes of the loop
block as they are. The edit model lists `loop` as a key that the builder does not edit.

*Pins 006 §9, 005 §9.1.*

---

## 13. L12 — The console

### L12.1 — The step line shows the iteration

A looped step prints `iteration 3/8`, or `iteration 3` where the source cannot say the total. A
step with no loop prints neither. The retries beyond one request for each iteration still print as
attempts. A failed assertion names `loop.index` and the value. A TTY row shows the iteration that
is in flight.

*Pins 006 §9.* The assertions are on properties and not on exact text, as R4l's are.

---

## 14. L13 — The app

The run view shows iterations as it shows attempts (006 §9, 002 §8.2 and §9). These scenarios live
in the app's own Jest suites and in the host's.

### L13.1 — The host names the iteration of a loop

`renderer:flow-read-capture` passes `loopIteration` to `readCapture`, beside the dataset iteration.
A host that named only the attempt would read the file of the first iteration, whichever iteration
the reader chose.

*Pins 006 §8.*

### L13.2 — The slice folds the iterations of a loop

`step:iteration` sets the iteration of the node and its total. A cursor has no total. `step:attempt`
keeps the attempt of each iteration, because under `concurrency` they interleave. A step with no loop
folds as it did before. `step:end` replaces what the events said with `StepResult.loop`, and a stored
run carries it the same way.

*Pins 006 §8, §9.*

### L13.3 — The step pane chooses an iteration as it chooses an attempt

The pane offers each iteration before the attempt selector, and opens on the iteration that decided
the step: the match, or the failure. The title of the selector gives `loop.index`. The capture that
the pane asks for names the iteration and the attempt. Choosing an iteration opens it on its final
attempt and offers the attempts of that iteration. The status of the step shows on the deciding
attempt only. While the loop runs, the pane follows the newest attempt that has a capture, and a
choice stops it. A step with no loop, a looped `uses:` step and a loop that ran no iteration offer
no iteration.

*Pins 006 §9, 002 §9.*

### L13.4 — The graph shows how far a loop has gone

A looped node says `iteration 3/8` while it runs and after it ends, `iteration 3` for a cursor, and
`no iterations` for a loop that ran none. Where an iteration retries, the node says
`iteration 2/5 · attempt 2/3`, with the attempt of that iteration. The footer marks the node
`loop 25`. A step with no loop says nothing of iterations.

*Pins 006 §9, 002 §8.2.*
