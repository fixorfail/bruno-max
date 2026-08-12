# 002-C — API Flows UI conformance scenarios

**Status:** Draft — companion to [002-api-flows-ui.md](./002-api-flows-ui.md)
**Owner:** Jake Campbell
**Last revised:** 2026-08-11

Scenarios the UI spec's behavior was derived from, written to be implemented directly as Playwright
specs. Start at §2 for the harness, §3–§6 for the four scenario families, §7 for the regression set,
and §9 for which section of 002 each one pins.

Where [001-C](./001-api-flows-conformance.md) tests that the engine *executes* flows correctly, this
file tests that the app *shows* what the engine reports — and, in a few places, that it does not
quietly compute something the engine owns.

---

## 1. Why this file exists

002's whole design position is that the UI decides nothing about flow semantics: the graph, the
statuses, the reasons and the capture format all come from `@bruno-max/flow`. That position is only
worth anything if it is tested, because every one of these scenarios has a cheap wrong
implementation that passes a casual look:

- A graph that draws edges from `depends` alone looks right on every flow that never relies on the
  implicit sequence — which is most flows, until someone inserts a step (001 §9.1, and the defect
  001-C F1.4 already guards on the engine side).
- A run view that renders `skipped` as one grey state looks right until the run that skipped its way
  to green (001 §11.2's `failOnUnresolved` case) is the one you are debugging.
- A step pane that reads bodies out of events looks right until the events stop carrying them, which
  001 §13.2 says they never do.

Each scenario names the 002 sections it pins. A change to §5.3's edge kinds or §8.2's node states
should break something here.

## 2. Where these tests live

`tests/flows/` — Playwright, per `.claude/rules/testing.md` and the `write-e2e-test` skill. The
`default` project.

```
tests/flows/
  fixtures/
    workspace/                  # a workspace with apispec/ and flows/, copied to a temp dir
      apispec/
      flows/
      collections/payments/flows/
    runs/                       # a committed .bruno-runs/ directory — see §6
  graph.spec.ts                 # §3
  run.spec.ts                   # §4
  diagnostics.spec.ts           # §5
  inspect-history.spec.ts       # §6
  regressions.spec.ts           # §7
```

**The target API is `packages/bruno-tests`, not a mock.** These are end-to-end tests of an Electron
app; stubbing HTTP inside the renderer would test a different application. `echo` covers ordinary
request/response, `auth` covers the token-passing shapes, and `wait-for` (`?time=<ms>`) is what makes
an in-flight request last long enough for a cancellation scenario to be deterministic.

**One new route is required.** §4.3's polling scenario needs an endpoint whose response *changes* —
`pending` for the first N calls, then `settled` — and nothing in `bruno-tests` is stateful in that
way today. Add a small counter-backed route rather than driving the poll off a flaky timing
assumption; the alternative is asserting on wall-clock, which is how a suite becomes flaky in CI.

**Fixture flows are real files**, following 001-C §2's rule for the same reason: they double as the
worked examples, and a format change should surface as a failure at a path rather than a diff inside
a template literal.

**Selectors are `data-testid`**, per `CODING_STANDARDS.md`. Graph nodes carry
`data-testid="flow-node-<stepId>"` and a `data-status` attribute, which is what lets a scenario assert
on state without depending on colour — the one thing about this UI that will legitimately churn.

---

## 3. U1 — The graph reads correctly

Fixture: a flow exercising every edge kind in 002 §5.3 at once — an implicit chain, an explicit
parallel branch, a status-conditioned fallback, an `any` join, a shared slot, and a declared
connector. Structurally this is 001-C's F2 (order fulfillment with carrier fallback) with a shared
slot added, so the two files pin the same shape from both sides.

### U1.1 The implicit sequence is drawn, and drawn differently

Open a flow whose steps declare no `depends`. Every consecutive pair has an edge, and each edge is
marked as a sequence edge rather than a declared one.

*Pins 002 §5.3.* This is the scenario the whole graph exists for. An implementation that drew only
declared edges renders this flow as a set of disconnected nodes and would otherwise pass every other
test in this file.

### U1.2 Inserting a step rewires the chain, visibly

Add a step in the middle of the fixture's `steps:` on disk. After the watcher reload, the edge that
previously ran from A to C now runs A → B → C.

*Pins 002 §1, §4.1, §5.3.* This is 001 §19's deferred implicit-sequence heuristic, answered by
drawing instead of by a validator rule — the test that the answer actually works.

### U1.3 A status-conditioned edge is labeled

The fallback step's incoming edge is labeled with `[failed]`; the ordinary edges carry no label.

*Pins 002 §5.3.* An unlabeled `[failed]` edge tells the reader a branch runs when it does not.

### U1.4 An `any` join is marked at the receiving node

The rejoin step is marked `any`. Changing the fixture to `all` removes the mark.

*Pins 002 §5.3.*

### U1.5 Data edges are distinct, toggleable, and named

A step declaring `outputs: { paymentId: data.id }` consumed downstream produces a data edge labeled
`paymentId`. Toggling data edges off leaves the control edges untouched.

*Pins 002 §5.3.* The "data paths are named and drawable" claim of 001 §8.1 is only true if the name
is on the edge.

### U1.6 An undeclared dependency is drawn as a warning

A step referencing `{{steps.other.body.id}}` — 001 §8.3's permitted raw access — produces a data edge
in the warning style, and a matching warning diagnostic.

*Pins 002 §5.3, §6.* Omitting the edge would make the graph assert there is no data path where there
is one.

### U1.7 A shared slot is drawn through a glyph, not between steps

Both writers connect to the slot; the reader connects from it. No edge runs directly from a writer to
the reader.

*Pins 002 §5.3.* 001 §9.1's slots deliberately do not name a producer; an edge drawn writer-to-reader
would assert a relationship the format denies.

### U1.8 A sub-flow is one collapsed node until expanded

A `uses:` step renders as a single marked node. Expanding it reveals its internal steps under
namespaced ids (`auth/login`).

*Pins 002 §5.4.*

### U1.9 A linear flow renders as a single column

Every node in the no-`depends` fixture shares one horizontal position.

*Pins 002 §5.2.* The degenerate case is the common case, and it should look like a list.

### U1.10 Node order within a rank is file order, not run order

Run the fixture twice with the parallel branches returning in different orders (`wait-for` on one of
them). The rendered node positions are identical both times.

*Pins 002 §5.2.* A graph that reorders itself between runs is one nobody trusts.

---

## 4. U2 — A live run

### U2.1 Steps advance in dependency order

Run the linear fixture at `concurrency: 1`. Each node passes pending → running → `success`, and no
node enters running before its parent is terminal.

*Pins 002 §8.2.*

### U2.2 Concurrent branches are in flight together

Run the branching fixture at `concurrency: 2` with both branches on `wait-for`. Both nodes are in the
running state simultaneously.

*Pins 002 §8.3.* A list view cannot express this, which is the argument for the graph.

### U2.3 A poll shows its attempts

Against the new counter route, a step with `retry: { maxAttempts: 10 }` and a `shouldRetry` predicate
shows `attempt n/10` while polling, and settles to `success` when the route flips — not to
`retries-exhausted`.

*Pins 002 §8.2.* 001 §11.1 makes polling first-class; a poll rendering as a minute of "running" is
indistinguishable from a hang.

### U2.4 Each skip reason is distinguishable

One fixture producing all four: a `when: false` step (`condition-false`), a step whose parent failed
(`unmet-dependency`), a step consuming an output that was never produced
(`unresolved-dependency`), and a step never reached because the run was cancelled (`run-cancelled`).
Each node shows its own reason, and `unmet-dependency` is not presented as a failure.

*Pins 002 §8.2, and 001 §14.6 directly.* The four reasons mean different things and only one of them
means something went wrong.

### U2.5 Cancel leaves `cancelled`, not `failed`

Cancel a run with a `wait-for` step in flight. The in-flight node ends `cancelled`, unstarted nodes
show `run-cancelled`, and the flow's status word is `cancelled`.

*Pins 002 §7.1, §8.2, §8.4.*

### U2.6 Cleanup after cancel is visible

With a step declaring `depends: [{ status: [cancelled] }]`, cancelling shows the cleanup state in the
run control while that step runs, and the step completes.

*Pins 002 §7.1.* 001 §11.3's grace window means the app keeps working for up to 30 seconds after
cancel; a UI showing nothing looks hung at exactly that moment.

### U2.7 Iterations are selectable and independent

A dataset flow of three rows shows an iteration selector. Selecting each shows that row's own node
states, and a step failing in row 2 leaves rows 1 and 3 passing.

*Pins 002 §8.3.*

### U2.8 A run survives its tab being closed

Start a run, close the tab, reopen the flow. The run is still in progress or completed, not
cancelled.

*Pins 002 §4.2.* Tying a run's lifetime to a tab would skip 001 §11.3's cleanup path entirely.

### U2.9 Quitting cancels rather than kills

With a `wait-for` step in flight and a step declaring `depends: [{ status: [cancelled] }]`, trigger
the app's quit flow. The cleanup step runs, the run is recorded `cancelled`, and only then does the
window close. Relaunching shows that run in §10's selector, marked cancelled.

*Pins 002 §4.2.* The failure mode is silent: killing the engine with the process leaves no error
anywhere, and the only evidence is a resource on a real API that nothing deleted.

### U2.10 A run is visible without its tab

Start a run and close the tab. The flow's sidebar row shows a running indicator, then a failure mark
when the run ends red. Reopening the flow clears the mark.

*Pins 002 §4.1, §4.2.*

### U2.11 The summary uses flow vocabulary, not step vocabulary

A run with one failed step reports flow status `failed` and step status `failed`; a fully green run
reports `passed`, and no step anywhere reports `passed`.

*Pins 002 §8.4.* 001 §14.6 keeps the two vocabularies distinct on purpose.

---

## 5. U3 — Diagnostics

### U3.1 An error blocks the run; a warning does not

A flow with an unknown `operationId` has a disabled run control and an error diagnostic carrying
`unknown-operation`. A flow whose only problem is an unknown property runs, with a warning shown.

*Pins 002 §6.* 001 §5.4's forward-compatibility posture is what makes the second half necessary.

### U3.2 A diagnostic anchors to its line

The unknown-operation error is anchored at the `operation:` line in the document view; clicking it
scrolls there.

*Pins 002 §6, §11.1.*

### U3.3 A structural diagnostic badges its node

A cyclic dependency badges the nodes it names, not just the header list.

*Pins 002 §6.*

### U3.4 A flow that does not parse still opens

A `.flow.yml` with a YAML syntax error opens to the document view with the parse error anchored, an
empty graph, and a disabled run control — it does not fail to open.

*Pins 002 §6.* The file you most want to look at is the broken one.

### U3.5 Diagnostics refresh on a watcher change

Fixing the error on disk clears it in the open tab without reopening.

*Pins 002 §4.1, §6.*

### U3.6 A library flow is marked and asks for its params

A flow declaring `params:` is marked in the sidebar, and its run configuration shows the parameter
inputs. A required param left empty blocks the run.

*Pins 002 §4.1, §7.2, and 001 §12.5.*

### U3.7 Scope decides which environment control appears

A collection-scoped flow's run configuration offers the collection's environments. A workspace-scoped
flow offers the workspace/global environments and no collection selector, and a variable defined only
in a collection environment does not resolve in it.

*Pins 002 §7.2.* The negative half is the load-bearing one: an implementation that quietly fell back
to some collection's environment would work on the developer's machine and fail in CI, where 001
§13.2's tiers are assembled without one.

---

## 6. U4 — Inspection and history

### U4.1 A step opens to its request and response

Select a `success` node. The request tab shows the materialized request — including values seeded
from the OpenAPI document that appear nowhere in the flow file (001 §7.1) — and the response tab
shows status, headers and body.

*Pins 002 §9.* Asserting on a spec-seeded field is what proves the pane shows the *materialized*
request rather than the file's inline body.

### U4.2 Assertion results show expected and actual

A step with a failing assertion shows the expression, the expected value and the actual one.

*Pins 002 §9.*

### U4.3 Attempts are individually inspectable

A polled step exposes one row per attempt, and attempt 3's response differs from attempt 1's.

*Pins 002 §9*, and 001 §14.5's per-attempt capture.

### U4.4 Declared outputs show their values

The step pane lists each declared output with the value extracted for it.

*Pins 002 §9.*

### U4.5 A past run opens into the same view

With the committed `.bruno-runs/` fixture in the scope root, the run selector lists it, and opening
it renders the same graph, node states and step detail as a live run — including attempts.

*Pins 002 §10.* This fixture is generated by `bru flow run` and committed, which also makes it a
regression test on the capture layout: a change to 001 §14.5 that the app does not follow breaks
here.

### U4.6 A CI run directory opens unchanged

The same fixture, placed as if downloaded from a build artifact, opens without modification.

*Pins 002 §10.* The strongest argument for reading 001's directory format rather than an app-private
store.

### U4.7 Runs of other flows in the scope are excluded

A second flow's run directory in the same scope root does not appear in the first flow's selector.

*Pins 002 §10.*

### U4.8 An interrupted run lists and opens without claiming an outcome

A fixture run directory containing `run.json` and step captures but **no** `summary.json` appears in
the selector for its flow, marked interrupted. Opening it shows the steps that completed and no
overall status — not `failed`, not `cancelled`.

*Pins 002 §10, §11.2.* Without `run.json` this run cannot be attributed to a flow at all, so this
scenario is also the test that the 001 §14.5 addition landed.

### U4.9 An in-progress run appears in the selector

While a run is executing, it is listed for its flow with state `running` and no status.

*Pins 002 §10, §11.2.* Same mechanism as U4.8 — the live case is not an edge case, and an
implementation that only listed finished runs would hide the one being watched.

### U4.10 Capture-disabled runs degrade honestly

With capture disabled in run configuration, the request and response tabs say so; assertion and
validation outcomes still render.

*Pins 002 §9.* They arrive in `StepResult`, so there is no excuse for losing them.

---

## 7. Regressions not owned by a single scenario

### R1 — Bodies are never read from events

Instrument the IPC boundary: no `main:flow-run-event` payload contains a response body. The step pane
still shows one.

*Pins 002 §8.1, §9, and 001 §13.2.* The cheap wrong implementation attaches bodies to events and
works perfectly until a large response is serialized twice per step across IPC.

### R2 — Events are batched

A run at `concurrency: 5` with polling produces materially fewer `main:flow-run-event` messages than
`FlowEvent`s, and every event still arrives.

*Pins 002 §8.1.*

### R3 — Redaction holds in the app

A flow authenticating with a secret variable shows the header redacted in the step pane and in the
capture the pane read, with no UI affordance to reveal it.

*Pins 002 §9, and 001 §14.4.* `--show-sensitive` has no app equivalent by design.

### R4 — The renderer computes no semantics

A structural assertion, not a behavioral one: no module under `bruno-app/src/fork/flows/` imports a
YAML parser, and none reimplements ranking, join resolution, or status derivation. The graph model
arrives from `describeFlow`; captures arrive from `readCapture`.

*Pins 002 §11.1, §11.2.* Every drift between the app and the CLI would start here.

### R5 — The upstream touchpoint set matches the manifest

`git diff` against the upstream merge base touches exactly the files listed in 001 §13.4 plus 002
§12.1, and `useIpcEvents.js` gains exactly two lines.

*Pins 002 §12.1.* The manifest is only a contract if something checks it — and this is the assertion
to re-run after every upstream merge.

### R6 — Statuses and reasons are used verbatim

Every **terminal** status and every reason the UI renders is one of 001 §14.6's, verbatim: all four
statuses and all 13 reasons have a rendering, and none is paraphrased.

The three pre-terminal states of 002 §8.2 — `pending`, `running`, `retrying` — are the permitted
exception, and the assertion has to name them or it is untestable. They describe a step that has no
outcome yet, which is a thing 001 §14.6's vocabulary deliberately does not model: its strings are
what a *finished* step reports to a reporter. Assert that none of the three ever appears on a step
whose `step:end` has been received, which is the drift actually worth preventing.

*Pins 002 §8.2.* A vocabulary the UI paraphrases is one that drifts from the reporters CI parses.

---

## 8. Not covered here

- **Engine semantics.** 001-C owns them. A scenario here that could fail because the *engine* is
  wrong is misfiled.
- **Visual appearance.** No screenshot comparisons. Layout *relationships* are asserted (§3), colours
  and spacing are not — they will churn, and pinning them makes every design tweak a test failure.
  This is the same judgement 001-C §8 makes about console output.
- **The builder.** Nothing here edits a flow; 002 §3 excludes it.
- **Large-graph performance.** Correctness of concurrent rendering is U2.2; throughput is not a
  conformance question.
- **The `run.json` writer.** U4.8 and U4.9 assert the app reads it; that the *engine* writes it at
  run start belongs in 001-C once 001 §14.5 carries it (002 §11.4).

## 9. Traceability

| Scenario | Pins | The wrong implementation it catches |
|---|---|---|
| U1.1, U1.2 | §5.3, §1 | Drawing only declared edges |
| U1.3, U1.4 | §5.3 | A fallback branch that looks unconditional |
| U1.5, U1.6 | §5.3, §6 | Data paths invisible, or undeclared ones hidden |
| U1.7 | §5.3 | A slot drawn as a writer→reader edge |
| U1.8 | §5.4 | Sub-flow internals shown by default |
| U1.9, U1.10 | §5.2 | A graph that reorders between runs |
| U2.1–U2.3 | §8.2 | A poll that looks like a hang |
| U2.4 | §8.2 | One grey "skipped" state |
| U2.5, U2.6 | §7.1, §8.2 | Cancel reported as failure; cleanup looking hung |
| U2.7 | §8.3 | Iterations overlaid on one graph |
| U2.8, U2.9 | §4.2 | A run killed by ⌘W or by quit, skipping cleanup |
| U2.10 | §4.1, §4.2 | A run in flight with nothing in the app saying so |
| U2.11 | §8.4 | Step and flow vocabularies conflated |
| U3.1–U3.3 | §6 | Warnings blocking, or diagnostics with nowhere to land |
| U3.4 | §6 | A broken flow that cannot be opened |
| U3.5 | §4.1, §6 | Stale diagnostics after an edit |
| U3.6 | §4.1, §7.2 | A library flow run with no params |
| U3.7 | §7.2 | A workspace flow silently borrowing a collection's environment |
| U4.1–U4.4 | §9 | A pane showing the file's body rather than the materialized request |
| U4.5–U4.7 | §10 | A second, weaker viewer for stored runs |
| U4.8, U4.9 | §10, §11.2 | A run with no `summary.json` shown as failed, or hidden entirely |
| U4.10 | §9 | Blank panels instead of an explanation |
| R1, R2 | §8.1, §9 | Bodies on events; an unbatched stream |
| R3 | §9 | A secret visible in the app but not in CI |
| R4 | §11.1, §11.2 | The renderer growing its own parser |
| R5 | §12.1 | Manifest drift after an upstream merge |
| R6 | §8.2 | A UI-only status |
