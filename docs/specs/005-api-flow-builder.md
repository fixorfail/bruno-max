# 005 — API Flow Builder (edit in the graph)

**Status:** **Implemented.** The design [002](./002-api-flows-ui.md) §15.2 deferred as *the flow
builder*, built on §9's writer; every 005-C scenario has a test, and `builder-registry.spec.js`
tracks which cite their id. §11 holds what was considered and decided against; §12 what is still
open; §13 what is wanted next.
**Owner:** Jake Campbell
**Last revised:** 2026-09-11

The editing half of [002](./002-api-flows-ui.md): open a `.flow.yml` and change it where it is drawn.
Add a request from the graph, click a step to edit it in the pane below, bind an API from the legend,
and save — with the file on disk still reading like something a person wrote. Reviewing a run is the
one state in which the graph is not editable.

Its companion, [005-C](./005-api-flow-builder-conformance.md), holds the scenarios this behavior was
derived from, written to be implemented as Playwright specs and as the engine's own round-trip tests.

---

## How to read this

001 and 002 are the prerequisites. This document cites both constantly and redefines neither: the
format, the graph, the run view, the draft mechanism and the IPC discipline are theirs, and where a
statement here looks like it invents a rule, it is quoting one. What is new is one thing — **the
engine can now write a step, and the app can ask it to** — and everything else follows from where that
capability is put.

| If you are… | Read |
|---|---|
| **Using the feature** | §4 when a flow is editable · §5 the canvas · §6 the step editor and the flow's settings · §8 running |
| **Implementing the renderer** | §4–§8 in order, then §9.4 for the channels you call |
| **Implementing the engine additions** | §9 entire — it is the only part that changes `@bruno-max/flow` |
| **Reviewing a proposed change** | §11 first. If the option is already there, the argument has been had |
| **Judging whether it's ready** | §12 open questions · §13 future work · the companion's §8 |
| **Re-checking after an upstream merge** | §10, and the companion's R5 |

### Sections

| | |
|---|---|
| **§1–§3** | Problem, goals, non-goals |
| **§4** | When a flow is editable, and what says so |
| **§5** | The canvas — adding, removing, connecting, the legend |
| **§6** | The step editor — the pane, its tabs, what each one writes, and §6.8's pane over the flow's own `config:` |
| **§7** | The draft — one buffer under two surfaces, saving, undo |
| **§8** | Running from the designer |
| **§9** | **The engine boundary** — the writer, the read, operations, IPC, what 005 changed in 001 and 002 |
| **§10** | Fork isolation and the manifest delta |
| **§11–§13** | Rejected alternatives, open questions, future work |

### The contracts

Most of this is reasoning about presentation, which can be reworked freely. These parts are
commitments something outside this feature depends on:

| Contract | Where | Consumed by |
|---|---|---|
| `applyFlowEdits`, the `FlowEdit` union, `FlowEditResult` | §9.1 | `bruno-electron`; any future host that edits a flow |
| `readFlowEditModel`, `FlowEditModel` | §9.2 | The renderer's step editor |
| `listOperations`, `listFlowOperations`, `OperationSummary` | §9.3 | The operation picker |
| **The round-trip guarantee** — what survives a structured edit, byte for byte | §9.1 | Every committed `.flow.yml` |
| IPC channel names | §9.4 | The renderer, and the e2e suite |
| Upstream files touched | §10 | Re-checked after every merge from upstream |
| `data-testid` on the affordances | companion §2 | Every Playwright spec in `tests/flows/designer.spec.ts` |

Everything 001 and 002 already fixed — the format, `describeFlow`, the draft in
`sources[pathname]`, the auto-save rule, the run view — remains theirs and is cited, not restated.

---

## 1. Problem

002 §1 describes why a flow is worth *seeing*: the graph is the artifact, and reading it in text is
the wrong medium. Everything that document delivers stops at reading. Changing a flow means the raw
YAML tab (002 §4.3), which is deliberately the non-standard way in — a tab reached from a menu,
marked as an editor, for the edit the flow's own surfaces do not cover. Since 002 shipped, that has
been every edit.

What that costs is visible on the first flow anyone writes from nothing. 002 §4.1c's form writes a
file with no `steps:`, because the app cannot guess a step; the author then opens the YAML tab and
types one, from memory of a format whose step block has twenty-two keys, with the spec's own worked
example in another window. The graph above the editor redraws as they type, which is the one thing
that makes it bearable — and it is also the tell: the drawing is right there, doing nothing.

Three things follow from making it do something, and they are the whole of this spec:

- **A step is a bound operation, not a request.** 001 §5.3 requires `operation: alias#operationId`
  (or `uses:` a sub-flow), resolved against the documents in the flow's `apis:` block. "Add a request"
  is therefore "pick an operation from an API this flow binds", which is a lookup — the shape of
  thing a picker answers and a text editor does not.
- **The graph is a view of the document, and stays one.** 002 §5.2 makes the engine decide ranks and
  §11.1 makes it decide structure; the renderer draws what it is told. An editable graph does not
  change that. An affordance on the canvas writes to the document, the engine describes the document,
  and the drawing follows — never the other way round, because a graph the renderer moved on its own
  would be the one drawing that can disagree with what runs.
- **The file is a committed, hand-edited artifact**, and 001 §15 requires a writer to leave it one.
  Nothing wrote a flow before this — 001 §18 records the question as open for that reason — so the
  builder answers it: the engine's writer edits a parsed document and re-emits it, and what a person
  did not touch is bytes the writer never visits.

## 2. Goals

1. **Opening a flow is opening it to edit.** The flow tab of 002 §4.2 is editable whenever it shows
   the flow as it stands. No second tab, no mode to enter.
2. **Add a step from the graph** — pick an operation from the flow's bound APIs, or a library flow
   to invoke, and the step appears where it was asked for, wired by the implicit sequence 001 §9.1
   already defines.
3. **Edit a step where it is drawn** — select a node and the pane below the graph edits that step:
   its request, its dependencies, its outputs, its assertions, and the rest of 001 §5.3.
4. **Bind an API from the legend**, which is the surface that already names the flow's APIs.
5. **Save a file a reviewer can read.** A structured edit changes the lines it means to and no
   others: comments, key order, anchors, blank lines and every key this build does not understand
   survive.
6. **One draft.** The designer and the YAML tab edit the same buffer; the dirty state, the auto-save
   rule and the divergence handling of 002 §4.3 are not duplicated.

## 3. Non-goals

- **A step that is not an operation.** Format v1 has no spec-less request, and this spec does not add
  one. §13 records what it would take.
- **Moving nodes.** Node positions are the engine's ranks (002 §5.2) and exist nowhere in the file.
  A node is placed by what it depends on, and changing where it is drawn means changing that.
- **Editing the file's non-step blocks in forms** — `config:`, `authProfiles:`, `vars:`, `shared:`,
  `stages:`, `params:`, `exports:`, `dataset:`. Each is a block the YAML tab already edits, none is
  what a canvas is for, and 002 §4.4 covers `meta:`. `apis:` is the one exception, because the
  legend is already its surface; and `shared:` gains an entry when a step publishes to a slot it
  does not declare (§6.2), which is a consequence of an edit to the step rather than a form for the
  block.
- **Editing a sub-flow through its `uses:` node.** The node is a container (002 §5.4); its steps
  belong to another file, which has its own tab.
- **Editing a stored run's flow.** 002 §10 pins a run to the graph it executed; that graph is a
  record.
- **A second writer.** The app assembles no YAML. §9.1 is the reason.

## 4. When a flow is editable

**The flow tab is editable exactly when it shows the flow as it stands, and read-only when it shows a
run.** 002 §4.2's tab draws one of two things: the file's own graph, or the graph a run executed —
live while it executes, stored once it is selected from the history. The first is a document and can
be changed; the second is a record and cannot. The predicate is the one 002 §5.6 already uses to
decide whether the Inputs panel takes typing: a run is open, or it is not.

```
editable  =  no run is open in the tab
          ∧  the flow's text has been read
          ∧  the engine has not said the text does not parse
```

The second clause exists because the designer edits *text* (§7) and cannot act before it has it. The
third is 002 §4.3's rule for the YAML tab's auto-save, applied to every affordance: an edit to a
document that does not parse has no document to edit, and the engine's writer refuses it (§9.1) — so
the controls say so first rather than offering an action that will be declined. **Not yet answered
counts as not yet valid**, in the direction 002 §4.3 already chose: between a keystroke in the YAML
tab and the engine's reply, the canvas withholds its affordances rather than acting on text nobody
has checked.

