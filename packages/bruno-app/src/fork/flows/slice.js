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
  /** Every request the dispatch port sent, oldest first, for the DevTools network tab (002 §8.5). */
  requestLogs: [],
  /**
   * pathname -> the raw-editing session for that flow (002 §4.3).
   *
   * Keyed by path rather than held in the pane, for the reason §4.2 keeps run state here: a tab is a
   * view of a flow, not the thing itself, and an unsaved edit that a tab switch discarded would be
   * the one kind of state loss no editor is allowed.
   */
  sources: {}
};

/**
 * 002 §4.3's editing session. `saved` is what is believed to be on disk, so *dirty* is a comparison
 * rather than a flag — a flag has to be cleared by every path that changes either side, and the one
 * that forgets leaves the tab claiming an edit that was written minutes ago.
 */
const emptySource = () => ({ content: '', saved: '', loading: true, saving: false, valid: true });

const emptyRun = ({ runId, iterationCount, captureDir, description }) => ({
  runId,
  dir: captureDir,
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
        source: stored.source
      };
      state.flowByRunId[stored.runId] = pathname;
    },

    iterationSelected: (state, action) => {
      const { pathname, iteration } = action.payload;
      state.runs[pathname].selectedIteration = iteration;
    },

    /** `stepId` is null when the selection is cleared — clicking the selected node again (002 §9). */
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
     * `valid` is the editor's own YAML parse, not a verdict on the flow: a document that parses but
     * declares a step twice is *invalid as a flow* and still draws, with its diagnostics, exactly as
     * §6 requires of the run view. What it gates is redrawing and auto-saving, and both want the
     * narrower question — is there a document here at all.
     */
    sourceEdited: (state, action) => {
      const { pathname, content, valid } = action.payload;
      const source = state.sources[pathname] || emptySource();
      state.sources[pathname] = { ...source, content, valid, error: undefined };
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
  describeStarted,
  describeSucceeded,
  describeFailed,
  runEventsReceived,
  pastRunLoaded,
  iterationSelected,
  stepSelected,
  requestLogsReceived,
  sourceLoaded,
  sourceLoadFailed,
  sourceEdited,
  sourceDescribed,
  sourceDescribeFailed,
  sourceSaving,
  sourceSaved,
  sourceSaveFailed
} = slice.actions;

export default slice.reducer;
