import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import { usePersistedState } from 'hooks/usePersistedState';
import { useVerticalSplit } from 'fork/hooks/useVerticalSplit';
import { describeFlow } from '../actions';
import { stepSelected, iterationSelected, configurationChanged } from '../slice';
import FlowGraph from './FlowGraph';
import RunControls from './RunControls';
import StepDetail from './StepDetail';
import RunSelector from './RunSelector';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.2 — the flow tab: the graph, the run controls, the diagnostics and the step detail.
 *
 * Run state lives in the slice keyed by the flow's path rather than here, so closing this tab does
 * not cancel the run and reopening reattaches to one in progress (§4.2).
 */

/**
 * §9's pane and §5's graph compete for one screen, and which one you want bigger changes with what
 * you are doing — reading a graph, or reading a response body. The split is dragged rather than
 * fixed, and the size is remembered across tabs and launches because re-dragging it on every flow
 * would be the whole point of a preference.
 */
const MIN_GRAPH_HEIGHT = 120;
const MIN_DETAIL_HEIGHT = 160;
const DEFAULT_DETAIL_HEIGHT = 260;

/**
 * One frozen object for every flow that has no configuration yet — a fresh `{}` per render would be
 * a new prop identity each time, which is the difference between a memo that holds and one that
 * never does.
 */
const EMPTY_CONFIGURATION = {};

const DiagnosticLine = ({ diagnostic }) => (
  <div className={`diagnostic ${diagnostic.severity}`}>
    <span className="diagnostic-code">{diagnostic.code}</span>
    <span>{diagnostic.message}</span>
    {/* §6 anchors a diagnostic at its line — the document view is the primary surface, and the
        position is what lets a click land there. */}
    {diagnostic.line ? <span className="diagnostic-line">{`line ${diagnostic.line}`}</span> : null}
  </div>
);

/**
 * §6's errors, listed above the graph. They block the run control, so the list is the answer to why
 * the flow will not run and belongs where it cannot be missed.
 *
 * **The run's own diagnostics (001 §13.2) are listed here too**, and they are a different thing with
 * the same word: §6's describe the *file* and are what `bru flow validate` reports, while a run's
 * describe what happened while it executed — a capture that could not be written, or the failure a
 * run that died on its own could not attach to any step. Nothing else in this view can carry those:
 * they belong to no step, so no node and no step pane will ever show them, and a run whose only
 * account of itself is the word `failed` is the state this whole surface exists to prevent.
 */
const Errors = ({ diagnostics, runDiagnostics }) => {
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  const fromRun = runDiagnostics || [];

  if (!errors.length && !fromRun.length) {
    return null;
  }

  return (
    <div className="flow-diagnostics" data-testid="flow-diagnostics">
      <div className="diagnostic-counts">
        {errors.length ? <span className="error">{`${errors.length} errors`}</span> : null}
        {fromRun.length ? (
          <span className="run-diagnostics-label" data-testid="flow-run-diagnostics">
            {`${fromRun.length} from this run`}
          </span>
        ) : null}
      </div>
      {errors.map((error, index) => (
        <DiagnosticLine key={`file-${index}`} diagnostic={error} />
      ))}
      {fromRun.map((entry, index) => (
        <DiagnosticLine key={`run-${index}`} diagnostic={entry} />
      ))}
    </div>
  );
};

/**
 * §6's warnings, as a count over the graph that opens on hover.
 *
 * **A warning is not a thing to deal with before running** — §6 is explicit that only errors block
 * the run, and 001 §5.4's forward-compatibility posture means a flow written by a newer Bruno
 * carries them indefinitely, as does one whose author accepted an undeclared dependency. Listed
 * above the graph they pushed the drawing down on every open and read exactly like the error list
 * that *does* stop a run. The count is the standing statement; the list is one hover away, over the
 * drawing rather than in front of it.
 *
 * Focusable, so the list is reachable without a pointer.
 */
