import { createSlice } from '@reduxjs/toolkit';

/**
 * API Flows renderer state — 002 §4 and §8.
 *
 * **Run state is keyed by flow path, not by tab** (§4.2). Closing the tab of a running flow does not
 * cancel it, and reopening reattaches; a run whose lifetime was a component's would drop events
 * exactly when 001 §11.3's cleanup steps are still running and nothing is watching.
 *
 * Nothing here computes flow semantics. Nodes, edges and ranks arrive from `describeFlow`, statuses
 * and reasons from `FlowEvent`s, bodies from `readCapture` — 002-C R4 asserts that this file grows
 * no parser and no status derivation of its own.
 */

/**
 * 002 §8.5. The panel is a debugging surface for the run in front of you, not a run archive — the
 * capture is that — so the oldest entries fall off rather than a long run growing the store without
 * bound. Comparable to the `logs` slice's own `MAX_LOGS`.
 */
const MAX_REQUEST_LOGS = 500;

const initialState = {
  /** The watcher's tree (002 §11.3's `FlowTreeEntry`), flat — the sidebar groups it by scope. */
  flows: [],
  /** pathname -> { description, error, loading } from `describeFlow` (002 §11.1). */
  descriptions: {},
  /** pathname -> the state of the run being watched, folded from events (002 §8). */
  runs: {},
  /** runId -> pathname, so a batch of events finds its flow without the sender repeating it. */
  flowByRunId: {},
  /** pathname -> the stepId whose detail pane is open (002 §9). */
  selectedStep: {},
  /**
   * pathname -> the run panel's configuration (002 §7.2) — params, concurrency, dataset.
   *
   * Keyed by path for the reason `sources` is: `RequestTabPanel` renders only the focused tab, so a
   * configuration held in the pane's own `useState` is discarded by every tab switch. A library
   * flow's params are typed by hand before each run (§12.5), and losing them silently on the way to
   * another tab is indistinguishable from never having typed them.
   *
   * **Deliberately not persisted to disk.** The snapshot middleware writes a curated subset of the
   * store, and a flow's params routinely hold a password — this one is in memory for the life of the
   * session and no longer.
   */
  configurations: {},
  /** Every request the dispatch port sent, oldest first, for the DevTools network tab (002 §8.5). */
  requestLogs: [],
  /**
   * pathname -> the raw-editing session for that flow (002 §4.3).
   *
   * Keyed by path rather than held in the pane, for the reason §4.2 keeps run state here: a tab is a
   * view of a flow, not the thing itself, and an unsaved edit that a tab switch discarded would be
   * the one kind of state loss no editor is allowed.
   */
  sources: {},
  /**
   * 002 §4.1a: absolute folder path -> whether the sidebar is showing what is inside it.
   *
   * **A folder absent from this map is collapsed**, which is what upstream's collection folders do
   * (`slices/collections` creates every folder item `collapsed: true`) and therefore what a reader of
   * this sidebar already expects a folder to do. It also keeps the map to the folders someone has
   * actually opened rather than a key per directory on disk.
   *
   * Held here rather than in the section, because `SidebarSection` unmounts its children when it is
   * collapsed: state owned by the component would forget every open folder each time the section was
   * shut, which is the one gesture most likely to precede reopening it.
   */
  folderExpansion: {},
  /**
   * 002 §10's suite run — the flows of a past suite being re-run, folded from `main:flow-suite-event`.
   *
   * **One at a time, and `null` when none is.** The host opens a single suite directory and runs the
   * roster through it in order, so a second suite started while one is in flight is not a state
   * anything can produce; the control that starts one becomes Cancel for as long as it runs.
   *
   * This holds only what the section header answers — which flow is where, and how far along the
   * suite is. Each flow's own outcomes arrive on the unchanged per-flow stream and are folded into
   * `runs` exactly as a single run's are, so there is no second viewer to drift from the first.
   */
  suiteRun: null
};

/**
 * 002 §4.3's editing session. `saved` is what is believed to be on disk, so *dirty* is a comparison
 * rather than a flag — a flag has to be cleared by every path that changes either side, and the one
 * that forgets leaves the tab claiming an edit that was written minutes ago.
 */
