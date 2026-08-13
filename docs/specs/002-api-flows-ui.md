# 002 — API Flows UI (run & observe)

**Status:** Draft — the three questions 001 owed this spec are answered; §14 carries one of its own,
local to `readCapture`'s options
**Owner:** Jake Campbell
**Last revised:** 2026-08-12

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
| **§8** | Watching a run — events, node states, concurrency, iterations |
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
| `describeFlow`, `listRuns`, `readCapture` | §11.1, §11.2 | `bruno-electron`, and the future builder |
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
6. **Near-zero upstream footprint.** Two lines in one upstream file beyond what 001 §13.4 already
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

```
FLOWS
  Workspace
    e2e-checkout.flow.yml
    shared/
      login.flow.yml                 (library)
  payments
    refund.flow.yml
```

Library flows (001 §12.5 — a flow declaring `params:`) are marked, because they are excluded from
glob runs and running one requires supplying parameters. This is the app's equivalent of
`bru flow list` marking them.

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

**The watcher parses nothing.** `apiSpecsWatcher` parses each file to extract `info.title`; the flow
watcher reports path, filename and mtime only, and the display name comes from `describeFlow` (§11)
when the flow is opened. A malformed flow must still appear in the sidebar so it can be opened and
its diagnostics read — a watcher that parsed would have to decide what to show for a file that does
not parse, which is a question §6 already answers better.

### 4.2 The flow tab

One tab type, `flow`, keyed on the flow's pathname. It is an ordinary closable tab — the
non-closable set (`NON_CLOSABLE_TAB_TYPES`) is for workspace-level surfaces that always exist, and a
flow is a file.

**Run state is keyed by flow path in the slice, not by tab.** Closing the tab of a running flow does
not cancel it, and reopening the flow reattaches to the run in progress. The alternative — tying a
run's lifetime to a piece of UI — makes an accidental ⌘W destroy a run that has already created
resources, and 001 §11.3 is explicit that cancellation runs cleanup under a grace window. A run
ending because a tab closed would skip that path entirely.

Cancellation is therefore always explicit, from the run control — or from quitting the app.

#### Quitting with a run in flight

**The app cancels the run through 001 §11.3's path before it closes**, rather than letting the
engine die with the process. In-flight requests are aborted, steps declaring `status: [cancelled]`
get their cleanup within `config.cleanupGrace`, the run is recorded `cancelled`, and the window then
closes.

This hooks the quit flow the app already has: `main:start-quit-flow` today prompts about unsaved
requests through `providers/App/ConfirmAppClose/`. A run in flight has the stronger claim on that
path — an unsaved request loses text the user can retype, while a killed run leaks whatever the flow
created, on a real API.

The comparison that settles it is the CLI: Ctrl-C on `bru flow run` runs cleanup. An app that
skipped it would be strictly worse than the terminal at the one thing 001 §11.3 exists to guarantee.

**No run state is persisted across a restart.** The snapshot middleware deliberately excludes
request and response bodies, and `.bruno-runs/` already holds the whole run. On restart the flow tab
reopens through the ordinary tab-restore path and §10's selector shows the run — including the one
that was cancelled by the quit — read from disk like any other. Persisting results in the snapshot
would be a second store of data the captures own, and the two would drift.

The tab has two views over the same flow, toggled in its header:

- **Graph** (default) — §5.
- **Document** — the raw `.flow.yml`, read-only, with diagnostics anchored into it (§6).

The run record (§8–§10) is a pane below both, so a step's outcome is visible beside the graph node
or the source line that produced it.

## 5. The graph

### 5.1 What is drawn

A node per step, rendered as inline SVG in fork code. Nodes are laid out in ranks; edges connect
them; both come from `describeFlow` (§11), so nothing about 001's semantics is recomputed here.

At rest a node carries the step's `id`, its `name` when it has one, and the resolved operation as
method and path — `POST /payments`, not `payments-api#createPayment`. The reference is what the file
says; the method and path are what the step *does*, and resolving them is the whole point of having
an engine describe the flow rather than reading the YAML.

Markers, shown only when the step carries the thing they mark:

| Marker | Means | 001 |
|---|---|---|
| `when` | The step is conditional | §9.3 |
| `↻ n` | Retry with `maxAttempts: n` | §11.1 |
| `⊂` | A sub-flow (`uses:`) | §12 |
| `!` | `failOnStatusCode: false` — a negative test | §10.3 |
| `⌸` | Reads or writes a shared slot | §9.1 |

