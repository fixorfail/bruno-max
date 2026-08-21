# 002 — API Flows UI (run & observe)

**Status:** Draft — the three questions 001 owed this spec are answered; §14 carries one of its own,
local to `readCapture`'s options
**Owner:** Jake Campbell
**Last revised:** 2026-08-14

The app surface for [001](./001-api-flows.md): open a `.flow.yml`, see its graph, run it against the
app's environment and auth, watch it execute, and diagnose a failure down to the attempt that caused
it. Authoring stays in the text editor — this spec covers reading and running, not editing.

Its companion, [002-C](./002-api-flows-ui-conformance.md), holds the scenarios this behavior was
derived from, written to be implemented as Playwright specs.

---

## How to read this

001 is the prerequisite. This document cites its sections constantly and redefines none of them; if a
statement here looks like it invents a rule, it is quoting one.

| If you are… | Read |
|---|---|
| **Using the feature** | §4 surfaces · §5 the graph · §7 running · §9 step detail · §10 past runs |
| **Implementing the renderer** | §4–§10 in order, then §11.3 for the channels you call |
| **Implementing the engine additions** | §11 entire — it is the only part that changes `@bruno-max/flow` |
| **Reviewing a proposed change** | §13 first. If the option is already there, the argument has been had |
| **Judging whether it's ready** | §14 open questions · §15 future work · the companion's §9 |
| **Re-checking after an upstream merge** | §12.1, and the companion's R5 |

### Sections

| | |
|---|---|
| **§1–§3** | Problem, goals, non-goals |
| **§4** | Where flows appear — sidebar, tab, run-state ownership |
| **§5** | The graph — nodes, layout, the five edge kinds, sub-flows |
| **§6** | Diagnostics, and what a broken flow does |
| **§7** | Running — the control, configuration, what the app supplies |
| **§8** | Watching a run — events, node states, concurrency, iterations, the DevTools network tab |
| **§9** | Inspecting a step |
| **§10** | Past runs from `.bruno-runs/` |
| **§11** | **The engine boundary** — `describeFlow`, the capture reader, IPC, what 002 changed in 001 |
| **§12** | Fork isolation and the manifest delta |
| **§13–§15** | Rejected alternatives, open questions, future work |

### The contracts

Most of this is reasoning about presentation, which can be reworked freely. These parts are
commitments something outside this feature depends on:

| Contract | Where | Consumed by |
|---|---|---|
| `describeFlow`, `listRuns`, `readRun`, `readCapture` | §11.1, §11.2 | `bruno-electron`, and the future builder |
| The `ListDirectory` port | §11.2 | Every host of `@bruno-max/flow` |
| IPC channel names | §11.3 | The renderer, and the e2e suite |
| Upstream files touched | §12.1 | Re-checked after every merge from upstream |
| `data-testid` on graph nodes | companion §2 | Every Playwright spec in `tests/flows/` |

Everything 001 already fixed — the format, `FlowEvent`, `StepResult`, the status and reason
vocabulary, the capture layout — remains 001's contract and is cited, not restated.

---

## 1. Problem

001 ships flows that run only from `bru`. That is enough for CI and not enough for the person
writing the flow: the graph a `.flow.yml` describes is not visible anywhere, the run's progress is a
scrolling log, and a failed step is diagnosed by finding the right `.bruno-runs/` directory in a
terminal and reading JSON out of it.

Three specific consequences, each of which this spec answers:

**The graph is invisible.** 001 §9.1's rule that *a step with no `depends` depends on the step
immediately above it* is what makes a flow readable top-to-bottom, and it is also why inserting a
step silently rewires the chain. 001 §19 defers a validator heuristic for exactly this, on the
grounds that one example is thin evidence for a rule that will produce false positives. A viewer
answers the same problem without a heuristic: if the implicit edge is *drawn*, an insertion that
rewires the sequence is visible the moment it happens.

**A run is a log.** Under `concurrency: 5` the CLI's interleaved output is the only view of which
branches are in flight. A 20-attempt poll (§11.1) is 20 lines that look like failure until the last
one.

**Captures are inaccessible from the app.** 001 §14.5 writes every step of every run — the
materialized request, each attempt's response, assertion outcomes — and 001 §19 lists surfacing them
in the app as deferred. Until it is done, the app can tell you a step went red and nothing about why.

## 2. Goals

1. **Understand a flow without reading YAML.** The graph, its data edges, and the conditions on them
   are legible at a glance, including the parts of 001's semantics that are implicit in the file.
2. **Run with the app's context.** The same environment, auth and cookie handling a request gets,
   assembled the way 001 §13.2 requires — as tiers, by the host.
3. **Watch a run honestly.** Concurrency, retries, iterations and skips are shown as they are, not
   flattened into a pass/fail list.
4. **Diagnose without leaving the app.** Any step of the current run, or of a past one, opens to its
   request, response and assertion outcomes at attempt granularity.
5. **No behavioral fork.** Every semantic decision stays in `@bruno-max/flow`. The UI renders what
   the engine reports and computes nothing 001 defines.
6. **Near-zero upstream footprint.** Three lines in one upstream file beyond what 001 §13.4 already
   claims (§12).

## 3. Non-goals

- **Authoring and editing.** Creating steps, wiring connectors, editing `depends` from the graph.
  The file stays authoritative and the text editor stays the way it is edited; a builder is its own
  spec, and 001 §3's judgement that the UI is "deliberately trial-and-error" applies most to the
  editing surface. Everything here is read-only against the flow document.
- **A flow-shaped reporter.** 001 §19's row stands; this spec renders runs, it does not export them.
- **Cross-run analytics** — trends, flake detection, duration history. §10 reads run directories; it
  does not aggregate across them.
- **Scheduling or remote execution.** Runs are started by a person, in this app, on this machine.

## 4. Surfaces

Flows occupy three places, and each is a fork-owned component registered through
`bruno-app/src/fork/registry.js` (001 §13.3).

| Surface | What it is |
|---|---|
| **Flows sidebar section** | A section beside Collections, API Specs and Mock Servers, listing every discovered flow grouped by scope. |
| **Flow tab** (`flow`) | Opening a flow. Holds the graph, the document, the run controls, and the run record. |
| **Step detail** | A pane inside the flow tab, not a tab of its own — a step is only meaningful in the context of the run that produced it. |

### 4.1 The sidebar section

**One section, grouped by scope, rather than flows nested inside their collection.** 001 §5.1 gives
flows two scopes — `workspace/flows/` and `<collection>/flows/` — and the tempting rendering puts
collection-scoped flows inside the collection's own tree, next to the requests they exercise.

That is rejected on fork cost. The collection tree is upstream's
`Sidebar/Collections/Collection/CollectionItem/`, a recursive renderer that is one of the
most-churned components in the app; injecting a foreign node type into it means fork logic inside
upstream's hottest file, re-merged forever, for an adjacency that a group header communicates nearly
as well. A single fork-owned section keeps the entire surface in a file upstream does not have.

The section is titled **API Flows**, matching upstream's *API Specs* beside it: the sidebar names
features, and a bare *Flows* reads as a folder someone happened to create.

```
API FLOWS
  Workspace
    Checkout, end to end                 (meta.name)
    Libraries
      login.flow.yml                     (meta.library: true, and declares no name)
  payments
    Refund a settled payment             (meta.name)
```

**A flow reads by the `meta.name` it declares, and by its filename when it declares none** — in the
sidebar and on its tab alike, so the two never disagree about what a flow is called. `meta.name` is
the author's own sentence about what the flow does and is the better label wherever there is room for
one; the filename is a fallback rather than an identity, which is also why nothing keys on it. §4.3's
raw editor keeps the filename in its tab regardless: that tab is a view of the *file*.

**Library flows (001 §12.5 — a flow declaring `meta.library: true`) are listed last within their
scope, under a `Libraries` label.** They are a different kind of thing to run: a glob run skips them,
and running one directly means supplying its `params:` first — so a single interleaved list answers
"what can I run here" with a mixture of flows and the parts other flows are built from. This is the
app's equivalent of `bru flow list` marking them, and it replaces the per-row tag that did the job
before: a label over the group and a badge on every row inside it say the same thing twice.

Only the libraries are labeled. The scope's own header already names what the flows above it are, and
a second header over them would be a heading per item type where one of the two types is the
exception — the same reason §5.1's markers mark what a step *has* rather than labeling every step
with what it is.

**The flag comes from the watcher's tree entry** (§11.3), beside `meta.name` and for the same reason:
this section lists flows nobody has opened, and `describeFlow` — the app's only other source of it —
resolves each flow's sub-flows and OpenAPI documents, which `readSpec` fetches over the network.
Reading it from a description instead put the mark on a flow only after it had been opened, which is
exactly when the reader no longer needs telling.

**The section lists the active workspace's flows only** — its own `flows/`, and those of the
collections the workspace holds. §11.3 has the renderer name the scopes to watch and nothing stops
watching one, so the store accumulates every scope opened since launch; a section rendering all of
them shows one workspace's flows under another's name and does not change when the workspace does. A
collection-scoped flow is matched by its collection rather than by the workspace root recorded in its
scope, because a collection's scope records the collection's own path there. Watching is deliberately
left running: §4.2 keeps a run alive across a closed tab, and a workspace switch is no more a reason
to stop reporting one.

**A flow's row carries its run status**, and so does its tab label: a running indicator while the run
executes, and a pass/fail mark when it ends, cleared the next time the flow is opened. §4.2 keeps a
run alive across a closed tab, so without this a run can be in flight with nothing in the app saying
so.

Ambient status rather than a notification, deliberately. A run is user-initiated and usually short,
so a toast on every completion interrupts to say something the person already knows; the case worth
covering is the run you walked away from, and a mark that waits for you covers it without demanding
anything. The collection runner has the same situation today and surfaces nothing at all — this is
the piece it is missing, not a new class of interruption. An OS-level notification would be a genuine
third surface with a preference to govern it, and §15 records it as the thing to reach for if long
flows turn out to be the norm.

Discovery mirrors API Specs exactly: a chokidar watcher in the Electron main process over each
scope's `flows/` directory, emitting tree events the renderer folds into a slice — the shape of
`bruno-electron/src/app/apiSpecsWatcher.js` and `slices/apiSpec.js`. A flow appears, disappears and
renames in the sidebar without the app being restarted, and a `git checkout` that swaps a branch's
flows is reflected the same way.

