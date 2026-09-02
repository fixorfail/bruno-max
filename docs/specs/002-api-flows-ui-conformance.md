# 002-C — API Flows UI conformance scenarios

**Status:** Draft — companion to [002-api-flows-ui.md](./002-api-flows-ui.md)
**Owner:** Jake Campbell
**Last revised:** 2026-08-14

Scenarios the UI spec's behavior was derived from, written to be implemented directly as Playwright
specs. Start at §2 for the harness, §3–§6 for the four scenario families, §7 for the host boundary,
§8 for the regression set, and §10 for which section of 002 each one pins.

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
  regressions.spec.ts           # §8
```

**§7's host scenarios are Jest, not Playwright**, and live beside the code they cover in
`packages/bruno-electron/src/ipc/flow/`. They are about what crosses IPC — which tier arrives in
which field, whether a batch mixes two runs — and driving that through a rendered UI would assert on
a picture of the answer rather than the answer. `.claude/rules/electron-ipc.md` already asks for
handler callbacks exported as named functions so they can be exercised without the main process;
these are the tests that asks for.

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

After a run, hovering that edge names the value it carried — `paymentId = "pay_1"` — and hovering it
before the producing step ends says nothing. A structured output is shown as far as it reads and cut
there; §9's pane is where it is read in full.

A step consuming **two** of that producer's outputs is joined to it twice: both names are legible,
each on its own line, and each hover reports its own value. This is the case a single label position
fails on, and it fails invisibly — the names are drawn, one on top of the other.

### U1.6 An undeclared dependency is drawn as a warning

A step referencing `{{steps.other.body.id}}` — 001 §8.3's permitted raw access — produces a data edge
in the warning style, and a matching warning diagnostic.

*Pins 002 §5.3, §6.* Omitting the edge would make the graph assert there is no data path where there
is one.

### U1.7 A shared slot is drawn through a glyph, not between steps — and only when asked for

With the **Shared slots** toggle off and nothing focused, the fixture draws no slot glyph and no slot
edge. Turning it on draws a glyph per slot: both writers connect to it, the reader connects from it,
and no edge runs directly from a writer to the reader. Two slots whose participants span the same
steps get two glyphs that do not overlap, each labeled with its slot's name.

*Pins 002 §5.3.* 001 §9.1's slots deliberately do not name a producer; an edge drawn writer-to-reader
would assert a relationship the format denies. The off-by-default half is what a flow with an
`authProfiles` entry reading `{{shared.token}}` forces: every authenticated step becomes a reader, and
a layer that cannot be turned off is a line from every box on the drawing to one glyph. Asserting
only that the glyph exists passes on the version that drew four of them at the same coordinate.

### U1.7a Focusing a step draws its own slots, and dims what it does not touch

Hovering a step that reads a slot draws that slot's glyph and **that step's** edge to it, with the
toggle still off; the slot's other participants are named on the glyph's hover rather than drawn.
Every edge and node not touching the focused step is visibly faded, both ends of a lit edge are lit,
and moving the pointer away restores the drawing. Selecting a step focuses it without a pointer.

*Pins 002 §5.3.* On a drawing with sixty edges, "which of these is mine" is the question, and dimming
is the answer that does not also throw away "how much else is going on". The it-draws-only-this-step's
edges half is the one an implementation gets wrong in the expensive direction — a slot with fourteen
participants answers a two-line question with fourteen lines.

### U1.8 A sub-flow is one collapsed node until expanded

A `uses:` step renders as a single marked node. Expanding it reveals its internal steps under
namespaced ids (`auth/login`), drawn as their own block of ranks continuing to the right of the
container node rather than continuing the caller's numbering.

Selecting the container writes `double click to expand` under it, in italic, and selecting an
ordinary step writes nothing. The line is gone once the internals are drawn.

Expanding also puts a band behind the steps the sub-flow drew — its container, and nothing else of
the caller, outside it — and rings that container in the band's colour. Expand a second sub-flow and
it takes a second colour; collapse either and the other's colour is unchanged. The rings sit outside
the boxes, so a container that failed still draws its own border red.

*Pins 002 §5.4.* Nothing else on the drawing announces the gesture, and a reader who never finds it
reads `subflow-failed` with no way to reach the step that caused it.

### U1.8a Several connectors between one pair of steps draw

A flow where one step feeds two of its outputs to a second step and two more to a third — the
`f3-batch-settlement` shape — draws, collapsed and with its sub-flow expanded. The connectors between
one pair share that pair's route, with a label each, stacked.

*Pins 002 §5.2, §5.3.* The layout ran every connector as its own edge through the layout engine,
which mislays some arrangements of parallel edges and throws — during render, so the tab caught it
and drew nothing at all, for a flow with nothing wrong with it. One route per pair is what the
drawing was always specified to show, which is why merging them costs it nothing.

### U1.8b An edge's label stays in the corridor between the ranks

A connector named `accountId` draws its label centred on its edge, inside the gap between the two
columns rather than over the box the edge points at. A name too long for the gap is elided, and the
edge's hover still names it in full.

*Pins 002 §5.3.* The label was laid out from the midpoint of its edge and ran rightward, so it had
half the corridor and spent the rest inside the consumer — from about the seventh character, which is
most output names. Centring is the fix; the elision is what stops a name longer than the whole
corridor from reaching a box anyway.

### U1.9 A linear flow renders as a single row, left to right

Every node in the no-`depends` fixture shares one vertical position, and each is further right than
the one before it. A rank holding fewer steps than the widest is centred against it, not aligned to
its top.

*Pins 002 §5.2.* The degenerate case is the common case, and it should look like a chain. Asserting
only "they share a position" passes on a vertical layout too, so the ordering half is what actually
pins the axis.

### U1.9a A node's text stays in its box

A flow with a step id longer than the node is wide, and one whose resolved path is — neither draws
outside its box, and both are legible over more than one line. An id with no spaces in it wraps too.

*Pins 002 §5.1.* SVG text does not wrap by any attribute, so this is not a styling nicety that could
be left to the stylesheet: it decides how the text is drawn at all. The unspaced id is the half that
distinguishes wrapping from breaking — a rule that only breaks between words leaves it overflowing.

### U1.9b The footer bar carries the markers, and the binding it calls

Every node draws a footer bar; a step with `when:`, `retry:`, `uses:`, `failOnStatusCode: false` or a
shared slot shows its marker there rather than over the step's name. **A step carrying four markers
at once shows four, none overlapping another and none overlapping the bar's edge.** On the two-API
fixture, the two bindings' bars are tinted differently, hovering a bar names its alias, and a key
titled `API` listing both sits over the graph and stays put while the graph is scrolled. **On a
one-API fixture the key is still there**, naming that binding, with no tint on the bars and no swatch
in the key.

*Pins 002 §5.1.* The four-marker case is the one a fixed pitch fails: `↻ 16` and `when` are words
rather than glyphs, so any step-per-marker spacing wide enough for one is too narrow for the other,
and the collision lands on whichever pair a given step happens to carry — which is why the markers
are laid out rather than positioned. The stays-put half is the legend's whole point: the drawing is
wider than its box, so a key inside the picture is visible only at rank 0, and with the alias off the
bar the key is the only thing that says which colour is which. The one-API case is not a degenerate
version of the same thing: nothing on that drawing names the service at all, which is why the key
outlives the colours that first justified it.

### U1.9d A step that computes values before its request is marked down its left edge

A step declaring 001 §8.7's `pre:` draws a coloured strip on the left edge of its box, the full
height of it, with a title naming what it means. A step declaring none draws no strip, and the strip
is not a footer marker.

*Pins 002 §5.1.* A footer marker answers "what does this step have" once you are already reading the
step; the question `pre:` gets asked with is "where in this flow is a value built", which is scanned
across the whole graph. The colour is the graph's one non-status hue — every other one already means
an outcome, and a strip in any of those would read as a verdict the step does not have.

### U1.9c A declared API colour is the one drawn

A fixture whose `apis:` binding declares `color: "#8ab4f8"` draws that colour on the bars of every
step calling it, on both themes, and shows it in the key. A **one-API** fixture that declares a
colour is painted with it, where one that declares none is not painted at all. A second binding
alongside a declared colour is assigned a different one.

*Pins 002 §5.1 and 001 §6.2.* The declaration is what a viewer must not overrule — a colour stored
beside the app is one machine's, and the file is the only place two hosts and a teammate agree. The
one-API half is where the two rules meet and an implementation is most likely to apply the
"nothing to distinguish" default over an explicit instruction.

### U1.10 Node positions come from the description, never from the run

Run the fixture twice with the parallel branches returning in different orders (`wait-for` on one of
them). The rendered node positions are identical both times, and identical again with no run at all.

*Pins 002 §5.2.* A graph that reorders itself between runs is one nobody trusts. Order within a rank
is now chosen to minimise crossings rather than taken from the file, which is a change of *which*
description-derived order is used and not a change to this: a layout that consulted anything the run
produced — completion order, duration — would draw one graph on a loaded machine and another on an
idle one.

### U1.11 Edges are routed around the steps they pass, and leave a step at distinct points

In a fixture with a step whose output is consumed several ranks later, that edge does not cross any
node box it does not connect — for every edge on the drawing, not only that one. A step with three
outgoing edges shows three distinct attachment points on its border, and each edge leaves the source's
right border and arrives at the target's left.

*Pins 002 §5.2.* This is the defect the layout engine was adopted for: measured on a real 18-step
flow, the hand-rolled version put 40 of 63 edges through boxes they did not connect. The
distinct-attachment-points half is separately load-bearing — eleven edges leaving one point is a
drawing in which no single edge can be followed, whatever the routing does after that.

### U1.12 The columns are the engine's ranks

A fixture with a one-step branch and a three-step branch that rejoin: the one-step branch sits in the
column its `rank` names, adjacent to the fork, rather than being pushed rightward against the join.

*Pins 002 §5.2, §11.1.* The engine decides ranks and the app decides pixels. A layout engine with a
ranker of its own will re-derive them by default — dagre's `longest-path` measures to a sink, which
draws a different graph from the one the CLI executes, and it does so silently on exactly the
branch-and-rejoin shape flows are written in.

### U1.13 Stages divide the drawing without moving it

A description carrying three stages draws a named region for each. Every boundary past the first
column has a rule in the gap between the two columns it divides — clear of the box on either side,
and centred between them — and the one *at* the first column has its name and no rule. The names sit
in a strip above the drawing that exists only when there are names, and the rules are drawn behind
the steps. A description with no stages draws neither.

*Pins 002 §5.5.* Two failures this is between. A rule at the drawing's left edge is a line dividing
a stage from nothing, and the first thing lost when the graph scrolls. And the names had to go
somewhere the halo of a running step in the top row is not already using — written into the existing
margin they are read through whichever step happens to be executing, which is the kind of defect that
only appears during a run.

Which boundaries arrive here at all is 001-C's R4q, not this file's: dropping the ones the schedule
contradicts is a statement about 001 §9.1's graph, and this view draws what it is given.

### U1.14 The interface is drawn at both ends of the flow

A library flow declaring `params:`, `vars:` and `exports:` draws an inputs panel to the **left** of
rank 0 and an exports panel to the **right** of the last rank. No step moves for either, and no edge
is drawn to or from them. A flow declaring neither draws neither panel. Each export row shows its
`steps.<id>.<output>` reference until the step behind it ends, and the value after — still the
reference while that step is running, and still the reference if it ends without producing the
output. A stored run whose description predates the panels draws the graph with them absent.

*Pins 002 §5.6, §11.1.* The panels are layers beside the graph, not ranks in it: a box inserted at
rank -1 or one past the last would renumber every column and make the drawing disagree with the run
the CLI executes. The mid-run half is the one that fails quietly — a value read before its step is
terminal is the previous attempt's on any step that retries, which reads as an export that changed
its mind.

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

Its node carries the in-flight halo throughout, in the retry colour rather than the running one from
the second attempt on, and the step detail's spinner turns for the whole poll rather than stopping
between attempts. Both are gone once the step settles.

*Pins 002 §8.2, §9.* 001 §11.1 makes polling first-class; a poll rendering as a minute of "running"
is indistinguishable from a hang, and a marker that resets on each attempt is how a poll comes to
look like a series of separate steps that each finished.

### U2.4 Each skip reason is distinguishable

One fixture producing all four: a `when: false` step (`condition-false`), a step whose parent failed
(`unmet-dependency`), a step consuming an output that was never produced
(`unresolved-dependency`), and a step never reached because the run was cancelled (`run-cancelled`).
Each node shows its own reason, and `unmet-dependency` is not presented as a failure.

*Pins 002 §8.2, and 001 §14.6 directly.* The four reasons mean different things and only one of them
means something went wrong.

### U2.4a A reason that names nothing carries the fact that does

The `unresolved-dependency` step of U2.4's fixture: hovering its node names the reference that was
never produced, and selecting it shows the same message above the step detail's tabs — on a run with
captures and on one without, since a skip has no capture either way. The run's verdict is `failed`
while no node is red, which is what this has to explain.

*Pins 002 §8.2, §9, and 001 §14.6's message.* This is the one outcome where every visible node is
green or grey and the run is still red; a UI showing only the reason leaves the person who ran it
reading the flow file to work out which value went missing.

### U2.4b The missing value is marked on the edge it should have travelled

Same run: the data edge from the producer to the skipped consumer is marked `✗` beside its output
label and carries the consumer's message on hover. A second data edge into the same consumer, whose
value *was* produced, is unmarked. Re-run with the output produced and no edge is marked.

*Pins 002 §5.3, §8.2.* The failure belongs to the path rather than to either end of it — the producer
succeeded and the consumer never ran — so a graph that marks only nodes has nowhere to put it. The
unmarked second edge is the half that matters: a UI keying off the consumer's reason alone paints
every incoming edge and points at the value that was fine.

### U2.4c The summary names the step the verdict fell on

The same run: its summary reads `failed` beside `0 failed`, and names `archive_receipt` as the cause.
Clicking that opens the step detail on it — reason, message and all — and highlights its node.
Neither an ordinary failing run (whose cause is already red in the graph) nor a passing one shows a
cause at all. On a dataset run where only iteration 2 was decided this way, iteration 1 shows none.

*Pins 002 §8.4, and 001 §13.2's `decidedBy`.* The counts tally step statuses and this verdict comes
from a *skipped* step, so the summary contradicts itself without this. The dataset half is what
catches a run-level list rendered against whichever iteration happens to be on screen.

### U2.4d A run that fails on its own stops looking like one still going

A flow whose engine-level failure is unavoidable — a step naming an operation the bound spec does not
contain, run without validating first — ends: the run control returns to **Run**, the summary reads
`failed`, and the graph stops. It does not sit at *running* with a Cancel that does nothing.

*Pins 002 §8.1, and 001 §13.2's termination guarantee.* The app resolves its own promise at
`run:start` and watches events from there, so a run that ended without saying so is a spinner with
nothing behind it — and the Cancel beside it has no run left to cancel, which is exactly how it reads
to whoever clicks it.

### U2.4e No marker outlives the run it belongs to

Force a run to end with a step still reading `running` — 001 §13.2's terminal `run:end` after a
failure no step could carry. The node's halo goes out, the step detail's spinner stops, and the pane
says the run ended without that step reporting rather than showing `running`. The run control is back
to **Run**.

*Pins 002 §8.2, §9.* A marker is a claim about now, and the node state it reads is a record of what
was last said — the two part company exactly once, and it is the case where nothing further is coming
to correct it.

### U2.5 Cancel leaves `cancelled`, not `failed`

Cancel a run with a `wait-for` step in flight. The in-flight node ends `cancelled`, unstarted nodes
show `run-cancelled`, and the flow's status word is `cancelled`.

Cancel one during a **polling** step's retry delay: it stops there rather than when the delay would
have elapsed, the node ends `cancelled`, and no further request goes out. A poll's delay is where a
run spends nearly all of its time (001 §11.1 allows 30 seconds of it), so a cancel that waited for the
sleep is a button that does nothing for as long as anyone is likely to watch it.

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

### U2.12 A flow's requests appear in the DevTools network tab

Run a two-step collection-scoped flow with the DevTools console open on Network. Both requests appear
as rows, with their method, status, and the URL including its query string, interleaved by time with
a request sent from an ordinary request tab in the same collection. Selecting a row opens the details
panel on that request's headers and its response body.

*Pins 002 §8.5.* This is the scenario the whole section exists for: a flow that dispatched perfectly
and showed nothing in the one panel that lists what the app sent. The interleaving matters as much as
the presence — a panel that appended flow requests at the end would order a run against the clock
wrongly. The cheap wrong implementation restores upstream's `useMemo` over collection timelines on a
merge and passes every other scenario here.

### U2.13 A poll's attempts are separate rows

A step that polls to a settled state produces one network row per attempt, each selectable and each
showing its own response.

*Pins 002 §8.5* — attempt is the row's identity, and the panel is where a poll's individual responses
are compared. A row keyed on the step would collapse twenty of them into one.

### U2.14 A workspace-scoped flow's requests are listed, and open

A flow under the workspace's own `flows/`, with no collection, produces rows; selecting one and
opening the details panel's **Response** tab renders the body. The row's `collectionUid` is the
workspace's scratch collection. Closing the collection a *collection*-scoped flow named, with its
rows still in the log, has the same two outcomes.

*Pins 002 §8.5 and §7.2.* Two failures with one cause. An implementation that needs a collection to
list a row at all drops exactly these — and a workspace flow spanning services is the case the panel
helps most. One that lists them unattributed instead **crashes** on the second half: the response
preview dereferences `collection.uid`, so a row with no collection takes the renderer down rather
than reading as anonymous. Asserting the rows exist without opening one passes while the panel is
still broken.

### U2.15 The view follows the step in flight

In a window narrow enough that the linear fixture's last ranks are outside the graph's box, run it
and watch the graph's scroll position: each step that starts outside the box brings the view to it,
and the node in flight is inside the box at every point in the run. Selecting a step stops that — a
later step starting leaves the view where the selection put it — and clearing the selection resumes
it at whatever is running then. A poll (U2.3) moves the view once, not once per attempt.

*Pins 002 §5.2 and §8.2.* Scrolling rather than scaling is what keeps a long flow readable, and the
halo marking the running step is worth nothing on a step nobody is looking at. The selection half is
the one an implementation gets wrong in the direction that hurts: §9's pane reads the selected step,
and a graph that keeps scrolling away from it is unusable in exactly the moment a run is being
debugged. Asserting only that the view moved passes on an implementation that re-scrolls on every
event, which fights a reader who scrolls anywhere themselves.

---

## 5. U3 — Diagnostics

### U3.1 An error blocks the run; a warning does not

A flow with an unknown `operationId` has a disabled run control and an error diagnostic carrying
`unknown-operation`, listed above the graph. A flow whose only problem is an unknown property runs,
and reports `1 warning` at the end of the toolbar, beside the data-edge toggle and the run selector —
not as a list, and not beside the errors.
Hovering the count lists it with its code and line; focusing it does the same. A flow with one of
each shows the error listed and the warning only under the count.

*Pins 002 §6.* 001 §5.4's forward-compatibility posture is what makes the second half necessary: a
flow can carry a warning for as long as it exists, so a warning presented like an error is a standing
instruction to fix something that is not broken — and it costs the drawing a strip of room every time
the tab is opened.

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

### U3.5a Capture is a kind of run, not a remembered setting

`Run` starts a run that writes to `.bruno-runs/`, on one click, with no capture control anywhere
beside it. Opening the control's menu and clicking **Run without capture** starts a run immediately
and that run writes nothing — and the *next* `Run` captures again. Both halves are disabled while the
flow has errors.

*Pins 002 §7.1, §7.2 and 001 §14.5.* The does-not-remember half is the reason this moved off a
checkbox: a run that captured nothing is indistinguishable from one that did until §9's pane says it
has nothing to show, which is far from the moment the decision was made. The runs-immediately half is
the other: a menu that armed the button instead would be the checkbox with an extra step in front of
it.

### U3.6 A library flow is grouped apart and asks for its params

A flow declaring `meta.library: true` is listed under the `Libraries` label at the end of its scope's
group — **without being opened first** — and its run configuration shows the parameter inputs. A
required param left empty blocks the run. A scope with no library flows shows no such label, and a
scope holding nothing but libraries still shows one.

*Pins 002 §4.1, §7.2, and 001 §12.5.* The without-opening half is the one that fails silently: the
flag is on the watcher's tree entry precisely because the sidebar lists flows nobody has opened, and
an implementation reading it from a description instead groups a library only after it has been
opened — by which point the reader has already found out.

### U3.6a A flow reads by the name it declares

A flow declaring `meta.name` is listed under that name, and opens into a tab labelled with it. One
declaring none is listed and labelled by its filename. Its raw editor tab is labelled by the filename
either way.

*Pins 002 §4.1, §4.3.* The filename is a fallback, not the flow's identity — and a name that only
appeared once the flow had been opened would be no name at all in the list that opens it.

### U3.6b The environment is selectable from the flow itself

A workspace with two environments: the flow tab's **header** offers both in the app's own environment
dropdown — at the end of the row, where a collection's header carries it — shows the active one, and
choosing the other changes what the app runs against everywhere, the request tab beside it included.
With none selected the trigger is the app's dashed *No Environment*, the same one every other surface
shows. Choosing *no environment* is offered and takes
effect. **Configure** opens the workspace's environments. A workspace with none opens on the same
list's empty state, which is the way in to creating one — and no Collection tab appears for the
collection a workspace flow borrows.

*Pins 002 §4.2, §7.2.* A flow tab hides the collection it borrows, and the environment selector went
with it — so without this there is nowhere to make the choice while looking at a flow, and a run
quietly uses whatever was last selected somewhere else. Its *place* is half the assertion: a control
someone uses daily, moved, is a control they have to find again. The "everywhere" half is the one worth asserting: a flow with a private selection
would run against different values than the request beside it.

### U3.6c A run's own diagnostics are shown

Run a flow with the capture directory made unwritable. The steps run and are judged normally, the run
does not fail on that account, and the tab lists a `capture-write-failed` diagnostic naming the step
and attempt. Selecting that step, the request and response tabs say its capture was **not written** —
not that one could not be read.

*Pins 002 §6, §9, and 001 §13.2, §14.5.* An artifact write that fails must not fail a run, which is
not the same as not reporting it: unreported, the step shows no request, no response, and no reason,
and the pane blames itself for a file nothing ever wrote.

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

**A step that declares no headers of its own still shows the ones it sent** — at minimum the body's
content type, and the `Authorization` its auth profile produced. Both tabs label the header group and
say so explicitly when the capture holds none.

**Both bodies must be *visible*, not merely present in the DOM** — assert a non-zero rendered box for
the body on each tab, on a step whose response carries enough headers to fill the pane.

*Pins 002 §9.* Asserting on a spec-seeded field is what proves the pane shows the *materialized*
request rather than the file's inline body. The header half proves something the materialized request
alone cannot: 001 §13.2 leaves auth, content type and cookies to the host, so a capture built from
the step's own headers records a request nobody sent — and for the ordinary step that declares none,
records an empty set. The visibility half is a layout relationship rather than
an appearance one (§9): the body renders last, after every header row, so a pane that grows with its
content instead of scrolling puts it behind the tab's `overflow: hidden` — present in the DOM, passing
every unit test, and unreachable on screen.

### U4.1a Clicking the selected step clears the selection

Select a step, then click the same node again: the detail pane closes, the graph stops dimming, and
no node reads as selected. Clicking a *different* node moves the selection rather than clearing it.

*Pins 002 §9.* There is no other control that clears it — a pane with no close button and a selection
that only ever moves is a graph that cannot be returned to watching the run (§5.2's follow and §5.3's
focus both answer to nothing being selected). The move-don't-clear half is what a naive toggle breaks.

### U4.2 Assertion results show expected and actual

A step with a failing assertion shows the expression, the expected value and the actual one.

*Pins 002 §9.*

### U4.3 Attempts are individually inspectable

A polled step opens on the attempt that settled it. Its header offers every attempt it made, and
choosing an earlier one shows that attempt's response *and* that attempt's assertion outcomes — a
poll that failed twice before passing reads as failed on attempt 1 and passed on the last, never as
passed throughout.

*Pins 002 §9*, and 001 §14.5's per-attempt capture.

### U4.4 Declared outputs show their values, next to what they came from

The step pane lists each declared output with the value extracted for it, on the **response** tab and
immediately above the body — with nothing between the two. It appears on no other tab, and still
appears when the run was made with captures disabled.

*Pins 002 §9.* Rendering it above the tab strip satisfies "lists each declared output" and is what
this scenario exists to reject: it puts the values on all five tabs, three of which have nothing to
do with them, and furthest from the body they were read out of. The capture-disabled half is the
other easy mistake — outputs arrive in `StepResult`, so nesting them inside the capture render loses
them for exactly the runs that have least else to show.

### U4.4a A step selected before the run opens by itself when the step ends

Select the first step of a flow that has not run, **then** press Run. While the step is in flight the
request tab says it is waiting; when the run finishes the request and response appear **without the
pane being closed and reopened**. No `renderer:flow-read-capture` rejection is logged for the run.

*Pins 002 §9.* The order is the whole scenario: `run:start` reports the capture directory before any
step has written into it, so a pane that reads on directory-known reads an empty directory. It then
reports "the capture could not be read", which is true and useless, and stays there because nothing
re-reads on `step:end`. Reopening the pane cures it — which is exactly what makes this survive manual
testing that clicks the step *after* the run. Assert the absence of the rejection too: a pane that
retries on a timer would show the right thing eventually while still failing the read.

### U4.4b The graph/detail split is dragged, remembered, and bounded

Drag the handle between the graph and the step pane: the pane resizes, and the graph takes the rest.
Neither can be dragged away — at both extremes the other keeps a visible minimum. Double-click
returns the pane to its default. Close the tab, open a different flow, and the dragged size is still
in effect.

*Pins 002 §9.* Persisting per tab rather than globally passes the first three sentences and fails the
fourth, which is the one that makes it a preference rather than a gesture. The bounds are the other
half: a split that clamps only one side lets the pane be dragged to fill the tab, and the graph is
what the tab is for.

### U4.4c A `uses:` step's pane says what the step is

Run a flow with a `uses:` step whose sub-flow contains a failing request. The container's node reads
`failed · subflow-failed` and its pane names the internal steps that failed. Every tab on that pane
says the step sent nothing itself and offers to draw the sub-flow's steps; none of them claims a
capture was not written. Take the offer and the internals appear in the graph (§5.4), where the
failing request opens into its own request, response and assertions. The offer is gone once they are
drawn, and the response tab of the container still shows the sub-flow's exports.

*Pins 002 §9, §5.4, and 001 §12.* A container has no `capturePath` and never will, so the
capture-was-not-written line renders a fact of the contract as a fault, and sends the reader to run
diagnostics that have nothing to say about it — while the steps that do hold the answer are not even
on the drawing.

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

### U4.9a Current stays reachable after a run, and is not returned to on its own

Run a flow. When it finishes, its own entry is what the selector shows — not `current` — and the
graph still carries the outcomes. `current` is in the list, and choosing it drops the run: the graph
is drawn from the flow as it is on disk now, with no node states and no run summary. Edit the flow
in §4.3's editor first and the `current` graph is the edited one, while the run's entry still opens
the graph it executed.

While the run is executing the selector is locked, and the Cancel control is the way out of a run in
progress.

*Pins 002 §10.* Offering `current` only while no run is open makes the flow-as-it-is unreachable
from the moment of the first run — the one state in this list that is not history, gone exactly when
the file is most likely to have moved on. The other half is the converse: a run that ended by
snapping the view back to `current` would throw away the outcomes it was started to produce.

### U4.10 Capture-disabled runs degrade honestly, and only themselves

With capture disabled in run configuration, the request and response tabs say so; assertion and
validation outcomes still render.

Then the converse, which is the one with teeth: run a flow **with** capture on, open a step's
request, and *now* uncheck capture in the run control. The captures on screen are unaffected, and
still are after switching steps and tabs. Opening a stored run from §10 while the box is unchecked
shows its captures too.

*Pins 002 §9.* Assertion and validation outcomes arrive in `StepResult`, so there is no excuse for
losing them. The second half catches the pane reading the checkbox instead of the run: it ties what a
*finished* run can show to a setting for the *next* one, so configuring the next run erases the
evidence from the last, and a run written by `bru` last week inherits whatever the control says now.

### U4.10a A running flow is not redrawn by an edit to its file

Start a run against a flow with a `wait-for` step, and while it is executing add a step in §4.3's
editor and save. The running graph does not gain the node — it stays the graph the run started with,
and the run finishes against it. Reopening the flow afterwards shows the new step.

*Pins 002 §8, §10, and 001 §13.2's `run:start` description.* Saving clears the stored description so
§6 re-describes, which is what would otherwise redraw a run in flight from a file it is not executing.

### U4.10b A past run is drawn as the flow it ran, not as the flow now

Run a flow, then rename one of its steps and add another — through §4.3's editor, which is the fast
way to do both. Reopen the earlier run from the selector: it draws the graph it executed, the renamed
step still carries its outcome and its captures still open, and the step added since does not appear
at all. The selector marks that run `flow edited since`.

Then the negative: a run directory with no snapshot (one written before 001 §14.5 recorded them)
opens against the current graph as it always did, and is **not** marked — unknown is not changed.

*Pins 002 §10, §11.2, and 001 §14.5's snapshot.* Every part of this failed silently before: the
renamed step's outcome vanished from the view, its captures became unreachable through a directory
name that cannot be inverted, and the new step rendered as one that never ran.

### U4.11 The raw editor is reached from the row menu, as its own tab

The flow's sidebar row carries a menu holding `Edit Yaml`. Choosing it opens a tab marked with a
pencil and an italic file name, showing the flow's text below its graph — and the flow still opens
into the run view from the row itself, as a second tab.

*Pins 002 §4.3.* Raw editing is the non-standard way in: reachable, and not what opening a flow does.

### U4.12 The graph follows the draft, and only a draft that parses

In the raw editor, add a step to the YAML without saving. The graph gains the node and its edge.
Then break the document mid-file: the graph holds what it last drew and the view says the YAML is
invalid — it does not empty. Restore it and the node returns.

A flow whose `vars:` carry a `!file` fixture (001 §5.4) is **not** one of the broken cases: the graph
follows it, the view says nothing about invalid YAML, and auto-save writes it.

*Pins 002 §4.3.* Answering "what did that edit do to the flow" from the last saved version answers a
different question, and a graph that vanished mid-keystroke would take the reference point with it.
The tag row is the one this check would otherwise miss entirely: an ordinary YAML reader calls a
`!file` an unknown tag, so the editor declares a valid flow invalid and freezes on it — with the CLI
validating the identical file.

### U4.13 Saving obeys the app's preference, and never writes broken YAML

With `autoSave` off, edits stay unsaved until ⌘/Ctrl+S or the Save button; the state says so
throughout. With `autoSave` on, a valid edit reaches disk after the configured interval and no Save
button is offered. With `autoSave` on and the draft not parsing, **nothing is written**, however long
it is left — and the run view continues to describe the file on disk, not the draft.

*Pins 002 §4.3.* A timer writing a half-typed line puts a file the watcher is reporting and a run may
be about to execute into a state nobody chose.

### U4.14 The editor refuses a path outside its scope

`renderer:flow-write-source` called with `../../elsewhere/x.flow.yml`, and with a sibling directory
sharing the scope's name prefix (`/workspace-two` against scope `/workspace`), is refused in both
cases. A path that is not a `.flow.yml` is refused too.

*Pins 002 §4.3, §11.3.* These are the only channels naming a file the user chose, and `preload.js`
has no allowlist — so the containment test has to be a resolved-path comparison rather than a string
prefix, which is what the second case catches.

### U4.15 Flow properties edit the `meta:` block and the file's own name

The row menu's second item opens a dialog holding the flow's `meta.name`, description, tags and
library flag **as the file declares them**, plus the filename with its `.flow.yml` extension not
offered for editing. Saving writes the block; clearing a field removes the key rather than writing
its default; everything outside `meta:` is left as it was.

Changing the file name renames the file **in place** — the directory does not change — and refuses if
a flow of that name is already there. A name that is not a valid filename, and an empty flow name,
are both refused before anything is sent.

*Pins 002 §4.4, and 001 §5.2 for what the block holds.* A flow's directory decides its scope (001
§5.1), so a rename that moved the file would change which environment tier it resolves against from a
control labelled with what it is called. 001 §5.2 makes a flow's identity its path and a rename just
a rename — nothing rewrites another flow's `uses:`, and the dialog says so where the rename is typed.

### U4.15a A rename takes the flow's open tabs and its run state with it

With the flow open in both its run view and its raw editor, rename it. Both tabs address the new
path, the run tab still reads by the flow's name and the editor by its file, and no tab is left
pointing at the old one. A run being watched, the params typed into the run panel and the selected
step all follow the flow rather than being dropped.

Saving properties **without** changing the name disturbs no tab at all.

*Pins 002 §4.4, §4.2.* A tab is keyed on pathname and type (§4.3), and the watcher reports a rename as
an `unlinkFile` and an `addFile` — two unrelated facts. Folding them that way drops state belonging
to a file that never stopped existing, and leaves every tab of that flow reading "no longer on disk"
with the flow reopening beside them as a second tab.

### U4.15b The dialog refuses to open over unsaved YAML

With the flow's raw editor holding an unsaved edit, the properties item does not open the dialog and
says why. With the editor open and its text matching the file, it opens normally.

*Pins 002 §4.4.* The dialog edits the text **on disk**. A dirty editor means the disk is already
behind what the author is looking at, so §4.3's auto-save would write the draft back over the
properties they had just set — with nothing on either surface saying it had happened.

### U4.15c Closing a dirty flow editor asks first

Closing the tab of a raw editor with unsaved changes prompts rather than closing: `Don't Save` closes
and writes nothing, `Save` writes then closes, and a save that **fails** leaves the tab open. The tab
carries the same unsaved marker every other Bruno tab does. A clean editor, and §4.2's run view
whatever the editor holds, close without asking.