The negative-test marker exists because a step that passes on a 403 is otherwise indistinguishable
from one that passes on a 200, and mistaking the first for the second is how a broken authorization
check reads as green.

### 5.2 Layout

**Ranks by longest path from a root; order within a rank by declaration order in `steps:`.**

Longest-path ranking places a step below every one of its dependencies, which is the property that
makes the drawing readable as execution order. Ordering *within* a rank by file order is the same
argument 001 §9.1 makes for last-writer-wins on shared slots: file order is stable and inspectable,
where any ordering derived from the run (completion time, duration) would redraw the graph
differently on a loaded machine than on an idle one, and moving nodes between runs is the fastest
way to make a visualization untrustworthy.

**The linear case degenerates to a single column, by construction.** A flow with no explicit
`depends` has one step per rank, so it renders as a vertical list — which is what 001 §9.1's
implicit-sequence rule is for. Branching is visible precisely because it is the exception.

Panning and zooming are not provided in v1. Flows are tens of steps; the graph is laid out to the
tab's width and scrolls vertically like any other document. If a real flow arrives that needs a
viewport, that is evidence for the graph library this spec declines to add (§13).

### 5.3 Edges

Five kinds, and the distinctions are load-bearing rather than decorative:

| Edge | Drawn | Why it is distinct |
|---|---|---|
| **Implicit sequence** | Solid, muted | It is not in the file. Drawing it identically to a declared edge hides the one thing about 001 §9.1 that surprises authors. |
| **Explicit `depends`** | Solid | Declared structure. |
| **Status-conditioned** | Solid, labeled with the status set | `[failed]` on the edge into a fallback branch is the difference between a branch that runs and one that never does. Unlabeled means the default `[success]`. |
| **Data (connector)** | Dashed, labeled with the output name | 001 §8.1's declared outputs — the feature's core claim is that data paths are named and drawable. This is where that is cashed. |
| **Shared slot** | Dashed, to and from a slot glyph | 001 §9.1's slots deliberately do not name a producer, so they cannot be drawn as a step-to-step edge without asserting a relationship the format denies. |

**These five are drawing treatments, not five values of `FlowEdge.kind`** (§11.1). Three of them —
implicit sequence, explicit `depends`, status-conditioned — are the `'sequence'` and `'depends'`
kinds, with the third distinguished by a non-empty `status` rather than by its own kind; the shared
slot is two kinds, `'slot-write'` and `'slot-read'`, because a slot edge has a direction and no
opposite endpoint. A renderer switching on `kind` alone draws a status-conditioned edge as an
ordinary one, which is precisely the mistake U1.3 exists to catch.

An `any` join (001 §9.1) is marked at the receiving node, because `all` and `any` differ in whether
the step runs at all and the incoming edges look identical otherwise.

**Data edges are toggleable and on by default.** On a flow where most steps consume the previous
one's output, control and data edges are largely parallel and the drawing is quieter with data
hidden; on a flow with real fan-out they are the interesting half. Neither default is right for both,
so it is a control rather than a decision.

**An undeclared dependency is drawn as a data edge in a warning style.** 001 §8.3 permits raw
`steps.<id>.body` access and has `validateFlow` report it as an undeclared-dependency warning.
Rendering it — rather than omitting it, which would make the graph claim a data path that exists in
the file does not exist — is what makes 001 §8.3's "declared outputs are drawn as edges" enforceable
by something the author looks at.

### 5.4 Sub-flows

A `uses:` step is one node, collapsed, marked `⊂`. Expanding it draws the sub-flow's own graph inline
beneath, with its steps under their namespaced ids (`auth/login`, per 001 §13.2 and §14.5).

Collapsed is the default because 001 §12 makes a sub-flow opaque by contract: the parent declares
`with:` and consumes `exports:`, and cannot reference internal step ids. A view that expanded by
default would show the caller structure it is specified not to depend on. Expansion exists because
when a sub-flow fails, its internals are exactly what you need.

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
- **A list in the tab header** — counts by severity, expanding to the full set. Diagnostics with no
  `stepId` and no position — a bad `apis:` binding, a scope-root escape — have nowhere else to go.

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

### 7.2 Run configuration

A panel beside the run control, following `RunnerResults/RunConfigurationPanel`'s shape:

| Control | Maps to |
|---|---|
| Environment | The `environment` tier of `RunOptions.variables` — see the scope split below |
| Variable overrides | `envVarOverrides` — the app's `--env-var` |
| Dataset | `overrides.dataset` (001 §9.4) |
| Concurrency | `overrides.concurrency` (001 §9.2) |
| Parameters | `params`, shown only for a library flow (001 §12.5) |
| Capture | Whether the run writes to `.bruno-runs/` — the app's `--no-capture` (001 §14.5). §9 states what the step pane shows when it is off |

