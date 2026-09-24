# 005-C — API Flow Builder conformance scenarios

**Status:** **Implemented** — companion to [005-api-flow-builder.md](./005-api-flow-builder.md).
Every scenario has a test — the engine's own Jest specs (§3, §5, §8a), the hosts' (§8), and
Playwright (§4, §6, §7) — and `builder-registry.spec.js` asserts each cites its `B…` id
**Owner:** Jake Campbell
**Last revised:** 2026-09-11

Scenarios the builder's behavior was derived from. Start at §2 for where the tests live, §3 for the
round-trip family that everything else stands on, §4–§6 for the app, §7 for the host boundary, §8 for
the regression set, and §10 for which section of 005 each one pins.

Where [002-C](./002-api-flows-ui-conformance.md) tests that the app *shows* what the engine reports,
this file tests that the app *changes a file* only through the engine, and that the engine changes
only what it was asked to.

---

## 1. Why this file exists

005's design position is 002's, extended by one clause: the renderer decides nothing about flow
semantics, **and writes nothing about them either**. Every scenario here has a cheap wrong
implementation that passes a casual look:

- A writer that reads the normalized model and serializes it back produces a correct flow and a
  whole-file diff. It passes every test that parses its output and fails the first code review of a
  committed `.flow.yml`.
- An editor that reads a step's `failOnStatusCode` as `false` when the key is absent renders every
  step correctly and, on the first untick, silently overrides a `config:` the author set on purpose.
- A canvas that paints the inserted node before the engine has described it looks faster and is the
  renderer deriving structure — the one thing 002-C R4 exists to catch.
- An operation picker built over the renderer's spec store offers an ambiguous `operationId` the run
  will refuse, and shows nothing for a document bound from outside the workspace.

Each scenario names the 005 sections it pins. A change to §9.1's guarantee or §6.5's tri-state rule
should break something here.

## 2. Where these tests live

Three places, by what each scenario is about:

```
packages/bruno-max-flow/tests/conformance/
  fixtures/flows/builder/          # §3's fixtures — one per shape the writer must leave alone
  edit-identity.spec.js            # B1.1–B1.3
  edit-steps.spec.js               # B1.4–B1.9
  edit-order.spec.js               # B1.10–B1.11
  edit-tags.spec.js                # B3.1–B3.3
  edit-refusals.spec.js            # B1.12–B1.16
  operations.spec.js               # B7.1–B7.7

packages/bruno-electron/src/ipc/flow/index.spec.js    # §7 — the existing file, the existing pattern

tests/flows/
  fixtures/workspace/flows/
    designer-linear.flow.yml       # three steps, no depends — the chain §4 rewires
    designer-empty.flow.yml        # version + meta + apis, no steps: — what the create form writes
    designer-tagged.flow.yml       # a !file body and a !... output — §3's opacity, seen from the app
    designer-unknown-key.flow.yml  # a step key this build does not model
  designer.spec.ts                 # §4, §6
```

**§3's fixtures are real files and are the whole of the round-trip test.** Every fixture already under
`tests/conformance/fixtures/flows/**` — the sixty-odd 001-C wrote — is also a round-trip fixture,
because B1.1 runs over all of them: a shape the writer has never seen is exactly the one it will
reformat. The `builder/` directory adds the shapes the existing corpus lacks: a comment on every
line, an anchor and its alias, a merge key, a flow-style step, a blank line between every key, a
trailing comment aligned in a column.

**Assertions on the writer are on bytes.** `expect(applyFlowEdits(text, []).text).toBe(text)`, and
for an edit, a line-by-line diff asserting exactly the expected lines changed. 001 §15's
`parse(stringify(x)) === x` is a statement about models; what a git-diffed file needs is a statement
about lines, and that is what these assert.

**§4 and §6 read the file back as text.** A scenario that adds a step through the canvas ends by
reading the `.flow.yml` from the temp workspace and diffing it against the committed original — 002-C
§2's fixtures-are-real-files rule, applied to the write side. Asserting on the graph alone would pass
a writer that drew the right thing and wrote the wrong file.

**`tests/utils/page/flows.ts` grows a `designer` namespace** with the affordances below. Selectors
stay `data-testid`:

```
graph:    flow-insert-first, flow-insert-after-<id>, flow-insert-before-<id>, flow-delete-<id>,
          flow-port-out-<id>, flow-port-in-<id>, flow-edge-remove-<from>-<to>
legend:   flow-legend-add, flow-legend-menu-<alias>, flow-legend-<alias>-edit, flow-legend-<alias>-remove,
          flow-api-dialog, flow-api-alias, flow-api-source, flow-api-baseUrl, flow-api-auth,
          flow-api-color, flow-api-rate-requests, flow-api-rate-per, flow-api-rate-burst,
          flow-api-strictNulls
picker:   flow-operation-picker, flow-operation-search, flow-operation-api-<alias>,
          flow-operation-<reference>, flow-operation-ambiguous-<reference>,
          flow-operation-libraries, flow-library-<filename>
editor:   flow-step-editor, flow-step-editor-tab-<name>, flow-step-field-<key>,
          flow-step-assert, flow-step-assert-table, flow-step-assert-op-<uid>,
          flow-step-assert-value-<uid>, flow-code-marker-script, flow-code-marker-expression,
          flow-step-outputs, flow-step-outputs-table, flow-step-output-source-<uid>,
          flow-step-output-value-<uid>,
          flow-step-opaque, flow-step-opaque-<key>, flow-step-open-yaml-<key>,
          flow-step-flag-<key> (tri-state), flow-step-seed-body, flow-step-seed-empty,
          flow-step-refusal, flow-step-dangled, flow-step-<field>-table,
          flow-step-exports, flow-step-export-<name>, flow-step-scripts, flow-step-script-add,
          flow-step-script-name-<index>, flow-step-script-editor-<index>, flow-step-script-remove-<index>,
          flow-step-shared-scripts, flow-step-shared-script-<index>, flow-step-shared-script-remove-<index>,
          flow-step-shared-script-add
settings: flow-settings, flow-settings-tab-<name>, flow-settings-defaults, flow-settings-runs,
          flow-settings-retry, flow-config-flag-<key> (tri-state), flow-config-<key>,
          flow-config-retry-<key>, flow-settings-refusal
status:   flow-designer-state, flow-designer-readonly, flow-designer-edit, flow-run-saves-first
```