**The watcher reads `meta.name` through the engine (001 §13.2's `readFlowMeta`), not with a parser of
its own.** 001 §5.4's local tags are part of the format, and an ordinary YAML reader rejects `!file`
as an unknown tag — so a watcher parsing for itself would report every flow carrying a fixture as
unreadable and name it after its file, a failure with no error anywhere and no sign but a name that
looks like the one a flow gets when it declares none.

**The watcher reads `meta.name` and nothing else.** `apiSpecsWatcher` parses each file to extract
`info.title`, and the flow watcher does the same one-field read for the same reason: the sidebar names
every flow it lists, including the ones nobody has opened. Everything else the app draws still comes
from `describeFlow` (§11) when the flow is opened, and taking the name from there instead would mean
resolving each listed flow's sub-flows and OpenAPI documents — which §11.3's `readSpec` will fetch
over the network — to render a directory listing.

The read is tolerant, and its failure is ordinary rather than exceptional: a malformed flow must still
appear in the sidebar so it can be opened and its diagnostics read (§6), and it appears under its
filename with no name of its own. That is the same answer as for a flow that simply declares none, so
the watcher never has to decide what to show for a file that does not parse.

### 4.2 The flow tab

One tab type, `flow`, keyed on the flow's pathname. It is an ordinary closable tab — the
non-closable set (`NON_CLOSABLE_TAB_TYPES`) is for workspace-level surfaces that always exist, and a
flow is a file.

**A flow tab still carries a `collectionUid`, because every tab in this app belongs to a
collection.** That is not a formality: `RequestTabs` renders the strip only for the active
collection, `addTab`'s pathname dedupe returns early without one, and the snapshot middleware groups
tabs by collection. A tab without a `collectionUid` is outside the model rather than merely unusual,
and the app errors when one is opened.

A collection-scoped flow uses its collection's uid. **A workspace-scoped flow uses the workspace's
scratch collection**, which is exactly how upstream's own `workspaceOverview` and
`workspaceEnvironments` tabs exist (`slices/workspaces/actions.js:668`) — so this borrows a
mechanism rather than inventing one.

**The borrowed collection is invisible.** It is a mechanism for holding the tab, not a statement
about where the flow lives, and left alone it surfaces twice: the strip groups tabs by collection, so
a workspace-scoped flow opens beside the workspace's permanent **Overview** and **Environments**
tabs; and the header renders the collection it is handed, so the same flow gets the *workspace's*
header and its switcher. So the strip groups by collection **and** by whether the tab is a flow — the
two never mix, in either direction — and a flow tab's header reads **API Flows** and carries no
switcher. There is nothing to switch: which flows exist is §4.1's question, and which one is open is
the strip's.

**It does carry the environment selector, at the end of the row where a collection's header keeps
it.** §7.2's control has to live somewhere, and this header is what stands in for the one that
normally holds it — so putting it anywhere else would ask someone to learn a second place for a
control they already use daily. It is the app's own selector, in its own two states: the colour of the
environment in force, and the dashed *No Environment* the app draws everywhere else for nothing
selected.

The name matches §4.1's sidebar section, which is titled *API Flows* rather than *Flows* for the same
reason API Specs is: the sidebar names features, and a bare noun reads as a folder.

**Flows are deliberately *not* in `nonReplaceableTabTypes`.** That list is singleton *per type*, so
adding `flow` would collapse every flow in a collection into a single tab. The dedupe a flow wants is
per pathname, which `addTab` already does once a `collectionUid` is present. Permanence — not being
replaced as a preview tab — comes from passing `preview: false` at the call site instead. Neither of
001 §13.4's two `tabs.js` lines is therefore needed, and that file leaves the manifest.

**Run state is keyed by flow path in the slice, not by tab.** Closing the tab of a running flow does
not cancel it, and reopening the flow reattaches to the run in progress. The alternative — tying a
run's lifetime to a piece of UI — makes an accidental ⌘W destroy a run that has already created
resources, and 001 §11.3 is explicit that cancellation runs cleanup under a grace window. A run
ending because a tab closed would skip that path entirely.

Cancellation is therefore always explicit, from the run control — or from quitting the app.

#### Quitting with a run in flight

**The app cancels the run through 001 §11.3's path rather than letting the engine die with the
process.** In-flight requests are aborted, steps declaring `status: [cancelled]` get their cleanup
within `config.cleanupGrace`, and the run is recorded `cancelled`.

A run in flight has a stronger claim on the quit path than an unsaved request does — an unsaved
request loses text the user can retype, while a killed run leaks whatever the flow created, on a real
API.

**It hangs off `app.on('before-quit')`, not off `main:start-quit-flow`.** This spec originally said
the latter, and that is wrong: `main:start-quit-flow` fires when quit is *initiated*, and
`providers/App/ConfirmAppClose/` lets the user dismiss the dialog and stay. Cancelling runs there
kills them for a quit that never happens — pressing ⌘Q and changing your mind would destroy the run
and stop the flow watcher.

`before-quit` is the right seam because `bruno-electron/src/index.js` already runs a guarded async
shutdown chain there — `closeAllWatchers()`, `ipc/mount.shutdown()`, `ipc/sqlite.shutdown()` — and
then `app.exit(0)`. The flow host joins it as a fourth sibling, so quit waits for cleanup the same
way it already waits for watcher teardown.

**The consequence is that the window closes before cleanup finishes, not after.** `before-quit` is
reached via `main:complete-quit-flow` → `mainWindow.destroy()` → `window-all-closed` → `app.quit()`,
so by the time the flow host runs there is no window left to hold open. Every substantive promise
above still holds — requests aborted, cleanup steps run, `summary.json` written — and only the
ordering of the window disappearing differs.

Holding the window until cleanup finished was considered and rejected. It needs `main:complete-quit-flow`
to await the fork, and `ipcMain.handle` permits exactly one handler per channel, so it means editing
an upstream handler rather than adding a line to a list. It would also freeze a visible window for up
to `cleanupGrace`, which reads as a hang precisely when the app is supposed to be closing. A capped
wait after the window is gone is the better trade, and the cap is a hang guard rather than a second
policy: 001 §11.3 already bounds cleanup, and `runFlow` resolves as soon as it is done.

The comparison that settles it is the CLI: Ctrl-C on `bru flow run` runs cleanup. An app that
skipped it would be strictly worse than the terminal at the one thing 001 §11.3 exists to guarantee.

**No run state is persisted across a restart.** The snapshot middleware deliberately excludes
request and response bodies, and `.bruno-runs/` already holds the whole run. On restart the flow tab
reopens through the ordinary tab-restore path and §10's selector shows the run — including the one
that was cancelled by the quit — read from disk like any other. Persisting results in the snapshot
would be a second store of data the captures own, and the two would drift.

The tab shows the **graph** (§5), with the run record (§8–§10) as a pane below it, so a step's
outcome is visible beside the node that produced it.

**The raw `.flow.yml` is a separate tab rather than a second view here** — §4.3. An earlier draft of
this section had a read-only Document view toggled in this tab's header, on the reasoning that source
and graph are two readings of one file. What that misses is that the source is also *editable*, and
an editable surface inside the run tab makes every one of the run tab's controls ambiguous: running a
flow means running the file, and the file is now something this tab can be ahead of. Separating them
keeps this tab about the flow as it exists and gives editing a place that can say what it is.

### 4.3 Editing the YAML

**A flow can be edited as raw YAML, and this is deliberately the non-standard way in.** A flow's own
surfaces are where a flow is meant to be built; this exists for the edit they do not cover, for
reading what a generated flow actually says, and for the fix that is faster to type than to click.
Everything about how it is reached and marked follows from that: it is not what you get by opening a
flow.

**It is reached from a menu on the flow's row**, right-aligned, revealed on hover — the same menu
shape upstream's own sidebar rows carry, holding one item, `Edit Yaml`. Hover-reveal rather than a
permanent control because the row already ends in §4.1's run mark, which is ambient status the menu
must not crowd out; the menu takes its space at all times and only becomes visible when the pointer
is on the row, so the mark never moves. An open menu stays visible wherever the pointer goes, because
reaching an item in a popover means leaving the row that opened it.

**Its tab is marked** — a pencil, and the file name in italic. A raw editor that looked like the run
view in the strip would be indistinguishable from one at a glance, and the two do different things to
the same file. It is a **distinct tab type** from §4.2's, keyed on the same path: upstream dedupes a
tab on pathname *and* type, so a flow's run view and its editor are two tabs of one file, each
reopening into itself, and neither displacing the other.

The view is split horizontally, dragged, with the **graph above** and the **editor below**:

| Half | Content |
|---|---|
| Top | §5's graph, the same component the run tab draws, without run state |
| Bottom | The file's text, in the app's own editor (`components/CodeEditor`) in YAML mode |

**The editor is the one §9's step pane uses**, not the API-spec panel's. That one hard-codes
`height: calc(100vh - 9rem)` on its CodeMirror because it is a full-page editor; inside a pane the
split has sized, it renders taller than the box showing it and therefore scrolls nothing — the lines
past the fold are unreachable rather than scrolled to. An editor placed in a dragged split has to
take its height from its container, which is what this one does.

**The editor's own parse knows §5.4's tags.** It asks the narrow question — is this a document at
all — and it asks it in the renderer, which cannot run the engine's parser (001 §13.1 makes it a Node
package). A plain YAML reader answers *no* for every flow using a `!file` fixture, and the answer
gates both the redraw and auto-save: the graph stops following a draft the CLI validates happily, and
the pane says the file is invalid. The renderer therefore carries the tag list, and nothing else about
the format.

**The graph redraws from the draft, before it is saved.** That is the reason the two halves are in
one view: the question being answered is "what did that edit do to the flow", and answering it from
the last saved version answers a different one. It is drawn from `describeFlow` given the draft text
(§11.1), never from a parse the renderer did itself — a graph the app derived on its own could differ
from the one the CLI executes, which is the disagreement §11.1 exists to rule out.

**It redraws when the draft is a YAML document, and holds when it is not.** Deliberately the narrow
test: a flow that parses but declares a step twice is invalid *as a flow* and still draws, with its
diagnostics on the nodes, exactly as §6 requires of the run view — being told what is wrong with a
flow is most of what this view is for. Text that does not parse has no document to describe at all,
and the view says so rather than blanking the graph, because a graph that vanished mid-keystroke
would take the reference point with it.

**Saving follows the app's own `autoSave` preference**, the setting that already governs every other
editable thing here — a feature with its own save behaviour is a second answer to a question the user
has already answered once. With it on, the draft is written after the configured interval, each
keystroke restarting the countdown; with it off, ⌘/Ctrl+S and a Save button beside the state. The
button appears only when auto-save is off: two controls answering "is this saved" would disagree the
moment one of them was mid-flight.

**Auto-save writes only a draft that parses.** The alternative — writing the buffer on a timer — puts
a half-typed line in a file the watcher is reporting, the run view is describing, and a run may be
about to execute, so a flow briefly becomes unrunnable because someone paused mid-word. A draft that
does not parse stays in the editor and says it is unsaved, which is true.

**The state is stated in words** — *Saved*, *Unsaved changes*, *Saving…*, or the error a save failed
with. This view writes to a file the rest of the app is watching, so what has and has not reached
disk is the one thing it must not be coy about.

**The draft belongs to the flow, not to the tab** — the same rule §4.2 applies to run state, for the
same reason: an unsaved edit discarded by a tab switch is the one kind of state loss no editor is
allowed.

**The run view keeps describing the file on disk.** The editor's graph is the draft's; §11.1's stored
description, which the run tab draws and a run would execute, is the file's. Folding the draft into it
would redraw the run tab from text no run can reach, and abandoning the edit would leave that drawing
behind, since only a watcher event clears the entry. Two descriptions of one flow is the honest shape:
they differ exactly while the editor is ahead of the file, and saving is what makes them agree —
through the watcher, which clears the stored description on the change the save causes.

Two limits, stated rather than discovered:

- Diagnostics are on the graph's nodes and **not anchored into the editor's gutter**. §6's line
  anchors exist and this view is where they would pay off most; using them here is future work.
- **The editor does not reload a file changed underneath it.** It reads the flow when it opens and
  the watcher's change events do not reach it, so an edit made elsewhere — another tool, a branch
  switch — is invisible until the tab is reopened, and saving over it is silent. Upstream's own
  editors keep a draft across an external change for the same reason (the draft is the thing you were
  working on), but they reload when there is *no* draft, and this view does not yet.

## 5. The graph

### 5.1 What is drawn

A node per step, rendered as inline SVG in fork code. Nodes are laid out in ranks; edges connect
them; both come from `describeFlow` (§11), so nothing about 001's semantics is recomputed here.

At rest a node carries the step's `id`, its `name` when it has one, and the resolved operation as
method and path — `POST /payments`, not `payments-api#createPayment`. The reference is what the file
says; the method and path are what the step *does*, and resolving them is the whole point of having
an engine describe the flow rather than reading the YAML.

**A node's text wraps inside its box, and is laid out as HTML for that reason.** SVG `<text>` does not
wrap — not by any attribute — so a step id or a path longer than the box ran out of it and across
whatever it met, and the longest names are the ones most worth reading. The text is therefore drawn
through a `foreignObject`, where CSS wraps it, including mid-word when a single token is wider than
the box: an unspaced step id has no break opportunity to take, and a rule that only breaks *between*
words leaves it overflowing exactly as before. The box is sized for a name over two lines and an
operation over two; past that the text is clipped by the box rather than escaping it, which keeps a
graph readable when one step is named like a sentence.

**The markers sit on a footer bar along the bottom of the box**, shown only when the step carries the
thing they mark:

| Marker | Means | 001 |
|---|---|---|
| `when` | The step is conditional | §9.3 |
| `↻ n` | Retry with `maxAttempts: n` | §11.1 |
| `uses` | A sub-flow (`uses:`) | §12 |
| `!` | `failOnStatusCode: false` — a negative test | §10.3 |
| `⌸` | Reads or writes a shared slot | §9.1 |

The negative-test marker exists because a step that passes on a 403 is otherwise indistinguishable
from one that passes on a 200, and mistaking the first for the second is how a broken authorization
check reads as green.

**A marker that names a key spells the key.** `when` and `uses` are words because that is what the
file says and what an author greps for; a symbol would have to be learned from a tooltip and then
re-learned by the next reader. The sub-flow marker was `⊂` — the subset sign, borrowed for a
relationship nobody draws that way — and there is no conventional glyph for *this step is another
flow*, so the key that declares it is the most recognisable mark available. The remaining three are
symbols because they mark a *property* rather than a key a reader would search for: a retry count
that must carry its number, and two one-character flags.

They were drawn over the box's top-right corner, which is where the step's *name* is — and the names
worth reading are the long ones. A bar of their own gives them a fixed place to be looked for, room
for the next marker this spec adds, and room beside them for the one thing the box never said.

**That thing is the binding: on a flow that binds more than one API, the footer is tinted in that
binding's colour — the band, and nothing else.** The bar's own divider stays neutral. It carried the
colour at full strength for a while and was the loudest thing on a graph of eighteen boxes: one quiet
statement per box reads as a distinction, and the same colour twice per box reads as decoration. 001 §6 lets a flow drive several services — `seed-verified-company` drives a
backend and a test harness — and which of them a step calls decides what a failure means and who
owns it. It was nowhere on the drawing: the operation line says `POST /companies/{pk}` whichever
service that is. Colour is what makes the *shape* of it legible, and the shape is the point: this
stretch is all one service, and then it is not.

**The colour alone, with the key and the bar's hover behind it.** The alias was drawn on the bar
beside the markers and is not any more: on a graph where every box carries one, the label is a word
repeated eighteen times to say what two colours already said, and the box's own scarce line is worth
more than the redundancy. The alias is on the legend and on the bar's hover, so it stays one glance
away without being on screen eighteen times.

**A colour the flow declares wins** (001 §6.2). Assignment is a default, and a default that overrode
the file would be the tool arguing with its author; a team that recognises a service by a colour
elsewhere gets to keep it here. It applies to a single-binding flow too, where the automatic rule
assigns nothing: having said which colour, the author has said there is one.

The rest are assigned in file order from a fixed list, and it **never cycles** — past it a binding
takes no colour rather than a second one's, since two services sharing a colour is worse than one
having none. A slot matching a colour the file already declared is skipped, so a declaration and an
assignment made around it cannot collide. Its first three slots are validated for every pair against both the light and the dark
surface, which is the range that matters: a flow driving four or more services is not one this spec
has seen. The run's own colours (§8.2 — green, red, yellow) are not in play at all: a binding painted
in one of them would report an outcome.

**A key sits over the graph**, top right, outside the scrolling box, titled `API` — and with the
alias off the bar it is the drawing's only statement of which colour is which service. §5.2's drawing is
far wider than its box, so a key drawn *into* the picture is off-screen for every rank but the first —
which is the state a legend exists to prevent.

**A flow binding one API is keyed too, with no colour beside it.** The colour is what is conditional,
not the key: there is nothing for one tint to distinguish, but *which* service a flow drives is a
question every one of these graphs is asked and none of them answers — the operation line is a path,
and a path names no host. The row carries no swatch in that case, and none for a binding past the
palette either: a chip in the key that no bar on the drawing wears is a colour the reader goes
looking for. The `API` title is what keeps a lone alias from reading as a caption on the flow.

The bindings are read off the drawn nodes rather than from the flow's `apis:` block, so a binding
declared and never called takes neither a colour nor a legend row for a service no box belongs to.

### 5.2 Layout

**Ranks by longest path from a root, computed by the engine; order within a rank chosen to minimise
crossings; edges routed around the steps they pass.**

Longest-path ranking places a step after every one of its dependencies, which is the property that
makes the drawing readable as execution order. **The ranks stay the engine's** (§11.1): the layout
requires each edge to span `rank(to) - rank(from)` layers, which makes 001's assignment the only
tight solution and keeps a layout engine from re-deriving one of its own. That is not a formality —
dagre's own `longest-path` ranker measures to a *sink*, which slides a short branch rightward until
it abuts the join it feeds and draws a different graph from the one the CLI executes.