**The renderer never assembles the variable tiers.** It sends the *selection* — which environment,
which overrides — and `bruno-electron` resolves each tier and hands `RunOptions.variables` to the
engine. 001 §13.2 is explicit that handing over a pre-merged map would let two hosts disagree about
precedence; a renderer that merged would make a third.

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

The Environment control for a workspace flow is therefore `EnvironmentSelector`'s **Global** tab, not
a new selector.

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

## 8. Watching a run

### 8.1 The event stream

`FlowEvent`s (001 §13.2) cross IPC on `main:flow-run-event` and fold into the flow slice. Events are
small and structured-clone-safe by contract, so nothing here needs to trim them.

**Events are batched per frame in the main process** before being sent, following
`main:mock-server-request-log-batch` (`bruno-electron/src/app/mock-server/mock-server.js:210`). A
run at `concurrency: 5` with polling steps emits `step:attempt` at request rate; one IPC message and
one dispatch per frame is the difference between a smooth graph and a renderer that spends the run
in reconciliation.

Batching preserves order within the batch, which is all 001 §13.2 guarantees anyway — it promises
`step:start` before `step:end` and both inside their iteration, and explicitly requires consumers to
key on `id` and `index` rather than assume adjacency.

### 8.2 Node states

A node is in exactly one state, and the four terminal ones are 001 §14.6's, unrenamed:

| State | From | Shown |
|---|---|---|
| pending | before `step:start` | outline only |
| running | `step:start` | animated border |
| retrying | `step:attempt` beyond the first | `attempt n/m` on the node |
| `success` | `step:end` | green, with status code and duration |
| `failed` | `step:end` | red, with the reason (001 §14.6) |
| `skipped` | `step:end` | muted, with the reason |
| `cancelled` | `step:end` | muted, distinct from skipped |

**The reason is on the node, not behind a click.** 001 §14.6 defines 14 of them and the distinctions
between four skip reasons are the substance of a run's outcome — `condition-false` is the flow
working, `unresolved-dependency` is usually a real failure that 001 §11.2 deliberately reports as a
skip. A UI that showed a uniform grey "skipped" would erase the distinction the vocabulary exists to
draw.

**`retrying` is a first-class state for the same reason.** 001 §11.1 makes polling the mechanism for
waiting on asynchronous state, and a 20-attempt poll that renders as "running" for a minute is
indistinguishable from a hang.

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

## 9. Inspecting a step

Selecting a node opens the step detail pane:

| Tab | Content |
|---|---|
| Request | The materialized request — method, resolved URL, headers, body — as sent (001 §7) |
| Response | Status, headers, body, duration |
| Assertions | Each `assert:` entry with `expected` and `actual`, from `StepResult.assertions` |
| Validation | Request-schema and response-schema outcomes (001 §10.1) |
| Attempts | One row per attempt when there was more than one |

**Bodies come from the capture, fetched on demand.** 001 §13.2 excludes bodies from events
deliberately — every event crosses IPC, and attaching payloads would serialize them twice for data
the UI needs only when a step is opened. Opening a step reads its capture through
`renderer:flow-read-capture` (§11.2); the pane shows a loading state for the moment that takes.

What the events *do* carry — status, reason, attempts, duration, assertion results, declared outputs
— renders immediately, so a step's verdict never waits on a file read.

**Declared outputs are shown with their values**, as the run's answer to "what did this step
contribute". This is the inspection counterpart to §5.3's data edges: the edge says a value moves,
the pane says what it was.

**Under `--no-capture`'s equivalent** — capture disabled in run configuration — the request and
response tabs state that captures were disabled rather than showing empty panels. Assertion and
validation outcomes still render, because they arrive in `StepResult`.

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
attempts, which is usually the only way to see what changed between them." §9's **Attempts** tab is
a row per call to this function, and a step-shaped return would have to carry all ten payloads to
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

The capture layout is a 001 contract (§14.5). A parser in the renderer would be a second reader of a
format the CLI writes, and the two would drift the first time the layout gained a field — the same
argument 001 §13.1 makes about request dispatch, applied to the artifact.

### 11.3 The IPC surface