*Pins 002 §4.3, §4.4.* A flow editor's draft is the only unsaved state upstream's tab strip cannot
see — every other draft hangs off a collection item. Closing does not lose it within a session, but
nothing persists the flows slice, so a quit after the close loses the edit silently.

### U4.16 Scripts are listed, and open into their own editor

A `.js` file under `flows/scripts/` appears in the sidebar under a `Scripts` label, **below** the
libraries, named by its filename and carrying no row menu. Clicking it opens a third tab type showing
the file in JavaScript mode — with no graph. A scope with no scripts shows no label.

Editing it behaves as §4.3's editor does: the draft survives a tab switch, ⌘/Ctrl+S and the Save
button write it, `autoSave` writes it on the interval, and the file changing underneath a clean
editor refreshes it while a dirty one is told the two diverged.

*Pins 002 §4.5.* `use:` still decides what a flow can call — 001 §8.6 picks up nothing implicitly, and
putting a file in the folder does not make a flow see it. The section makes helpers findable, which is
all it claims to do.

### U4.16a A script is renamed from its own row menu

The script row carries a three-dot menu holding **`Rename` and nothing else** — neither `Edit Yaml`
nor the flow properties, which act on a `meta:` block a `.js` does not have. Opening the menu does
not open the script behind it.

The dialog opens on the file's stem with `.js` shown but not editable, renames **in place** — a
script in `flows/scripts/money/` stays there — and refuses to land on a file already present, or on a
name that is not a valid filename. The script's open tab follows to the new path and is renamed with
it, and an unsaved edit in its editor crosses with the file.