Order *within* a rank is whatever crosses least. It was file order, on the argument that file order
is stable and inspectable where anything derived from the run (completion time, duration) would
redraw the graph differently on a loaded machine than on an idle one. **That argument survives
intact and its conclusion does not**: a crossing-minimised order is derived from the description,
not from the run, so the property that matters — the same file draws the same graph, every run, on
any machine (002-C U1.10) — still holds. What is given up is that the first-declared of two siblings
is the upper one, which buys the drawing far more than it costs: on `seed-verified-company` it is the
difference between a readable branch and two chains woven through each other.

**Edges are routed, not drawn straight.** An edge is a polyline through the free lanes between ranks,
with its corners rounded, and both ends attached along the vertical borders of the boxes they join —
so an edge spanning six ranks travels above or below the five steps between rather than through them,
two edges between the same pair stay two visible lines, and eleven edges out of one step leave at
eleven heights rather than from one point. This is the single largest thing wrong with a hand-rolled
graph and the reason §13's rejection was revisited: measured on `seed-verified-company` (18 steps),
the straight-bezier version put 40 of its 63 edges through a box they did not connect, 174 crossings
in total; routing takes both to zero.

A hidden data edge is still laid out (§5.3): a toggle is a view of one drawing rather than a second
drawing, and a graph that re-laid itself around what is currently ticked would move every box under
the reader's cursor.

**Ranks advance left to right; steps sharing a rank stack downward.** A step box carries a name, an
operation and a status line, so it is three times wider than it is tall. Spending the rank axis on
the *short* dimension is spending the one that is scarce: a twelve-step flow becomes twelve stacked
boxes with 220px of empty margin either side, and the graph pushes the step detail (§9) off the
bottom of the tab in exactly the case — a long flow — where you most want both. Along the wide axis
the same flow fits in a strip the pane can scroll sideways, and the graph keeps its height.

It also matches the direction the thing being drawn runs. A request flows left to right in every
sequence diagram anyone reading this has seen, and branch-and-rejoin reads as a widening and a
narrowing rather than as an indent.

**The linear case degenerates to a single row, by construction.** A flow with no explicit `depends`
has one step per rank, so it renders as a left-to-right chain — which is what 001 §9.1's
implicit-sequence rule is for. Branching is visible precisely because it is the exception: a rank
with two steps is the only thing that ever uses the vertical axis.

A rank narrower than the widest one is **centred** against it, so a branch reads as spreading from
the step before it rather than hanging off its top edge — as is a step against the steps it joins,
which is what makes a fork and its rejoin symmetrical.

Panning and zooming are not provided in v1. Flows are tens of steps; the graph is drawn at its own
size and scrolls inside its box, in both directions. It is deliberately never scaled to fit — a
twelve-step flow shrunk to the tab's width is unreadable, and a graph you cannot read is worse than
one you have to scroll. If a real flow arrives that needs a viewport, that is evidence for the graph
library this spec declines to add (§13).

**The view follows the step in flight, while nothing is selected.** Scrolling rather than scaling is
what keeps a long flow legible, and its cost is that the run walks off the right edge of the box:
§8.2's halo answers *which* step is executing and says nothing at all to a reader looking at a part
of the drawing the run has already left. So the graph scrolls itself to the running step — by the
minimum that brings it inside the box rather than by centring it, so consecutive ranks nudge the view
along instead of swinging the whole drawing on every `step:start`, and so a node already in view does
not move it at all. Selecting a step (§9) ends the follow for as long as the selection stands: the
pane below is reading that step's response, and a view that slid away from it would be moving the
drawing out from under the thing it is explaining. Under `concurrency > 1` (§8.3) the earliest node
in the layout is followed and held until it leaves the in-flight set: a view that re-chose on every
event would swing between branches on events that say nothing about where to look, and a poll's
attempts would each move it again.

### 5.3 Edges

Five kinds, and the distinctions are load-bearing rather than decorative:

| Edge | Drawn | Why it is distinct |
|---|---|---|
| **Implicit sequence** | Solid, muted | It is not in the file. Drawing it identically to a declared edge hides the one thing about 001 §9.1 that surprises authors. |
| **Explicit `depends`** | Solid | Declared structure. |
| **Status-conditioned** | Solid, labeled with the status set | `[failed]` on the edge into a fallback branch is the difference between a branch that runs and one that never does. Unlabeled means the default `[success]`. |
| **Data (connector)** | Dashed, labeled with the output name — `✗` on it when the run produced no value | 001 §8.1's declared outputs — the feature's core claim is that data paths are named and drawable. This is where that is cashed. |
| **Shared slot** | Dashed, to and from a slot glyph in a lane below the graph — **drawn on demand**, see below | 001 §9.1's slots deliberately do not name a producer, so they cannot be drawn as a step-to-step edge without asserting a relationship the format denies. |

**These five are drawing treatments, not five values of `FlowEdge.kind`** (§11.1). Three of them —
implicit sequence, explicit `depends`, status-conditioned — are the `'sequence'` and `'depends'`
kinds, with the third distinguished by a non-empty `status` rather than by its own kind; the shared
slot is two kinds, `'slot-write'` and `'slot-read'`, because a slot edge has a direction and no
opposite endpoint. A renderer switching on `kind` alone draws a status-conditioned edge as an
ordinary one, which is precisely the mistake U1.3 exists to catch.

An `any` join (001 §9.1) is marked at the receiving node, because `all` and `any` differ in whether
the step runs at all and the incoming edges look identical otherwise.

**Where several edges join one pair of steps, their labels stack.** 001 §8.1 draws a connector per
output, so a step consuming two of a producer's values is joined to it twice. Routing gives each its
own lane where there is room for one (§5.2) and the same lane where there is not — labels placed
identically then land on top of each other and read as one illegible word rather than as two values. They stack away from the path rather than spreading along
it: the path is short, shared and shrinks with the layout, so labels distributed along one drift over
the nodes at either end and collide again on the next flow. Each stays its own label, with its own
mark and its own hover.

**Data edges are toggleable and on by default.** On a flow where most steps consume the previous
one's output, control and data edges are largely parallel and the drawing is quieter with data
hidden; on a flow with real fan-out they are the interesting half. Neither default is right for both,
so it is a control rather than a decision.

**Slot edges are a layer of their own, and it is off by default.** This is the one default on that
toolbar that is not a preference. A slot is read by every step that references it, and an
`authProfiles` entry interpolating `{{shared.userAuthToken}}` makes *every authenticated step* a
reader — on `seed-verified-company` that is one slot with 14 participants, and slot edges are 34 of
the flow's 63 edges. Drawn together they are a line from almost every box on the drawing to one
glyph, which says less than drawing none of them: the measurement that prompted this was 155 of 174
box-crossings coming from that layer alone. What the graph keeps unconditionally is §5.1's `⌸` marker
— *this step shares state* — and what the layer adds is *which values, with whom*.

**A slot's glyph sits in a lane below the ranks, and no two glyphs share a spot.** The lane is walked
left to right in barycentre order with each glyph placed past the end of the last, and every glyph
carries its slot's name and, on hover, its writers and readers. The first version centred each glyph
on the span of its participants and drew them all on one line, which for four slots spanning the same
flow put four glyphs at one coordinate — one square where four should be. A glyph is placed under the
middle of the steps that use it because that is the only positional information a slot has: it says
where on the drawing this value is being passed around.

**Focusing a step draws that step's slots whatever the toggle says**, and only that step's own edges.
Hovering a node focuses it; failing that, the step §9's pane is reading is focused. The glyph names
the other participants, so nothing is hidden — answering *what does this step share* with fourteen
lines answers a question nobody asked.

**Everything not touching the focused step recedes rather than disappearing.** With sixty edges on a
drawing, "how much is going on" is answered and "which of these is mine" is not; dimming answers the
second without giving up the first, which is why the rest fades instead of being removed. Both ends
of a lit edge stay lit — a line into a faded box says a value went somewhere and not where — and a
line fades further than a box, because a box that faded as far would take its step's name with it and
the reader would lose their place. The lane grows the drawing downward as slots appear, so no step
ever moves in response to what is being looked at.

**While a run is on the graph, a data edge names the value that travelled along it on hover.** The
edge and its label say a value moved and what it was called; which value it *was* is otherwise only in
§9's pane, behind selecting the producing step and opening a tab — a long way round for the question
reading a graph is mostly made of. It is a hover rather than a second label because an output is a
response fragment, not a word: a value long enough to need a viewer is cut, and §9 is where it gets
read in full. Nothing is claimed before the producing step ends.

**A data edge whose value never arrived is marked `✗` beside its label, and names the reference on
hover.** The edge is where this belongs: 001 §11.2 reports the *consumer* as `unresolved-dependency`
and 001 §8.1 makes the absent key on the *producer* the definition of "not produced", so the failure
is a property of the path between them and of neither node alone — which is why §8.2's red run can
otherwise draw nothing but green and grey nodes. The hover text is the consumer's own message (001
§14.6), shown verbatim rather than reworded here, so the graph, the node and §9's pane cannot end up
saying three different things about one missing value.

**The mark follows the run, not the file.** The consumer's reason says which step's references went
unproduced and the producer's recorded outputs say which one of them is missing — both reported by the
engine — so a step referencing two values and failing on one marks one edge. A renderer that inferred
"missing" from the graph alone would be deciding what a flow means, which §11 puts out of bounds.

**An undeclared dependency is drawn as a data edge in a warning style.** 001 §8.3 permits raw
`steps.<id>.body` access and has `validateFlow` report it as an undeclared-dependency warning.
Rendering it — rather than omitting it, which would make the graph claim a data path that exists in
the file does not exist — is what makes 001 §8.3's "declared outputs are drawn as edges" enforceable
by something the author looks at.

### 5.4 Sub-flows

A `uses:` step is one node, collapsed, marked `uses`. Expanding it draws the sub-flow's own graph inline
after it — its own block of ranks, continuing rightward — with its steps under their namespaced ids
(`auth/login`, per 001 §13.2 and §14.5).

Collapsed is the default because 001 §12 makes a sub-flow opaque by contract: the parent declares
`with:` and consumes `exports:`, and cannot reference internal step ids. A view that expanded by
default would show the caller structure it is specified not to depend on. Expansion exists because
when a sub-flow fails, its internals are exactly what you need.

**The selected container says how to open it** — `double click to expand`, in italic under the box,
left-aligned with it. Expansion is the only gesture this drawing has that nothing on it announces,
and a collapsed container is at its least obvious exactly when it is the step that failed. It is
written under the *selected* node only: on every container at once it is one more label per box,
competing with the sub-flow path each already carries, and the reader who selected one is the reader
asking what it holds. It goes once the internals are drawn, since the same gesture then collapses
them. §9 makes the same offer from the step pane, where a `uses:` step has nothing of its own to show.

**An open sub-flow stands on a band of its own colour, and its container wears that colour as a
ring.** Expanded, its steps are just more boxes in the same picture, and nothing said where the
caller stopped and the sub-flow began — with two open at once, nothing said which steps came out of
which `uses:`. The band is that boundary, the ring is the tie back to the step that drew it, and one
colour is what makes them a single statement rather than two.

The ring is drawn *outside* the box rather than on it. The box's own border is how §8.2 says passed,
failed or in flight, and a step outlined to group it would have stopped saying what happened to it —
on the one node whose failure is a failure somewhere else.

The colour is neither a status nor an API's: §8.2 owns green, red and yellow, and §5.1 spends blue,
orange and green on the bindings whose bars sit inside these very boxes. It is fixed by the
container's place among the flow's `uses:` steps rather than by the order they were opened in, so
collapsing one sub-flow never recolours another. Past the palette a band takes a neutral outline
instead of a second container's colour — §5.1's rule, for §5.1's reason: two regions in one colour
is worse than one with none, because the reader cannot tell and has no reason to doubt.

## 6. Diagnostics

`validateFlow` (001 §13.2) runs when a flow is opened and again on every watcher change. Its
`Diagnostic[]` is the only source of correctness feedback in the UI — the renderer performs no
validation of its own, so the app and `bru flow validate` cannot disagree.

**Errors block the run control; warnings do not.** This follows 001 §5.4's posture directly: an
unknown property is a warning so an older Bruno opens a newer file, and the same reasoning applies to
an app that must stay usable against a flow written by a newer version.

Diagnostics surface in three places, each carrying the stable `code` (001 §14.6):

- **The document view** — anchored at `line`/`column`, which is why `describeFlow` returns positions
  (§11.1). This is the primary surface: a diagnostic about `depends` is most useful next to the
  `depends` that caused it.
- **The graph** — a badge on the node whose `stepId` the diagnostic names. A cyclic dependency or a
  non-ancestor reference is a statement about structure, and the structure is what is drawn.
- **A list in the tab header** — errors, listed. Diagnostics with no `stepId` and no position — a bad
  `apis:` binding, a scope-root escape — have nowhere else to go, and an error is the answer to why
  the run control is disabled, so it belongs where it cannot be missed.
- **The run's own diagnostics (001 §13.2), listed with the errors.** These are a different thing
  wearing the same word: §14.3's describe the file, a run's describe what happened while it executed —
  a capture that could not be written, or the failure a run that died on its own could not attach to
  any step. Nothing else in this view can carry them, because they belong to no step: no node will
  badge them and no step pane will show them. They are listed rather than hidden behind a hover,
  because unlike a file's warning they are about the run in front of you and there is no second place
  to go looking.
- **A count at the end of the toolbar** — warnings, whose list opens on hover. A warning does
  not block the run, and 001 §5.4's posture means a flow written by a newer Bruno carries one
  indefinitely, as does one whose author accepted an undeclared dependency. Listed beside the errors
  they pushed the drawing down on every open and read as something to deal with before running, which
  is what the error list means and what a warning is specifically not. The count is the standing
  statement; the list is a hover away, and it opens *over* the graph rather than in front of it. It
  takes focus as well as a pointer, or the list is unreachable from the keyboard.

  It sits with the view's other controls — the data-edge toggle, the run selector — at the right end
  of their row, rather than floating over the drawing. They are the same kind of thing: what this view
  is showing, and what it has to say about it. Over the graph it was the one control that moved with
  the drawing, and it occupied a corner of the drawing to do it.

