# 003 — Running flows in parallel

**Status:** **Accepted; implemented.** The three decisions are settled and recorded in §2–§4, and
all three are built — the CLI scheduler, the app's, and §4's suite strip. §5.2 holds what is still
open, none of it blocking.
**Owner:** Jake Campbell
**Last revised:** 2026-09-10

Today both hosts run a selection of flows strictly one at a time. This spec is about running several
at once, from `bru flow run` and from the app, and it is mostly about three choices that are not
the engine's to make.

## 1. Where we start

**The CLI is a sequential loop.** `packages/bruno-cli/src/fork/flow/index.js:859` is
`for (const file of flows) { outcomes.set(file, await attempt(file)); }`, and the retry loop below
it is the same shape.

**The app is too.** `runSuiteFlows` (`packages/bruno-electron/src/ipc/flow/index.js:730`) awaits
each `runSuiteFlow` in roster order.

**`config.concurrency` is not this.** It is a single run-wide budget *inside one flow* — parallel
steps, sub-flow internals and dataset iterations all draw from it (001 §9.2). Nothing today bounds
or schedules across flows, because nothing runs across flows.

### What is already ready

Three things do not need changing, which is most of why this is worth doing now:

- **Cookie jars are already isolated per run.** 001 §7.6 scopes a jar `${runId}:${iteration}`, so two
  flows in flight cannot see each other's session. This was decided for dataset iterations and
  happens to be exactly right here.
- **The IPC event channel is already per-run.** `pendingEvents` is keyed by `runId` and flushed one
  message per run, with the reason stated in place: 001 §13.2 guarantees order *within* a run and
  nothing across two, so a batch mixing them "would invent an ordering the engine never promised."
  Concurrent runs are the case that comment was written for.
- **The capture layout needs nothing.** Each run already writes its own directory under the suite
  (001 §14.5), and `suite.json`'s roster is written at suite start, before any flow runs.

### What is not ready, and is not one of the three questions

**Report ordering must not follow completion order.** 001-C R4l pins deterministic summary ordering,
and today that is free because completion order *is* roster order. Under concurrency it is not, so
every reporter and the console summary must sort by the roster rather than by whichever flow
finished first. A run that reorders its own report between two identical invocations is a diff
nobody can read.

## 2. Decision one — whose budget

`config.concurrency` is declared in a flow file and defaults to 5.

| Option | What it means |
|---|---|
| **A. Per-flow budgets, plus a flow count** | `config.concurrency` keeps its exact meaning. A new knob — `--flows N` and an app setting — caps how many flows are in flight. Worst-case in-flight steps is `N × concurrency`. |
| **B. One shared budget** | `--concurrency` becomes the total in-flight steps across the whole suite; a flow's own `config.concurrency` becomes a cap within it. |
| **C. Both** | Per-flow budgets, plus a suite-wide ceiling that additionally bounds the total. |

**Decided: A.** `config.concurrency` is untouched. A new `--flows N` bounds how many flows are in
flight, and **defaults to `1`** — see §5.1 for why the default is sequential.

B is the tempting one, because a single number bounding total load is what an API owner actually
wants. It is wrong for the same reason §12.3's `config:` inheritance was settled the way it was in
this fork's last revision: **a flow must mean the same thing wherever it is invoked.** Under B,
`config.concurrency: 5` means five when the flow runs alone and something else when it runs in a
suite — and the something else depends on what it is running *beside*, which the flow's author
cannot see.

C adds a second knob and reintroduces a hazard 001 §9.2 already had to reason about: a budget that
can be smaller than what a flow needs is how a sub-flow deadlocks. A suite ceiling below a flow's
own budget is that shape again, one level up.

A's cost is honest and documentable: the ceiling is `N × concurrency` rather than a single number.
Anyone who needs a hard total picks `N` accordingly.

## 3. Decision two — what `--bail` means

Today `--bail` breaks the sequential loop after a flow does not pass. With several in flight there
is a second question: what happens to the ones already running.

| Option | What it means |
|---|---|
| **A. Drain** | Start no more flows; let those in flight finish normally. |
| **B. Abort** | Start no more flows, and cancel those in flight. |
| **C. `--bail=drain\|abort`** | Configurable. |

**Decided: A (drain).** `--bail` stops the scheduler starting anything new; flows already in flight
run to their natural end and report real verdicts.

`--bail` exists to stop spending time on the rest, and *the rest* is what has not started. A flow
already running is time already spent, and cancelling it converts a result you would have had into
`cancelled` — which this fork settled in its last revision as an outcome that hides a real failure
behind an infrastructure one. Under B a `--bail` run's report is a mix of real verdicts and
half-finished ones, and the half-finished ones are the flows that were furthest along.

B also triggers 001 §11.3's cleanup window per cancelled run, each with its own `cleanupGrace` —
so the "faster" option can take up to 30 seconds per in-flight flow to stop.