**A live run is read-only, and so is the finished run it becomes.** A run in flight paints node
states keyed by step id onto the description recorded at its start (002 §8.2, §10). Inserting or
deleting a step under that would leave a node wearing a status that belongs to a step no longer in
the file, or a new node reading *pending* forever because nothing will ever report it. When the run
ends the tab still shows it — its results are what the reader is looking at, and closing them on
arrival would discard the thing the run was for — so a finished run is read-only for the same reason
a stored one is, and **returning to `current` in 002 §10's selector is what returns the graph to
editing**. The alternative, drawing the draft with the run's statuses overlaid where the ids still
match, is coherent and is rejected in §11: it asks the reader to hold two flows in their head in the
minute they are least able to.

**The state is said in words, in the toolbar.** Two things a designer can be, and each is stated:

| State | Reads | Control |
|---|---|---|
| Editable | The draft's save state — *Saved*, *Unsaved changes*, *Saving…*, or the error — in 002 §4.3's words, because it is 002 §4.3's draft | Save, when auto-save is off (002 §4.3's rule, unchanged) |
| Read-only | Why — *reviewing a run from …*, *running — editing resumes when the run is closed*, or *the file does not parse* | **Edit flow**, which closes the run (`runClosed`) and is the same act as choosing `current` |

The save state is stated here as well as in the YAML tab because a designer may never open the YAML
tab, and 002 §4.3's divergence notice — *the file also changed on disk* — is the one message that
must not be missed by whoever is about to overwrite it.

## 5. The canvas

002 §5's drawing, unchanged in what it draws and how, with affordances that appear only when §4 says
the graph is editable. Every affordance writes to the document through §9.1 and nothing else; the
drawing never moves ahead of the engine's description of what was written. On a fast machine the gap
between an edit and its redraw is a frame; on a slow one the affordance that was used shows a pending
state until the description arrives. That gap is stated rather than hidden, because the alternative —
painting the node the renderer *expects* — is the renderer deriving structure, which 002-C R4 forbids
and `noYamlParser.spec.js` enforces.

### 5.1 Adding a step

**A `+` sits on every sequence edge, before the first step and after the last.** 002 §5.3's
implicit-sequence edges are the drawing of 001 §9.1's rule — a step with no `depends` follows the
one above it in the file — so the midpoint of one is the one place on the canvas that means *between
these two*. The control after the last step means *at the end*; the one before the first — the step
`steps:` lists first — means *a new first step*: the step spliced there has nothing above it to
follow, and the step that was first now follows it by the same rule, so becoming the new head of a
flow is one pick rather than an insert and a rewrite of the old head's `depends:`. On a flow with no
steps at all the one control is drawn alone in the middle of the empty graph, with the words: *Add
the first request*.

**Choosing one opens the operation picker.** The picker lists the flow's bound APIs down one side and,
for the chosen one, its operations — method, path, `operationId`, summary, tags — searched by a fuzzy
match over all of them. It is the same list §9.3 computes, which is the engine's list: an operation
the engine cannot resolve is not offered as one it can. Two markings matter:

- **`deprecated`**, from the document, drawn as such and still selectable. The author knows their API.
- **`ambiguous`** — the `operationId` is declared twice, so 001 §6.5 refuses a reference to it.
  Listed, marked, and *not* selectable: the operation exists, the name is the problem, and hiding it
  would send the author looking for an operation they can see in the spec. The marking says what to
  fix. A method-and-path reference to the same operation is offered beside it, since 001 §6.1's
  fallback is exactly what an ambiguous id needs.

**Picking one writes two lines.** The step is spliced into `steps:` at the position the `+` named —
after step X, or at the end — with an `id` and an `operation:`, and nothing else:

```yaml
  - id: create_payment
    operation: payments-api#createPayment
```

No `depends:`, because the position is the dependency: 001 §9.1 links a step with no `depends` to the
one above it, and re-points the one below it — if *it* has no `depends` — at the new one. Where the
step below declares an explicit `depends`, nothing rewires and the new step is a leaf, which is
correct and which the graph shows. This is 002-C U1.2's already-tested behaviour arriving from the
app rather than from a hand edit, and it is why inserting a step is a two-line diff and not a
rewiring of its neighbours.

**The new step is selected.** It is the one the author is about to fill in, so §6's editor opens on
it without a second click — by the id the engine derived and reported (§9.1's `inserted`), since
nothing in the renderer could know it.

No `body:`, `query:` or `headers:` either, though the engine could seed them from the spec's
examples. 001 §7.1 already seeds the *request* from the spec at run time, so a body written here would
duplicate what the engine supplies; and a multi-line diff nobody asked for is the wrong default for
a file under review. §6.7's *Seed from spec* control writes it when it is wanted.

**The id is derived from the `operationId`, and is editable.** 001 §5.3 restricts an id to
`^[a-zA-Z_][a-zA-Z0-9_]*$` — no `-`, because it is subtraction in the expression dialect. The
derivation is snake case of the `operationId` (`createPayment` → `create_payment`,
`getOrderByID` → `get_order_by_id`), any run of characters outside the class becoming one `_`
(`create-payment` → `create_payment`), a leading digit prefixed with `_`, and a name already in the
flow suffixed `_2`, `_3`. For a method-and-path
reference it is the method and the path's static segments (`POST /payments/{id}/refund` →
`post_payments_refund`). A `uses:` step is named for the file it invokes — `./shared/login.flow.yml`
→ `login`, a `workspace:` prefix and the directories being where the library lives rather than what
the step does. One rule, in the engine (§9.1's `step.insert` takes the reference and derives the id
when none is given), so two flows created from one spec name the same operation the same way. The
overview tab (§6.2) is where it is changed.

**The picker's list is the draft's.** A binding added on the legend (§5.5) and not yet saved offers
its operations at once, because §9.3 describes the draft's text exactly as 002 §11.1's `describeFlow`
does. A flow that binds nothing and can reach no library is told to add an API on the legend, rather
than shown an empty rail.

**A library is offered beside the APIs.** The rail's last entry, after the aliases, is *Libraries*:
every flow in the workspace that declares `meta.library: true` (001 §12.5) and that this flow could
`uses:` — one under its own scope root, reached by a relative path, or one under the workspace root,
reached by a `workspace:` path (001 §12.2). The flag is read where 002 §4.1's sidebar reads it, off
the watcher's tree entry, so the list costs no describe. A flow is never offered to itself, since a
step invoking its own file is the cycle 001 §12.4 refuses. Picking one writes the same two lines,
`id` and `uses:`, the path relativized by the host (§9.4); `with:` is not seeded, for the reason §13
gives. The entry is not offered where the picker is changing an existing step's operation (§6.2),
because a library is not an operation and 001 §5.3 lets a step declare only one of the two.

### 5.2 Removing a step

**A delete control on the selected node**, and the Delete key while the graph has focus and a step is
selected. The step's entry in `steps:` is removed and nothing else is touched; the implicit sequence
closes over the gap on its own, exactly as it opened for an insert.

**What references the step is left to the engine.** A `depends: [removed]` on another step, a
`{{steps.removed.x}}` in a body, a `shared:` slot it wrote to — each is now a dangling reference, and
each is a diagnostic 001 §14.3 already reports and 002 §6 already draws on the node that carries it,
within one describe of the edit. Rewriting the other steps to repair them would be a second edit the
author did not ask for, made in places they are not looking, and it would have to guess — remove the
dependency, or re-point it at the step above? — where a diagnostic says what happened and lets them
decide. §12 keeps a reference-rewriting rename on the list for later.

**Removing the last step removes the `steps:` key**, restoring the file to the shape 002 §4.1c writes
rather than leaving `steps: []` — the two mean the same to the engine, and the create form's is the
one a person would have written.

### 5.3 Selecting a step

002 §9's rule stands: clicking a node selects it, clicking it again clears the selection, and the
pane below follows. What the pane *is* depends on §4: the step's run record when a run is open, the
step editor (§6) when the flow is editable. The selection itself is the same state — `selectedStep`
keyed by flow — so a step selected while reading a run stays selected when the run is closed and the
editor opens on it.

### 5.4 Connecting steps

**Every node has an out-port on its right edge and an in-port on its left, drawn only when the graph
is editable.** Dragging from one step's out-port to another's in-port writes the source into the
target's `depends:` — appended to a bare list, or added as `{ on: <source> }` to an `all:` or `any:`
mapping, whichever form the target already uses. A target with no `depends:` gains
`depends: [<source>]`, which turns its implicit dependency into an explicit one and the graph shows
the change of kind (002 §5.3).