**A flow that does not parse still opens.** The tab shows the document view with the parse error
anchored, an empty graph, and a disabled run control. The failure mode to avoid is a file that cannot
be opened *because* it is broken, which is when you most want to look at it.

## 7. Running

### 7.1 The run control

One control, in the tab header: **Run** while idle, **Cancel** while running. No separate "run from
here" or per-step run — a flow is a graph with declared dependencies, and running a subset means
inventing semantics 001 does not define. (Running one step of a flow is a real want; §14 records it.)

Cancel maps to the `AbortSignal` of 001 §13.2. While cleanup steps run under `config.cleanupGrace`
(001 §11.3) the control shows that state explicitly rather than appearing hung — a flow with
`depends: [{ status: [cancelled] }]` steps keeps working for up to 30 seconds after cancel by design,
and a UI that showed nothing would look broken at exactly that moment.


**Capture hangs off that control rather than sitting beside it as a setting.** `Run` runs and
captures; a menu attached to it carries the runs you take a decision about, and today that is one —
**Run without capture** — which runs on the click that chooses it.

It was a checkbox in §7.2's panel, and three things were wrong with that. It made the ordinary run a
two-part act: read the state of a box, then press the button. It *remembered*, so a run that wrote
nothing to `.bruno-runs/` looked exactly like one that did until you went looking — and §9's pane
saying it has no capture to show is a poor moment to find out. And it stated capture as a property of
the tab when 001 §14.5 makes it a property of a run.

The menu item runs rather than arming the button, which is the whole distinction: a chooser that only
set the mode would be the checkbox again with a step in front of it. Nothing is remembered, so the
next `Run` captures — the default is what a single click does, and the exception costs two.

### 7.2 Run configuration

A panel beside the run control, following `RunnerResults/RunConfigurationPanel`'s shape:

| Control | Maps to |
|---|---|
| Environment | The `environment` tier of `RunOptions.variables` — see the scope split below. On §4.2's header rather than in this panel, where a collection keeps it |
| Variable overrides | `envVarOverrides` — the app's `--env-var` |
| Dataset | `overrides.dataset` (001 §9.4) |
| Concurrency | `overrides.concurrency` (001 §9.2) |
| Parameters | `params`, shown only for a library flow (001 §12.5) |
| Capture | **Not in this panel** — it is a kind of run, chosen on §7.1's control. §9 states what the step pane shows when a run captured nothing |

**The renderer never merges the variable tiers.** It sends each tier's variables *separately and
unmerged*, and `bruno-electron` flattens each one and hands `RunOptions.variables` to the engine.
001 §13.2 is explicit that handing over a pre-merged map would let two hosts disagree about
precedence; a renderer that merged would make a third. Precedence stays where 001 §7.3 puts it — in
the engine — and neither the renderer nor the main process ever computes it.

**But the renderer sends values, not a selection, because the main process has no environment to
resolve.** This app keeps environments in renderer state: `send-http-request`
(`bruno-electron/src/ipc/network/index.js:1344`) takes the whole `collection` and the whole
`environment` object as IPC arguments on *every* request, and the main process holds no map from a
collection to its environments. A flow run is given the same three objects a request is given, and
main flattens each into its tier with the `getEnvVars` the request path already uses.

Resolving the environment in main *from a name* was the first design and is rejected on two counts:

- **Secret values are not in the file.** A `secret: true` environment variable's value lives
  encrypted in the `secrets` electron-store, keyed by collection path and environment name
  (`bruno-electron/src/store/env-secrets.js`), not in `environments/<name>.yml`. A main-side read of
  the file would silently produce an empty string for every secret, and the flow would fail against
  an authenticated API for a reason nothing in the run could explain.
- **It would make a flow disagree with a request in the same app.** The renderer's copy is what
  every request already uses, unsaved edits included. A flow reading the file instead would run
  against different values than the request beside it — which is the drift this feature exists to
  remove, arriving in the one place the design was not watching.

This is symmetric with the CLI rather than divergent from it: `bru` also hands the engine values it
resolved itself (`loadEnvFromFile` for `--env`), and each host resolving its own tiers is exactly
what 001 §13.2 asks for. What is host-specific is *where* the values come from, which was never the
engine's business.

**Each variable's `secret: true` flag survives into main**, because the renderer sends whole variable
entries rather than a flattened map. 001 §14.4's provenance tracking needs precisely that input, and
this is the first host able to supply it.

#### Which environment, by scope

A collection-scoped flow inherits its collection's active environment (001 §5.1), so the Environment
control is the collection selector already in the app and every tier is populated as it is for a
request.

**A workspace-scoped flow has no collection, and gets the active workspace environment and the
workspace `.env` — nothing else.**

| `variables` field (001 §13.2) | Collection-scoped flow | Workspace-scoped flow |
|---|---|---|
| `globalEnvironment` | active workspace/global environment | active workspace/global environment |
| `collectionVars` | the collection's | — |
| `environment` | the collection's active environment | — |
| `processEnv` | collection `.env` | workspace `.env` |
| `envVarOverrides` | run configuration | run configuration |

The Environment control for a workspace flow is therefore the app's own workspace-environment
selection, not one the flow keeps privately: it selects the active environment through
`selectGlobalEnvironment`, exactly as the selector in a collection's header does, and `tiersFor` reads
that selection and needs no notion of a flow having chosen one.

**It sits on §4.2's flow header rather than in this panel**, at the end of the row, because that is
where a collection's header keeps it — this is the one control here that someone already knows the
location of, and the run configuration is not that location. The rest of this table is a flow's own.

**It is upstream's list, composed rather than copied.** `EnvironmentListContent` — the body of the
selector a collection's header shows — is written against environments rather than against a
collection, so search, colour badges, the active tick and the *No Environment* row come with it, as
does its stylesheet. What is not reused is the selector *around* it: that opens on a Collection tab and
keys its configure and create paths off `collection.uid`, and the collection a workspace flow borrows
(§4.2) is the workspace's scratch one, whose environments must never show through as chrome. Its
configure, create and import actions land where all three happen — the workspace's environments.

A flow tab borrows a collection to exist and then hides that collection's chrome, and the environment
selector went with it — so before this there was nowhere to make the choice while looking at a flow,
and a run silently used whatever was last selected elsewhere in the app. Selecting *no* environment
stays available: a flow taking every value from a `.env` or an override has made a choice, not an
omission.

**Workspace environments and global environments are one mechanism in this app, not two.**
`renderer:get-global-environments` serves them from `workspaceEnvironmentsManager` when a
`workspacePath` is present and from the app-data store otherwise
(`bruno-electron/src/ipc/global-environments.js:138`), the `main:workspace-environment-*` file events
refresh the same `globalEnvironments` slice, and `EnvironmentSelector` offers exactly two tabs. 001
§5.1 describes these as two tiers; §11.4 records the correction.

Two alternatives were rejected. **Letting a workspace flow borrow a collection's environment** gives
it more reach, but a workspace flow spans services by definition, so binding it to one collection is
arbitrary — and it makes the same flow behave differently depending on a dropdown that has no CI
equivalent. **Flow-scoped environment files** are cleaner conceptually and are a new on-disk artifact
needing a format, a schema and a `bru` equivalent, which is 001's territory rather than this spec's.

Configuration is per flow and remembered across app restarts through the existing snapshot
middleware, not written to the flow file. A run configuration is a property of who is running, not of
the flow — writing it back would make `.flow.yml` differ between two people running the same test.

### 7.3 What the app supplies that the CLI does not

The `ExecuteRequest` port (001 §13.2) is `bruno-electron`'s existing `ipc/network` path, so a flow
step gets the app's proxy settings, client certificates, cookie jar and OAuth2 token cache without
flows implementing any of it. This is the concrete payoff of 001's port design and the reason a flow
run in the app can differ from one in CI only in configuration, never in mechanism.

**`RunScript` runs against the flow's scope root, which for a workspace flow is the workspace.** The
VM resolves `require` against a path and refuses to start without one, so a host handing it nothing
turns every one of 001 §8.2's script positions — an `outputs` script, a `when:` condition, a
`shouldRetry` — into a `script-error` on the step, blaming the author's script for something the host
did. A workspace-scoped flow has no collection by construction (§7.2), so this is not an edge case
there; `bru` already falls back the same way, which is what keeps a script's behaviour identical in
both hosts. The safe-mode refusal above stays keyed to a real collection, since that setting is a
collection's.

## 8. Watching a run

### 8.1 The event stream

`FlowEvent`s (001 §13.2) cross IPC on `main:flow-run-event` and fold into the flow slice. Events are
small and structured-clone-safe by contract, so nothing here needs to trim them.

**Events are batched per frame in the main process** before being sent, following
`main:mock-server-request-log-batch` (`bruno-electron/src/app/mock-server/mock-server.js:210`). A
run at `concurrency: 5` with polling steps emits `step:attempt` at request rate; one IPC message and
one dispatch per frame is the difference between a smooth graph and a renderer that spends the run
in reconciliation.

**A run in this view always ends**, because 001 §13.2 guarantees `run:end` follows `run:start`. The
slice has no timeout of its own and needs none: a run's terminal state is an event like any other, and
inventing one here — a spinner that gives up after N minutes — would be the app deciding a run's
outcome from the outside, which §8.2 gives the engine.

Batching preserves order within the batch, which is all 001 §13.2 guarantees anyway — it promises
`step:start` before `step:end` and both inside their iteration, and explicitly requires consumers to
key on `id` and `index` rather than assume adjacency.

### 8.2 Node states

A node is in exactly one state, and the four terminal ones are 001 §14.6's, unrenamed:

| State | From | Shown |
|---|---|---|
| pending | before `step:start` | outline only |
| running | `step:start` | a halo travelling around the box |
| retrying | `step:attempt` beyond the first | the same halo, in the retry colour, plus `attempt n/m` on the node |
| `success` | `step:end` | green, with status code and duration |
| `failed` | `step:end` | red, with the reason (001 §14.6) |
| `skipped` | `step:end` | muted, with the reason |
| `cancelled` | `step:end` | muted, distinct from skipped |

**The reason is on the node, not behind a click.** 001 §14.6 defines 14 of them and the distinctions
between four skip reasons are the substance of a run's outcome — `condition-false` is the flow
working, `unresolved-dependency` is usually a real failure that 001 §11.2 deliberately reports as a
skip. A UI that showed a uniform grey "skipped" would erase the distinction the vocabulary exists to
draw.

**The message that goes with it (001 §14.6) is on the node's hover.** A node has room for a state and
a reason and no more, and the message is a sentence — but the reason alone routinely names nothing to
act on. `unresolved-dependency` is the case that forces this: the run's verdict is *failed* while
every node it drew is green or grey, and the one fact that explains both — which reference was never
produced — is on the skipped node and nowhere else. Hover rather than a fifth line, so the graph does
not resize itself around whichever step happened to fail; §9's pane shows the same message in full for
the step being read, and §5.3 marks the data edge the missing value should have travelled along.

**Both markers answer to the run as well as to the node.** A node's state is the last thing the
engine said about that step, so one that announced `step:start` and never announced its end reads
`running` for as long as the tab is open — true of the report, and false about the world the moment
the run ends. 001 §13.2 guarantees the stream terminates, so the run's own terminal state is the
engine's answer to *is anything still in flight*, and it is the one an in-flight marker asks. Nothing
is invented to cover the gap: the node keeps the status it was given, and §9's pane says plainly that
the run ended without the step reporting rather than repeating `running` beside a run that is over.

**`retrying` is a first-class state for the same reason.** 001 §11.1 makes polling the mechanism for
waiting on asynchronous state, and a 20-attempt poll that renders as "running" for a minute is
indistinguishable from a hang.

**The halo moves, and its colour separates the two states.** Motion is what distinguishes a request
in flight from a step drawn in a state it reached and stopped in — a static border says the same
thing about a step that is working and one that is wedged. It turns *around the box* rather than
pulsing it, so a graph with several steps in flight under `concurrency > 1` (§8.3) reads as several
things happening rather than as a flashing diagram. The retry colour is what makes a poll legible
from across the graph without reading the attempt count on the node, which is the distinction this
state exists for. Under `prefers-reduced-motion` the ring holds still: the colour still says the step
is in flight, and only the motion goes.

### 8.3 Concurrency and iterations

Multiple nodes are in `running` simultaneously under `concurrency > 1`, which is the point of drawing
a graph rather than a list — the shape of what is in flight is visible.

A dataset flow (001 §9.4) gets an **iteration selector**; the graph shows one iteration at a time,
with a per-iteration status strip above it. Iterations are independent by contract — their own
`steps.*`, their own shared slots, their own cookie jar — so overlaying them on one graph would
require a node to hold several states at once and mean nothing in particular. Under `parallel: > 1`
several iterations advance at once and the strip shows that; the selected iteration is just which one
is drawn.

### 8.4 The run summary

A header line from `RunResult.summary`: total, passed, failed, skipped, cancelled, plus elapsed time
and the flow's own status word. 001 §14.6 keeps flow status (`passed`/`failed`/`cancelled`) lexically
distinct from step status (`success`/…) precisely so a summary is unambiguous about what it
describes; the UI uses the same two vocabularies in the same two places.

**A verdict the counts do not account for names the step it fell on**, as a control that selects that
step. The counts tally step statuses, and 001 §11.2's `failOnUnresolved` fails a run through a step
that is *skipped* — so this line can read `failed` over `0 failed` with every node in the graph green
or grey, which is the one run outcome the whole view otherwise explains nowhere. Selecting the step
opens §9's pane on it, where its reason and 001 §14.6's message are, and the graph highlights the node
on the way: one click from the verdict to the sentence.

**The steps come from 001 §13.2's `decidedBy`, and the displayed iteration's rather than the run's.**
Scanning the steps for `unresolved-dependency` instead would name one that opted out of the rule —
`failOnUnresolved` is per-step and `StepResult` does not carry it — which is the same class of mistake
as computing a status here. §8.3 draws one iteration at a time, so a cause from another row would
point at a node that ran perfectly well in the one on screen. A step the graph already draws red gets
no mention: it says it itself, in the place that shows what it was.