*Pins 002 §4.5, §4.4.* A script's only name is its filename, so the rename is the whole of what a
script's menu can offer. It stays in the directory because the directory is what makes a `.js` a
listed script — moving it out would delete it from the sidebar as a side effect of naming it — and
nothing rewrites the `use:` entries that named the old path, which `bru flow validate` reports as
`unresolved-function-library`.

### U4.17 A script that does not parse is never auto-saved

With `autoSave` on, break the JavaScript mid-file: **nothing is written**, however long it is left,
and the view says the file does not parse. Repair it and it saves. An explicit Save writes it either
way.

`renderer:flow-write-source` is refused for a `.js` **outside** `flows/scripts/` — including one
elsewhere inside the same scope — and for a path climbing out of the scope, and for a sibling
directory sharing the scope's name prefix.

*Pins 002 §4.5, §11.3.* This is U4.13's rule with higher stakes: a flow's broken YAML breaks that
flow, but a script is composed into the prelude of *every* script position in *every* flow that names
it (001 §8.6), so one half-typed line fails all of them at once with `script-error` naming whichever
step happened to run first. The guard is a directory and not an extension because "a `.js` inside the
scope" would make every npm package the user has installed writable from the renderer.


### U4.18 A flow's directory is a folder in the sidebar

With `flows/checkout.flow.yml`, `flows/company/create_company.flow.yml` and
`flows/company/billing/invoice.flow.yml` on disk, the section shows a **`company` folder row above
`checkout`** and nothing of what is inside it. Opening `company` reveals `create_company` and a
`billing` folder — but not `billing`'s own flow until `billing` is opened too. Clicking `company`
again closes it.