**A pair the sequence already joins offers no drop.** Writing `depends: [above]` on a step that
already follows `above` implicitly is a no-op diff; the port declines the drop and the engine's
`changed: false` (§9.1) is the backstop if something reaches it anyway.

**A declared edge can be removed from the edge.** Hovering a `depends` edge in edit mode shows a
control that removes that entry; removing the last entry deletes the `depends:` key, and the step
falls back to the implicit sequence. Sequence edges carry no such control — there is nothing in the
file to remove.

A cycle is not refused here. The engine's `cyclic-dependency` diagnostic (001 §9.1) is anchored and
reports it within one describe, and refusing at the port would mean the renderer computing
reachability, which is a rule 002-C R4 keeps in the engine.

### 5.5 The API legend

002 §5.1's legend is where a flow's APIs are already named, and it becomes where they are managed. In
edit mode:

- **`+ API`** opens a dialog: an alias, a document, and optionally the `auth` profile and `color`
  001 §6.2 puts on a binding. The document is chosen from the workspace's API Specs, paired with
  what is loaded exactly as 002 §4.1c's create form pairs them (`matchLoadedApiSpecs`), and the alias
  is derived from the document's filename by the same rule and shown for the same reason — it is what
  every step will type. The dialog writes one `apis:` entry through §9.1's `api.add`; the path is
  relativized to the flow's directory by the host, as 002 §4.1c's create does.
- **Each entry carries a menu** — edit the binding, rename the alias, remove it. Removing a binding a
  step still references is refused with the steps named (§9.1's `api-in-use`), because unlike a
  dangling `depends` there is no diagnostic anchored where the author is looking: every step that used
  the alias would go red at once, and the legend row that caused it would be gone. **Renaming an
  alias renames it where the steps say it** — every `operation: <alias>#…` is retargeted in the same
  edit. This is not the reference rewrite §5.2 refuses for a step id: an id can be meant or not meant
  by any `steps.<id>` in a body or a script, where an alias has exactly one place a step names it,
  the prefix of `operation:`, so retargeting is reading rather than guessing — and leaving it would
  turn every step of the API red for the rename of a label.

**In edit mode the legend lists what the file declares, not what the drawing uses.** 002 §5.1
deliberately lists only the bindings a step calls — a legend row for a service no box wears is a
colour the reader goes looking for — and draws no legend at all when there are none. Both rules are
right for reading and wrong for editing: a binding just added would vanish the moment it was written,
because no step uses it yet, and an empty flow would have nowhere to add its first. So an editable
legend iterates the description's declared `apis` (001 §6.2, in file order) merged with the used set,
draws an unused binding with no swatch — 002 §5.1's rule that a swatch marks a tint the drawing
actually has — and is drawn with only `+ API` when the flow declares nothing. The read-only legend is
002's, unchanged.

This is the one place an API is added. Not in the step editor, where a picker with an "add an API…"
entry would put a file-level decision inside a step-level form, and not in the toolbar, which is the
run's.

## 6. The step editor

### 6.1 Two panes, one seam

002 §9's step detail pane reads a run; this pane edits a step. They are two components, because they
share no state — one is a machine over attempts and captures, the other over a draft and a pending
edit — and what they share is chrome: the split the graph hands a height to, the header row, the tab
strip. That chrome is one component both render into, so the pane opens and resizes the same way
whichever it is, and `flow-step-detail` stays the root of the run pane for every test that already
reaches it.

Which one renders is §4's predicate. A reader who wants both after a run — *what did this send*, then
*let me fix it* — closes the run and the same selection opens the editor. Showing both at once is
§13's.

### 6.2 The tabs

One tab per concern of 001 §5.3, ordered as the block reads. Each writes the keys it names and no
other; each reads the step **as written** (§9.2), never as normalized, so a field the file leaves out
is shown as left out rather than as its default.

| Tab | Edits | Notes |
|---|---|---|
| **Overview** | `id`, `name`, `operation`, `meta` | The id per §5.1's rule; the operation reopens the picker. `meta` is an open mapping (001 §5.3) edited as key/value rows |
| **Scripts** | `pre`, and the flow's `functions.use` | 001 §8.7's values computed before the request, one named code editor per entry — the format's pre-request script, which is a set of named values read as `{{pre.<name>}}` rather than one script that mutates the request. A value is written once it has a name; the mapping is committed whole and unset when emptied. Above them, the flow's **shared scripts** — 001 §8.6's `functions.use:`, the files every script in the flow may call into — listed as written and added to from 002 §4.5's `flows/scripts/` files under the flow's scope root, each through §9.1's `functions.use`/`functions.unuse` with the path relativized by the host (§9.4). The block is the flow's, so the list is the same on every step; it lives on this tab because a script's helpers are what a script's author needs to see. Not offered on a `uses:` step (001 §12.4) |
| **Request** | `pathParams`, `query`, `headers`, `body` / `bodyFile`, `contentType`, `auth` | Key/value tables for the first three; the body per §6.7; `auth` a select over the flow's `authProfiles` names plus the connector-file ones the description knows; `contentType` a select over the operation's declared media types, shown only when there is more than one (001 §7.5) |
| **Flow** | `depends`, `when`, `retry`, `timeout`, `maxDuration` | `depends` as the list §5.4 also writes, with each entry's `status` and the `all`/`any` join; `when` as 001 §9.3's conditions, one row each with the kind it is — an expression in a field, a script in a `CodeEditor` — since held in one box the script form was reachable only by typing its JSON, and a lone expression stays the bare string §9.3 also accepts; `retry` as its fields, `shouldRetry` in the same `CodeEditor` §8.2's other script positions get — a predicate is a function, and every script in this editor is written in one |
| **Outputs** | `outputs`, `shared` | **A row names its source**: 001 §8.1's four `from` values and `script`, from the engine's vocabulary (§9.2). An output is a name and a source, and the format's shorthand — where a bare value is a body path — makes a one-column table a trap: a script typed into it is a string, the engine reads it as a path, the path selects nothing, and every output is undefined with nothing said. A script is written **under the table**, in a single `CodeEditor` that follows the focused row — a step publishing four of them is a table of four rows and at most one editor, and a step nobody is editing is a table and nothing else. A cell sets the width a value may use and moves every row around it as its height changes, which is what a function does while it is typed. Focus rather than selection, because the editor is part of what has focus rather than a pane opened beside it: it appears when a script row is entered and goes when focus leaves the section, so moving from the row into the editor keeps it. The editor is headed by the output it belongs to, and the row keeps the line its script starts with. The box grows with the script, by §6.7's measurement. A status row has no path to type and its cell is disabled; a `pre:` path equal to the output's own name is omitted, which is the block's own default (§8.7); a body path is written as the shorthand rather than the long form, and a row nobody touched keeps the form the file wrote it in. A note under the title gives the form everything reads an output by — `steps.<this step's id>.<output>`, with the step's own id rather than a placeholder, since the bare name resolves to nothing in an assertion without saying so (001 §8.1, §10.2). Outputs as name → path rows, with the `from`/`path` form when it is written that way; `shared` as the slot mapping. A `uses:` step lists its library's `exports:` first, read-only, each as the `steps.<id>.<name>` a caller reads and the source the library gives it — off the description's node (002 §11.1's `exports`), never off the library's text — because those are what the step's own `outputs:` and `shared:` name (001 §12.4) and the author cannot see them without opening the other file. A library that could not be read says so rather than listing nothing |
| **Assert** | `assert` | `expr · op · value` rows, `op` from the engine's operator vocabulary (§9.2) — the same three columns the collections pane edits an assertion as, over this dialect. A row is written back as the line or the mapping the file held until one of its three parts moves, so opening the tab reformats nothing; a bare expression reads as `isTruthy` and goes back bare. An operator taking no operand leaves its row's value cell empty and disabled, and one the engine does not list is still shown rather than silently re-pointed |
| **Settings** | `failOnStatusCode`, `failOnUnresolved`, `validateRequest`, `validateSchema`, `strictSchema` | Tri-state, §6.5 |