const emptySource = () => ({ content: '', saved: '', loading: true, saving: false });

const emptyRun = ({ runId, iterationCount, captureDir, description, params, origin }) => ({
  runId,
  dir: captureDir,
  /**
   * §10: who started this run and against which environments, reported at `run:start` (001 §14.5).
   * A run recorded before the field existed, or started by a host that supplied none, has none —
   * the view says nothing rather than guessing which environment it ran against.
   */
  origin,
  /**
   * §5.6: what this run was started with, reported at `run:start` rather than read back from the
   * capture. The inputs node switches from boxes to a record the moment a run begins, and a node
   * waiting on the artifact would show a live run as having been started with nothing.
   */
  params,
  /** Filled per iteration from `iteration:vars`, keyed the way `steps` is. */
  vars: {},
  /**
   * The graph this run is executing — 001 §14.5's snapshot, reported at `run:start`.
   *
   * Pinning it is what keeps a run being watched from being redrawn out from under itself: §4.3
   * makes editing the file a two-second operation, and the watcher clears the stored description on
   * the save, so without this the running graph would follow the edit rather than the run.
   */
  description,
  state: 'running',
  status: undefined,
  summary: undefined,
  iterationCount,
  selectedIteration: 0,
  // { [iteration]: { [stepId]: node } } — 001 §13.2 keys a step event by id *and* iteration, and
  // under `dataset.parallel > 1` two iterations of the same step are genuinely in flight at once.
  steps: {}
});

/**
 * 001 §13.2's `decidedBy`, keyed by iteration the way `steps` is.
 *
 * The run-level list is the union across iterations, and this view is drawn one iteration at a time
 * (§8.3) — so naming a step the *displayed* iteration ran perfectly well would be the summary
 * pointing at the wrong row. An iteration reports its own causes; this only re-keys them.
 */
const decidedByIteration = (result) =>
  Object.fromEntries((result.iterations || []).map((iteration) => [iteration.index, iteration.decidedBy || []]));

const nodesFor = (run, iteration) => {
  run.steps[iteration] = run.steps[iteration] || {};
  return run.steps[iteration];
};

/**
 * 002 §8.2's node states. The four terminal ones are 001 §14.6's, unrenamed — R6 asserts the UI
 * paraphrases none of them, so a step's status is stored exactly as the engine reported it.
 */
const applyEvent = (state, event) => {
  if (event.type === 'run:start') {
    state.flowByRunId[event.runId] = event.flow;
    // 001 §13.2 reports the directory at run start, not only at run end, so §9 can open a
    // *running* step's capture. Absent when capture is disabled.
    state.runs[event.flow] = emptyRun(event);
    return;
  }

  const pathname = state.flowByRunId[event.runId];
  const run = pathname ? state.runs[pathname] : undefined;
  if (!run) {
    return;
  }

  switch (event.type) {
    case 'step:start':
      nodesFor(run, event.index)[event.id] = { state: 'running', operation: event.operation };
      break;

    case 'step:attempt': {
      const node = nodesFor(run, event.index)[event.id] || {};
      // The first attempt is the step simply running; `retrying` starts at the second, which is
      // what keeps a 20-attempt poll from reading as a hang (§8.2).
      node.attempt = event.attempt;
      node.state = event.attempt > 1 ? 'retrying' : 'running';
      nodesFor(run, event.index)[event.id] = node;
      break;
    }

    case 'step:end': {
      const {
        status,
        reason,
        message,
        attempts,
        durationMs,
        assertions,
        validation,
        outputs,
        capturePath,
        kind
      } = event.result;
      nodesFor(run, event.index)[event.id] = {
        state: status,
        reason,
        // 001 §14.6's occurrence beside its rule: `reason` is the vocabulary, this is what happened.
        message,
        attempts,
        durationMs,
        assertions,
        validation,
        outputs,
        capturePath,
        kind
      };
      break;
    }

    case 'iteration:start':
      nodesFor(run, event.index);
      break;

    case 'iteration:vars':
      // §7.3 resolves `vars:` per iteration, so this arrives once per row and never replaces
      // another iteration's values.
      run.vars[event.index] = event.vars;
      break;

    case 'run:end':
      run.state = 'complete';
      run.status = event.result.status;
      run.summary = event.result.summary;
      run.decidedBy = decidedByIteration(event.result);
      /**
       * §13.2's run diagnostics — what happened during the run that did not stop it, and the reason
       * a run that failed on its own has to give. Nothing else in the store carries them: the tab's
       * other diagnostics describe the *file* (§6), which is a different question with the same word.
       */
      run.diagnostics = event.result.diagnostics || [];
      break;

    default:
      break;
  }
};