### 8.5 Flow requests in the DevTools network tab

**Every request a flow sends appears in the app's DevTools network tab, beside the ones sent from a
request tab.** A flow is the app sending HTTP, and a panel that lists what the app sent is either
complete or misleading — a user who opens it mid-run and sees nothing concludes the flow never
dispatched, which is exactly the failure it would be used to diagnose.

Nothing about the panel makes this automatic. It lists a collection's `timeline`, which is appended
by the `responseReceived` reducer on the `send-http-request` path; §7.3 deliberately routes a flow
through `configureRequest` directly rather than through that handler, so a flow's requests reach no
collection and the panel has no source for them. The dispatch port therefore reports each request
it sends, on `main:flow-request-log-batch`, and the panel selects over both sources.

**The port reports, not the engine.** 001 §13.2 keeps bodies out of `FlowEvent` so a large response
is not serialized twice per step, and adding a request event would undo that for every host
including `bru`, which has no panel to feed. The port is the app's own request path and already
holds the request and the response; reporting from there costs the engine nothing and leaves the CLI
unchanged.

**A flow request is mapped into the timeline entry the panel already reads**, so nothing downstream
of the merge learns that flows exist. Two fields need a rule of their own:

| Field | Value |
|---|---|
| collection | The collection owning the flow; for a workspace-scoped flow (§7.2), the workspace's **scratch collection** |
| row identity | `runId:stepId:iteration:attempt` — an attempt is the finest selectable thing, so a 20-attempt poll (§11.1) is 20 rows |

**Every row names a collection, including a workspace-scoped flow's.** The obvious alternative —
leaving those rows unattributed, since the flow genuinely belongs to no collection — is what the
details panel cannot take: it resolves a collection from the row and hands it to the response viewer,
which dereferences `collection.uid`, so an unattributed row crashes the renderer rather than reading
as anonymous. Borrowing the scratch collection is the same answer §4.2 already gives for the flow's
own *tab*, and for the same reason: everything in this app belongs to a collection, and a
workspace-level thing belongs to the workspace's scratch one. A row whose named collection has since
been **closed** takes the same fallback. Nothing displays the collection, so nothing misreads it.

**Headers are masked with the run's own policy** — 001 §14.4's denylist extended by
`config.redactHeaders`, the same set the capture masks. The panel is a second reporting surface, not
an exemption from the one rule 002-C R3 pins; a masked token that the network tab printed in full
would not be masked at all. Applying the *run's* policy rather than the built-in denylist is why
`FlowContext` carries `redactHeaders` (§11.4).

Three limits, each stated rather than discovered:

- **A body larger than 1 MiB is reported as absent, with its size.** Unlike the single response of
  an ordinary request, a run's bodies accumulate — one per attempt — and the capture holds the real
  bytes, which is where §9 already sends you to read one.
- **Only a textual request body is reported.** `binary` and `multipart` bodies are the two the
  capture describes structurally (001 §14.5); restating that summary here would put a second, weaker
  description of a body in the app.
- **A request that got no response shows an empty status.** That is what happened, and the step's
  own `transport-error` reason (001 §14.6) is on the node.

The log is capped at 500 entries and is not persisted — the snapshot middleware serializes a curated
subset that does not include it, so this surface is in-memory and local to the running app. Anything
worth keeping is in the capture.

## 9. Inspecting a step

Selecting a node opens the step detail pane, and **clicking the selected node again clears the
selection** — the click that made the statement is the one that takes it back. Nothing else does: the
pane has no close control of its own, and a graph with no way back to nothing-selected is one whose
§5.3 focus and §5.2 follow can both be entered and never left.