**A slot a step publishes to is declared.** A `shared:` entry on a step names a slot, and 001 §9.1
has the flow declare its slots in a root `shared:` block. The engine reports nothing for a write to
a slot no block declares — the step publishes, the graph draws no slot to receive it, and only a
*reader* is told the slot is undeclared — so an author who typed a slot in the Outputs tab would
have to open the YAML to finish the thought. The writer (§9.1) therefore declares it as part of the
same edit, in the form the block already has: a name appended to the list form, a
`{ writers: all }` entry in the mapping form, and for a flow with no block the list, placed where
§5.2 reads it. Nothing is ever taken back: a slot nobody writes stays legal, and which slots a flow
declares — and which are `writers: any` — is the author's, edited in the YAML tab like the rest of
the block (§3).

A `uses:` step shows Overview (with `uses` in place of `operation`, as text, and `with` as key/value
rows), Flow, Outputs and Settings, because those are the fields 001 §12.4 allows it; Request and
Assert are not offered rather than offered empty. The sub-flow's declared params are not looked up to
populate `with` — that is describing another file, and §13 has it.

The tables are the app's own editable table, which takes rows and reports changes and touches no
store; the code editors are the app's own, in the mode the content type names, and are the ones 002
§9 already renders into this split. Upstream's request-pane tabs are not reused, for the reason 002
§12 gives for every upstream component: they are bound to a request item in the collection tree and
to the tab's own pane state, and the one place upstream reused them elsewhere paid for it in a
duplicated reducer file longer than this spec.

#### 6.2a Which fields take code, and which kind

001 §8.2's script positions and §10.2's expression positions look identical in a form and are not the
same place. A script — a `pre:` entry, an output's `script:`, `retry.shouldRetry`, a `when:` written
as one — runs through the engine's script runner, which composes the flow's shared functions (§8.6)
around it, so they are in scope by name. An expression — an assertion's `expr` and `value`, a `when:`
written as one — is evaluated on its own, and a shared function called there resolves to nothing.

Nothing about the two boxes said so, and the failure is quiet in the direction that matters: §10.2
treats a value that could not be evaluated as an ordinary failed assertion, so a shared function in
an assertion reads as a test that failed rather than as a call that was never in scope.

So each field that takes either carries a marker beside its label naming which it is, and the
sentence — including what to do instead, which is to compute the value in an output and assert on
that — is the marker's payload, as its accessible name and in the app's own tooltip, which appears on
hover with no delay. Not the `title` attribute: the browser waits about a second before showing one,
which is longer than anyone scanning a form will hover, and a hint that behaved differently from
every other hint in the window would read as a different kind of thing. The positions marked are
the four script ones above and the expression ones on the Assert and Flow tabs; a `shared:` slot is a
name rather than a value to compute, and carries none.

### 6.3 Committing a field

**A field commits on blur, on Enter, or after a pause in typing — whichever comes first — and a commit
is one edit through §9.1.** Every keystroke is a change to the document in principle, and every
change to the document is a parse, a mutation, a serialize and a describe; sending thirty a second
would put the round trip in the caret. So a text field holds its own value while it is being typed
in and hands it over when the typing stops. That is the whole of what is local: the moment the edit
is applied, the field reads back from the model the engine returns, and the graph is redrawn from
the engine's description of the text that was written. Nothing in the pane or on the canvas is
painted from what the renderer *expects* the engine to say.

**A table row commits the same way, per cell**, and adding or deleting a row commits at once.