| Channel | Direction | Purpose |
|---|---|---|
| `renderer:flow-describe` | invoke | `describeFlow` for one flow |
| `renderer:flow-run` | invoke | Start a run; resolves with the `runId` |
| `renderer:flow-cancel` | invoke | Abort a run by `runId` |
| `renderer:flow-list-runs` | invoke | `listRuns` for a scope |
| `renderer:flow-read-capture` | invoke | One step attempt's capture |
| `main:flow-run-event` | send | A batch of `FlowEvent`s (§8.1) |
| `main:flow-tree-updated` | send | Watcher: a flow file added, changed or removed |

All of it is registered by `registerFlowIpc` in a new `bruno-electron/src/ipc/flow.js` — the single
`require` + call that 001 §13.4 already claims in `bruno-electron/src/index.js`. `preload.js` passes
any channel through with no allowlist, so none of these needs an upstream edit.

The main process owns the `AbortController` per `runId`, assembles `RunOptions.variables` from the
renderer's selection (§7.2), and supplies the three ports. The renderer holds no engine state beyond
what the slice folds from events.

### 11.4 What 002 changed in 001

Writing this spec found three things in 001 that had to change. **All are applied**; they are
recorded here because the reasoning belongs with the spec that produced it, and because a reviewer
comparing the two documents should know which parts of 001 moved and why.

Only one is a change to a *contract* — and it is additive, so 001 §15's compatibility rules are not
engaged.

- **§14.5 — `run.json`, written at run start** (`runId`, flow path, `startedAt`), beside the
  `summary.json` written at the end. This is the contract change. A run's identity was recoverable
  only from a file that does not exist until the run finishes, so neither an in-progress run nor an
  interrupted one could be attributed to its flow at all — and listing the run currently being
  watched is §10's ordinary case, not an edge. 001-C's R4g2 covers the writer; 002-C's U4.8 and U4.9
  cover the reader.
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
  flows/
    slice.js                           # flows, describe results, run state keyed by flow path
    ipcEvents.js                       # registers the listeners in the table above
    FlowSidebarSection/index.js
    FlowTabPane/
      index.js
      FlowGraph/
        index.js
        layout.js                      # ranks -> coordinates
      StepDetail/index.js
      RunControls/index.js
      RunSelector/index.js
```

Electron-side code is two new files upstream does not have —
`bruno-electron/src/ipc/flow.js` and `bruno-electron/src/app/flowsWatcher.js`. The watcher starts
from inside `registerFlowIpc`, so it rides 001's existing entry and adds nothing.

### 12.1 The manifest delta

001 §13.4's table is the contract for the whole feature. Run & observe adds **one file and two
lines** to it:

| Upstream file | Edit | Lines |
|---|---|---|
| `packages/bruno-app/src/providers/App/useIpcEvents.js` | register fork IPC listeners, and call the returned disposer in the teardown | 2 |

**Two lines, not one, and the reason is structural.** Every listener in that file is registered as
`const removeXListener = ipcRenderer.on(...)` and then called in the `useEffect`'s returned cleanup
function. A single registration line without the matching teardown line would leak a listener across
hot reloads and re-mounts. The fork registers all of its listeners in one call returning one
disposer, so the count stays at two however many channels §11.3 grows.

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

**No new dependency.** The graph is hand-rolled SVG (§5.2), so `bruno-app/package.json` is untouched
and the rendering choice costs nothing at merge time. §13 records what that trades away.

## 13. Rejected alternatives

**A graph library — React Flow, or dagre for layout alone.** Both give pan, zoom, minimap and edge
routing immediately, and either would be the right base for the visual builder. Rejected for v1 on
two grounds: it adds a dependency to an upstream `package.json`, and this spec's graph is a *view* of
a document, where a library's value is concentrated in interactive editing. Revisit it with the
builder spec, which is where the interaction budget actually gets spent — reconsidering then costs a
rewrite of one component, since §11.1 keeps the graph model in the engine.

**Flows nested inside the collection tree.** Better adjacency, rejected on fork cost — §4.1.

**A separate tab type per run.** Comparing a red run to a green one by putting each in its own tab is
tempting, but it multiplies tab types for what is a selector, and 001 gives runs no identity outside
the flow that produced them. Diffing two runs is a real want and is recorded in §15.

**A renderer-side parser, for either the flow or the capture.** It would remove two IPC round-trips
and cost a second implementation of a 001 contract — §11.1 and §11.2.

**Live-run-only, with captures left to the CLI.** The smallest possible spec, and it fails goal 4: a
step that goes red in the app would send you to a terminal to find out why, which is the problem §1
describes.

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