| Tab | Content |
|---|---|
| Request | The materialized request — method, resolved URL, headers, body — as sent (001 §7, §13.2's `requestHeaders`) |
| Response | Status, headers, body, duration |
| Assertions | Each `assert:` entry with `expected` and `actual`, as recorded for the attempt |
| Validation | Request-schema and response-schema outcomes (001 §10.1), as recorded for the attempt |

**The pane shows one attempt, and the attempt is chosen on its header rather than on a tab.** 001
§14.5 writes one capture per attempt, holding that attempt's request, response, assertion outcomes
and schema-validation outcomes — so all four tabs are attempt-scoped and one selection governs them
together. A fifth tab listing the attempts put the choice in one place and its effect in another: you
selected attempt 3, remained on a tab that showed only a list of attempts, and nothing appeared to
happen. The chooser therefore sits between the step's id and its outcome, beside what it re-keys. It
carries no label, because it always shows a value and that value names what it is.

**Every tab is the chosen attempt's, or none of them is.** Reading the verdict from `StepResult`
while reading the request and response from a capture is the mix that makes a poll unreadable: 001's
engine builds `StepResult` from the attempt that *settled* the step, so a poll that failed twice and
then passed showed a passing assertion beside attempt 1's failing response. 001 §14.5 already records
each attempt's own outcomes for exactly this reason, and §11.2 types them onto `StepCapture`.

**It opens on the final attempt** — the one the step's own outcome was built from, so opening a step
is opening its verdict, and a poll that settled on attempt 12 opens on the response that settled it
rather than on the first of eleven that did not. While the step is still running the final attempt is
the one in flight, whose capture has not been written yet, so the pane follows the newest attempt that
*has* one and a poll's responses appear as they arrive; choosing an attempt stops the following. The
in-flight attempt is offered as well, and reads as "Attempt n has not finished" rather than as a
failed read — the same readiness rule stated below.

**A step still in flight turns a spinner beside its attempt selector.** §9's header shows a step's
status and duration only once they are the step's own (below), so a running step's header would
otherwise be indistinguishable from a finished step's whose events this pane missed. It stays up
across a poll's retries for the reason §8.2 gives for the halo: `retrying` is the same request still
in flight, and a spinner that stopped between attempts would say it had landed. The two surfaces use
one pair of colours, so the pane and the node being read never disagree about what is happening.

**The reason's message (001 §14.6) sits above the tabs**, where it is read whichever one is open — and
it has to be, because the steps whose message matters most have no tab that could carry it. A skip
never dispatched: its request, response, assertions and validation tabs are four ways of reporting the
same absence, and the message is then the only thing on the pane that says anything about why.

**Four things stay the step's: its status and reason, that reason's message, its duration, and its
declared outputs.** No per-attempt form of them exists to show — 001's engine measures the duration
across every attempt and the delays between them, and §11.2 keeps the outcome and the outputs out of
the captures deliberately, because copying them into each would let the copies disagree. On the final attempt they *are* that
attempt's, which is why the pane opens there and shows them without qualification; on an earlier
attempt they describe a different call, so the header drops the status, its message and the duration,
and the response tab drops the outputs. The step's verdict is on its node in the graph throughout, which is why
withholding it here costs nothing.

**A step whose capture was never written says that, rather than that one could not be read.** 001
§14.5 lets an artifact write fail without failing the run, so a step can have dispatched, been judged
and have nothing on disk — and `StepResult.capturePath` is how the run says which. Reading anyway
renders a file that was never written as a read this pane got wrong, and points at the wrong half of
the problem: the reason is on the run's diagnostics above, which is where the pane sends the reader.

**A `uses:` step reports what it is, rather than a capture that went missing.** 001 §12 has the
container dispatch nothing of its own — its requests, assertions and schema checks are the sub-flow's
steps, which the run reports under namespaced ids and §5.4 draws once the container is expanded. Its
`StepResult` carries no `capturePath` and never will, so the paragraph above is a false statement
about it, made in the one place a reader goes looking and pointing at run diagnostics that say nothing
about it. All four tabs say what the step is instead, and offer the expansion with it: the steps
holding the answer are not on the drawing while the container is collapsed, and a reader who has
opened this pane is already looking for them.

What the container does have of its own is already here — `subflow-failed`, 001 §14.6's message
naming the internal steps that failed, and on the response tab the `exports:` it read out of the
sub-flow.

**Under capture-disabled runs there is no attempt to choose.** The chooser is absent, and the
assertion and validation tabs render `StepResult`'s step-level outcomes — the one case where they are
not an attempt's, and the case where nothing else exists to show.

**"As sent" is meant literally, and it is why 001 §13.2 grew `requestHeaders`.** A step's declared
headers are rarely the ones that went out: the content type comes from the body, the `Authorization`
from the resolved auth profile, cookies from the jar — all applied by the host, after the engine has
handed the request over. A pane showing the declared set displays nothing at all for the common step
that declares no headers, while the request it is describing carried several.

**Headers are labelled and grouped**, on both tabs, with an explicit statement when the capture holds
none. Unlabelled rows sat flush against Method and URL and read as more of the same list, which is
the other half of a header section that appears to be missing.

**A capture is read the way it was written.** 001 §14.5 nests a run's captures under `iteration-N`
only for a `dataset:` flow, so `readCapture` is given an `iteration` only when `describeFlow`
reported one. Naming iteration 0 for a flow that has no dataset reads a directory that was never
created.

**A capture that could not be read is reported as that**, never as a step that sent nothing. The two
are different facts about the run, and only one of them is the pane's to assert.

**A capture is not read until the attempt that writes it has settled.** 001 §14.5 writes an
attempt's file *after* the attempt returns — `step:attempt` announces the request going out, the
capture is recorded when it comes back — so the window between the two is a period in which the file
legitimately does not exist. The pane's readiness comes from the node the events fold into: a step
still in flight has a capture for every attempt *before* its current one, a step that has stopped has
one per attempt it made, and a step that made none (skipped, or cancelled before it dispatched) never
will. Those three cases read as **waiting**, **readable**, and **nothing was sent** respectively.

This is the one place where §11.2's "a missing capture is a caller error" is a rule the *caller* has
to keep. The failure it prevents is specific and was observed: selecting a step and then starting the
run puts `run:start`'s capture directory in front of a pane that has not seen any step finish, so the
read fires against an empty directory, fails, and — because nothing re-reads on `step:end` — stays
failed until the pane is closed and reopened. Deriving readiness from node state is also what makes
the recovery automatic: the same event that ends the step changes the input the read is keyed on.

**Bodies come from the capture, fetched on demand.** 001 §13.2 excludes bodies from events
deliberately — every event crosses IPC, and attaching payloads would serialize them twice for data
the UI needs only when a step is opened. Opening a step reads its capture through
`renderer:flow-read-capture` (§11.2); the pane shows a loading state for the moment that takes.

What the events *do* carry — status, reason, attempts, duration, declared outputs — renders
immediately, so a step's verdict never waits on a file read. The assertion and validation *tabs* do
wait, because which attempt's outcomes they show is the question the capture answers.

**The split between the graph and the pane is dragged, and remembered.** §5's graph and this pane
compete for one screen, and which one you want bigger changes with what you are doing — following a
20-node graph, or reading a response body. A fixed share is wrong for both. The handle clamps so
neither side can be dragged away entirely, double-click hands the pane back to its default, and the
size persists across tabs and launches, because re-dragging it for every flow is what a preference
exists to avoid.

The stored size is **re-clamped when the window shrinks**: a pane dragged tall in a maximized window
would otherwise reopen in a small one having eaten the graph, and the graph is what the tab is for.

**Declared outputs are shown with their values**, as the run's answer to "what did this step
contribute". This is the inspection counterpart to §5.3's data edges: the edge says a value moves,
the pane says what it was.

They belong to the **response tab, directly above the body**, because the body is what 001 §8.1 read
them out of — a value and the bytes it was extracted from are read together or neither is worth much.
Above the tab strip instead they are on every tab, most of which have nothing to do with them, and
furthest from the one thing that explains them. They arrive in `StepResult`, so they render on a
capture-disabled run too — the same reason assertion and validation outcomes survive one.

**Under `--no-capture`'s equivalent** — capture disabled in run configuration — the request and
response tabs state that captures were disabled rather than showing empty panels. Assertion and
validation outcomes still render, because they arrive in `StepResult`.

**Whether a run has captures is a property of that run, read from the run**, never from the run
control. 001 §13.2 reports `captureDir` at `run:start` and omits it when capture was off, and §11.2's
stored runs carry the directory they were read from, so the directory's presence *is* the answer for
a live run and a past one alike. Reading the checkbox instead ties what a *finished* run can show to a
setting for the *next* one: unchecking it to configure the next run blanks the captures of the run
you are looking at, and §10's stored runs — which were written by a different process on a different
day — inherit whatever the control happens to say now.

Redaction (001 §14.4) is applied by the engine before emission and before writing captures, so the
app displays what it is given and has no `--show-sensitive` equivalent. A secret hidden in CI output
is hidden here too, and for the same reason.

## 10. Past runs

The run pane's run selector lists the run directories under `.bruno-runs/` for the scope that owns
the flow (001 §14.5), newest first, each showing its timestamp, status and step counts from
`summary.json`.

**A past run opens into the same view as a live one.** The graph, node states, step detail and
attempts are identical; only the source differs — `summary.json` and the capture files rather than a
live event stream. Building a second, weaker viewer for stored runs would guarantee the two drift,
and the stored form is a superset of what events carry.

Three properties this inherits from 001 §14.5 rather than inventing:

- **CI runs open locally.** The capture layout is a 001 contract written by the CLI, so a
  `.bruno-runs/` directory downloaded from a build artifact opens in the app exactly as a local run
  does. This is the strongest argument for reading the directory format rather than an app-private
  store.
- **Retention is the engine's.** The last `config.captureRetainRuns` runs are kept and older ones
  pruned at the start of a run. The UI shows what is on disk and does not prune; a viewer that
  deleted runs would be a second retention policy.
- **Redaction already happened.** Captures are written redacted, so nothing here needs to filter.

Runs from a *different* flow in the same scope are excluded — `run.json` names its flow, which is
why the filter works on a run that has not finished as well as one that has.

**A run directory with no `summary.json` is an interrupted run**, and is listed as one. The file is
written when a run ends, so its absence means the process died before that — a `SIGKILL`, a crash, or
a machine losing power. 001 §11.3 covers the cases the engine can see and cannot cover this one by
construction.

Such a run still opens: the step directories that exist render as the steps that completed, and the
rest show as never-started. This is worth supporting rather than hiding, because a run that died
without writing its summary is one of the few situations where the captures are the only evidence of
what happened. What it must not do is claim an outcome — an interrupted run has no status, and
showing it as `failed` or `cancelled` would assert something nobody recorded.

**This is what 001 §14.5's `run.json` is for** — written when the run starts, carrying `runId`, the
flow's path and `startedAt`. Without it an interrupted run cannot be attributed to a flow at all: the
directory is named for a timestamp and a short id (`2026-08-05T14-22-01Z-a3f9`), and the only thing
naming the flow would be the `summary.json` that was never written. The selector filters by flow
(above), so an unattributable run could not be listed under the flow that produced it.

The same file fixes the live case, which is not an edge: a run *currently in progress* has no
`summary.json` either, so §10 cannot list the run the user is watching without it. `listRuns` reads
`run.json` for identity and `summary.json` for outcome, and an entry with the first and not the
second is either running or interrupted — distinguishable because the engine knows which runs it
owns.

**Whether a run finished is a separate field from what its outcome was** (§11.2's `state` beside
`status`). Adding `running` or `interrupted` to the same slot that carries 001 §14.6's
`passed`/`failed`/`cancelled` would grow a contract vocabulary from the UI side, which §14.6
forbids — those strings are parsed by CI. A run in progress has no outcome yet and an interrupted one
never got one; both are the absence of a status, not a new value of it.

The addition is additive and changes no existing field, so it costs nothing under 001 §15. §11.4
records why it was needed.

The selector's default is the current or most recent run for that flow, so opening a flow after a
failed run shows the failure rather than an empty graph.

**`current` is always one of the options, and a run ending does not go back to it.** Every other
entry is a record of something that already happened; `current` is the flow as it stands on disk,
and it is the only one whose graph can have moved since the newest run — §4.3 makes editing the file
a first-class action, so a stored run's snapshot and the current text diverge as a matter of course.
Offering `current` only while no run is open puts the flow-as-it-is out of reach the moment a run
finishes, which is exactly when the file is most likely to have changed. Returning to it is a
choice rather than something the end of a run performs: the run that just finished stays selected,
because its outcome is what the run was for, and `current` is a second act.

A run started **without** capture never gets a directory and so is never in this list. While it is
the run in the view the selector names it as that run rather than showing `current`, which would
claim the graph is the flow as it stands when it is showing a run's outcomes.

**The selector is locked while a run is executing.** Every entry in it replaces the run state events
are being folded into, and a live run has nowhere to be restored from — 001 §13.2's `run:start` is
what creates it, and it has already been sent. Leaving a run in progress would drop the remainder of
its events and take §7.1's Cancel control with them, mid-run.

**A live run pins its graph too.** 001 §13.2 reports the snapshot at `run:start`, and the tab draws
it for the run in progress exactly as it does for a stored one. Without it, saving an edit while a run
executes redraws the running graph from the new file — the watcher clears the stored description on
the save, so the tab would follow the edit rather than the run it is watching. Under a capture-disabled
run there is no snapshot to report and the view falls back to the file, which is the same degradation
§9 states for that case.

**A past run draws the graph it executed, not the flow's current one.** 001 §14.5 records the
description at run start, and §11.2 returns it; the tab draws that in preference to the live
description whenever a stored run is open. Drawing today's graph instead is not a cosmetic mismatch —
it drops a renamed step's outcome, shows a step added since as one that never ran, and draws edges
the run never had, all silently. §4.3 makes editing a flow a first-class action, so this stopped being
a rare case the moment raw editing existed. A run written before snapshots has none, and falls back
to the current graph exactly as it did before.

**And a run whose flow has since changed says so in the selector** — `flow edited since`, from
§11.2's `flowChanged`. The graph it opens into is that older flow's, which is otherwise
indistinguishable from the current one in a list of timestamps. Only a definite change is marked:
`flowChanged` is three-valued, and a run that predates the digest is *unknown*, not unchanged.

The same snapshot fixes a quieter failure in §9. `readRun` asks which steps have captures, and the
ids it asks about used to come from today's graph — so a renamed step's captures became unreachable,
since 001 §14.5's directory name is a lossy encoding that cannot be inverted. With a snapshot the
reader asks about the ids the run actually had.

---

## 11. The engine boundary

001 §13.2 exposes `runFlow` and `validateFlow`. Neither returns a graph and neither reads a capture,
so this spec adds two read-only entry points to that contract. Both belong in `@bruno-max/flow` for
the reason 001 §13.1 gives for everything else in it: a renderer that parsed `.flow.yml` would
re-implement 001 §9.1's implicit-sequence and join rules, and the app would then be able to draw a
graph the CLI does not execute.

### 11.1 `describeFlow`

```ts
declare function describeFlow(options: DescribeOptions): Promise<FlowDescription>;

type DescribeOptions = {
  entry: string;
  scope: { workspaceRoot: string; collectionRoot?: string };
  ports: { readFile: ReadFile; readSpec: ReadSpec };
};

type FlowDescription = {
  id: string;                          // path relative to the scope root (001 §5.2)
  name: string;                        // meta.name, or the filename
  isLibrary: boolean;                  // meta.library: true (001 §12.5)
  params: { name: string; required: boolean; default?: unknown }[];
  dataset?: { source: string; parallel: number };
  nodes: FlowNode[];
  edges: FlowEdge[];
  slots: { name: string; writers: string[]; readers: string[] }[];
  diagnostics: Diagnostic[];           // the same set validateFlow returns
};

type FlowNode = {
  id: string;                          // sub-flow internals namespaced: "auth/login"
  name?: string;
  kind: 'operation' | 'subflow';
  operation?: { api: string; method: string; path: string; operationId?: string };
  uses?: string;                       // sub-flow path, when kind is 'subflow'
  parent?: string;                     // the uses: node this internal step belongs to
  rank: number;                        // longest path from a root — see below
  outputs: string[];                   // declared output names (001 §8.1, §8.5)
  markers: {
    conditional: boolean;              // when: (001 §9.3)
    retryMaxAttempts?: number;         // retry: (001 §11.1)
    allowsErrorStatus: boolean;        // failOnStatusCode: false (001 §10.3)
    usesSharedSlot: boolean;           // (001 §9.1)
  };
  position: { line: number; column: number };
};

type FlowEdge = {
  from: string;
  to: string;
  kind: 'sequence' | 'depends' | 'data' | 'slot-write' | 'slot-read';
  status?: StepResult['status'][];     // depends edges, when not the default [success]
  join?: 'all' | 'any';                // depends edges
  output?: string;                     // data edges: the connector's name
  declared?: boolean;                  // data edges: false for raw .body access (001 §8.3)
  slot?: string;                       // slot edges
};
```

**`kind: 'sequence'` is how an implicit edge is distinguished from a declared one.** The renderer
cannot infer it — both are ordinary parent-child relationships by the time the graph exists — and
§5.3 makes the distinction the most useful thing the drawing communicates.

**`rank` is the engine's; pixels are the renderer's.** Longest-path ranking is a fact about the
resolved DAG and needs the same knowledge `runFlow` has, so computing it in the renderer would be a
second implementation of the scheduling order. Turning ranks into coordinates is presentation and
stays in fork UI code.

**A sub-flow's internals are ranked within their own flow, not continued from the caller's.** Its
first step is rank 0. §5.4 draws the expansion as its own graph inline after the container node,
so those ranks are the ones that picture needs; continuing the caller's numbering would make a
sub-flow's layout depend on how deep in the parent it happened to be invoked, and the same library
flow would draw differently in two callers. The `parent` field is what relates the two.

**Positions are why this returns more than a graph.** §6 anchors diagnostics into the document view,
and a `Diagnostic` already carries `line`/`column` (001 §13.2). `FlowNode.position` extends the same
idea to selection: clicking a node scrolls the document to its step.

`describeFlow` never dispatches and never reads state. It resolves operations against the bound
OpenAPI documents, which means it can fail the same way `validateFlow` does — hence `diagnostics` on
the result rather than a thrown error. A flow with errors still returns whatever nodes and edges
could be built, because §6 requires a broken flow to open.

### 11.2 Reading runs

```ts
declare function listRuns(options: ListRunsOptions): Promise<RunIndexEntry[]>;
declare function readRun(options: ReadRunOptions): Promise<StoredRun>;
declare function readCapture(options: ReadCaptureOptions): Promise<StepCapture>;

type ListRunsOptions = {
  scopeRoot: string;                   // where .bruno-runs/ lives (001 §14.5)
  flow?: string;                       // filter to one flow
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

type RunIndexEntry = {
  runId: string;                       // from run.json — see §10 and §11.4
  dir: string;
  flow: string;                        // from run.json, so the filter works on unfinished runs
  startedAt: string;                   // from run.json
  state: 'complete' | 'running' | 'interrupted';
  status?: RunResult['status'];        // 001 §14.6's vocabulary, only when state is 'complete'
  summary?: RunResult['summary'];      // likewise — both come from summary.json
  flowChanged?: boolean;               // run.json's flowHash vs the flow now; undefined = unknown
};

type ReadRunOptions = {
  dir: string;                         // a run directory, from `listRuns`
  stepIds?: string[];                  // which ids to ask about — see below
  iteration?: number;                  // which iteration's captures, for a dataset flow
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

type StoredRun = RunIndexEntry & {
  result?: RunResult;                  // summary.json — absent on a running or interrupted run
  capturedSteps: string[];             // the steps with a capture — see below
  description?: FlowDescription;       // flow.json — the graph this run executed (001 §14.5)
  source?: string;                     // flow.yml — its text at run time
};

type ReadCaptureOptions = {
  dir: string;
  stepId: string;
  iteration?: number;
  attempt: number;
  ports: { readFile: ReadFile };
};

type StepCapture = {
  stepId: string;                      // namespaced for sub-flow internals (001 §14.5)
  iteration: number;
  attempt: number;                     // 1-based, matching 001 §11.1's numbering
  startedAt: string;
  durationMs: number;
  request?: CapturedRequest;           // absent when nothing was sent — see below
  response?: CapturedResponse;         // absent on a transport error or an aborted attempt
  assertions: StepResult['assertions'];         // 001 §13.2, as recorded for this attempt
  validation?: StepResult['validation'];        // 001 §10.1's automatic checks
};

type CapturedRequest = {
  method: string;
  url: string;                         // as sent — resolved, query string included
  headers: Record<string, string>;
  body?: CapturedBody;
};

type CapturedResponse = {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  body?: CapturedBody;
  responseTimeMs: number;
};

type CapturedBody =
  | { kind: 'text';      contentType?: string; text: string }
  | { kind: 'binary';    contentType?: string; byteLength: number; file: string }
  | { kind: 'upload';    sourcePath: string; filename: string;
                         contentType: string; byteLength: number }   // by reference (001 §7.5)
  | { kind: 'multipart'; parts: CapturedPart[] };

type CapturedPart =
  | { name: string; kind: 'field'; value: string; contentType?: string }
  | { name: string; kind: 'file';  sourcePath: string; filename: string;
      contentType: string; byteLength: number };                    // by reference (001 §7.5)
```

**A `StepCapture` is one attempt, not one step.** `ReadCaptureOptions` already takes an `attempt`,
and 001 §14.5 captures each retry separately because "a step that polled ten times records ten
attempts, which is usually the only way to see what changed between them." §9's attempt chooser is one
call to this function per attempt, and a step-shaped return would have to carry all ten payloads to
answer a question about one.

**It is self-describing, and that is what makes an interrupted run readable.** §10 opens a run with
no `summary.json` and renders "the step directories that exist" — so for that run there is no
step-level record anywhere, and an attempt capture carrying only a request and a response would
render as a call with no verdict. Carrying this attempt's own `assertions` and `validation` is what
001 §14.5 already commits to ("the assertion and schema-validation outcomes"), and it is why 001-C
R4g2 can require that an interrupted run's existing captures parse.

**The step's final outcome is not here; it is in `summary.json`.** A step's `status`, `reason` and
declared `outputs` describe the step, not an attempt of it — a poll that settles on attempt 3 has one
outcome and three captures, and copying the outcome into each would let the copies disagree. 001
§14.5's `summary.json` "carries the outcome", which is `RunResult` (001 §13.2); reading it gives §10
every node state without opening a single attempt file. This is a reading of 001 rather than an
addition to it, and it is the reason a skipped step needs no capture at all: 001 §14.5 says such a
step records "their status and skip reason; no request was made, so there is nothing else to store",
and both of those fields live in the summary.

**`request` and `response` are independently optional**, because 001 has three shapes that produce
neither or only one: a step failing `validateRequest` never dispatches (§10.1), a transport error
returns no response (§11.2), and an attempt aborted by `maxDuration` or a cancel (§11.3) has a
request and nothing back. A type requiring both would make the engine synthesize an empty response
for the exact cases §9's step pane most needs to describe honestly.

**`CapturedBody` is the untruncated payload — the `preview` / `truncated` / `originalSize` fields in
001 §14.5's JSON example are the *reporter's* inline copy and do not appear here.** That example sits
under "Storage is split", and the split is precisely that reporters carry a capped preview while the
artifact directory holds the whole thing. A reader who assumed `readCapture` returns the preview
shape would build §9's Response tab against a truncated body and a path it would then have to resolve
itself.

Textual bodies — JSON included — are stored as `text` rather than as a parsed value, so what the pane
shows is what crossed the wire rather than a re-serialization of it. `binary` names a sibling file
because 001 §14.5 writes binary payloads out "with an appropriate extension" and never previews them;
`file` is that artifact's name, resolved against the same `dir` the options carry.

**`upload` and `binary` are not the same case, and only responses ever produce the second.** A
request's binary body is always a file source (001 §7.5's `bodyFile:` and `!file` bodies), so 001
§14.5's capture-by-reference rule applies to it exactly as it does to a multipart file part — the
content is already in the repository, and naming the fixture is the more useful record. Folding both
into `binary` would either copy every upload into every run's artifact or leave a `file` field
pointing at a sibling that was deliberately never written.