**An edit the engine refuses is shown on the field**, in the engine's words, and the field keeps
what was typed so it can be corrected: an id that collides, a key the format does not have, a value
the schema rejects (§9.1's refusals). The document is unchanged, which the save state confirms.

### 6.4 Opaque fields

**A field the editor cannot round-trip is shown, not edited.** Two kinds:

- **A key this build does not model** — a flow written by a newer Bruno, which 001 §15's forward
  compatibility says must open and must not lose the key. The editor lists it by name under
  *Not editable here*, and 001 §15's guarantee is kept by construction: the writer visits only the
  keys an edit names (§9.1), so a key no edit can name is bytes it never touches.
- **A value carrying a local tag** — `body: !file ./fixture.json`, an output suppressed with `!...`
  (001 §5.4). The tag is structure the form cannot show without inventing a widget for it, and
  re-emitting it wrong destroys a fixture; §9.2 reports the key as opaque and the writer leaves it
  alone. Listed under the same heading, with the tag shown.

Each opaque row carries one control — *Open in YAML* — which opens 002 §4.3's tab anchored at that
key's line, through the same `documentAnchored` path 002 §6's diagnostics use. Two paths to the same
line that computed it separately would eventually disagree.

### 6.5 The flags are tri-state

`failOnStatusCode`, `failOnUnresolved`, `validateRequest`, `validateSchema` and `strictSchema` each
have a default in 001 §5.2 *and* a flow-level setting under `config:` that a step inherits. **An
absent key does not mean the default; it means whatever `config:` says.** A two-state checkbox —
`true` when ticked, deleted when not — silently overrides a flow-level `false` on tick and silently
reverts to it on untick, in the one place where a change alters what a flow *does* without changing
what it *draws*. Each flag is therefore a three-way control — *inherit* · *on* · *off* — where
*inherit* deletes the key and the other two write it, and the inherited value is shown beside
*inherit* so the author knows what they are inheriting. The same rule applies to `timeout`, `retry`
and `contentType` where `config:` supplies a default: a blank field means inherit, and the inherited
value is shown as its placeholder.

### 6.6 Ids

Renaming a step's id writes the new id and nothing else. Every `{{steps.<old>.…}}` in the file, every
`depends:` naming it and every `stages:` entry pointing at it now dangles, and each is a diagnostic
the engine anchors on the line that has it (001 §14.3) within one describe. The editor shows the
count beside the id field after the rename — *3 references to the old name* — with each one opening
the YAML at its line. A rename that rewrote them is §13's, and the reason it is not here is the
reason §5.2 gives for a delete: an edit made where the author is not looking, on a guess about which
occurrences mean this step.

### 6.7 The body

The body is a code editor in the mode the operation's request media type names, over the text of
what the file holds. A structured YAML body (`amount: 9900`) is shown as the JSON it will be sent as
and written back as YAML; a string body is shown and written as the string. Which of the two a
field *is* is read from the document (§9.2) and preserved on write, so an author who wrote a JSON
string does not find it turned into a mapping.

**Seed from spec** is a control beside the editor that asks the engine for the operation's request
example — 001 §7.1's `requestExample`, resolved the same way the run resolves it — and replaces the
body with it. An explicit act, for §5.1's reason: a seed is a decision about the file, not a default
for it. When the operation declares no example, the control says so rather than seeding from the
schema, since a schema-derived body is a guess with the shape of a fact.

**The box is the size of what is in it.** A body is the one field on any tab with no natural height:
a schema-shaped payload is however many lines the API asks for, and a box fixed at twelve of them
shows six of a twenty-line body while reserving twelve for a two-line one. So it follows its content
between a floor of about three lines and a ceiling, and scrolls inside itself past the ceiling.

The same measurement sizes the Outputs tab's script editors, which is why it is a hook rather than
this pane's own code.

**Measured from what the editor drew, not from the text.** `lineWrapping` is on, so a minified
payload pasted on one line is one `\n`-delimited line and several rows on screen — the case a line
count gets most wrong, and the one most likely to arrive by paste. What is observed is
`.CodeMirror-sizer`, the node CodeMirror sizes to the document, which answers for wrapping, folds and
the font the preferences chose; none of those is something this pane can compute. Sizing the box
resizes the editor inside it, which is a resize the observer sees, so a target that has not moved is
not applied and the second pass settles rather than rings. A host with no `ResizeObserver`, and the
first paint before anything is drawn, get the stylesheet's height.

`bodyFile:` is a path field, exclusive with `body:` (001 §5.3); choosing one removes the other. A
`body: !file` is opaque (§6.4).

### 6.8 The flow's own settings

The sheet below the graph shows the selected step. With nothing selected it shows the flow: 001
§5.2's `config:`, in the same chrome, through §9.1's `config.patch`.

It is here rather than in a dialog because of what §6.5 leaves dangling. Each of the five flags is
*inherit · on · off* on a step, where *inherit* means **whatever `config:` says** — and until this
pane existed, what `config:` said was visible only in the YAML. A tri-state pointing at a value the
author cannot see is three states of which one is a rumour.

Two tabs, by what the setting governs: the five flags, and **every run** — `baseUrl`, `concurrency`,
`maxRunDuration`, `cleanupGrace`, `redactHeaders`, `capturePreviewBytes`, and the flow-wide `retry`
defaults — `shouldRetry` among them, in the same `CodeEditor` §8.2's other script positions get,
since it is the predicate every step that declares none inherits. Plural, and named that way deliberately: nothing in `config:` is about a particular run,
and this strip sits a few pixels from a run selector where *the run* means the one on screen. `redactHeaders` is one comma-separated line, as `meta.tags` is in 002 §4.4's dialog, for
that field's reason: a row of chips would be a second way to read what the YAML tab shows on one.

**The flags read *default* · *on* · *off* here, not *inherit*.** A step's silence points at a value
one level up; a flow's has nothing above it and means 001 §5.2's own default, so the state is named
for what it does and the default is spelled out beside it — *default — on*. A field cleared unsets
its key, never writes the default out.

**Clearing the selection is what opens it**, so the drawing's background clears it and so does
Escape. Selecting the selected node again already did — silently, which made this pane's predecessor,
the empty half of the sheet, reachable only by a gesture nothing announced.

This is not `config:` entire. `vars:`, `stages:`, `params:`, `exports:`, `dataset:`, `shared:` and
`authProfiles:` are the YAML tab's until a surface is argued for each; what is here is the block the
step editor already refers to.

## 7. The draft

### 7.1 One buffer

**The designer edits 002 §4.3's draft.** The text of the flow lives in the store keyed by path
(`sources[pathname]`), it is what the YAML tab edits, and it is what the designer edits — through the
engine rather than through a caret, but the same string. Opening a flow's tab reads its text, as the
YAML tab already does when it opens. A structured edit sends that text to the engine with the edit,
receives the text with the edit applied (§9.1), and puts it back where the YAML tab's keystrokes go.
Everything 002 §4.3 built on that string holds unchanged and is not restated: dirty is
`content !== saved`; auto-save follows the app's preference and writes only a draft that parses; the
save state is said in words; the file changing underneath is taken by a clean editor and reported by
a dirty one.

**The engine describes the draft, and the flow tab draws that description.** 002 §4.3 kept two
descriptions of one flow on purpose — the file's, which the run view drew and a run would execute,
and the draft's, which the YAML tab drew — and the argument was that folding the draft into the run
view would redraw it from text no run can reach. That argument is now the *reason to draw the
draft*: the flow tab is where the draft is being made, and a canvas that showed the last saved graph
while its author added a step to it would be drawing the wrong document. So: **when a run is open the
tab draws the run's description, as 002 §10 says; otherwise it draws the draft's.** The file's own
description keeps its place in the store and its meaning — it is what `renderer:flow-run` executes —
and §8 is what keeps the two from being different when it matters.

Two tabs open on one buffer must not describe it twice. A structured edit describes at once — it is
one complete document, and the 300 ms 002 §4.3 waits exists for typing — and the YAML tab's own timer
would fire on the same text a moment later. The describe is skipped when the engine has already
answered about exactly this text, which is a comparison the store already keeps.

### 7.2 The edit that arrived late

An edit is applied to the text as it was when the edit was sent, and the answer arrives after a
round trip. A keystroke in the YAML tab in between — same buffer, other tab — would be destroyed by
writing the answer over it. So the buffer is compared again when the answer lands, and if it moved,
**the edit is discarded and the author is told**: *the document changed while that edit was being
applied — try again*. This is 002 §4.3's rule for a file read that a keystroke overtook, applied to a
transform, and for the same reason: discarding a structured edit costs a click, and overwriting a
keystroke costs the keystroke.

### 7.3 Undo

**⌘Z in the flow tab undoes the last structured edit**, and ⌘⇧Z redoes it. The history is the
buffer's previous texts, held beside the draft, capped by count and by size, and it belongs to the
flow rather than the tab for the reason every other piece of draft state does. ⌘Z in the YAML tab is
the code editor's own history and is untouched; the two are never ambiguous because a keystroke lands
in one tab.

**A text edit ends the structured history.** A hand-typed line in the YAML tab, then ⌘Z in the flow
tab restoring text from before it, is a silent loss of the typed line — the one loss 002 §4.3 says an
editor is not allowed. The history is cleared when the YAML tab's text changes, and when the buffer is
replaced from disk. It survives a save: undoing past a save re-dirties the draft, which is what an
author who saved by reflex and then wants the previous state expects.

An edit the engine reports as changing nothing (`changed: false`) pushes no history and does not
dirty the buffer.

### 7.4 Revert

**A Revert control beside the save state puts the draft back to the text the editing session started
from.** Undo walks; revert arrives. An author who has spent ten edits discovering that the shape was
wrong wants the file as it was, and counting the edits back is work in exactly the moment they have
decided the work was wasted.

**The text it goes back to is a third one, beside the draft and the last save.** The draft and the
file agree again at the first save, and with auto-save on that happens a second after the first edit
— so a revert to the last save would have nothing to discard for most of a session. The session's
opening text is what does not move. It is re-taken whenever the buffer is replaced from disk (§7.3's
other baseline move), because text the file has since moved away from is not something to offer to
restore.

**Revert does not write the file.** It restores the text into the draft and leaves the buffer dirty,
which is §7.3's rule for undoing past a save over a longer reach; where auto-save is on, auto-save
writes it as it writes every other edit. One path reaches the file, and it is the one that always
did.

**The discarded draft goes onto the undo history, and the control asks first.** ⌘Z takes a revert
back like any other edit — but only as far as the history still reaches, and a hand-typed line ends
it. An editor may lose work to a deliberate answer, never to a click.

The control offers itself whenever the draft differs from the opening text, which is not the same as
being unsaved: after auto-save the buffer reads *Saved* and the edits are still there to discard.

## 8. Running from the designer

`renderer:flow-run` executes the file on disk (002 §7); it has no draft overlay, and should not — a
run is a record of a file. A run started over an unsaved draft would therefore execute the previous
version of a flow whose current version is drawn above the button, which is the one disagreement 002
§11.1 exists to rule out.

**The run control saves, then runs, as one act.** When the draft is dirty and parses, pressing Run
writes it and starts the run; the control's label says so — *Save & run* — so nobody is surprised by
the save. The two are one gesture rather than two because they are one intent, which is the argument
002 §4.4 makes for writing a rename and a `meta:` change in one call. When the draft does not parse,
the control is disabled with the parse error stated, as 002 §7.1 already disables it for a flow with
errors; 002 §4.3's auto-save refuses the same text for the same reason.

The control's own gating — errors in the description, missing required params (002 §7.1) — reads the
draft's description while the flow is editable, not the file's, or it would enable and disable on a
document the drawing above it no longer matches.

Once the run starts, §4 applies: the graph is the run's, and read-only, until it is closed.

## 9. The engine boundary

The additions to `@bruno-max/flow`. Three reads and one write, all pure functions over text except
§9.3's second entry, which takes 002 §11.1's read-only ports because it opens the flow's OpenAPI
documents. Nothing here changes `runFlow`, `validateFlow` or `describeFlow`.

### 9.1 The writer

001 §18 asked what writes a flow file. This does:

```ts
declare function applyFlowEdits(text: string, edits: FlowEdit[]): FlowEditResult;
```

**One entry point over a list of edits, not a function per edit.** Three reasons, in order of weight.
Edits compose, and they have to compose inside one parse: an insert-between is potentially two
mutations of one gesture, and applying named functions in sequence means parse → serialize → parse →
serialize, where the second parse re-derives every node from text the first pass just rewrote — the
comment and blank-line preservation below holds across a compound edit only if there is one parse and
one emission. The IPC boundary is a union anyway: whatever the engine exports, the renderer sends a
structured-clone-safe payload over a channel and the host switches on it, so named functions would be
either a channel per function sharing one guard or an untyped `{ op, ...args }`; the union is that
payload, typed, with exhaustiveness the compiler checks. And one refusal vocabulary: every edit fails
for the same handful of reasons, and `writeFlowProperties`' `string | undefined` (002 §4.4) does not
scale past one.

`writeFlowProperties` stays as it is. It is 002 §4.4's shipped contract with its own handler and
tests, and re-expressing it as an edit would change a file that works to save a function.

```ts
type EditValue =
  | null | boolean | number | string
  | EditValue[]
  | { [key: string]: EditValue };

/**
 * Explicit about clearing. `undefined` does not survive structuredClone, so `{ body: undefined }`
 * arrives as an absent key — indistinguishable from "I did not mention body".
 */
type StepPatch = { set?: Record<string, EditValue>; unset?: string[] };

/** 001 §5.2's `config:`, patched the same way and for the same reason — a default is an absence. */
type ConfigPatch = { set?: Record<string, EditValue>; unset?: string[] };

type StepDraft = { id?: string; operation?: string; uses?: string } & Record<string, EditValue>;

type ApiBindingDraft = {
  alias: string;
  source: string;                 // as the file should read it — relative, resolved by the host (001 §6.2)
  baseUrl?: string;
  auth?: string;
  color?: string;
  rateLimit?: { requests: number; per?: 'second' | 'minute' | 'hour'; burst?: number };
  defaultHeaders?: Record<string, EditValue>;
  defaultQuery?: Record<string, EditValue>;
  strictNulls?: boolean;          // 001 §10.1 — false is this key's meaningful value, so it is written
};

type FlowEdit =
  | { kind: 'step.insert'; step: StepDraft; after?: string; before?: string }   // neither: at the end
  | { kind: 'step.remove'; id: string }
  | { kind: 'step.rename'; id: string; to: string }
  | { kind: 'step.duplicate'; id: string; to: string; after?: string }
  | { kind: 'step.move'; id: string; after?: string; before?: string }
  | { kind: 'step.patch'; id: string; patch: StepPatch }
  | { kind: 'config.patch'; patch: ConfigPatch }                                // 001 §5.2's flow-wide block
  | { kind: 'api.add'; binding: ApiBindingDraft }
  | { kind: 'api.update'; alias: string; binding: ApiBindingDraft }
  | { kind: 'api.rename'; alias: string; to: string }
  | { kind: 'api.remove'; alias: string }
  | { kind: 'functions.use'; source: string }      // 001 §8.6's use: — a shared script, as the file reads it
  | { kind: 'functions.unuse'; source: string }
  | { kind: 'functions.define'; define: Record<string, string> };  // §8.6's inline definitions, as a block

type FlowEditRefusal =
  | 'unparseable'        // the text has no document to edit
  | 'no-such-step' | 'no-such-api'
  | 'duplicate-step-id' | 'duplicate-alias' | 'invalid-step-id'
  | 'unknown-field'      // a `set` key outside the step's schema
  | 'schema-refused'     // the edit would introduce a schema error the text did not have
  | 'api-in-use'         // `api.remove` of a binding a step references
  | 'unknown-edit';      // a kind this build of the engine does not know — said, never applied as nothing

type FlowEditResult =
  | { ok: true; text: string; changed: boolean; inserted?: string[] }
  | { ok: false; reason: FlowEditRefusal; message: string; steps?: string[] };
```

**A script is written as a block scalar.** No position requires one — every one of 001 §8.2's script
positions reads its value as a string, whatever spelling it arrived in — but the YAML library chooses
a spelling per string: plain, double-quoted the moment a script contains `: `, `|-` the moment it
contains a newline. One flow then holds three spellings of the same kind of value, and which one a
script got says nothing about the flow. So `pre:` entries, an output's `script:` and both
`retry.shouldRetry` blocks are written as `|-` wherever this writer puts one. It applies to the key
being edited and nothing else: a script the author spelled their own way elsewhere is not restyled by
an edit that was not about it, which is the same promise the writer makes about comments, anchors and
flow style.

**`api.update` merges, it does not replace.** `ApiBindingDraft` models eight keys and a binding may
carry more — one a later format version adds, one a hand-written file has — so a write that rebuilt
the mapping from the draft deleted every unmodelled key each time the author saved an edit to the
colour, from a form that never showed them. The modelled keys are written in place and the rest stay
where they were written. A *modelled* key the draft omits is still removed, because omission is how a
form clears one; a modelled key the file wrote under a tag is not, since §6.4 keeps those out of the
draft and their absence says nothing. When nothing but `source:` is left and no unmodelled key is
holding the mapping open, the binding collapses to §5.2's shorthand — what `api.add` would have
written for it.

**`config.patch` creates its block and removes it.** It is the only edit whose subject is a block
rather than a thing inside one, and both follow from that. A flow that declares no `config:` gets one
in §5.2's position rather than a refusal — turning the first flag off is the common case, and
refusing it would mean *open the YAML first* for the one edit the pane exists to make. A block whose
last key is unset is deleted, because a flow back at its defaults should read as one and a
`config: {}` left behind says nothing while still having to be explained.

`step.insert` with no `id` derives one from the operation, or from the `uses:` path, by §5.1's rule,
and the result names every id `step.insert` and `step.duplicate` wrote, in order, as `inserted` —
present only when one was — so the caller can select what it could not name (§5.1).

**How it writes, and what it promises.** The document is parsed with the YAML library's document API
— the AST, with comments, anchors, merge keys, flow-style collections and blank lines as nodes —
mutated in place, and re-emitted. This is `writeFlowProperties`' mechanism (002 §4.4) applied to
the rest of the file, and it comes with that function's tag table, which resolves `!file` and
`!...` **to the node itself** rather than to the `FileRef` and symbol the engine runs on: a resolved
tag has no serializer, and re-emitting one yields `!file "[object Object]"`.

**The emission is transplanted, not written out.** Measured over the committed corpus,
`String(document)` alone returns 38 of 132 fixtures changed: the library has one flow-collection
padding setting for the whole document, one line width, and no memory of the spaces an author used
to align a column of trailing comments, so emitting directly re-spells `depends: [a, b]` and
collapses a comment column a hundred lines from the edit. So the document is emitted twice — before
and after the mutation — and, both coming off the same emitter, they differ only where the edit
acted; the span between the first and last differing line is spliced onto the original text, and
every byte outside it is the original's. Where the emitter changes how many lines the document takes
(a flow mapping past the line width becoming a block) there is no line to transplant onto and the
emission stands whole — a correct file that reformats, over a wrong one that does not, and the one
case in which the guarantee below degrades to *the document is correct*. §13 records the CST-level
editing that would close it. The guarantee that follows is the answer to 001 §18:

> **A structured edit changes the lines it names and no others.** Every node the edit did not visit
> is emitted as it was parsed. Comments, key order, anchors and aliases, merge keys, flow-style
> collections, blank lines, quoting style and every key this build does not model survive a
> structured edit byte for byte. `applyFlowEdits(text, [])` is the identity on every committed
> fixture, and 005-C B1 asserts it on bytes.

The one exception is 002 §4.4's: the library re-emits a trailing comment one space after its value,
so padding that aligned a column of them collapses on the line that was edited. Nothing the format
carries meaning in is affected.

Four rules keep the promise honest at the edges:

- **Read from the document, never from the normalized model.** 001 §5.2's defaults are filled by
  `normalizeFlow`; a read through it followed by a write back would spell every default out, and
  turn a renamed step into a whole-file diff. `readFlowProperties` already makes this choice for
  `meta:`, and it is the same choice one level down.
- **A new key lands where the format reads it, not at the end.** The step block's key order is the
  schema's own property declaration order, which is 001 §5.3's listing order — one declaration, so
  the order the writer uses cannot drift from the set ajv accepts — and a newly written key is
  spliced at its position. A root block that does not yet exist — `apis:`, or the `steps:` 002 §4.1c
  writes none of — is created after the last key the file has that the schema's root order (001
  §5.2's: `version`, `meta`, `apis`, `functions`, `config`, `authProfiles`, `vars`, `shared`,
  `dataset`, `params`, `exports`, `stages`, `steps`) reads before it, which is `ensureMetaBlock`'s
  argument generalized: a file the app touched should still read as one somebody wrote.
