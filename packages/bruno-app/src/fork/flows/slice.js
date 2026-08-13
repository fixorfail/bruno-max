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
  selectedStep: {}
};

const emptyRun = (runId, iterationCount, captureDir) => ({
  runId,
  dir: captureDir,
  state: 'running',
  status: undefined,
  summary: undefined,
  iterationCount,
  selectedIteration: 0,
  // { [iteration]: { [stepId]: node } } — 001 §13.2 keys a step event by id *and* iteration, and
  // under `dataset.parallel > 1` two iterations of the same step are genuinely in flight at once.
  steps: {}
});

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
    state.runs[event.flow] = emptyRun(event.runId, event.iterationCount, event.captureDir);
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
      const { status, reason, attempts, durationMs, assertions, validation, outputs, capturePath, kind } = event.result;
      nodesFor(run, event.index)[event.id] = {
        state: status,
        reason,
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
              attempts: step.attempts,
              durationMs: step.durationMs,
              assertions: step.assertions,
              validation: step.validation,
              outputs: step.outputs,
              kind: step.kind
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
        iterationCount: stored.result?.iterations.length || 1,
        selectedIteration: 0,
        steps
      };
      state.flowByRunId[stored.runId] = pathname;
    },

    iterationSelected: (state, action) => {
      const { pathname, iteration } = action.payload;
      state.runs[pathname].selectedIteration = iteration;
    },

    stepSelected: (state, action) => {
      const { pathname, stepId } = action.payload;
      state.selectedStep[pathname] = stepId;
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
  stepSelected
} = slice.actions;

export default slice.reducer;