A nested flow opens, runs and carries its run mark exactly as a top-level one does, and its row menu
holds the same `Edit Yaml` and properties. Two flows named `create.flow.yml` in different folders are
two distinct rows.

The libraries and the scripts fold the same way. A library in `flows/auth/` appears under an
**`auth`** folder beneath the `Libraries` label; a `.js` in `flows/scripts/auth/` under an `auth`
folder beneath `Scripts`, with no `scripts` folder row restating the label. Where one directory holds
both an ordinary flow and a library, the two `company` rows either side of the `Libraries` label
**open independently**.

Collapse the **API Flows** section entirely and reopen it: the folders that were open are still open.

*Pins 002 §4.1a.* The watcher already reported these flows — recursion into `flows/` predates this
scenario — so what is under test is the folder, not the discovery. The reopen is the case the obvious
implementation fails: `SidebarSection` unmounts its children when collapsed, so expansion held in the
component is lost on the one gesture most likely to precede reopening it.

### U4.18a The header opens and closes every folder at once

With folders nested two deep and all collapsed, the section header's three-dot menu — beside the `+`,
not inside it — holds **`Expand All Folders`** and **`Collapse All Folders`**. Expanding reveals every
flow at every depth in one gesture; collapsing returns the section to folder rows alone. Both items
are present whichever state the tree is in, and **the menu itself is absent** when the workspace's
flows sit in no folders at all. The `+` opens the create form directly.