`flow-step-detail` keeps its meaning — the root of the run's pane — so every 002-C scenario that
scopes to it is untouched.

---

## 3. B1 — The writer changes what it names and nothing else

Fixtures: the whole conformance corpus, plus `builder/`.

### B1.1 The empty edit is the identity

For every `.flow.yml` under `tests/conformance/fixtures/flows/**`, `applyFlowEdits(text, [])`
returns `{ ok: true, changed: false }` and text byte-identical to the input.

*Pins 005 §9.1.* The whole guarantee, at its cheapest. A writer that normalizes on read fails this on
the first fixture with a comment.

### B1.2 A one-key patch changes one line

On `builder/commented.flow.yml` — a comment on every line, a trailing comment aligned in a column —
`step.patch` setting `timeout: 5000` on the second step produces text that differs from the input on
exactly the lines the diff names: one line added, in the position §9.1's key order puts it, and no
other line changed. The aligned trailing comments on every *other* line keep their column.

*Pins 005 §9.1.* The exception 002 §4.4 records — the library re-spacing a trailing comment — is
confined to the line that was edited, and this asserts the confinement.

### B1.3 An anchor, a merge key and a flow-style collection survive

`builder/anchored.flow.yml` declares `retry: &poll { maxAttempts: 10, delay: 500 }` on one step,
`retry: *poll` on another, `<<: *defaults` on a third, and `depends: [a, b]` in flow style. A patch
to an unrelated step leaves all four spellings as written.

*Pins 005 §9.1.* Each is a spelling the normalized model does not distinguish and a re-serializer
would rewrite.

### B1.4 Insert after writes two lines, and the sequence rewires

On `designer-linear` (a → b → c, no `depends`), `step.insert { after: 'a', step: { operation: 'api#op' } }`
adds exactly two lines between `a` and `b` — `- id:` and `operation:` — and `describeFlow` of the
result draws a → new → b → c with sequence edges. No `depends:` is written anywhere.

*Pins 005 §5.1, 001 §9.1.* 002-C U1.2 from the writer's side. An implementation that wrote
`depends: [a]` on the new step and `depends: [new]` on `b` draws the same graph and produces a
four-line diff plus two declared edges where there were none.

### B1.5 Insert does not rewire an explicit dependency

On a two-step flow where `b` declares `depends: [a]`, inserting after `a` leaves `b`'s line untouched
and the new step is a leaf — nothing follows it implicitly, because the only step below it declares
what it follows.

*Pins 005 §5.1.* The rule is *position*, not *rewiring*.

### B1.6 Insert into a flow with no `steps:` creates the block

On `designer-empty` — `version`, `meta`, `apis`, nothing else — `step.insert` adds a `steps:` block
after `apis:`. `steps` is the last root key, so for a file in order this coincides with appending; the
rule it shares with B1.11 is pinned there, where `apis:` has to land above a trailing `config:`.

*Pins 005 §9.1.* `ensureMetaBlock`'s argument generalized: `setIn` appends, and a block above `meta:`
is 001 §5.2 inverted by the first click.

### B1.7 Remove closes the gap, and removing the last step removes the key

Removing `b` from a → b → c yields a → c with a sequence edge, and the diff is the removed lines
only. Removing the last remaining step removes the `steps:` key, leaving the file as
`designer-empty` reads.

*Pins 005 §5.2.*

### B1.8 Rename writes the id and nothing else

`step.rename { id: 'b', to: 'fetch' }` on a flow where `c` has `when: steps.b.status eq 200` changes
the `id:` line and leaves `c`'s `when:` as written; `describeFlow` of the result reports an
`unknown-step-reference` diagnostic anchored on `c` — 001 §14.3 anchors it on the step that holds
the reference.

*Pins 005 §6.6, §5.2.* The rewrite is future work; the diagnostic is the contract.

### B1.9 The derived id is deterministic

`step.insert` with no `id` and `operation: 'api#createPayment'` yields `create_payment`;
`api#getOrderByID` yields `get_order_by_id`; `api#create-payment` yields `create_payment`;
`api#POST /payments/{id}/refund` yields `post_payments_refund`; a second `createPayment` in the same
flow yields `create_payment_2`; `api#2faVerify` yields `_2fa_verify`. A `uses: './sign-in.flow.yml'`
yields `sign_in`, and `uses: 'workspace:flows/shared/login.flow.yml'` yields `login` — the file's
name, wherever it lives and however it is reached.

*Pins 005 §5.1.* Every output matches `^[a-zA-Z_][a-zA-Z0-9_]*$`.

### B1.10 A new key lands in schema order

`step.patch` setting `assert`, then `headers`, then `name` on a step that has only `id` and
`operation` produces a block reading `id`, `name`, `operation`, `headers`, `assert` — the schema's
order, whatever order the edits arrived in.

*Pins 005 §9.1.* And the order is asserted to equal `Object.keys` of the schema's step properties, so
the two cannot drift.

### B1.11 `api.add` lands after the last root key that precedes it

On a file with no `apis:`, `api.add` creates the block after `meta:`; with `meta:` absent, after
`version:`.

*Pins 005 §9.1, §5.5.*

### B1.12 Unparseable text is refused, not rebuilt

`applyFlowEdits('version: [\n', edits)` returns `{ ok: false, reason: 'unparseable' }` for any
edit, and never a document built from scratch.

*Pins 005 §9.1.* `writeFlowProperties`' position, held.

### B1.13 A refused edit leaves the text unchanged

For each refusal — `no-such-step`, `no-such-api`, `duplicate-step-id`, `duplicate-alias`,
`invalid-step-id` (`my-step`, `1st`, `a.b`), `unknown-field` (`set: { colour: 'red' }`),
`api-in-use`, `unknown-edit` (a `kind` this build does not have) — the result names the reason, and
the input text is the text that stands.

*Pins 005 §9.1.* `api-in-use` also lists the steps that reference the alias. `unknown-edit` is what
an older engine says to a newer renderer, in place of the edit that changes nothing and says nothing.

### B1.14 The schema gate refuses only what the edit introduced

