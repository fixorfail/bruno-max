import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import { describeFlow } from '../actions';
import { stepSelected, iterationSelected } from '../slice';
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

const Diagnostics = ({ diagnostics }) => {
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  const warnings = diagnostics.filter((entry) => entry.severity === 'warning');

  if (!diagnostics.length) {
    return null;
  }

  return (
    <div className="flow-diagnostics" data-testid="flow-diagnostics">
      <div className="diagnostic-counts">
        {errors.length ? <span className="error">{`${errors.length} errors`}</span> : null}
        {warnings.length ? <span className="warning">{`${warnings.length} warnings`}</span> : null}
      </div>
      {diagnostics.map((diagnostic, index) => (
        <div key={index} className={`diagnostic ${diagnostic.severity}`}>
          <span className="diagnostic-code">{diagnostic.code}</span>
          <span>{diagnostic.message}</span>
          {/* §6 anchors a diagnostic at its line — the document view is the primary surface, and
              the position is what lets a click land there. */}
          {diagnostic.line ? <span className="diagnostic-line">{`line ${diagnostic.line}`}</span> : null}
        </div>
      ))}
    </div>
  );
};

const FlowTabPane = ({ tab }) => {
  const dispatch = useDispatch();
  const [configuration, setConfiguration] = useState({ capture: true });
  const [expandedSubflows, setExpandedSubflows] = useState([]);
  const [showDataEdges, setShowDataEdges] = useState(true);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const described = useSelector((state) => state.flows.descriptions[tab.pathname]);
  const run = useSelector((state) => state.flows.runs[tab.pathname]);
  const selectedStep = useSelector((state) => state.flows.selectedStep[tab.pathname]);

  const description = described?.description;

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
        onConfigurationChange={setConfiguration}
      />

      {/* §5.3: data edges are toggleable and on by default — on a flow where most steps consume the
          previous one's output they are largely parallel to the control edges, and on one with real
          fan-out they are the interesting half. */}
      <div className="flow-toolbar">
        <label>
          <input type="checkbox" checked={showDataEdges} onChange={(event) => setShowDataEdges(event.target.checked)} />
          Data edges
        </label>

        <RunSelector flow={flow} description={description} run={run} />

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
      </div>

      {described?.loading ? <div className="flow-loading">Reading the flow…</div> : null}
      {described?.error ? <div className="flow-error">{described.error}</div> : null}

      {description ? <Diagnostics diagnostics={description.diagnostics} /> : null}

      {/* §6: a flow that does not parse still opens — an empty graph, its diagnostics anchored, and
          a disabled run control. The failure mode to avoid is a file that cannot be opened
          *because* it is broken, which is when you most want to look at it. */}
      {description ? (
        <FlowGraph
          description={description}
          nodeStates={nodeStates}
          diagnostics={description.diagnostics}
          selectedStep={selectedStep}
          expandedSubflows={expandedSubflows}
          showDataEdges={showDataEdges}
          onSelectStep={(stepId) => dispatch(stepSelected({ pathname: flow.pathname, stepId }))}
          onToggleSubflow={toggleSubflow}
        />
      ) : null}

      {selectedStep ? (
        <StepDetail
          stepId={selectedStep}
          node={selectedNode}
          runDir={run?.dir}
          /* 001 §14.5 nests captures under `iteration-N` only for a `dataset:` flow, so the reader
             has to ask the same way the writer wrote — naming an iteration for a flow that has none
             looks in a directory that was never created. */
          iteration={description?.dataset ? iteration : undefined}
          captureEnabled={configuration.capture !== false}
        />
      ) : null}
    </StyledWrapper>
  );
};

export default FlowTabPane;