With a second workspace's flows also watched, collapsing here does not touch the folders opened
there: switching to that workspace shows them still open.

*Pins 002 §4.1a, §4.1.* The last part is the one that fails silently — the store accumulates every
scope watched since launch, so a collapse-all implemented by clearing the map shuts folders in a
workspace the reader is not looking at and cannot see change.

### U4.19 Fixtures are listed, and open as editable text

Files under `flows/fixtures/` appear in the sidebar under a `Fixtures` label, **below** the scripts,
named by their filenames and carrying **no** row menu. A `.json`, a `.csv`, a file with no extension
at all and a `.js` are all listed; a `.json` sitting anywhere else under `flows/` is not. A scope with
no fixtures shows no label.

Clicking one opens a fourth tab type showing the file as text — no graph — highlighted by its
extension, and `text/plain` for a `.csv` or an extensionless file. Editing behaves as §4.3's editor
does: the draft survives a tab switch, ⌘/Ctrl+S and the Save button write it, `autoSave` writes it on
the interval, and the file changing underneath a clean editor refreshes it while a dirty one is told
the two diverged.

**A draft that is not valid JSON is still auto-saved**, where a script's broken JavaScript would not
be. A `.js` under `flows/fixtures/` opens as a fixture and is written back there, rather than being
refused for sitting outside `flows/scripts/`.