`step.patch { set: { operation: 'x#y' } }` on a `uses:` step is refused as `schema-refused` (001
§5.3's xor). But `step.insert` on `designer-empty` — a file that is *already* schema-invalid for
lacking `steps:` — succeeds, and so does a patch to an unrelated step on a flow carrying a
pre-existing schema error.

*Pins 005 §9.1.* The gate that refuses any error locks the builder out of every new flow.

### B1.15 An unknown key is preserved through an edit to its own step

`designer-unknown-key` declares `retryPolicy: aggressive` on a step. `step.patch` setting `timeout`
on that same step leaves `retryPolicy:` as written, and `readFlowEditModel` lists it under `opaque`.

*Pins 005 §6.4, 001 §15.* Nothing tested §15's "never drops unrecognized fields" before this.

### B1.16 A compound edit is one parse

`applyFlowEdits(text, [insert, patch-the-inserted-step, rename-it])` yields the same text as
applying the three in sequence, and the comments around the touched step are as they were. Asserted
by comparing against the sequential result *and* against the original's untouched lines.

*Pins 005 §9.1.* The reason for one entry point.

### B1.17 A slot a step publishes to is declared

`step.patch` setting `shared: [chargeId]` on a flow with no `shared:` block writes `shared: [chargeId]`
at the root, after the last block §5.2 reads before it. With `shared: [sessionToken]` already there
it becomes `[sessionToken, chargeId]`, a name already listed is not listed twice; with the mapping
form it gains `chargeId: { writers: all }`; a step's mapping form (`chargeId: backupId`) declares
`chargeId`. A `step.insert` carrying `shared:` declares the same way. Every slot already declared
changes nothing at the root, and unsetting a step's `shared:` removes no declaration.

*Pins 005 §6.2, §9.1, 001 §9.1.* A slot published and never declared; a declaration written twice;
a `writers: any` rule overwritten; a declaration taken back with its last writer.

### B1.18 An alias renamed is renamed where the steps say it, and an insert says what it named

`api.rename` of `regress-api` to `regress`, and an `api.update` whose binding carries the new
alias, leave no `operation: regress-api#…` in the file and every one reads `regress#…`; nothing else
in the steps changes. A result with a `step.insert` or `step.duplicate` in it carries `inserted`
with their ids in order, and one without carries no `inserted` key.

*Pins 005 §5.5, §5.1, §9.1.* A renamed alias that turns every step of the API red; a caller left to
guess a derived id.

### B1.19 A shared script joins `functions.use:`, and leaves it

`functions.use` on a flow with no `functions:` writes `functions:` with `use: [ ./scripts/helpers.js ]`
where §5.2 reads the block; on `use: ./a.js` it writes `use: [ ./a.js, ./b.js ]`; on a block-style
list it appends one line in that style and touches nothing else in the block; a path already listed
is `changed: false`. `functions.unuse` removes the path, removes `use:` with its last path, and
removes `functions:` when nothing else is declared in it — and keeps the block when the flow defines
a function of its own there. `readFlowEditModel` reports `functions` as the paths written, in order.

*Pins 005 §6.2, §9.1, §9.2, 001 §8.6.* A path listed twice; an empty `functions:` left behind; a
flow's own helper deleted with the last shared file.

### B1.20 The flow's own `config:` is created, patched and removed

`config.patch` setting `validateSchema: false` on a flow with no `config:` writes the block at the
root, after the last block §5.2 reads before it. On a flow that has one, a new key lands in the
schema's order beside the keys already there, an existing key is overwritten in place with its
trailing comment intact, and `unset` deletes a key rather than writing its default out. Unsetting the
last key removes the block; an `unset` against a flow with no block changes nothing and reports
`changed: false`. A key outside §5.2's block is refused `unknown-field` with the text unchanged. The
model carries the block as declared and nothing it does not declare, and offers its keys as
`vocabulary.configKeys`.

*Pins 005 §9.1, §9.2, §6.8, 001 §5.2.* A default spelled out instead of deleted; a `config: {}` left
behind; a block appended below `steps:`; a pane that reads an unwritten key as `false`.

### B1.21 A binding updated keeps what the draft does not model

`api.update` on a binding carrying a key this build does not model — `x-owner:`, or whatever a later
format version adds — leaves that key where the author wrote it, including when the edit clears every
key the draft *does* model, and the mapping stays a mapping because the unknown key holds it open. A
modelled key the draft omits is still removed, since omission is how the form clears one; a modelled
key written under a tag is kept, because §6.4 keeps it out of the draft in the first place. A binding
left with only its `source:` and nothing unmodelled collapses to §5.2's shorthand. A key the binding
gains lands in `BINDING_KEYS` order, and a trailing comment, the quoting and a flow-style mapping all
survive the write.

*Pins 005 §5.5, §9.1, §6.4.* A binding rebuilt from the draft, so an edit to the colour deletes the
keys the form never showed; a merge so complete that no field can be cleared.

### B1.22 A script is written as a block

A one-line script patched into `pre:`, into an output's `script:`, or into either `retry.shouldRetry`
is written as `|-` and reads back identical. An output that is a path stays the plain scalar it is. A
script already in the file, in whatever spelling its author gave it, is untouched by an edit to
another key.

*Pins 005 §9.1, 001 §8.2.* Three spellings of one kind of value in one file; a writer that reformats
what the edit was not about.

## 4. B2 — The canvas edits the document

Fixture: `designer-linear` open in the flow tab, no run.

### B2.1 An open flow is editable; a stored run is not

Open the flow. `flow-insert-after-a`, `flow-delete-*` (after selecting) and the ports are present,
and `flow-designer-state` reads *Saved*. Select a stored run from 002 §10's selector: every affordance
is absent, `flow-designer-readonly` names the run, and `flow-designer-edit` returns to *current* with
the affordances back.

*Pins 005 §4.* One predicate, two states, each said.

### B2.2 A finished live run stays read-only until closed

Run the flow and wait for it to end. The affordances stay absent and the badge reads that the run is
open; `flow-designer-edit` closes it and the graph is editable again, drawn from the file.

*Pins 005 §4.* The correction §4 records: results are not discarded on arrival.

### B2.3 Insert from the canvas, through the picker, to the file

Click `flow-insert-after-a`. The picker opens listing the fixture's one alias; search `create`; pick
the operation. A node appears between `a` and `b` with sequence edges either side, selected, with
the editor open on it and its id field reading the derived id; `flow-designer-state` reads *Unsaved
changes*; save. Read the file from the temp workspace: it differs from the committed fixture by
exactly two added lines.

*Pins 005 §5.1, §7.1, §9.1.* End to end, and on bytes; a new step the author has to find and click.

### B2.4 The empty flow offers its first request

Open `designer-empty`. The graph shows `flow-insert-first` with *Add the first request* and nothing
else; the legend shows the fixture's binding. Insert through the picker: the node appears alone, and
the file gains a `steps:` block after `apis:`.

*Pins 005 §5.1, §5.5, B1.6.* The create form's output is the builder's first input.

### B2.5 Delete rewires

Select `b`, press Delete. The graph shows a → c; the file has lost `b`'s lines and no others.

*Pins 005 §5.2.*

### B2.6 The graph waits for the engine

Stub `renderer:flow-describe` to delay 500 ms. Click `flow-insert-after-a`; pick an operation. For
the 500 ms, no node for the new step is drawn and the `+` shows its pending state; then the node
appears.

*Pins 005 §5, 002-C R4.* The renderer draws no node the engine has not described. An implementation
that painted the node from the edit it sent would show it at once and fail this.

### B2.7 A port drag writes `depends:`

Drag `flow-port-out-a` onto `flow-port-in-c`. `c`'s edge from `b` becomes a declared edge from `a`
(002 §5.3's distinction), and the file's `c` gains `depends: [a]` on one line. Dragging `a` onto `b`
— already joined by the sequence — offers no drop and writes nothing.

*Pins 005 §5.4.*

### B2.8 An edge control removes a declared dependency

Hover the declared edge from B2.7; `flow-edge-remove-a-c` removes it; `c` gains its sequence edge
back and the file's `depends:` line is gone.

*Pins 005 §5.4.*

### B2.9 The legend adds a binding, and the picker offers it before save

Click `flow-legend-add`; choose a second spec; the alias shown is derived from its filename. Confirm.
The legend lists the new alias with no swatch; `flow-designer-state` reads *Unsaved changes*. Open the
picker: the new alias is in the rail and lists its operations. Save: the file's `apis:` has one new
entry, written relative to the flow's directory.

*Pins 005 §5.5, §9.3, §9.4.* The draft overlay on `flow-list-operations`, and the legend listing what
is declared.

### B2.10 Removing a used binding is refused with its steps named

Open the legend menu for the fixture's alias; choose remove. The dialog names every step using it
and writes nothing.

*Pins 005 §5.5, §9.1.*

### B2.11 An ambiguous operation is shown and not selectable

A fixture spec declaring `getThing` twice: the picker lists it marked `flow-operation-ambiguous-…`,
disabled, with the method-and-path reference for the same operation offered beside it.

*Pins 005 §5.1, 001 §6.5.*

### B2.12 A library is offered, and inserted as a `uses:` step

Open `designer-linear`; click `flow-insert-after-a`. The picker's rail ends in `flow-operation-libraries`;
under it, the workspace's `sign-in.flow.yml` (`meta.library: true`) is listed as `flow-library-sign-in.flow.yml`
and the flow itself is not. Pick it: a node `sign_in` appears between `a` and `b` carrying the sub-flow
marker, wired by the sequence. Save and read the file: it differs from the committed fixture by exactly
`- id: sign_in` and `uses: ./sign-in.flow.yml`. In the pane's Jest: a library outside the flow's
workspace is not listed; a flow that binds no API still lists its libraries rather than the empty
message; the picker opened from *Change…* has no Libraries entry.

*Pins 005 §5.1, §9.4, 001 §12.2.* A library the run could not reach, offered; a `uses:` written
absolute; a library offered in place of an operation.

### B2.13 The leading `+` writes a new first step

Open `designer-linear`; click `flow-insert-before-a` and pick an operation. The new node is drawn
first with a sequence edge to `a`, `flow-insert-before-<new>` now leads and `flow-insert-before-a`
is gone. Save and read the file: it differs from the committed fixture by exactly the two new lines,
and they precede `- id: a`. No `depends:` is written on `a`.

*Pins 005 §5.1, 001 §9.1.* A new head that rewrites the old head's `depends:`; a leading control
drawn on a step other than the file's first.

### B2.14 A binding edited keeps what the form does not draw

Open `designer-linear` with a binding carrying `rateLimit:`, `defaultHeaders:` and a colour. Edit it
from the legend: the rate is in the form as the file wrote it. Change the base URL and set nulls to
*tolerated*; confirm. The `api.update` carries the colour, the rate, the headers it never drew and
`strictNulls: false` — `api.update` replaces the binding with what it is handed (§9.1), so a field
the dialog dropped is a field an edit to the colour deletes.

*Pins 005 §5.5, §9.1, 001 §6.2, §10.1.* A dialog that writes only what it renders; a `strictNulls:
false` dropped as falsy.

### B2.15 Clearing the selection opens the flow's own settings

Open `designer-linear`. With nothing selected the sheet below the graph is the flow's settings, and
`validateSchema` reads *default — on* rather than *off*. Choose *off*: one `config.patch` sets it.
Choose *default* again: one `config.patch` unsets it. On the *runs* tab, `concurrency` emptied unsets
the key and a field inside `retry:` rewrites that map around the one entry it edits. Select a step —
the sheet is the step editor; click the drawing's background, or press Escape, and it is the flow's
settings again.

*Pins 005 §6.8, §6.5, §9.1, 001 §5.2.* A pane reachable only by re-clicking the selected node; a
flow-level flag offering *inherit*; a cleared field writing the default out.

## 5. B3 — Opaque fields

### B3.1 A tagged value is opaque, in the model and in the editor

`readFlowEditModel` of `designer-tagged` reports `body` with tag `!file` and `outputs` with tag
`!...` under the step's `opaque`, and neither under `fields`. In the app, selecting the step shows
both under `flow-step-opaque` with the tag, and `flow-step-open-yaml-body` opens the YAML tab at the
`body:` line.

*Pins 005 §6.4, §9.2.*

### B3.2 A patch beside a tagged value leaves it byte-identical

`step.patch` setting `timeout` on the tagged step leaves `body: !file ./fixture.json` and
`role: !...` as written.

*Pins 005 §9.1.* The `meta.spec.js` "silently wrong" case, one level down — the identity tag table is
what makes this pass, and using the engine's resolving table instead yields `!file "[object Object]"`.

### B3.3 Every position the format allows a tag is covered

One fixture per position §12 lists — `body`, `vars.*`, `dataset.source`, `outputs.<name>`, a key of
`query`/`headers`/`body` suppressed with `!...`, `with.*` — each surviving a patch to an unrelated key
and each reported opaque when its own step is read.

*Pins 005 §12.* The list is believed complete, and this is where a missing position shows up.

## 6. B4 — The step editor writes what it names

Fixture: `designer-linear`, step `b` selected, flow editable.

### B4.1 A header committed on blur is one line in the file

On the Request tab, add a row `X-Trace: {{flow.runId}}` and blur. The graph is unchanged (a header
changes no edge), `flow-designer-state` reads *Unsaved changes*, and after save the file's `b` has a
`headers:` block with that one entry, placed after `query:` had there been one — the schema's order.
The YAML tab, if open, shows it.

*Pins 005 §6.2, §6.3, §7.1.*

### B4.2 A field reads as written, not as normalized

`b` declares no `timeout`. The Flow tab's timeout field is blank with the inherited value as its
placeholder, not populated with 001 §5.3's default. `failOnStatusCode` shows *inherit*, with what
`config:` says beside it.

*Pins 005 §6.2, §6.5.* The normalized model is the wrong source, and this is where reading from it
shows.

### B4.3 The flags are tri-state, and *inherit* deletes the key

Set `failOnStatusCode` to *off*: the file gains `failOnStatusCode: false`. Set it back to *inherit*:
the line is gone, not `failOnStatusCode: true`. On a flow whose `config:` says `false`, the same
sequence never writes `true`.

*Pins 005 §6.5.* The silent-override case, in both directions.

### B4.4 A refused edit stays on the field

Rename `b` to `a`. The id field shows the engine's `duplicate-step-id` message under
`flow-step-refusal`, keeps `a` in the field for correction, and `flow-designer-state` still reads
*Saved* — the document did not change.

*Pins 005 §6.3, §9.1.*

### B4.5 Rename counts what it dangled

Rename `b` to `fetch` where `c`'s `when:` references `steps.b`. The id field shows *1 reference to the
old name*, the node for `c` carries the diagnostic, and the file's `when:` line is as written.

*Pins 005 §6.6.*

### B4.6 Seed from spec is explicit and says when there is nothing

On a step whose operation declares a request example, `flow-step-seed-body` replaces the body with it
and the file gains the block. On one whose operation declares none, the control states that and writes
nothing.

*Pins 005 §6.7.*

### B4.7 A `uses:` step offers the tabs 001 allows it

Select a `uses:` step: Overview, Flow, Outputs and Settings are offered; Request and Assert are not.

*Pins 005 §6.2, 001 §12.4.*

### B4.8 The operation can be changed, and the id does not

From the Overview tab, reopen the picker and choose another operation. The file's `operation:` line
changes; the `id:` line does not.

*Pins 005 §6.2, §5.1.* An id is the author's once written.

### B4.9 A `uses:` step lists its library's exports first

Open `fulfillment`, select `sign_in`, open the Outputs tab. `flow-step-exports` heads the tab, named
for `./sign-in.flow.yml`, and `flow-step-export-token` reads `steps.sign_in.token` with the source
the library gives it, `steps.authenticate.token`; the step's own Outputs table sits below. In Jest: a
library exporting nothing says so, one the engine could not read says that instead, and an
operation step lists no exports. The engine side: a described `uses:` node carries `exports` as the
library declares them, and none when the target could not be read.

*Pins 005 §6.2, 002 §11.1, 001 §12.1.* A renderer that opens the library to find out; a library
that could not be read shown as one that exports nothing.

### B4.10 A script computed before the request is written under `pre:`

Open `designer-linear`, select `b`, open the Scripts tab: `flow-step-scripts` says the step computes
nothing. `flow-step-script-add`, name the entry `timestamp` in `flow-step-script-name-0`, type a
script into its editor. Save and read the file: `b` gains `pre:` with `timestamp:` holding the
script. In Jest: an entry with no name writes nothing; an edit to one entry's script writes the whole
mapping with the others as they were; removing the last entry unsets `pre`; a `uses:` step is not
offered the tab.

*Pins 005 §6.2, 001 §8.7.* A pre-request script an author cannot find; a half-typed entry written
under an empty name.

### B4.11 A shared script is added to the flow from the Scripts tab

Open `designer-linear`, select `b`, open the Scripts tab: `flow-step-shared-scripts` says the
flow uses no shared script, and `flow-step-shared-script-add` offers the workspace's
`flows/scripts/helpers.js`. Choose it: `flow-step-shared-script-0` reads `./scripts/helpers.js`.
Save and read the file: it differs from the committed fixture by `functions:` and
`use: [ ./scripts/helpers.js ]`. Remove it and save: the file is the committed fixture again. In
Jest: a script already used is not offered; the tab says when there is nothing to add.

*Pins 005 §6.2, §9.4, 001 §8.6.* A `use:` written absolute; a script offered twice; a helper the
author cannot reach from the designer.

### B6.7 `functions.use` is relativized by the host

A `functions.use` or `functions.unuse` whose `source` is absolute arrives at `applyFlowEdits`
relative to the flow's directory, with `./` and POSIX separators — and the two round-trip: use then
unuse leaves the text as it was.

*Pins 005 §9.4, 001 §8.6.*

### B4.12 The body box is the size of the body

Open a step whose body is two lines: the box is about three lines tall, not twelve. Open one whose
body is forty: the box is as tall as the ceiling and the body scrolls inside it, with the fields
below still on the tab. Paste a minified payload on one line into a wrapping editor: the box takes
the rows it *drew*, not the one line it holds. Type a new line and the box grows by one; delete it
and the box shrinks back. Nothing oscillates — sizing the box resizes the editor it contains, and
that second measurement settles.

*Pins 005 §6.7.* A box fixed at a height that suits no body; a line count that ignores wrapping; a
measurement loop between the box and the editor inside it.

### B4.13 The model carries the vocabularies, and the derived one stays derived

`vocabulary.operators` is every operator 001 §10.2 accepts — the aliases `==` and `!=` included, so
a file written with one meets a control that offers it. `vocabulary.unaryOperators` is the subset
that takes no operand, derived from the evaluator's own table by arity rather than listed again, so
an operator added to the engine cannot be missed off it.

*Pins 005 §9.2, 001 §10.2.* A renderer's own copy of the operator list; an alias a control cannot
show; a unary list that drifts from the evaluator.

### B4.14 An assertion is edited as its three parts

Open a step whose `assert:` holds a line, a mapping and a bare expression. Each is one row of
`expr · op · value`; the bare one reads `isTruthy` with no operand. Edit the value of the first: the
patch writes that row as a line and hands the other two back exactly as the file held them — the
mapping still a mapping, the bare expression still bare. Choose an operator that takes no operand:
the value cell empties and disables, and the line is written without one. The operator list is the
engine's, `==` included; an operator the engine does not list still shows as the row's own.

*Pins 005 §6.2, §9.2, 001 §10.2.* A tab that reformats every assertion in a file the first time one
is touched; a dropdown that drops the operator a row was written with.

### B4.15 A field says whether it takes a script or an expression

The Scripts tab's `pre:` section, an output's column and *Retry when* carry the script marker; the
Assert section and *Runs only when* carry the expression one. Hover either: the tooltip appears at once —
the app's own, not the browser's second-long one — and the script marker says the flow's shared
functions are in scope while the expression marker says they are not and that the value should be
computed in an output and asserted on. Both sentences are the marker's accessible name as well as
its tooltip. A `shared:` slot carries no marker — it is a name, not a value to
compute.

*Pins 005 §6.2a, 001 §8.2, §8.6, §10.2.* Two positions that look alike and behave differently; a
shared function in an assertion failing as an ordinary assertion with nothing said about scope; an
icon whose meaning is only in the commit that added it.

### B4.16 An output names its source

The Outputs table reads each of §8.1's five forms as its own source — a body path, a header, the
status, a `pre:` value, a script — and offers them from the engine's vocabulary. Set a row to
*Script* and type a function: the file gains `{ script: … }`, not a string the engine would read as a
path. A status row's value cell is empty and disabled, and writes `{ from: status }`. A `pre:` path
equal to the output's own name is omitted. A body path is written as the shorthand. A row nobody
touched keeps the form the file wrote it in, and clearing every row unsets the block.

At most one editor sits under the table, headed by the output it belongs to and sized to the script
it holds. There is none until a script row is entered; entering another moves it there; focus moving
from the row into the editor keeps it, and focus leaving the section takes it away. A row that is not
a script opens none, and editing changes only the output the editor is on.

A row with no name yet is not written — §8.1 publishes an output under its name — and is kept in the
table anyway, in its place. Every blur in the section commits, so a row dropped by one takes what was
typed into it.

*Pins 005 §6.2, §9.2, 001 §8.1, §8.7.* A script reachable only by editing the YAML; a one-column
table where a bare value silently means a body path; a function typed into a table cell; a row
deleted mid-edit because the document could not hold it yet.

### B4.17 An output that resolved to nothing is listed as undefined

Run a step declaring two outputs where one path misses. The response pane lists both: the one that
resolved with its value, the one that did not as *undefined*. A value recorded under a name the
description no longer declares is listed after them. A step that declares none and produced none
shows no Outputs block at all.

*Pins 005 §6.2, 002 §11.1, 001 §8.1.* An output that found nothing rendering as no row, so the pane
opened to diagnose it is the one place that says nothing.

### B4.18 Every script position is edited in a script editor

`pre:` entries, an output's script and `retry.shouldRetry` are each a `CodeEditor` with JavaScript
highlighting and the code font the preferences chose — not a text box that happens to hold code.
Editing the retry predicate commits the whole `retry:` block with the other fields intact.

*Pins 005 §6.2, 001 §8.2.* A function typed into a two-row box; one script position treated unlike
the others.

### B4.19 The functions a flow defines are edited beside the files it reads

The Scripts tab lists §8.6's inline definitions under the shared scripts, each a name and a
`CodeEditor` — the same shape as a `pre:` entry, which is what they are one level up. Editing one
writes the whole block through `functions.define`, leaving `use:` exactly as it was; the block is
created for a flow that has none, removed when neither half has anything left, kept while it still
reads files. A definition called `use` is refused. Each source is written as a block scalar.

*Pins 005 §6.2, §9.1, §9.2, 001 §8.6.* Inline definitions invisible in the builder; a write to one
half of `functions:` clobbering the other.

### B4.20 A condition says whether it is an expression or a script

`when:` is a row per condition with the kind it is. A bare condition reads as the list of one §9.3
makes it; the script form opens in an editor. Changing a row to *Script* writes `{ script: … }`; a
lone expression is written as the bare string rather than a list of one; a condition nobody touched
keeps the form the file wrote it in, and clearing the last one unsets the key. Each row carries the
marker for its kind, so what is in scope is said per condition.

*Pins 005 §6.2, 001 §9.3, §8.2.* A script form reachable only by typing its JSON; a bare condition
turned into a list of one by an unrelated edit.

## 7. B5 — One draft, two surfaces, and the run control

### B5.1 A YAML edit redraws the flow tab before save

Open both tabs on `designer-linear`. Type a fourth step in the YAML tab. Switch to the flow tab: the
fourth node is drawn, `flow-designer-state` reads *Unsaved changes*, and the file on disk is the
original until save.

*Pins 005 §7.1.* 002 §4.3's "the run view keeps describing the file on disk", narrowed to while a run
is open — this asserts the new rule, which no 002-C scenario covers in either direction.

### B5.2 A structured edit is visible in the YAML tab

Delete `b` from the canvas. The YAML tab's editor shows the text without `b`, and its own save state
agrees with the designer's.

*Pins 005 §7.1.* One string.

### B5.3 An external change while dirty is reported in the designer

Make a structured edit; then change the file on disk from outside. `flow-designer-state` reads
*Unsaved changes — the file also changed on disk*, and the draft keeps the edit.

*Pins 005 §4, 002 §4.3.* The designer user who never opens the YAML tab must still see this.

### B5.4 Undo is structured, and a text edit ends it

Insert a step, then ⌘Z in the flow tab: the node is gone, the state reads *Saved* (the buffer matches
disk again). Insert again, type one character in the YAML tab, return to the flow tab and ⌘Z: nothing
happens — the structured history was cleared.

*Pins 005 §7.3.*

### B5.5 An edit the buffer overtook is discarded and said

Stub `renderer:flow-apply-edit` to delay 500 ms. Click delete on `b`; within the delay, type in the
YAML tab. The delete does not land, the typed text is intact, and `flow-step-refusal` (or the toolbar)
says the document changed while the edit was being applied.

*Pins 005 §7.2.*

### B5.6 Run saves first

With the draft dirty and parsing, the run control reads *Save & run* (`flow-run-saves-first`).
Press it: the file on disk gains the edit, then the run starts, and the run's recorded description
(002 §10) is the edited graph.

*Pins 005 §8.* A run over the previous version would record the previous graph.

### B5.7 An unparseable draft disables the run control and the affordances

Break the YAML in the YAML tab. In the flow tab the run control is disabled with the parse error, the
affordances are absent, and `flow-designer-readonly` says the file does not parse. Fix the YAML: both
return.

*Pins 005 §4, §8.*

### B5.8 `changed: false` dirties nothing

Drag a port onto a pair already joined by the sequence, through a path that reaches the engine (the
port declines, so this is asserted at the thunk with a mocked reply of `changed: false`): the buffer
is not marked dirty and no undo entry is pushed.

*Pins 005 §7.3, §9.1.*

### B5.9 Revert goes back to the text the session started from

A flow is opened, edited, and saved — by hand or by auto-save — and then edited again. **Revert**
beside the save state restores the text the session opened with, not the text of the last save, and
the buffer is left dirty rather than the file being written. The discarded draft is on the undo
history, so ⌘Z brings it back. The control is offered whenever the draft differs from the opening
text, including while the buffer reads *Saved*, and the buffer being replaced from disk re-takes the
baseline.

*Pins 005 §7.4.*

## 8. B6 — The host boundary

Jest, beside the handlers, in the file and pattern 002-C §7 established.

### B6.1 `flow-apply-edit` writes no file

Call `applyFlowEditHandler` with a valid edit. The result carries the new text; the file on disk is
byte-identical to before the call.

*Pins 005 §9.4.* The assertion that pins the transform-not-write shape.

### B6.2 The three handlers enforce the scope

Each of `applyFlowEditHandler`, `readFlowEditModelHandler`, `listFlowOperationsHandler` rejects an
`entry` outside the scope root, and one that is not a `.flow.yml`, as 002 §11.3's read channels do.

*Pins 005 §9.4.*

### B6.3 The draft overlay reaches both reads

`readFlowEditModelHandler` and `listFlowOperationsHandler` given `content` answer about that text and
not the file's — a binding present only in `content` lists its operations.

*Pins 005 §9.3, §9.4, §5.5.*

### B6.4 `api.add` is relativized by the host

An `api.add` whose `binding.source` is absolute arrives at `applyFlowEdits` relative to the flow's
directory, with POSIX separators, and with `./` on a bare filename — as 002 §4.1c writes it.

*Pins 005 §9.4.*

### B6.5 One unreadable binding does not empty the picker

A flow binding one readable document and one missing file: `listFlowOperationsHandler` resolves with
both aliases, the first with its operations and the second with `error` and none.

*Pins 005 §9.3.*

### B6.6 A `step.insert`'s absolute `uses:` is relativized by the host

A `step.insert` whose `step.uses` is absolute arrives at `applyFlowEdits` as 001 §12.2 resolves it:
`./`-relative to the flow's directory where the library lies under the flow's scope root;
`workspace:`-prefixed and relative to the workspace root where a collection flow reaches a library
outside its collection; and untouched where it lies under neither, for the engine to report.

*Pins 005 §9.4, 001 §12.2.*

### B6.8 The edit model carries every name a script may call

A flow using a raw `.js` library and declaring an inline function: `readFlowEditModelHandler` answers
with `functionNames` carrying the helpers the file declares *and* the inline name. A `use:` entry
that cannot be read leaves the model intact, with the inline names alone.

*Pins 005 §9.2, 001 §8.6.* The linter in every script box knows the sandbox globals and nothing else,
so a helper that is genuinely in scope reads as *is not defined* — and an author who learns to ignore
the linter has lost the real warnings with it.

## 8a. B7 — Operations are the engine's list

Jest, in `operations.spec.js`, against `listOperations` and `listFlowOperations` directly.

### B7.1 The list is de-duplicated by identity

A document whose every operation declares an `operationId` lists each operation once, though the
index stores it under two keys.

*Pins 005 §9.3.* `new Set(spec.operations.values())` is the operation set because `indexDocument`
stores the same object twice; iterating keys lists everything with an id twice.

### B7.2 An ambiguous id is marked and referenced by method and path

A document declaring `getThing` on two paths lists both, each `ambiguous: true` with the
`operationId` still reported, and each with a `reference` in the `METHOD /template` form.

*Pins 005 §9.3, §5.1, 001 §6.5.*

### B7.3 Summary, description, tags and deprecation come from the document

Each is read off the raw operation object, absent when the document omits it; `tags` is `[]` rather
than absent, and `deprecated` is `false` rather than absent.

*Pins 005 §9.3.*

### B7.4 The fallback reference round-trips

For a document with no `operationId`s, every `reference` resolves through `resolveOperation` to the
operation it names.

*Pins 005 §9.3, 001 §6.1.* The normalization is the engine's; this is the proof the picker's output is
the run's input.

### B7.5 Swagger 2 and OpenAPI 3 list the same way

The same operations, described in each document form, produce the same summaries.

*Pins 005 §9.3.* `indexDocument` already reads both; the list must not re-derive either.

### B7.6 One unreadable binding does not fail the call

A flow binding one readable document and one missing file resolves with both aliases — the first
listing its operations, the second carrying `error` and none, and no `resolved`.

*Pins 005 §9.3.* B6.5 asserts the same through the handler.

### B7.7 A flow that does not parse lists no aliases

`listFlowOperations` over unparseable text resolves with `{ apis: [] }` rather than rejecting.

*Pins 005 §9.3.* The picker over a broken draft is empty, not broken; §4 keeps the affordance that
opens it withheld anyway.

## 9. Regressions not owned by a single scenario

### R7 — The renderer describes and writes nothing itself

002-C R4's structural test — no YAML parser imported under `fork/flows/` — recurses, so every
directory 005 adds is covered as it is created. This extends the assertion: no module under
`fork/flows/` imports `@bruno-max/flow`, and no module under it constructs a `.flow.yml` string
(asserted by grepping the module graph for `version: 1` and `steps:` literals outside test files).

*Pins 005 §1, §9.* The picker is the module most tempted — it has a parsed spec within reach in the
store — and B2.9's draft-overlay case is what it would fail.

### R8 — The upstream touchpoint set is unchanged

002-C R5's diff against the upstream merge base, re-run: the set of upstream files touched is exactly
002 §12.1's table. 005 adds no row.

*Pins 005 §10.*

### R9 — The existing conformance suites are untouched

002-C's Playwright suite and `meta.spec.js` pass with no edits after every 005 increment. Two Jest
tests are rewritten because their *docstrings* become false under §7.1 — the run tab now draws the
draft, and every open flow tab has a source — and B5.1 is what replaces the claim they made.

*Pins 005 §9.5.* A green test asserting the opposite of its name is worse than a red one.

## 10. Not covered here

- **Engine semantics.** 001-C owns them; a scenario here that could fail because `describeFlow` drew
  the wrong edge is misfiled.
- **Visual appearance** of the affordances. Presence, placement relative to nodes, and state are
  asserted; pixels are not.
- **The YAML tab itself.** 002-C U4.11–U4.17 own it; §7 asserts only what crosses between the two
  surfaces.
- **The create form.** 002-C's; B2.4 starts from its output.
- **Performance of the picker over a large document.** 005 §12's open question; measured, not
  asserted.

## 11. Traceability

| Scenario | Pins | The wrong implementation it catches |
|---|---|---|
| B1.1–B1.3 | §9.1 | A writer that normalizes on read; a re-serializer that drops comments, anchors or flow style |
| B1.4, B1.5 | §5.1, 001 §9.1 | An insert that writes `depends:` and turns two-line diffs into rewiring |
| B1.6, B1.10, B1.11 | §9.1 | A block or key appended where the format reads it first |
| B1.7 | §5.2 | `steps: []` left behind; a delete that repairs neighbours |
| B1.8 | §6.6 | A rename that rewrites references on a guess |
| B1.9 | §5.1 | Two flows naming one operation two ways; an id the format rejects |
| B1.12–B1.14 | §9.1 | A refusal that rebuilds the document; a schema gate that refuses the first step |
| B1.15 | §6.4, 001 §15 | An unknown key dropped by an edit to its own step |
| B1.16 | §9.1 | Composition by re-parsing |
| B1.17 | §6.2, §9.1 | A slot published and never declared; a declaration taken back with its writer |
| B1.18 | §5.5, §5.1, §9.1 | A renamed alias that reddens every step of the API; a derived id the caller must guess |
| B1.19 | §6.2, §9.1, §9.2 | A path listed twice; an empty `functions:` left behind; a flow's own helper deleted |
| B1.20 | §9.1, §9.2, §6.8 | A default written out instead of deleted; a `config: {}` left behind |
| B1.21 | §5.5, §9.1, §6.4 | A binding rebuilt from the draft; a merge that leaves no way to clear a field |
| B2.14 | §5.5, §9.1 | A binding's unrendered fields deleted by an edit to the ones that are |
| B2.15 | §6.8, §6.5 | Flow-wide settings reachable only in the YAML; a tri-state pointing at a value nothing shows |
| B2.1, B2.2 | §4 | Affordances on a record; a finished run discarded on arrival |
| B2.3–B2.5 | §5.1, §5.2, §7.1 | A canvas that draws the right node and writes the wrong file |
| B2.6 | §5, 002-C R4 | A node painted before the engine described it |
| B2.7, B2.8 | §5.4 | A drop that duplicates the sequence; a declared edge with no way back |
| B2.9–B2.11 | §5.5, §9.3 | A binding that vanishes when added; a picker that offers what the run refuses |
| B2.12 | §5.1, 001 §12.2 | A library the run could not reach; a `uses:` written absolute; a library in place of an operation |
| B2.13 | §5.1, 001 §9.1 | A new head that rewrites the old head's `depends:` |
| B3.1–B3.3 | §6.4, §9.1, §12 | A fixture destroyed by an edit to its neighbour |
| B4.1 | §6.2, §6.3 | A commit per keystroke; a key appended out of order |
| B4.2, B4.3 | §6.5 | A checkbox that silently overrides `config:` |
| B4.4, B4.5 | §6.3, §6.6 | A refusal that clears the field; a rename that says nothing about what it broke |
| B4.6 | §6.7 | A body seeded nobody asked for; a schema guessed as an example |
| B4.7, B4.8 | §6.2, 001 §12.4 | A `uses:` step offered a body; a re-picked operation renaming the step |
| B4.9 | §6.2, 002 §11.1 | A renderer that opens the library; an unreadable library shown as exporting nothing |
| B4.10 | §6.2, 001 §8.7 | A pre-request script nobody can find; an entry written under an empty name |
| B4.11 | §6.2, §9.4, 001 §8.6 | A `use:` written absolute; a script offered twice |
| B5.1, B5.2 | §7.1 | Two drafts of one file |
| B5.3 | §4 | A divergence the designer never shows |
| B5.4 | §7.3 | Undo restoring text from before a hand-typed line |
| B5.5 | §7.2 | A late edit overwriting a keystroke |
| B5.6, B5.7 | §8 | A run over the previous file; a run over text that does not parse |
| B5.8 | §7.3 | A no-op edit dirtying the buffer |
| B5.9 | §7.4 | Ten edits undone one keystroke at a time; a revert that overwrites the file |
| B6.1 | §9.4 | An edit channel that writes |
| B6.2–B6.7 | §9.3, §9.4 | A handler outside the scope; a picker emptied by one bad binding; a `uses:` or a `use:` the run resolves elsewhere |
| B6.8 | §9.2 | A helper in scope, underlined as undefined |
| B7.1–B7.7 | §9.3, 001 §6.1, §6.5 | Operations listed twice; an ambiguous id offered as resolvable; a reference the run cannot resolve |
| R7 | §1, §9 | A renderer that reads a spec or writes YAML on its own |
| R8, R9 | §10, §9.5 | An upstream edit; a 002 scenario broken by the draft swap |