/**
 * 002 §11.3's suite stream, which runs alongside the per-flow one rather than replacing it.
 *
 * A suite is a roster and an order; a flow's *result* is the per-flow stream's, and folding an
 * outcome out of `suite:flow-end` into `runs` would be a second, weaker account of a run beside the
 * one every flow tab is already showing.
 */
const applySuiteEvent = (state, suiteId, event) => {
  if (event.type === 'suite:start') {
    state.suiteRun = {
      suiteId,
      startedAt: event.startedAt,
      state: 'running',
      flows: event.flows.map((flow) => ({ ...flow, state: 'pending' }))
    };
    return;
  }

  // A suite the host is still finishing after this one replaced it has nothing left to say here:
  // the header reports the suite in flight, and one at a time is what the runner offers.
  const suite = state.suiteRun;
  if (!suite || suite.suiteId !== suiteId) {
    return;
  }

  if (event.type === 'suite:end') {
    suite.dir = event.dir;
    /**
     * A cancel is the renderer's own fact — `suite:end` reports the same shape whether the suite ran
     * out of flows or was stopped — so an end must not overwrite it. Everything the cancel did stop
     * is recorded as `cancelled` in the manifest, which is where a run that was stopped is read back
     * from; this only keeps the header from calling it complete.
     */
    suite.state = suite.state === 'cancelled' ? 'cancelled' : 'complete';
    return;
  }

  const flow = suite.flows.find((entry) => entry.entry === event.entry);
  if (!flow) {
    return;
  }

  if (event.type === 'suite:flow-start') {
    flow.state = 'running';
    return;
  }

  if (event.type === 'suite:flow-end') {
    flow.state = 'done';
    // 001 §14.6's outcome, unrenamed — R6 asserts the UI paraphrases none of them.
    flow.outcome = event.outcome;
  }
};