- **A default is written as an absence** — `unset` deletes the key — with §6.5's tri-state flags as
  the reason the *editor* must be careful about what it asks to unset.
- **Refuse rather than corrupt, and refuse only what the edit caused.** After mutating, the writer
  parses its own output with the engine's parser and runs the schema pass (001 §5.4, §14.3) over it.
  An unknown property is a *warning* there — 001 §15's forward compatibility — so only errors count;
  and a flow can carry an error before the edit: the schema requires `steps`, so **every flow the
  create form writes is schema-invalid until its first step**, and a gate refusing any error would
  refuse the first insert. The pass therefore runs before and after, keyed by node path and message,
  and refuses with `schema-refused` only when the after-set has an error the before-set did not.
  The missing-`steps` error is exempt on both sides, because §5.2 makes removing the last step
  *restore* that shape — a gate that counted it would refuse the delete with the schema as the
  reason. On refusal the original text stands. Text that does not parse is refused as `unparseable`
  and never rebuilt from scratch — `writeFlowProperties`' exact position.

`step.remove` of the last step removes the `steps:` key (§5.2). `api.remove` of a binding any step's
`operation:` names is refused as `api-in-use` with those steps listed (§5.5). `api.rename`, and an
`api.update` that changes the alias, retarget every `operation: <alias>#…` to the new alias (§5.5).
`step.rename` and `step.remove` rewrite nothing else (§5.2, §6.6). `functions.use` adds a path to
`functions.use:` in the form the block has — the one-path string becoming a list at the second —
creating the block where §5.2 reads it, and a path already listed is `changed: false`;
`functions.unuse` removes one, and the block goes with the last path unless it still defines a
function of the flow's own (001 §8.6).