`CapturedPart` mirrors 001 §13.2's `MultipartPart` with one field swapped: `bytes` becomes
`sourcePath` plus `byteLength`. That is 001 §14.5's capture-by-reference rule expressed in the type —
an upload's content is already in the repository, and copying it in would put the fixture corpus in
every CI artifact.

**Redaction has already been applied** (001 §14.4, §14.5), so nothing reading a `StepCapture` filters
anything, and there is no `--show-sensitive` equivalent in the app (§9).

**`ListDirectory` is a new port**, added to 001 §13.2's `ExecuteRequest` / `ReadFile` / `Clock` set,
and it exists for the same reason they do: the engine stays free of `fs`, each host keeps its own
path handling, and conformance scenarios supply a run directory in memory rather than on disk. It is
also what lets 001 §7.4's scope-root containment be enforced by the engine for history reads exactly
as it is for fixture reads — a run directory outside the scope root is refused before the port is
called.

**`readRun` is the index/detail split.** `listRuns` answers "which runs are there" and must stay
cheap enough to build a selector from — it reads two small files per directory and reports counts.
Opening one run needs every step's outcome, which is the `iterations[].steps[]` that `summary.json`
already holds, and putting that in `RunIndexEntry` would make listing twenty runs parse twenty full
result sets to render twenty rows.

It is a separate entry point rather than a flag on `listRuns` because the two return different
shapes and §10 calls them at different moments — the selector on open, the reader on selection.

`capturedSteps` is what makes §10's interrupted run render. A run that died before writing
`summary.json` has no `StepResult` for anything, so the only evidence of what happened is which step
directories exist; knowing them lets the graph show those steps as having run and the rest as
never-started, without claiming an outcome for any of them. On a complete run it is redundant with
`result`, and returning it anyway keeps one shape for both cases rather than making every consumer
branch on which fields are present.

**`stepIds` is an input rather than something the reader discovers, because 001 §14.5's directory
name is a lossy encoding of the step id.** The segment replaces `/` with `__`, suffixes a reserved
Windows device name, and truncates a long id to a hash — so `child__use` is either `child/use` or a
step genuinely named `child__use`, and nothing on disk separates them. Walking the tree and inverting
the names would answer confidently and sometimes wrongly. The caller already holds the ids it cares
about — the graph `describeFlow` returned — so the decidable question is which of *those* have a
capture, and the id-to-segment mapping stays in the engine, where §14.5 puts every path computation.

**A run's own snapshot supersedes that input.** 001 §14.5's `flow.json` holds the graph the run
executed, so its node ids are the ids that could have captures — and they are the right ones to ask
about, because the caller's list is *today's* graph and a step renamed since would leave its captures
unreachable. `stepIds` stays the fallback for runs written before snapshots; the argument above is
why it exists at all, not an argument for preferring it when the run knows better.

The capture layout is a 001 contract (§14.5). A parser in the renderer would be a second reader of a
format the CLI writes, and the two would drift the first time the layout gained a field — the same
argument 001 §13.1 makes about request dispatch, applied to the artifact.

### 11.3 The IPC surface

| Channel | Direction | Purpose |
|---|---|---|
| `renderer:flow-describe` | invoke | `describeFlow` for one flow, or for draft text (§4.3) |
| `renderer:flow-read-source` | invoke | One flow's own text, for §4.3's editor |
| `renderer:flow-write-source` | invoke | Write one flow's text back |
| `renderer:flow-run` | invoke | Start a run; resolves with the `runId` |
| `renderer:flow-cancel` | invoke | Abort a run by `runId` |
| `renderer:flow-list-runs` | invoke | `listRuns` for a scope |
| `renderer:flow-read-run` | invoke | One stored run's results |
| `renderer:flow-read-capture` | invoke | One step attempt's capture |
| `renderer:flow-watch-scope` | invoke | Start watching a scope's `flows/`; resolves with what is already there |
| `renderer:flow-unwatch-scope` | invoke | Stop watching a scope |
| `main:flow-run-event` | send | A batch of `FlowEvent`s (§8.1) |
| `main:flow-request-log-batch` | send | A batch of requests the dispatch port sent (§8.5) |
| `main:flow-tree-updated` | send | Watcher: a flow file added, changed or removed |

**The renderer says which scopes to watch**, because it is the side that knows which workspaces and
collections are open — main learns a workspace path as an IPC argument and holds no list of its own
(§7.2 makes the same observation about environments). This is how API Specs already work: the
renderer calls `renderer:open-api-spec-file` per file and each call starts a watcher
(`bruno-electron/src/ipc/apiSpec.js:123`). Flows watch a *directory* per scope rather than a file
per artifact, since §4.1 requires a flow that appears on disk to appear in the sidebar without
anyone having opened it.

`renderer:flow-watch-scope` resolves with the flows already present rather than relying on the
watcher's initial `add` burst. Both would work — chokidar's `ignoreInitial: false` emits one `add`
per existing file — but a slice that can populate from the call it made has a defined moment at
which the section is complete, and one that only accumulates pushes never knows whether it is still
loading or simply empty.

All of it is registered by `registerFlowIpc` in a new `bruno-electron/src/ipc/flow/` — the single
`require('./ipc/flow')` + call that 001 §13.4 already claims in `bruno-electron/src/index.js`.
`preload.js` passes any channel through with no allowlist, so none of these needs an upstream edit.

**That missing allowlist is why §4.3's three channels validate their own path.** They are the only
ones that name a file the *user* chose rather than one the engine or the watcher produced, and two
rules make them safe to expose: the target is a `.flow.yml`, and it resolves inside the scope named
in the same call. The second is not decorative — without it a scope root constrains nothing, since
`../../elsewhere/x.flow.yml` satisfies the extension and reaches anywhere on disk. Containment is
tested by resolving the path and asking `path.relative`, not by comparing prefixes, because
`/workspace-two` starts with `/workspace` as a string.

**`renderer:flow-describe` takes an optional `content`,** and when it is given, the *port* is
overlaid rather than the engine being told about drafts: `readFile` answers the entry from memory and
everything else — sub-flows, OpenAPI documents — from disk exactly as before. `describeFlow` is
unchanged and cannot tell the difference, which is what keeps "the graph you are editing" and "the
graph that will run" the same computation.

The main process owns the `AbortController` per `runId`, assembles `RunOptions.variables` from the
tiers the renderer sends (§7.2), and supplies the seven ports. The renderer holds no engine state
beyond what the slice folds from events.

#### The payloads

Channel *names* are useless as a contract without the arguments that go with them, and two
independent implementers — the renderer and the e2e suite — read this table. Every payload is
structured-clone-safe, per the same rule §8.1 puts on events.

```ts
type FlowScope = { workspaceRoot: string; collectionRoot?: string };

// renderer:flow-describe  ->  FlowDescription (§11.1)
type DescribeRequest = { entry: string; scope: FlowScope };

// renderer:flow-run  ->  { runId: string }
type RunRequest = {
  entry: string;
  scope: FlowScope;
  tiers: {
    globalEnvironment?: BrunoEnvironment;   // the app's active global/workspace environment
    collectionVars?: EnvironmentVariable[]; // collection.root.request.vars.req
    environment?: BrunoEnvironment;         // the collection's active environment
    envVarOverrides?: Record<string, string>;
  };
  params?: Record<string, unknown>;
  overrides?: {
    concurrency?: number;
    dataset?: string;
    capture?: { enabled?: boolean };
  };
};

// The shapes the renderer already holds and already sends to `send-http-request`.
type BrunoEnvironment = { name: string; variables: EnvironmentVariable[] };
type EnvironmentVariable = { name: string; value: unknown; enabled: boolean; secret?: boolean };

// renderer:flow-cancel  ->  boolean (false when the runId is not executing here)
type CancelRequest = { runId: string };

// renderer:flow-list-runs  ->  RunIndexEntry[] (§11.2)
type ListRunsRequest = { scopeRoot: string; flow?: string };

// renderer:flow-watch-scope    ->  FlowTreeEntry[], the flows already on disk
// renderer:flow-unwatch-scope  ->  void
type WatchScopeRequest = FlowScope;

// renderer:flow-read-run  ->  StoredRun (§11.2)
type ReadRunRequest = { dir: string };

// renderer:flow-read-capture  ->  StepCapture (§11.2)
type ReadCaptureRequest = { dir: string; stepId: string; iteration?: number; attempt: number };

// main:flow-run-event
type RunEventBatch = { runId: string; events: FlowEvent[] };

// main:flow-request-log-batch — §8.5. Batched across runs, unlike the events above: the panel is
// chronological rather than per-run, and two concurrent runs belong interleaved in it.
type RequestLogBatch = { requests: RequestLog[] };
type RequestLog = {
  runId: string;
  stepId: string;
  iteration: number;
  attempt: number;
  /** Absent for a workspace-scoped flow; the renderer then resolves the workspace's scratch collection. */
  collectionRoot?: string;
  workspaceRoot: string;
  /** When the request was sent. */
  timestamp: number;
  request: { url: string; method: string; headers: Record<string, string>; data: string | null };
  response:
    | { error: string }
    | {
        status: number;
        statusText: string;
        headers: Record<string, string | string[]>;
        /** null past §8.5's size limit; `size` still reports what arrived. */
        data: unknown | null;
        dataBuffer: string | null;
        size: number;
        duration: number;
      };
};

// main:flow-tree-updated — two arguments, matching `main:apispec-tree-updated`
type FlowTreeEvent = 'addFile' | 'changeFile' | 'unlinkFile';
// `name` is the flow's `meta.name` and `library` its `meta.library`, each absent when the flow
// declares none or does not parse (§4.1) — both read by one cheap parse that resolves nothing
type FlowTreeEntry = {
  pathname: string; filename: string; name?: string; library?: boolean;
  workspaceRoot: string; collectionRoot?: string
};
```

**A scope is a `FlowScope` on every channel that takes one**, so the sidebar, the describe call and
the run call all key on the same pair of paths. `ListRunsRequest.scopeRoot` is deliberately not one:
it names 001 §14.5's capture root, which `--capture-dir` can move outside the scope entirely.

**`tiers` carries whole variable entries, not flattened maps**, so `secret: true` survives the
crossing for 001 §14.4 and so main applies the same `getEnvVars` the request path applies. §7.2 is
where that direction is argued.

**`processEnv` is not in `tiers`.** The `.env` tier never belonged to the renderer: main reads
`<workspaceRoot>/.env` and `<collectionRoot>/.env` at run start and layers them over `process.env`,
which is `store/process-env.js`'s documented precedence and the two paths `scope` already carries. A
renderer that shipped `.env` contents over IPC would be sending main a copy of main's own disk.

Reading at run start rather than borrowing the dotenv watcher's cache is deliberate on two counts.
The cache is keyed by *collection uid* and reaches the workspace `.env` only through a collection,
so a workspace-scoped flow — which §7.2 says gets exactly the workspace `.env` — cannot be served
from it without widening an upstream module. And a run that reads the file it is about to run
against is the same thing `bru` does, which is one fewer way for the two hosts to disagree.

**`getEnvVars` appends a `__name__` key** for `bru.getEnvName()`; it is dropped before the tier
reaches the engine. It is Bruno's request-path convention rather than a variable an author declared,
and leaving it in would make `{{__name__}}` resolve in the app and not in `bru`.

**`main:flow-tree-updated` reports `unlinkFile`, which `apiSpecsWatcher` does not.** §4.1 requires a
flow to leave the sidebar when the file is deleted or a branch is switched, and the API-spec watcher
has no deletion path to copy — its watchers are per opened file rather than over a directory.

**`renderer:flow-cancel` resolves `false` rather than throwing on an unknown `runId`.** §10 and
`listRuns` both admit runs this process is not executing (a CLI run, or one from a previous launch),
and asking to cancel one is an ordinary race between the run ending and the click landing, not an
error worth a toast.

### 11.4 What 002 changed in 001

Writing this spec found four things in 001 that had to change. **All are applied**; they are
recorded here because the reasoning belongs with the spec that produced it, and because a reviewer
comparing the two documents should know which parts of 001 moved and why.

Two are changes to a *contract* — and both are additive, so 001 §15's compatibility rules are not
engaged.

- **§14.5 — `run.json`, written at run start** (`runId`, flow path, `startedAt`), beside the
  `summary.json` written at the end. This is a contract change. A run's identity was recoverable
  only from a file that does not exist until the run finishes, so neither an in-progress run nor an
  interrupted one could be attributed to its flow at all — and listing the run currently being
  watched is §10's ordinary case, not an edge. 001-C's R4g2 covers the writer; 002-C's U4.8 and U4.9
  cover the reader.
- **§13.2 — `FlowContext.redactHeaders`**, the run's `config.redactHeaders` from the root flow, the
  same value and the same scope the capture is given. The other contract change. §14.4's policy
  governs a *host* surface too once a host has one (§8.5), and a host applying the built-in denylist
  alone would silently unmask exactly the headers an author added to the list. 001-C's R4n covers it
  alongside the capture assertions it belongs with.
- **§5.1 — one environment tier, not two.** It described workspace-scoped flows resolving "against
  workspace and global environments (both of which Bruno already has)". Those are one mechanism
  (§7.2). Left alone, a reader looks for a workspace environment scope that does not exist and an
  implementer builds a second selector for it.
- **§13.2 — `ListDirectory`, and a pointer to the read-only entry points** in §11.1 and §11.2 here,
  so the boundary's readers learn the package's surface is five functions rather than two.

Three consequential edits followed from those: 001 §3's UI non-goal now scopes itself to the builder
and points here; 001 §19 loses its two UI rows, per its own rule that a specified item leaves the
table rather than being duplicated, with the still-deferred remainder tracked in §15 here; and
001-C §8 hands the UI to 002-C instead of recording an absence.

## 12. Fork isolation

All renderer code lives under `packages/bruno-app/src/fork/`, the directory 001 §13.3 establishes:

```
packages/bruno-app/src/fork/
  registry.js                          # the delegation surface upstream calls into
  tabTypes.js                          # leaf: the fork's tab types, imported by upstream's strip
  tabGroup.js                          # leaf: §4.2's grouping rule
  hooks/
    useVerticalSplit/index.js          # §9's draggable graph/detail split
  flows/
    slice.js                           # flows, describe results, run state keyed by flow path
    ipcEvents.js                       # registers the listeners in the table above
    collectionScope.js                 # which collection a flow's tab and rows belong to
    networkRequests.js                 # §8.5's merged devtools list
    FlowSidebarSection/index.js
    FlowTabHeader/index.js             # §4.2's "API Flows" header, replacing CollectionHeader
    FlowTabPane/
      index.js
      FlowGraph/
        index.js
        layout.js                      # ranks -> coordinates
      StepDetail/index.js
      RunControls/index.js
      RunSelector/index.js
```

**`useVerticalSplit` is a deliberate near-duplicate of upstream's `hooks/useDragResize`**, which does
the same job on the horizontal axis. Widening that hook to take an axis is the better call in a
repository that owns its code, and the wrong one here: it is an upstream edit re-merged at every
pull, against a few dozen fork-owned lines that never conflict. The two keep the same controlled
shape — caller owns the persisted value, hook owns the drag state — so reading one teaches the other.

Electron-side code is a new directory and a new file upstream does not have:

```
packages/bruno-electron/src/
  ipc/flow/
    index.js                           # registerFlowIpc — the channels in §11.3
    ports.js                           # the seven ports of 001 §13.2
    variables.js                       # §7.2's tiers, flattened
  app/flowsWatcher.js
```

`ipc/flow/` is a directory rather than the single `ipc/flow.js` this spec first named, following
`ipc/mock-server/`: the ports are the largest part and are the part worth unit-testing on their own,
and `.claude/rules/electron-ipc.md` asks for handler files that stay small. `require('./ipc/flow')`
resolves either way, so 001 §13.4's manifest row is unaffected.

The watcher starts from inside `registerFlowIpc`, so it rides 001's existing entry and adds nothing.

### 12.1 The manifest delta

001 §13.4's table is the contract for the whole feature. Run & observe adds **three files** to it:

| Upstream file | Edit | Lines |
|---|---|---|
| `packages/bruno-app/src/providers/App/useIpcEvents.js` | import, register fork IPC listeners, and call the returned disposer in the teardown | 3 |
| `packages/bruno-app/src/components/Devtools/Console/index.js` | import, and select the request list through the registry (§8.5) | 2 |
| `packages/bruno-app/src/components/Devtools/Console/NetworkTab/index.js` | the same import and selection | 2 |
| `packages/bruno-app/src/components/RequestTabs/index.js` | imports, the strip's grouping rule, and the header a fork tab gets instead (§4.2) | 5 |
| `packages/bruno-app/package.json` | the `@dagrejs/dagre` dependency the graph's layout needs (§5.2) | 1 |
| `packages/bruno-app/jest.config.js` | a second `setupFiles` entry, pointing at the fork's own test setup | 1 |

**The two new rows are the cost of §5.2's layout engine, and the second one is a registry again.**
A dependency has to be declared by the package that imports it (`.claude/rules/architecture.md`), so
the `package.json` line has no fork-owned home; it is one line at the least churn-prone point of a
file whose conflicts are already routine. The `jest.config.js` line buys the same saving the IPC
registry does: jsdom ships no `structuredClone`, which dagre calls, and the shim lives in
`src/fork/jest.setup.js` rather than in upstream's `jest.setup.js` — so the fork's *next* test-environment
gap costs no upstream edit at all.

**§4.3 adds nothing to this table, and that is the registry earning its keep.** A whole second tab
type — its own pane, its own label, its own IPC channels, a menu on the sidebar row — reaches the app
through delegation points that already exist and dispatch on nothing: `SpecialTab`'s `default:` case
hands any unrecognized type to `ForkTabLabel`, `RequestTabPanel` asks `isForkTab`, `preload.js`
forwards any channel. The indirection was paid for once by the first flow tab; the second cost zero
upstream edits, which is exactly the saving §12 predicted and the reason to keep paying it that way.

**Two of those lines are inseparable, and the reason is structural.** Every listener in that file is registered as
`const removeXListener = ipcRenderer.on(...)` and then called in the `useEffect`'s returned cleanup
function. A single registration line without the matching teardown line would leak a listener across
hot reloads and re-mounts. The fork registers all of its listeners in one call returning one
disposer, so the count stays flat however many channels §11.3 grows — the third line is the `import`,
which 001 §13.4's table now counts for every delegation.

**A third upstream file was avoided, and the avoidance is the design.** Every response the app had
ever rendered belonged to a collection, so `ResponsePane/QueryResult/QueryResultPreview` dereferences
`collection.uid` freely; §8.5's rows were the first that could arrive without one, and guarding that
component was the first fix reached for. It was withdrawn: the guard is a third upstream edit
re-merged forever, and §8.5's scratch-collection rule makes the state it guards against unreachable
instead. The rule of thumb it came from — when the choice is between changing an upstream file and
making the state that needs the change impossible, the second is cheaper at every future merge —
holds beyond this instance. (The guard is still a real upstream defect: the timeline's own body block
passes a possibly-undefined `item` into the same component. It belongs in a PR to `usebruno/bruno`,
not in the fork.)

**The `RequestTabs` edit is the second half of §4.2's borrowed collection.** Borrowing one is what
lets a flow be a tab at all; it is also an implementation detail the user should never see, and
unmodified it leaks twice. The strip groups by `collectionUid`, so a workspace-scoped flow opens
beside the workspace's permanent **Overview** and **Environments** tabs; and `CollectionHeader`
renders the collection it is handed, so the same flow gets the *workspace's* header, complete with a
workspace switcher. Neither has anything to do with the flow. The grouping rule becomes collection
**and** side-of-the-fork — symmetric, so the workspace's strip gains no flows either — and a fork tab
brings its own header. Both go through leaf modules (`fork/tabTypes`, `fork/tabGroup`) rather than
the registry, so upstream's tab strip does not pull the fork's component tree in.

**The two DevTools lines each *replace* a block rather than add one.** Both files built the same
list from collection timelines in their own `useMemo`; both now select it from the fork registry,
which merges §8.5's flow requests in. The duplication going is why the edit is a net deletion — and
a merge that reintroduces upstream's memo shows up as flow requests vanishing from the panel, which
002-C U2.12 catches.

**Which scopes to watch costs no upstream line at all.** §11.3 has the renderer name them, and the
fork learns what is open by subscribing to `main:workspace-opened` and `main:collection-opened` —
the channels upstream already broadcasts. `ipcRenderer.on` is additive, so the fork's listeners sit
beside upstream's own handlers rather than replacing or editing them.

Two alternatives were considered:

- **Mount the listener from a fork component instead**, which needs no upstream edit at all. Rejected
  because run events must be folded into the slice whether or not any flow UI is mounted — 001 §11.3
  keeps cleanup steps running after cancel, and §4.2 keeps a run alive across a closed tab. A
  listener whose lifetime is a component's would drop events exactly when a run is still going and
  nothing is watching it.
- **Gate the feature behind upstream's `BETA_FEATURES` map** (`bruno-app/src/utils/beta-features.js`),
  as Mock Server does. Rejected: it is a third upstream line for something the fork registry can
  decide by itself, and a fork-owned flag does not collide when upstream adds a beta key.

Everything else lands on hooks 001 §13.4 already claims: the pane registry, the tab-label registry,
the reducer map, the sidebar-section list, and the two tab-type constants. `Sidebar/index.js` builds
its sections in a `useMemo` array, so the spread there is genuinely one line at a stable point.

**One new dependency, and it is a considered reversal.** The graph's *rendering* is still hand-rolled
SVG; its layout is `@dagrejs/dagre` (§5.2), which is a line in `bruno-app/package.json` and a row in
the manifest below. §13 records why the original rejection was revisited and what the reversal is
worth.

## 13. Rejected alternatives

**A graph library — React Flow, or dagre for layout alone.** ~~Rejected for v1~~ — **reversed for
layout, on evidence.** The original argument was that a library's value is concentrated in
interactive editing and this graph is a *view* of a document, so a dependency on an upstream
`package.json` bought pan, zoom and a minimap nobody had asked for. What that argument missed is that
**edge routing is not an interaction feature**: it is what makes a static drawing legible, and the
hand-rolled layout had none. The first real flow to arrive — `seed-verified-company`, 18 steps, 63
edges — put 40 of those edges through boxes they did not connect, because an edge spanning six ranks
was drawn as one curve from the producer's right edge to the consumer's left. Waypoint routing,
crossing-minimised ordering within a rank and per-edge ports are each a hard algorithm and together
they are a layout engine; writing one to avoid a dependency is the worse trade.

`@dagrejs/dagre` rather than React Flow: layout only, no React, no viewport, no interaction model.
The drawing stays this fork's own SVG, so §5.1's `foreignObject` text, §8.2's halo and §5.3's edge
treatments are unaffected, and **the engine keeps deciding ranks** (§5.2, §11.1) — dagre is
constrained to reproduce 001's ranking rather than to invent one. That containment is what makes the
reversal cheap to undo: the seam is one module, `layout.js`.

React Flow remains rejected, and remains the right base for the visual builder — which is where the
interaction budget actually gets spent.

**Flows nested inside the collection tree.** Better adjacency, rejected on fork cost — §4.1.

**A separate tab type per run.** Comparing a red run to a green one by putting each in its own tab is
tempting, but it multiplies tab types for what is a selector, and 001 gives runs no identity outside
the flow that produced them. Diffing two runs is a real want and is recorded in §15.

**A renderer-side parser, for either the flow or the capture.** It would remove two IPC round-trips
and cost a second implementation of a 001 contract — §11.1 and §11.2.

**Live-run-only, with captures left to the CLI.** The smallest possible spec, and it fails goal 4: a
step that goes red in the app would send you to a terminal to find out why, which is the problem §1
describes.

**A `request` event on `FlowEvent`, feeding §8.5's panel from the event stream.** It needs no new
channel and no new port argument. Rejected because it puts bodies back on the event stream that 001
§13.2 deliberately keeps them off — every host would serialize them, `bru` included, for a panel only
one host has. The dispatch port already holds the request and the response, so reporting from there
costs the engine nothing.

**Pushing flow requests into the collection's `timeline` instead.** The panel would need no change at
all. Rejected because a workspace-scoped flow has no collection (§7.2), so it would either drop those
requests or invent an attribution for them — and it would make a flow's requests indistinguishable
from a request tab's inside a collection's own state, which the autosave and snapshot paths also read.

**An editable document view.** Making the YAML pane editable is a small change to the component and a
large change to the spec — it needs the lossless round-trip rules of 001 §15 and
`.claude/rules/dsl-changes.md` to hold against a UI that writes, plus a decision about what happens
while text is mid-edit and unparseable. That is the builder's problem, and taking it on here would
mean shipping half of it.

## 14. Open questions

The three raised in review are resolved into the body: the workspace-scoped environment tier
(§7.2), run lifetime across quit and restart (§4.2, §10), and how a run is surfaced without its tab
(§4.1). Two of them changed 001 rather than only 002 — workspace and global environments are one
mechanism where §5.1 described two, and §14.5 needed a `run.json` at run start or a run has no
identity until it finishes. Both are applied; §11.4 records what moved.

A later audit raised four more. **Three were 001's to answer and are now answered**, all three the
way this spec needed:

- **`StepResult` carries schema-validation outcomes** — 001 §13.2 gains a `validation` field
  separate from `assertions[]`, so §9's **Validation** tab reads the result and 002-C U4.10 holds as
  written, with the outcomes surviving capture being disabled.
- **`step:start` / `step:end` fire for sub-flow internals**, which appear as ordinary members of a
  flat `steps[]` with namespaced ids (001 §13.2). §5.4's inline expansion populates live rather than
  from a capture after the run, and 002-C U1.8 stands.
- **`describeFlow` resolves remote `apis:`** through the `ReadSpec` port added in 001 §13.2, now in
  §11.1's signature. A flow binding an `https://` document returns a graph, not diagnostics.

One remains, and it is this spec's own:

**Can `readCapture` enforce scope-root containment?** §11.2 claims containment is enforced "before
the port is called" for history reads, but `ReadCaptureOptions` carries `dir` with no `scopeRoot`
to check it against — unlike `ListRunsOptions`. Either the option grows a scope root, or containment
holds only for `listRuns` and a `dir` handed in from the renderer is trusted.

Details left to implementation, as they do not change a contract:

- The exact indicator treatment on a sidebar row and tab label (§4.1), which is styling.
- Whether the graph's data-edge toggle (§5.3) remembers its state per flow or per app.

## 15. Future work

Deferred deliberately. As in 001 §19, this is distinct from §3 (outside the feature's purpose) and
§13 (considered and decided against): these are wanted, but not now.

| Item | Why not now | What it needs |
|---|---|---|
| **The flow builder** | 001 §3's judgement that the UI is trial-and-error applies hardest to editing; the viewer is the cheaper half and informs it | Its own spec: an editing model that round-trips losslessly per 001 §15, and an answer for unparseable intermediate states |
| **Running one step or a subgraph** | 001 defines execution for a whole flow; a subset needs semantics for what its dependencies resolve to | A definition of partial-run state — probably seeding `steps.*` from a previous run's capture, which is a format question, not a UI one |
| **Diffing two runs** | §10 makes both runs readable, which is the prerequisite; what to diff (bodies? outputs? timings?) is unclear without watching people use it | A diff model over `StepCapture`, and evidence about which comparison people reach for first |
| **`--dry-run` in the app** | 001 §7.1's dry run prints the effective request per step and is the tool for seeing a spec change's blast radius; the engine already supports it | A run mode that materializes without dispatching, and a pane that shows the request tab of §9 with no response |
| **Pan, zoom and a minimap** | Flows are tens of steps and the graph scrolls; no real flow has needed a viewport yet | A flow that does — which is also the evidence for reconsidering §13's graph library |
| **OS-level run notifications** | §4.1 covers the ambient case; an OS notification is a third surface needing a preference, and no Electron `Notification` usage exists in the app to build on | Evidence that flows run long enough for people to leave the app during one |
| **Cross-run trends** | §3 excludes analytics; `.bruno-runs/` retention (default 10) is too short a window to trend over anyway | A durable run store, which is a different feature from reading artifacts |