const slice = createSlice({
  name: 'flows',
  initialState,
  reducers: {
    /** `renderer:flow-watch-scope` resolved: what was already on disk for one scope. */
    flowsLoaded: (state, action) => {
      const { workspaceRoot, collectionRoot, flows } = action.payload;
      const isOtherScope = (flow) => flow.workspaceRoot !== workspaceRoot || flow.collectionRoot !== collectionRoot;
      state.flows = [...state.flows.filter(isOtherScope), ...flows];
    },

    /** `main:flow-tree-updated` (002 §11.3). */
    flowTreeUpdated: (state, action) => {
      const { event, entry } = action.payload;
      const others = state.flows.filter((flow) => flow.pathname !== entry.pathname);

      if (event === 'unlinkFile') {
        state.flows = others;
        delete state.descriptions[entry.pathname];
        return;
      }

      state.flows = [...others, entry];
      // §6: diagnostics refresh on a watcher change, so a stale description must not survive one.
      if (event === 'changeFile') {
        delete state.descriptions[entry.pathname];
      }
    },

    /**
     * §4.3: the file changed underneath a raw editor that has no unsaved work, so the editor takes
     * the file's text.
     *
     * `loading` is deliberately not touched. Bruno's own save fires the same watcher event, so this
     * runs after every save — going back through the loading state would flash the pane on each one.
     * `saved` moves with `content` because the two now agree: this *is* what is on disk.
     */
    sourceRefreshed: (state, action) => {
      const { pathname, content } = action.payload;
      const source = state.sources[pathname];
      if (source) {
        source.content = content;
        source.saved = content;
        source.staleOnDisk = false;
        source.error = undefined;
      }
    },

    /**
     * The file changed underneath an editor that *does* have unsaved work. Taking the file's text
     * would discard it, and 002 §4.3 makes that the one loss an editor is not allowed — so the
     * editor keeps what was typed and the pane says the two have diverged.
     */
    sourceDivergedOnDisk: (state, action) => {
      const source = state.sources[action.payload.pathname];
      if (source) {
        source.staleOnDisk = true;
      }
    },

    describeStarted: (state, action) => {
      const { pathname } = action.payload;
      state.descriptions[pathname] = { loading: true };
    },

    describeSucceeded: (state, action) => {
      const { pathname, description } = action.payload;
      state.descriptions[pathname] = { loading: false, description };
    },

    describeFailed: (state, action) => {
      const { pathname, error } = action.payload;
      state.descriptions[pathname] = { loading: false, error };
    },

    /** A batch from `main:flow-run-event` — §8.1 batches per frame, order preserved within one. */
    runEventsReceived: (state, action) => {
      for (const event of action.payload.events) {
        applyEvent(state, { ...event, runId: action.payload.runId });
      }
    },

    /** One event from `main:flow-suite-event` — §11.3's suite stream, beside the per-flow one. */
    suiteEventReceived: (state, action) => {
      const { suiteId, event } = action.payload;
      applySuiteEvent(state, suiteId, event);
    },

    /**
     * The suite was stopped from here. Recorded on the way out rather than waiting for `suite:end`,
     * which reports a stopped suite and an exhausted one identically — the renderer is the only side
     * that knows which of the two this was.
     */
    suiteRunCancelled: (state, action) => {
      const suite = state.suiteRun;
      if (suite && suite.suiteId === action.payload.suiteId) {
        suite.state = 'cancelled';
      }
    },

    /**
     * §10: a past run opens into the same view as a live one, so it is folded into the same shape.
     * Building a second, weaker viewer for stored runs would guarantee the two drift.
     */
    pastRunLoaded: (state, action) => {
      const { pathname, stored } = action.payload;
      const steps = {};

      for (const iteration of stored.result?.iterations || []) {
        steps[iteration.index] = Object.fromEntries(
          iteration.steps.map((step) => [
            step.id,
            {
              state: step.status,
              reason: step.reason,
              message: step.message,
              attempts: step.attempts,
              durationMs: step.durationMs,
              assertions: step.assertions,
              validation: step.validation,
              outputs: step.outputs,
              kind: step.kind,
              // §9 reads a step's capture only where the run recorded one; a stored run says so the
              // same way a live one does (001 §13.2).
              capturePath: step.capturePath
            }
          ])
        );
      }

      // An interrupted run has no `summary.json`, so the only evidence is which steps have a
      // capture. Those render as having run; the rest stay pending. Neither claims an outcome.
      if (!stored.result) {
        steps[0] = Object.fromEntries(stored.capturedSteps.map((id) => [id, { state: 'ran' }]));
      }

      state.runs[pathname] = {
        runId: stored.runId,
        dir: stored.dir,
        state: stored.state,
        status: stored.status,
        summary: stored.summary,
        diagnostics: stored.result?.diagnostics || [],
        // A run stored before `decidedBy` existed reports none, and an interrupted one has no
        // `summary.json` to report it in; neither is a run that nothing decided.
        decidedBy: stored.result ? decidedByIteration(stored.result) : {},
        iterationCount: stored.result?.iterations.length || 1,
        selectedIteration: 0,
        steps,
        /**
         * The graph this run executed (001 §14.5), which the tab draws instead of the flow's current
         * one. Painting a run's outcomes onto today's nodes drops a step renamed since, shows one
         * added since as never-started, and draws edges the run never had. Absent for a run written
         * before snapshots existed, which falls back to the current graph as it always did.
         */
        description: stored.description,
        source: stored.source,
        /**
         * §5.6: what this run was started with, secrets already masked by the engine (001 §14.4).
         * `undefined` for a run recorded before inputs were — the panel says "not recorded" rather
         * than drawing empty boxes, which would claim nothing was supplied.
         */
        params: stored.params,
        /** §5.6: `vars:` as each iteration resolved them, keyed by iteration the way `steps` is. */
        vars: stored.vars,
        /** A live run's provenance and a stored one's are the same record — 001 §14.5's manifest. */
        origin: stored.origin
      };
      state.flowByRunId[stored.runId] = pathname;
    },

    /**
     * §10: back to `current` in the run selector — the flow as it stands, with no run open.
     *
     * The tab draws the run it holds in preference to the file (§10's pinned graph), so returning to
     * the current flow is dropping the run rather than selecting a different one. `flowByRunId` goes
     * with it: it is what routes a run's events into this entry, and a mapping left behind would
     * fold late events into a run the view no longer has.
     *
     * A run in progress is not closed here. Its events have nowhere else to land and nothing
     * restores it mid-run, so the only way to leave one is to let it end (or cancel it); the
     * selector locks for the same reason.
     */
    runClosed: (state, action) => {
      const { pathname } = action.payload;
      const run = state.runs[pathname];
      if (!run || run.state === 'running') {
        return;
      }

      delete state.flowByRunId[run.runId];
      delete state.runs[pathname];
    },

    iterationSelected: (state, action) => {
      const { pathname, iteration } = action.payload;
      state.runs[pathname].selectedIteration = iteration;
    },

    /** §7.2's run panel, edited. The whole configuration is replaced: the panel owns it as a unit. */
    configurationChanged: (state, action) => {
      const { pathname, configuration } = action.payload;
      state.configurations[pathname] = configuration;
    },

    /** `stepId` is null when the selection is cleared — clicking the selected node again (002 §9). */
    /** §4.1a: one folder row clicked. */
    folderToggled: (state, action) => {
      const { key } = action.payload;
      state.folderExpansion[key] = !state.folderExpansion[key];
    },

    /**
     * §4.1a's header actions, over the folders the section is currently showing.
     *
     * They take the keys rather than clearing the map, because the store holds every scope watched
     * since launch (§4.1) and the section shows one workspace's: collapsing what is in front of you
     * must not silently shut the folders of a workspace you are about to switch back to.
     */
    foldersExpanded: (state, action) => {
      for (const key of action.payload.keys) {
        state.folderExpansion[key] = true;
      }
    },

    foldersCollapsed: (state, action) => {
      for (const key of action.payload.keys) {
        delete state.folderExpansion[key];
      }
    },

    stepSelected: (state, action) => {
      const { pathname, stepId } = action.payload;
      state.selectedStep[pathname] = stepId;
    },

    /** 002 §4.3 — the file's text, read when the raw editor opens. */
    sourceLoaded: (state, action) => {
      const { pathname, content } = action.payload;
      state.sources[pathname] = { ...emptySource(), content, saved: content, loading: false };
    },

    sourceLoadFailed: (state, action) => {
      const { pathname, error } = action.payload;
      state.sources[pathname] = { ...emptySource(), loading: false, error };
    },

    /**
     * **Whether the draft parses is derived by the pane, not stored here.** It used to be a field on
     * the source, written only by this reducer — so every *other* path that moves `content`
     * (`sourceRefreshed` above, after a save or an edit made outside Bruno) left behind a verdict on
     * text that was no longer in the editor. One transient half-typed line then pinned "not saving"
     * for the rest of the session, over a file that had since been fixed on disk.
     *
     * The panes ask their own parser at render (§4.3's YAML, §4.5's JavaScript), which is also the
     * only place that knows which language this path is in. There is nothing to keep in step.
     */
    sourceEdited: (state, action) => {
      const { pathname, content } = action.payload;
      const source = state.sources[pathname] || emptySource();
      state.sources[pathname] = { ...source, content, error: undefined };
    },

    /**
     * The draft's own graph, kept beside the draft rather than in `descriptions`.
     *
     * `descriptions` is what the run view draws, and it describes the file **on disk** — the one a
     * run would execute. Folding an unsaved draft into it would redraw the run view from text no run
     * can reach, and abandoning the edit would leave that drawing behind, since only a watcher event
     * clears the entry. Two descriptions of one flow is the honest shape here: they differ exactly
     * while the editor is ahead of the file, and saving is what makes them agree.
     */
    sourceDescribed: (state, action) => {
      const { pathname, description } = action.payload;
      const source = state.sources[pathname];
      if (source) {
        source.description = description;
        source.describeError = undefined;
      }
    },

    sourceDescribeFailed: (state, action) => {
      const { pathname, error } = action.payload;
      const source = state.sources[pathname];
      if (source) {
        source.describeError = error;
      }
    },

    sourceSaving: (state, action) => {
      const source = state.sources[action.payload.pathname];
      if (source) {
        source.saving = true;
      }
    },

    /**
     * What was written, not what is in the editor now: a save is asynchronous and the keystrokes
     * during it are genuinely unsaved. Recording the editor's current text instead is how an edit
     * made mid-save is marked clean and then lost.
     */
    sourceSaved: (state, action) => {
      const { pathname, content } = action.payload;
      const source = state.sources[pathname];
      if (source) {
        source.saved = content;
        source.saving = false;
        source.error = undefined;
        // Whatever the file held a moment ago, it holds this now.
        source.staleOnDisk = false;
      }
    },

    sourceSaveFailed: (state, action) => {
      const { pathname, error } = action.payload;
      const source = state.sources[pathname];
      if (source) {
        source.saving = false;
        source.error = error;
      }
    },

    /**
     * 002 §4.4: the flow moved, and everything this slice holds about it is keyed by where it was.
     *
     * A rename is the one change a watcher event cannot carry through. `unlinkFile` and `addFile`
     * arrive as two unrelated facts — a flow gone, a flow appeared — and folding them that way drops
     * the run being watched, the params typed into the run panel and the raw editor's session, all
     * of which belong to a file that never stopped existing. The dialog knows both paths, so it says
     * so once and every keyed map moves together.
     *
     * `flows` itself is left to the watcher. It is the tree, the tree is what is on disk, and two
     * writers of it would disagree the first time a rename failed halfway.
     */
    flowPathRenamed: (state, action) => {
      const { from, to } = action.payload;
      if (from === to) {
        return;
      }

      for (const keyed of [state.descriptions, state.runs, state.selectedStep, state.configurations, state.sources]) {
        if (keyed[from] !== undefined) {
          keyed[to] = keyed[from];
          delete keyed[from];
        }
      }

      // §8's events address a run by id and are resolved to a flow through this map, so a run still
      // in flight during the rename keeps reaching the flow it belongs to.
      for (const [runId, pathname] of Object.entries(state.flowByRunId)) {
        if (pathname === from) {
          state.flowByRunId[runId] = to;
        }
      }
    },

    /** A batch from `main:flow-request-log-batch` — §8.5. */
    requestLogsReceived: (state, action) => {
      state.requestLogs.push(...action.payload.requests);
      if (state.requestLogs.length > MAX_REQUEST_LOGS) {
        state.requestLogs = state.requestLogs.slice(-MAX_REQUEST_LOGS);
      }
    }
  }
});

export const {
  flowsLoaded,
  flowTreeUpdated,
  flowPathRenamed,
  describeStarted,
  describeSucceeded,
  describeFailed,
  runEventsReceived,
  suiteEventReceived,
  suiteRunCancelled,
  pastRunLoaded,
  runClosed,
  iterationSelected,
  configurationChanged,
  folderToggled,
  foldersExpanded,
  foldersCollapsed,
  stepSelected,
  requestLogsReceived,
  sourceLoaded,
  sourceLoadFailed,
  sourceRefreshed,
  sourceDivergedOnDisk,
  sourceEdited,
  sourceDescribed,
  sourceDescribeFailed,
  sourceSaving,
  sourceSaved,
  sourceSaveFailed
} = slice.actions;

export default slice.reducer;