*Pins 002 §4.6, §4.5.* `!file` still decides what a flow reads — 001 §7.4 resolves the path each flow
writes out, and putting a file in the folder does not make a flow see it. The section makes the corpus
findable, which is all it claims to do. The absent gate is the deliberate half: a corpus has no single
language, so gating the files that happen to be JSON would be a rule that fires by extension.

### U4.19a A fixture that is not text is refused, not decoded

Put a real `.pdf` in `flows/fixtures/` — 001 §7.4's own example attaches one. It is **listed**, and
clicking it opens a tab saying the file could not be read because it is not text. **No editor is
shown**, and nothing is written to the file. `renderer:flow-read-source` refuses it directly, and
refuses any path climbing out of `flows/fixtures/`.

*Pins 002 §4.6, §11.3.* This is the case an extension allowlist gets wrong in both directions, which
is why content decides it. Decoding the file as UTF-8 would fill the editor with replacement
characters and the next auto-save would write them back — destroying a file in the repository with
nothing on screen having said so, and no error anywhere to find afterwards.

### U4.20 A flow is duplicated from its row menu

The flow's row menu holds **`Duplicate`** alongside `Edit Yaml` and the properties. Choosing it opens
the **Create API Flow** form retitled *Duplicate API Flow*, filled from the flow's own `meta:` — the
name suffixed `copy`, the file name `<kebab>-copy`, the description, the tags and the library
checkbox — with the source flow's directory as the location. The API spec list is **absent**, replaced
by a line naming the file everything else is copied from.

Confirming writes a new flow beside the original. Its `meta:` is what the form said; **everything
else is the source's, byte for byte** — the `steps:`, the `apis:` block, the comments between them,
and a `!file` fixture reference, which a serializer of the app's own would have destroyed. The
original is unchanged, and the new flow appears in the sidebar without a reload.

Duplicating onto a name already taken is refused and says so. Duplicating a flow whose YAML editor
holds unsaved changes is refused before the form opens, the way the properties dialog is. `Duplicate`
does **not** appear on a script row or a fixture row.

*Pins 002 §4.7, §4.4.* The byte-for-byte half is the whole feature: rebuilding the document from the
form would silently drop every step the author is duplicating the flow to keep. The unsaved-editor
refusal is the case with no other signal — the host copies the file on disk, so the duplicate would
be missing the author's last edits, in a file they would then go on to edit as though it had them.

---

## 7. U5 — The host boundary

002 §11.3's channels are a contract two implementers read, and every scenario below has a wrong
implementation that a rendered UI cannot distinguish from the right one — a merged variable map
still resolves `{{token}}`, and a batch that mixes two runs still animates a graph.

### U5.1 A tier arrives as a tier

`renderer:flow-run` is given an environment defining `baseUrl` and a collection variable of the same
name. `runFlow` receives them in `variables.environment` and `variables.collectionVars`
respectively — two populated fields, not one merged map — and the value the run interpolates is the
one 001 §7.3's precedence selects.