### 9.2 The read

```ts
declare function readFlowEditModel(text: string): FlowEditModel | undefined;

type StepFields = {
  id: string;
  /** Every key the step declares that this format models, as written — never normalized. */
  fields: Record<string, EditValue>;
  /**
   * Keys the editor must not rewrite: unknown to this build, or carrying a local tag. Named rather
   * than dropped, because 001 §15's "never drops unrecognized fields" is only true if the surface
   * that would drop them can see them.
   */
  opaque: { key: string; tag?: string }[];
  /** One-based, from the parser's line counter — what *Open in YAML* jumps to. */
  position: { line: number; column: number };
  /** Per key, so the jump lands on the key rather than on the step. */
  keyPositions: Record<string, { line: number; column: number }>;
};

type FlowEditModel = {
  steps: StepFields[];
  apis: (ApiBindingDraft & { opaque: string[] })[];
  /** Names the editor offers in selects, with what the file declares beside what a connector file supplies. */
  authProfiles: string[];
  /** 001 §8.6's functions.use: entries as written, in order — the shared scripts the flow draws on. */
  functions: string[];
  definitions: Record<string, string>;   // §8.6's inline definitions, by name, in declaration order
  /**
   * Every name a script in this flow may call — the definitions above, and what each library it uses
   * declares. **Absent from the text-only read and filled in by the host**, because a library is a
   * file: a host with the ports resolves them (`resolveFunctions`) and sets this.
   */
  functionNames?: string[];
  /**
   * 001 §5.2's config: as the file declares it — what §6.8's pane renders from. A key the block does
   * not carry is absent rather than filled in with its default, for the same reason a step's is: a
   * default written back out is a decision the author did not make.
   */
  config: Record<string, EditValue>;
  /**
   * The closed vocabularies the editor's controls need. Sent rather than duplicated in the renderer,
   * for 002-C R4's reason: a dropdown offering an operator the engine does not accept is the
   * renderer deciding semantics.
   */
  vocabulary: {
    operators: string[];        // 001 §10.2
    statuses: string[];         // 001 §9.1's four
    authModes: string[];        // 001 §6.4's eleven
    backoff: string[]; jitter: string[];
    stepKeys: string[];         // the schema's step keys, in order
    configKeys: string[];       // §5.2's config: keys, in order — what §6.8's pane may write
    unaryOperators: string[];   // 001 §10.2's operators that take no operand — derived by arity
    outputSources: string[];    // §8.1's kinds of output: the four `from` values, and `script`
  };
};
```

**`functionNames` is what the script editors tell their linter.** A script is evaluated with §8.6's
library composed into its prelude, so a helper is in scope by its name — and the linter, which knows
only the sandbox globals, reports every one of them as *is not defined*. An author reading that in a
box where the code is correct learns to ignore the linter, which is worse than not having one. The
list is passed to every editor in a script position: an output's script, a `when:` script, a `pre:`
entry, an inline definition, and both `shouldRetry` boxes.

A library that cannot be read leaves the list at the inline definitions rather than failing the
model. The unreadable file is reported where it belongs — `unresolved-function-library`, on the flow
— and a step editor that went blank because a helper file was mid-rename would be a worse answer to
the same fact.

`undefined` for text that does not parse, for `readFlowProperties`' reason. The model is what the
editor renders from; the description (002 §11.1) is what the graph renders from; neither is widened
to carry the other. `FlowDescription` is snapshotted into every run's `run.json` (001 §14.5) so a
stored run stays readable after the file moves on — widening it with bodies and headers would write
every step's request into every run forever, for a pane only the editor has.

### 9.3 Operations

```ts
type OperationSummary = {
  /** What a step's `operation:` reads after the alias — the operationId, else 001 §6.1's `METHOD /template`. */
  reference: string;
  operationId?: string;
  method: string;
  path: string;                 // the template as written
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  /** 001 §6.5: the id is declared twice, so a reference to it resolves to two operations and the run refuses it. */
  ambiguous: boolean;
};

declare function listOperations(spec: SpecIndex): OperationSummary[];

type FlowOperations = {
  apis: {
    alias: string;
    source: string;             // as the flow writes it
    resolved?: string;          // where it resolved to; absent when it could not be read
    error?: string;             // per binding, so one unreadable document does not empty the picker
    operations: OperationSummary[];
  }[];
};

declare function listFlowOperations(options: DescribeOptions): Promise<FlowOperations>;
```

**In the engine, not in the renderer.** The renderer holds parsed OpenAPI documents already — the
API Specs feature keeps every open spec's JSON in its store — and walking their `paths` would need no
new channel. Rejected in §11, for reasons that decide it: a reference's identity is 001 §6.1's rule
set (the literal id, then a normalized method-and-path with interpolations and origin stripped and
`{param}` rewritten), a twice-declared id is `ambiguous` and only the engine's index knows, and the
renderer's store holds the specs *open in the workspace* — not a document bound by relative path from
outside it, and not an `https://` source the engine fetches through the `ReadSpec` port. The picker
would show an empty rail for exactly the bindings real flows have.

`listFlowOperations` takes `describeFlow`'s options so the host can overlay the read port with the
draft's text exactly as it does for a describe (002 §11.3), which is what lets a binding added on the
legend offer its operations before it is saved. It walks the flow's own `apis:` — a connector file
(001 §8.5) enriches a binding by document identity and never supplies an alias — and loads each
document through the same loader the run uses, so the list is the run's list.

### 9.4 The IPC surface

Three invoke channels, added to the ones 002 §11.3 lists and registered by the same `registerFlowIpc`.
No push channel; the watcher already reports everything a structured edit ends in.

| Channel | Direction | Purpose |
|---|---|---|
| `renderer:flow-read-edit-model` | invoke | §9.2 for one flow — `{ entry, scope, content? }`; the draft's text when given, the file's otherwise |
| `renderer:flow-apply-edit` | invoke | §9.1 — `{ entry, scope, content, edits }`; resolves with the `FlowEditResult` |
| `renderer:flow-list-operations` | invoke | §9.3 — `{ entry, scope, content? }`; the draft overlay as for `flow-describe` |

**`flow-apply-edit` is a transform, not a write.** It takes text and returns text, and touches no
file — the write is 002 §11.3's `renderer:flow-write-source`, reached by the same save path the YAML
tab uses, behind the same guard. This is the whole of what makes §7.1 true: one buffer, one dirty
comparison, one auto-save rule, one write guard. 002 §11.3's argument for keeping its write channels
separate is that *each carries a guard the others do not*; every structured edit carries the same
guard — a flow inside the named scope — and the same write path, so that argument is for one channel
here, not against it.

The one thing the handler does that the engine cannot: an `api.add` or `api.update` arrives with the
document's path as the renderer knows it, absolute, and the handler relativizes it against the flow's
directory before calling the engine — the same `relativeSpecSource` 002 §4.1c's create uses, because
paths are the host's and the renderer's `path` is a POSIX shim. A `step.insert` whose `uses:` is
absolute — the picker names a library by the path the watcher lists it under (§5.1) — is written the
way 001 §12.2 resolves it: relative to the flow where the library lies under the flow's own scope
root, `workspace:`-prefixed where a collection flow reaches one outside its collection but inside
the workspace, and untouched where it lies under neither, for the engine to report. A
`functions.use` or `functions.unuse` whose `source` is absolute is written relative to the flow's
directory, which is where 001 §8.6 resolves a `use:` entry from.

Each handler validates `entry` as 002 §11.3's read channels do — a `.flow.yml`, inside the scope —
and each is a named export, per the electron rules, so the host's own tests can exercise it without
the main process. 005-C §7 names them.

### 9.5 What 005 changed in 001 and 002

- **001 §18's *"What writes a flow file?"* is answered** — by §9.1, with the round-trip guarantee
  stated there and asserted by 005-C B1. The row moves to 001's resolved index.
- **002 §15.2's *"The flow builder"* row is deleted**, per the README's convention that an item
  leaves the future-work table by being specified. Nothing else in 002 changes: §4.3's YAML tab is
  still the non-standard way in and is unchanged; §4.2's flow tab gains §4's editable state without
  gaining a second view.