Draining costs at most the duration of the longest flow already running. C is a knob for a question
that has an answer.

## 4. Decision three — what the app shows

002 §8's run view renders one run: one graph, one iteration strip, one step-detail pane.

| Option | What it means |
|---|---|
| **A. One graph, plus a suite strip** | The tab shows the selected flow's graph. A strip above it carries one chip per flow in the suite with its live status; clicking a chip switches the graph. |
| **B. A separate suite view** | A new top-level surface listing the suite's flows, from which you drill into one. |
| **C. Tiled graphs** | Several graphs at once. |

**Decided: A.** One graph, with a suite strip above it carrying a chip per flow.

C is already ruled out by a decision 002 made for its own reasons: §5.2 says the graph is
deliberately **never scaled to fit**, because a flow of tens of steps is read by scrolling. Two
graphs side by side are two scroll regions; five are unreadable.

A wins over B because the pattern already exists and is already understood. 002 §8.3's
`IterationStrip` is per-iteration status chips above the graph, for a dataset run — a suite strip is
the same component shape one level up, and the interaction (chip selects, graph follows) is one the
user has already learned. B builds a second surface to do what an existing one does.

## 5. Settled, and still open

### 5.1 `--flows` defaults to `1`

**Sequential is the default and parallelism is opt-in.** Every invocation that exists today behaves
identically after this change — which matters more than it sounds, because a suite written against a
sequential runner may share backend state between its flows, and nothing in a flow file declares
that it does. Defaulting above 1 would be faster out of the box and would silently break exactly
those suites, at a moment when nobody had asked for anything to change.

The corollary is that `--flows 1` must be a real code path and not a special case: the scheduler
runs the same way at 1 as at 5, so the default is not a separate implementation that can drift from
the parallel one.

### 5.2 Still open

Not blockers, but they need answers before the phases they belong to:

- **What bounds `--flows` against a dataset?** A flow with a 200-row dataset at `parallel: 10` is
  already a lot of concurrency; multiplying it by a flow count needs at least a documented worst case.
- ~~Where the app's flow count is set.~~ **Settled:** the overflow menu beside the play button sets
  it, and `runLabel` shows it — *Run 7 flows, 3 at a time*. The header is a row of icon buttons and a
  number input is not one (002 §4.1b's "one control, one job"), so the value goes in the menu and the
  control that consumes it narrates the value. It is persisted and **not** scoped: how many flows a
  machine should have in flight is a fact about that machine and the API it points at, not about a
  project. Offered as `1 · 2 · 4 · 8` rather than typed, because §2's cost multiplies with a flow's
  own `config.concurrency` and a short list keeps the worst case somewhere a person has considered.

  One consequence worth recording: 002 §4.1a's rule that the overflow menu is *absent rather than
  empty* still holds, but folder actions are no longer the only thing that can fill it. The count is
  offered only where it could change something — more than one flow to run — so a section with one
  flow and no folders still has no menu at all.
- **What does the console print while several flows are running?** 001 §14.7's output is a stream of
  per-step lines that currently belong to one flow at a time. Interleaved, they need a flow prefix
  or a different shape entirely — and §14.7 is explicitly not a stable format, so this is a design
  question rather than a contract change.

## 6. Implementation status

| Part | Where | State |
|---|---|---|
| `--flows N`, default 1 (§2, §5.1) | `bruno-cli/src/fork/flow/index.js` — `runSelection` | **done** |
| `--bail` drains (§3) | the same scheduler; a worker stops taking new work and finishes what it holds | **done** |
| Report order is roster order (§1) | `reporters/index.js` — `end()` sorts records against the roster captured at `start()` | **done** |
| Retry passes are as parallel as the pass they repeat | `runSelection` is reused for `--retries` | **done** |
| The app runs flows concurrently | `bruno-electron` — `runSuiteFlows`, `parallel` on the suite request, default 1 | **done** |
| The suite strip (§4) | `bruno-app` — `FlowTabPane/SuiteStrip` | **done** |
| Each flow's scope on the roster | `suite:start` carries it, so a chip can open a flow from another collection | **done** |
| The app's flow count (§4.1b) | `FlowSidebarSection` — set in the overflow menu, shown on the play button, persisted | **done** |

The ordering row is the one worth re-reading before touching a reporter: completion order and roster
order are the same thing at `--flows 1`, so a reporter that sorts by whichever flow finished first
passes every sequential test in the suite. `parallelism.integration.spec.js` makes the two disagree
on purpose — `a` is slowest and `b` fastest, so completion order is `b, c, a` — which is the only
arrangement in which the mistake is visible.

## 7. Non-goals

- **Cross-flow ordering or dependencies.** Flows in a selection are independent by construction; a
  flow that needs another to have run first is a sub-flow (001 §12), not a scheduling problem.
- **Distributing flows across machines.** CircleCI's own splitter does that, and it operates on the
  file list rather than on anything the engine knows.