const Warnings = ({ diagnostics }) => {
  const warnings = diagnostics.filter((entry) => entry.severity === 'warning');

  if (!warnings.length) {
    return null;
  }

  return (
    <div className="flow-warnings" tabIndex={0} data-testid="flow-warnings">
      <span className="flow-warnings-count">
        {`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
      </span>
      <div className="flow-warnings-list" role="tooltip" data-testid="flow-warnings-list">
        {warnings.map((warning, index) => (
          <DiagnosticLine key={index} diagnostic={warning} />
        ))}
      </div>
    </div>
  );
};

/**
 * §10: where the run in the view came from — the host that started it, and the environments it ran
 * against (001 §14.5's `origin`).
 *
 * Read off the run rather than off the app's own environment dropdown, because the two routinely
 * disagree: a `.bruno-runs/` directory downloaded from a build artifact opens here exactly as a
 * local run does, and the dropdown would label it with whatever this machine happens to have
 * selected now.
 */
const RunOrigin = ({ origin }) => (
  <span className="flow-run-origin" data-testid="flow-run-origin" title="Where this run came from">
    {[origin.host, origin.environment, origin.globalEnvironment].filter(Boolean).join(' · ')}
  </span>
);

const FlowTabPane = ({ tab }) => {
  const dispatch = useDispatch();
  // §7.1 decides capture per run rather than storing it here: this is what the run *panel* keeps
  // between runs, and capture is a property of a run rather than of the tab.
  //
  // It lives in the slice, keyed by path, because `RequestTabPanel` renders only the focused tab —
  // held here it would be discarded by every tab switch, taking a library flow's hand-typed params
  // with it and leaving boxes that look no different from ones nobody filled.
  const configuration = useSelector((state) => state.flows.configurations[tab.pathname]) || EMPTY_CONFIGURATION;
  const [expandedSubflows, setExpandedSubflows] = useState([]);
  const [showDataEdges, setShowDataEdges] = useState(true);
  /**
   * §5.3: the slot layer is off by default, and that is the one default on this toolbar that is not
   * a preference. A slot read by every authenticated step — a session token, which is the common
   * case — is a line from every box on the drawing to one glyph, and drawing them all says less than
   * drawing none. Off, the graph still marks every step that uses one (§5.1), and focusing a step
   * draws that step's own slots whatever this says.
   */
  const [showSlotEdges, setShowSlotEdges] = useState(false);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const described = useSelector((state) => state.flows.descriptions[tab.pathname]);
  const run = useSelector((state) => state.flows.runs[tab.pathname]);
  const selectedStep = useSelector((state) => state.flows.selectedStep[tab.pathname]);

  /**
   * §10: a past run draws the graph **it** executed, not the flow's current one. 001 §14.5 records
   * the description at run start precisely so a run stays readable after the file moves on — without
   * it, a step renamed since loses its outcome silently and one added since reads as never-started.
   *
   * A live run has no snapshot in the slice and falls through to the current description, which is
   * the same file it is executing.
   */
  const description = run?.description || described?.description;

  const splitRef = useRef(null);
  const [detailHeight, setDetailHeight] = usePersistedState({
    key: 'flows-step-detail-height',
    default: DEFAULT_DETAIL_HEIGHT
  });
  const { dragging, dragHeight, dragbarProps } = useVerticalSplit({
    containerRef: splitRef,
    height: detailHeight,
    onHeightChange: setDetailHeight,
    minTop: MIN_GRAPH_HEIGHT,
    minBottom: MIN_DETAIL_HEIGHT
  });
  const appliedDetailHeight = dragging ? dragHeight : detailHeight;

  // §6: `describeFlow` runs when a flow is opened and again on every watcher change, which clears
  // the stored description — so this reloads whenever the file behind the tab moves.
  useEffect(() => {
    if (flow && !described) {
      dispatch(describeFlow(flow));
    }
  }, [dispatch, flow, described]);

  if (!flow) {
    return <div className="pb-4 px-4">This flow is no longer on disk.</div>;
  }

  const iteration = run?.selectedIteration || 0;
  const isRunning = run?.state === 'running';
  /**
   * §10: a run open in the tab — live or restored — is a record, so its inputs are shown rather than
   * edited. Returning to `current` drops the run (`runClosed`) and the boxes come back.
   */
  const viewingRun = Boolean(run);
  const nodeStates = run?.steps?.[iteration] || {};
  const selectedNode = selectedStep ? nodeStates[selectedStep] : undefined;

  const toggleSubflow = (id) =>
    setExpandedSubflows((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <StyledWrapper>
      <RunControls
        flow={flow}
        description={description}
        run={run}
        configuration={configuration}
        onConfigurationChange={(next) =>
          dispatch(configurationChanged({ pathname: tab.pathname, configuration: next }))}
      />

      {/* §5.3: data edges are toggleable and on by default — on a flow where most steps consume the
          previous one's output they are largely parallel to the control edges, and on one with real
          fan-out they are the interesting half. */}
      <div className="flow-toolbar">
        <label>
          <input type="checkbox" checked={showDataEdges} onChange={(event) => setShowDataEdges(event.target.checked)} />
          Data edges
        </label>

        <label>
          <input
            type="checkbox"
            checked={showSlotEdges}
            onChange={(event) => setShowSlotEdges(event.target.checked)}
            data-testid="flow-toggle-slot-edges"
          />
          Shared slots
        </label>

        <RunSelector flow={flow} description={description} run={run} />

        {/* Beside the control that says which run is on screen. A run recorded before the field
            existed has none, and nothing is drawn: an absent origin is not a run that came from
            here, and naming an environment nobody recorded would be a guess. */}
        {run?.origin ? <RunOrigin origin={run.origin} /> : null}

        {/* §8.3: a dataset flow gets an iteration selector — iterations are independent by
            contract, so the graph shows one at a time. */}
        {run && run.iterationCount > 1 ? (
          <label>
            Iteration
            <select
              value={iteration}
              onChange={(event) =>
                dispatch(iterationSelected({ pathname: flow.pathname, iteration: Number(event.target.value) }))}
            >
              {Array.from({ length: run.iterationCount }, (unused, index) => index).map((index) => (
                <option key={index} value={index}>
                  {index + 1}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/* At the end of the row the flow's other controls are on, rather than over the drawing:
            they are the same kind of thing — what this view is showing and what it is showing about
            — and a count that floated over the graph was the only one of them that moved with it. */}
        {description ? <Warnings diagnostics={description.diagnostics} /> : null}
      </div>

      {described?.loading ? <div className="flow-loading">Reading the flow…</div> : null}
      {described?.error ? <div className="flow-error">{described.error}</div> : null}

      {description ? <Errors diagnostics={description.diagnostics} runDiagnostics={run?.diagnostics} /> : null}

      {/* The element the split divides, so the drag clamps against the room the graph and the pane
          actually share rather than against the whole tab. */}
      <div className={`flow-split${dragging ? ' is-dragging' : ''}`} ref={splitRef}>
        {/* §6: a flow that does not parse still opens — an empty graph, its diagnostics anchored,
            and a disabled run control. The failure mode to avoid is a file that cannot be opened
            *because* it is broken, which is when you most want to look at it. */}
        {description ? (
          <FlowGraph
            description={description}
            nodeStates={nodeStates}
            /* §8.2's in-flight markers answer to the *run*, not only to the node. A step that
               announced `step:start` and never announced its end leaves its node reading `running`
               for as long as the tab is open — so a run that has ended is the fact that settles it,
               and it is the engine's fact rather than a timeout invented here. */
            running={isRunning}
            diagnostics={description.diagnostics}
            selectedStep={selectedStep}
            expandedSubflows={expandedSubflows}
            showDataEdges={showDataEdges}
            showSlotEdges={showSlotEdges}
            /**
             * §5.6: the panel edits the *configuration* while the tab shows the flow as it stands,
             * and reports the run's own inputs once it shows a stored one. `onParamChange` is what
             * distinguishes them — a viewer of a past run has nothing to change, and the run it is
             * looking at has already been started with whatever it was.
             */
            paramValues={viewingRun ? run.params : configuration.params}
            /* The iteration the rest of the view is showing: under a dataset each row resolved its
               own `vars:`, so the panel and the nodes describe the same one. */
            varValues={viewingRun ? run.vars?.[iteration] : undefined}
            onParamChange={
              viewingRun
                ? undefined
                : (name, value) =>
                    dispatch(
                      configurationChanged({
                        pathname: tab.pathname,
                        configuration: { ...configuration, params: { ...configuration.params, [name]: value } }
                      })
                    )
            }
            onSelectStep={(stepId) => dispatch(stepSelected({ pathname: flow.pathname, stepId }))}
            onToggleSubflow={toggleSubflow}
          />
        ) : null}

        {selectedStep ? (
          <>
            <div
              className="flow-split-handle"
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize · double-click to reset"
              data-testid="flow-split-handle"
              {...dragbarProps}
            />
            <StepDetail
              stepId={selectedStep}
              node={selectedNode}
              running={isRunning}
              runDir={run?.dir}
              /* 001 §14.5 nests captures under `iteration-N` only for a `dataset:` flow, so the
                 reader has to ask the same way the writer wrote — naming an iteration for a flow
                 that has none looks in a directory that was never created. */
              iteration={description?.dataset ? iteration : undefined}
              /* §5.4 draws a sub-flow's steps only while its container is expanded, and a `uses:`
                 step's pane has nothing of its own to show — so the pane offers the expansion, and
                 stops offering it once the steps are on the drawing. */
              onExpandSubflow={
                expandedSubflows.includes(selectedStep) ? undefined : () => toggleSubflow(selectedStep)
              }
              height={appliedDetailHeight}
            />
          </>
        ) : null}
      </div>
    </StyledWrapper>
  );
};

export default FlowTabPane;