- **002 §4.3's "the run view keeps describing the file on disk" is narrowed** to *while a run is
  open*, by §7.1. The description of the file on disk keeps its place and its meaning.
- **002 §5.1's legend rule is narrowed** to the read-only legend, by §5.5.
- **002-C R4 gains a corollary**: the renderer draws no node the engine has not described. Stated in
  §5 and pinned by 005-C B2.6.

## 10. Fork isolation

**This feature adds no row to 002 §12.1's manifest.** Each temptation, and why it costs no upstream
line:

| Temptation | Why zero |
|---|---|
| A new tab type | There is none — the designer *is* 002 §4.2's `flow` tab |
| Three IPC channels | `preload.js` forwards any channel with no allowlist; registration is inside the fork-owned `ipc/flow/` |
| New reducers and thunks | `fork/flows/slice.js` and `actions.js`; the reducer map already hands the fork its key |
| A search library for the picker | `fast-fuzzy` is already a dependency of the app, used by upstream's own selection list |
| The undo keybinding | Bound on the pane, the precedent the YAML tab set for ⌘S, rather than joining upstream's hotkey provider |
| Upstream's request-pane tabs | Not reused — §6.2. The presentational leaves (the editable table, the code editors, the tab strip) carry no store dependency and are consumed as they are |
| The e2e page module | `tests/utils/page/flows.ts` is fork-authored and already re-exported by the two lines 002 §12.1 counts |

One precedent is deliberately not followed. 002 §12.1 rejected upstream's `SearchInput` for the
sidebar's search row because it autofocuses and carries a fixed DOM `id`, and the row is rendered for
as long as the section is open. The picker is a modal rendered only while open, in which the
autofocus is wanted and there is one instance — so the objection does not apply, and it is reused.
Said here so the next reader does not take the earlier decision as a rule.

Everything new lives under `packages/bruno-app/src/fork/flows/`, `packages/bruno-electron/src/ipc/flow/`
and `packages/bruno-max-flow/src/`. 002-C R5's assertion — the diff against the upstream merge base
touches exactly the manifest's files — is what keeps the count at zero after the next merge.

## 11. Rejected alternatives

**A step that is a free request — method and URL, no spec.** The most-asked-for thing the format
does not have, and the first thing a user of the request tab reaches for. Rejected here because it is
a format change (001 §5.3 requires `operation:` or `uses:`), and a format change is 001's to make:
it needs a schema version, a materialization path with no operation to seed from, an answer for
schema validation on a step that has no schema, and 001 §15's compatibility rules for a file an older
Bruno opens. §13 records what adopting it would take. The builder is worth having without it, and
shipping it inside a UI spec would be shipping half of it.

**Free node positioning — React Flow.** 002 §13 named React Flow as the right base for the builder,
and the reasoning there was that a library's value is in interactive editing. What that misses is
what "interactive" would edit: positions are 002 §5.2's ranks, computed by the engine from the
dependency graph, and exist nowhere in the file. A dragged node either writes nothing (and snaps
back, which is a drag that lies) or writes a position (which needs a sidecar or a format field the
engine ignores, so the drawing and the executed graph diverge on purpose). Editing the *structure* —
where a step sits in the sequence, what it depends on — is what moves a node, and §5 puts the
affordances on those. React Flow stays rejected, now for the builder as well; the seam 002 §13 kept
(`layout.js`) is untouched.

**Making the YAML tab the editor, and this tab a viewer with buttons.** The smallest change: keep 002
§4.3's editor as the place a flow is written, and give the run tab a toolbar that opens it at the
right line. Rejected because it answers §1 with the thing §1 describes — a text editor with the
graph beside it — and because "add a request" is a lookup that a picker answers and a caret does not.

**A draft of the designer's own.** A separate buffer, edited by the designer, distinct from the YAML
tab's. Simpler to build; rejected because two drafts of one file can both be ahead of disk and ahead
of each other, and neither the save state nor the divergence notice of 002 §4.3 can say anything
true about a file with two unsaved versions. §7.1's one buffer is what makes 002 §4.3's rules hold
without a second copy of them.

**Widening `describeFlow` to carry step fields.** It would save a channel and a second read. Rejected
in §9.2: the description is snapshotted into every run, and a stored run would carry every step's
request body from then on.

**Enumerating operations in the renderer**, from the API Specs store. Rejected in §9.3, decisively:
the renderer cannot know an id is ambiguous, cannot apply 001 §6.1's normalization, and does not hold
the documents a flow binds from outside the workspace's list.

**Editing during a run, with statuses overlaid where ids still match.** Coherent — a step added
mid-run reads *pending*, a removed one takes its status with it, and the rest keep theirs. Rejected in
§4 because it draws two documents at once for a reader who is watching one execute, and because the
finished run's results would sit on a graph the file no longer describes, which is what 002 §10
exists to prevent. *Edit flow* on the badge is the one-click alternative.

**Seeding a new step's body from the spec.** Rejected as the default in §5.1; kept as §6.7's control.

**Rewriting references to a step on rename and delete.** Rejected for v1 in §5.2 and §6.6; the
anchored diagnostics say what happened and where, and §13 keeps the rewrite. An *alias* rename is
the exception and not this item (§5.5): its one reference form is literal.

**Named writer functions per edit.** Rejected in §9.1.

**Refusing any schema error after an edit.** Rejected in §9.1 because the create form's own output
is schema-invalid until its first step; the gate compares before and after.

## 12. Open questions

- **Which fields carry a tag in practice**, so §6.4's opacity rule is checkable rather than
  discovered: `body` and `vars.*` (`!file`), `dataset.source` (`!file`), `outputs.<name>` and the
  keys of `body`, `query`, `headers` (`!...`), `with.*` (either). The list is believed complete and
  005-C B3 asserts each; a tag in a position not listed is a case to add, not a bug in the rule.
- **The picker's cost.** A full document parse per open, through the same loader a run uses. A large
  spec re-parsed each time is the measurable risk; the lever is a host-side index keyed on the resolved
  path and its modification time. Measured before built.
- **Whether `documentAnchors` go stale across a structured edit** — an anchor recorded for line 40
  before a step was inserted above it. The next describe re-anchors, and the YAML tab reads the anchor
  when it mounts; the window in between is one describe wide. Worth one line here so nobody debugs it
  twice.

Details left to implementation, as they change no contract:

- The exact placement and hit-target size of the `+` and the ports.
- Whether the picker remembers the last alias chosen.
- The debounce that commits a field (§6.3) — a few hundred milliseconds, tuned by use.

## 13. Future work

Deferred deliberately. As in 001 §19 and 002 §15, these are wanted and not now; each carries why it
was deferred and what adopting it takes, and leaves by being specified.

| Item | Why not now | What it needs |
|---|---|---|
| **A spec-less request step** | A format change, 001's to make — §11 | 001: a `request:` form beside `operation:` with `method` and `url`, a materialization path that seeds nothing, `validateSchema` meaningless for it, a schema version, and 001 §15's compatibility story. Then this spec's picker gains a *free request* entry |
| **Rewriting references on rename and delete** | §5.2, §6.6: an edit made where the author is not looking, on a guess | A reference index over the document from the engine (which occurrences of `steps.<id>` mean this step, in bodies, `when`, scripts, `stages`), and a preview of what would change |
| **The run pane and the editor together** | §6.1: two state machines in one split | A layout that shows a step's last response beside its editor without either pane losing the height it needs |
| **Editing `with:` from the sub-flow's declared params** | Describing another file from inside a step editor | `describeFlow` of the `uses:` target, cached, and a rule for a param the sub-flow no longer declares |
| **Tag-aware editing** — a `!file` body as a file picker, a `!...` suppression as a checkbox | §6.4 makes them opaque; round-tripping a tag through a form needs a projection both ways | `{ $tag, value }` in `EditValue`, a writer that re-tags a node, and 005-C B3 extended to the projected form |
| **Editing the non-step blocks in forms** | §3 — the YAML tab covers them and none is a canvas concern | Per block, a form and an edit kind; `authProfiles` first, since §6.2's `auth` select is where an author discovers a profile is missing |
| **Byte-exact editing through the CST** | §9.1's transplant keeps the guarantee for every edit that does not change the document's line count elsewhere; the library's CST would keep it for all of them | The `yaml` package's `Parser`/`CST` layer — editing tokens rather than nodes, and a stringifier over them — which is a second parse of the format and needs 001 §5.4's tags handled at the token level |