*Pins 002 §7.2, §11.3, and 001 §13.2.* The cheap wrong implementation merges in main and works on
every flow where no two tiers define the same name.

### U5.2 A secret variable keeps its flag across IPC

An environment variable with `secret: true` reaches main with the flag intact and its value present.

*Pins 002 §7.2, §11.3.* This is the input 001 §14.4's provenance tracking has never had, and a
handler that flattened to `{name: value}` in the renderer would destroy it while looking correct —
the run still authenticates, and the secret is simply never masked.

### U5.3 `.env` comes from main, and `__name__` does not travel

A run request carrying no process variables still gets the collection's `.env` in
`variables.processEnv`, and `variables.environment` contains no `__name__` key.

*Pins 002 §11.3.* Two opposite failures with one cause — being unclear about which side owns a tier.

### U5.4 Cancel is scoped to a run this process owns

Cancelling a live `runId` aborts that run and no other; cancelling an unknown one resolves `false`
without throwing.

*Pins 002 §11.3, §7.1, and 001 §11.3.* §10 lists runs this process is not executing, so being asked
to cancel one is ordinary.

### U5.5 A batch never mixes runs

With two flows running concurrently, every `main:flow-run-event` payload carries one `runId` and only
that run's events, in emission order.

*Pins 002 §8.1, §11.3.* §8.1 permits batching and guarantees order within a batch; a single global
buffer keyed by nothing would satisfy the first and quietly break the second.

### U5.6 The watcher reports, and reads only the name

`renderer:flow-watch-scope` resolves with the flows already on disk. Adding, editing and deleting a
`.flow.yml` under a workspace and under a collection then each emit one `main:flow-tree-updated`, and
`renderer:flow-unwatch-scope` stops them. An entry carries the flow's `meta.name` and reports the new
one when it is edited. A file that is not valid YAML still appears, with no name.

A flow using a `!file` fixture (001 §5.4) reports its declared name like any other — the tags are part
of the format, and a parser without them calls the file unreadable and falls back to its filename.

*Pins 002 §4.1, §11.3.* The name is what the sidebar labels an unopened flow with, and it is the only
field read from a **flow**: the rest is `describeFlow`'s, which resolves OpenAPI documents over the
network. A watcher that failed on a file it could not parse would drop the flow that most needs
opening — the broken one.

### U5.6a A workspace flow's scripts run

A **workspace-scoped** flow whose step declares an `outputs` script, a `when:` condition and a
`shouldRetry`: each one runs and its value is used. The same flow under a collection behaves
identically.

*Pins 002 §7.3, and 001 §8.2.* The script VM resolves `require` against a path and refuses to start
without one, and a workspace flow has no collection to supply it — so every script position failed at
once, as a `script-error` naming the author's script. Scripts are the half of a flow that a
collection-scoped fixture exercises and a workspace-scoped one silently does not.

### U5.6b The watcher reports scripts, and reads nothing out of them

A `.js` file under `flows/scripts/` is listed by `renderer:flow-watch-scope` and emits
`main:flow-tree-updated` on add, change and delete, carrying a `script` flag and its filename — and
**no name**, because nothing opens the file. One nested inside `flows/scripts/` is listed too.

A `.js` anywhere else under `flows/` is not listed, and neither is a non-`.js` file inside
`flows/scripts/`. Flows and scripts list together, with only the scripts flagged.

*Pins 002 §4.5.* The directory is the whole rule: "any `.js` under `flows/`" would list every helper
sitting beside a flow — legal `use:` targets since 001 §8.6 and never meant to be a listing — and the
section would be a file browser rather than a place helpers are kept. Reading the file would be a
read per script on every tree change, for a field a script does not have.

### U5.7 A flow tab is a tab the app can actually hold

Opening a workspace-scoped flow and a collection-scoped one each produce a tab that renders in the
strip, survives a reload from the snapshot, and does not replace the other. Opening two different
flows in the same collection yields two tabs; opening the same flow twice yields one.

*Pins 002 §4.2.* Every tab in this app belongs to a collection, and a workspace-scoped flow borrows
the workspace's scratch collection. Without a `collectionUid` the tab falls outside the model
entirely and the app errors on open — which no unit test caught, because each piece works alone.

The second half is the opposite failure: putting `flow` in `nonReplaceableTabTypes` makes the tab
permanent, and also singleton *per type*, so the second flow you open silently replaces the first.

### U5.7a The borrowed collection never shows through

Open a workspace-scoped flow. The strip contains that flow and any other open flow, and **no**
`workspaceOverview` or `workspaceEnvironments` tab; the header above it reads **API Flows**, ends with
the environment selector (§7.2) and has no workspace switcher. Focus the workspace's Overview tab: its strip contains the workspace tabs and
**no** flows, and the workspace header is back. The sidebar section is titled *API Flows*.

*Pins 002 §4.1, §4.2.* The header reads **API Flows** and ends with the environment selector — that
one control is deliberate, and everything else the workspace's header would have shown is not. §4.2
borrows the scratch collection so a flow can be a tab at all, and every consequence of that borrowing
is upstream behaviour working exactly as designed — which is why it
needs asserting rather than noticing. Both directions matter: a grouping rule that only hides the
workspace's tabs from a flow still puts flows in the workspace's own strip.

### U5.8 Quitting cancels a run; changing your mind does not

Start a run, press ⌘Q, and dismiss the confirmation. The run is still executing and the flow watcher
still reports file changes. Press ⌘Q again and confirm: the run's requests are aborted, its
`status: [cancelled]` steps run their cleanup, and `summary.json` records the run `cancelled`.

*Pins 002 §4.2, and 001 §11.3.* The first half is the defect this scenario exists for — hooking
`main:start-quit-flow` looks correct and destroys a run for a quit that never happens. The second is
what the CLI already does on Ctrl-C, and an app that skipped it would be worse than the terminal at
the one thing 001 §11.3 guarantees.

### U5.9 Request logs batch across runs, and stop at a closed window

Two runs dispatching concurrently produce a single `main:flow-request-log-batch` per frame carrying
both runs' requests in the order they were sent. With the window destroyed, a queued batch is dropped
rather than sent.

*Pins 002 §8.5.* The batching rule is the **opposite** of U5.5's — events are per run because 001
§13.2 promises no ordering across two, while the panel is one chronological list and splitting it per
run would be inventing a grouping the panel does not have. Copying U5.5's shape here is the mistake
worth pinning.

---

## 8. Regressions not owned by a single scenario

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

A flow authenticating with a secret variable shows the header redacted in the step pane, in the
capture the pane read, **and in the DevTools network tab**, with no UI affordance to reveal it. A
flow setting `config.redactHeaders` has that header masked in the network tab too, not only the
built-in denylist.

*Pins 002 §9 and §8.5, and 001 §14.4.* `--show-sensitive` has no app equivalent by design. The second
half is what `FlowContext.redactHeaders` exists for: a host masking the built-ins alone passes the
first half and leaks the header the author actually named.

### R4 — The renderer computes no semantics

A structural assertion, not a behavioral one: no module under `bruno-app/src/fork/flows/` imports a
YAML parser, and none reimplements ranking, join resolution, or status derivation. The graph model
arrives from `describeFlow`; captures arrive from `readCapture`.

*Pins 002 §11.1, §11.2.* Every drift between the app and the CLI would start here.

