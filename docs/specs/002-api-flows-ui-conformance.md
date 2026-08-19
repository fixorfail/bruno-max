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

*Pins 002 §5.4.*

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
field read from the file: the rest is `describeFlow`'s, which resolves OpenAPI documents over the
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
| U1.9, U1.10 | §5.2 | A graph laid out down the short axis; one that reorders between runs |
| U1.9a | §5.1 | A step id drawn across the graph instead of inside its own box |
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
| U4.5–U4.7 | §10 | A second, weaker viewer for stored runs |
| U4.8, U4.9 | §10, §11.2 | A run with no `summary.json` shown as failed, or hidden entirely |
| U4.10 | §9 | Blank panels instead of an explanation; the next run's setting erasing the last run's captures |
| U5.1–U5.3 | §7.2, §11.3 | Tiers merged in main, or a secret flattened in the renderer |
| U5.4–U5.6 | §11.3, §8.1, §4.1 | A cancel that misses, a batch that mixes runs, a watcher a broken flow defeats |
| U5.6a | §7.3, 001 §8.2 | Every script position failing for a flow that has no collection |
| U5.7 | §4.2 | A tab the app's collection-scoped tab model cannot hold |
| U5.7a | §4.1, §4.2 | The borrowed scratch collection showing through as workspace chrome |
| U5.8 | §4.2 | A cancelled quit that kills the run anyway; a confirmed one that skips cleanup |
| U5.9 | §8.5 | Copying U5.5's per-run batching onto a chronological panel |
| R1, R2 | §8.1, §9 | Bodies on events; an unbatched stream |
| R3 | §9, §8.5 | A secret visible in the app but not in CI; a panel that masks only the built-ins |
| R4 | §11.1, §11.2 | The renderer growing its own parser |
| R5 | §12.1 | Manifest drift after an upstream merge |
| R6 | §8.2 | A UI-only status |