### R5 — The upstream touchpoint set matches the manifest

`git diff` against the upstream merge base touches exactly the files listed in 001 §13.4 plus 002
§12.1, `useIpcEvents.js` gains exactly two lines, and neither DevTools file has regrown a request
list of its own. In particular `ResponsePane/QueryResult/QueryResultPreview` is **untouched** — 002
§12.1 records why the guard that belongs there was withdrawn in favour of making the state
unreachable, and a diff that reintroduces it is the manifest drifting.

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

001 §14.6's *message* is deliberately outside this: it is human text the engine writes about one
occurrence, and the UI displays it unaltered rather than treating it as a term. What R6 forbids is the
UI inventing a word where the engine gave it one — not the engine explaining itself.

*Pins 002 §8.2.* A vocabulary the UI paraphrases is one that drifts from the reporters CI parses.

---

## 9. Not covered here

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
- **`listRuns` and `readCapture` themselves.** §11.2 declares them here, but what makes them correct
  is that they recover what 001 §14.5's writer wrote — a round trip, and so 001-C's R4o. U4.5–U4.10
  assert the app renders what they return, which is the part that is this file's.
- **`describeFlow`'s nodes and edges.** Same split: which edges exist, and what `rank` each node
  gets, are statements about 001 §9.1's graph, so they are 001-C's R4q. U1.1–U1.10 assert the
  drawing — that a sequence edge *looks* different from a declared one, that a slot goes through a
  glyph — which is what this file can see and R4q cannot.

## 10. Traceability

| Scenario | Pins | The wrong implementation it catches |
|---|---|---|
| U1.1, U1.2 | §5.3, §1 | Drawing only declared edges |
| U1.3, U1.4 | §5.3 | A fallback branch that looks unconditional |
| U1.5, U1.6 | §5.3, §6 | Data paths invisible, or undeclared ones hidden |
| U1.7 | §5.3 | A slot drawn as a writer→reader edge |
| U1.8 | §5.4 | Sub-flow internals shown by default |
| U1.8a | §5.2, §5.3 | A layout failure taking the whole tab down |
| U1.9, U1.10 | §5.2 | A graph laid out down the short axis; one that reorders between runs |
| U1.9a | §5.1 | A step id drawn across the graph instead of inside its own box |
| U1.9d | §5.1 | A step that changes what it sends saying so nowhere on its box, or saying it in a colour that reads as a verdict |
| U1.13 | §5.5 | A stage rule clipped off the edge of the drawing, or a name read through a running step's halo |
| U2.1–U2.3 | §8.2, §9 | A poll that looks like a hang, or like a series of steps that each finished |
| U2.4 | §8.2 | One grey "skipped" state |
| U2.4a | §8.2, §9 | A red run whose graph is entirely green and grey, explaining itself nowhere |
| U2.4b | §5.3, §8.2 | The missing value marked on neither end of the path it never crossed, or on every edge into the consumer |
| U2.4c | §8.4 | A summary reading `failed` over `0 failed`, accounting for the difference nowhere |
| U2.4d | §8.1 | A run that died leaving the view running forever, and a Cancel with nothing to cancel |
| U2.4e | §8.2, §9 | A halo and a spinner still going for a step whose run has ended |
| U2.5, U2.6 | §7.1, §8.2 | Cancel reported as failure; cleanup looking hung |
| U2.7 | §8.3 | Iterations overlaid on one graph |
| U2.8, U2.9 | §4.2 | A run killed by ⌘W or by quit, skipping cleanup |
| U2.10 | §4.1, §4.2 | A run in flight with nothing in the app saying so |
| U2.11 | §8.4 | Step and flow vocabularies conflated |
| U2.12–U2.14 | §8.5, §7.2 | A run that dispatched perfectly and left the network panel empty; a row with no collection taking the response viewer down |
| U3.1–U3.3 | §6 | Warnings blocking, or diagnostics with nowhere to land |
| U3.4 | §6 | A broken flow that cannot be opened |
| U3.5 | §4.1, §6 | Stale diagnostics after an edit |
| U3.6 | §4.1, §7.2 | A library flow run with no params |
| U3.6a | §4.1, §4.3 | Flows listed by filename, or named only once opened |
| U3.6b | §7.2 | No way to pick an environment from a flow tab; or a flow picking one privately |
| U3.6c | §6, §9 | A run reporting on itself to nobody; a missing capture blamed on the reader |
| U3.7 | §7.2 | A workspace flow silently borrowing a collection's environment |
| U4.1–U4.4 | §9 | A pane showing the file's body rather than the materialized request |
| U4.4a | §9 | Reading a capture before the attempt that writes it has settled, and never re-reading |
| U4.4b | §9 | A split that clamps one side only, or forgets the size between tabs |
| U4.4c | §9, §5.4 | A `uses:` step blamed for a capture that was never going to exist |
| U4.5–U4.7 | §10 | A second, weaker viewer for stored runs |
| U4.8, U4.9 | §10, §11.2 | A run with no `summary.json` shown as failed, or hidden entirely |
| U4.9a | §10 | The flow as it stands unreachable after a run; a run's outcomes discarded when it ends |
| U4.10 | §9 | Blank panels instead of an explanation; the next run's setting erasing the last run's captures |
| U4.15 | §4.4, 001 §5.2 | A property edit that reformats the whole file, or a rename that quietly moves the flow to another scope |
| U4.15a | §4.4, §4.2 | A rename folded as an unlink and an add — every tab of the flow left on a path that is gone |
| U4.15b | §4.4 | A properties write that the next auto-save of a stale draft silently reverts |
| U4.15c | §4.3, §4.4 | The one draft upstream's tab strip cannot see, closed without a word and lost on quit |
| U4.16 | §4.5 | A scripts folder that resolves implicitly, or a section that lists every `.js` in the tree |
| U4.16a | §4.5, §4.4 | A script's menu copied from a flow's; a rename that moves the file out of the folder that lists it |
| U4.17 | §4.5, §11.3 | A timer writing a half-typed prelude into every flow that names it; a guard on the extension rather than the directory |
| U5.1–U5.3 | §7.2, §11.3 | Tiers merged in main, or a secret flattened in the renderer |
| U5.4–U5.6 | §11.3, §8.1, §4.1 | A cancel that misses, a batch that mixes runs, a watcher a broken flow defeats |
| U5.6a | §7.3, 001 §8.2 | Every script position failing for a flow that has no collection |
| U5.6b | §4.5 | A watcher reading `meta:` out of a `.js`, or listing helpers it was never meant to |
| U5.7 | §4.2 | A tab the app's collection-scoped tab model cannot hold |
| U5.7a | §4.1, §4.2 | The borrowed scratch collection showing through as workspace chrome |
| U5.8 | §4.2 | A cancelled quit that kills the run anyway; a confirmed one that skips cleanup |
| U5.9 | §8.5 | Copying U5.5's per-run batching onto a chronological panel |
| R1, R2 | §8.1, §9 | Bodies on events; an unbatched stream |
| R3 | §9, §8.5 | A secret visible in the app but not in CI; a panel that masks only the built-ins |
| R4 | §11.1, §11.2 | The renderer growing its own parser |
| R5 | §12.1 | Manifest drift after an upstream merge |
| R6 | §8.2 | A UI-only status |
