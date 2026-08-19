import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import { IconPlayerPlay, IconPlayerStop } from '@tabler/icons';
import { runFlow, cancelFlowRun } from '../../actions';
import { stepSelected } from '../../slice';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §7.1 — one control: **Run** while idle, **Cancel** while running.
 *
 * There is no "run from here" and no per-step run: a flow is a graph with declared dependencies, and
 * running a subset means inventing semantics 001 does not define (§14 records it as a real want).
 */

/**
 * §8.4: the steps the verdict fell on that the graph does not already show as red.
 *
 * 001 §11.2's `failOnUnresolved` is the one rule that fails a run through a step that is *not*
 * failed, and it is the only way the counts beside this can read `0 failed` under the word `failed`.
 * A step the graph already draws red needs no chip — it says it itself, in the place that shows what
 * it was — so this names what is otherwise unaccounted for and nothing more.
 *
 * The ids come from `decidedBy` (001 §13.2) rather than from scanning the steps for a reason: which
 * outcome the engine *acted on* depends on a per-step `failOnUnresolved` that `StepResult` does not
 * carry, so a scan would name a step that opted out and had nothing to do with the verdict.
 */
const unaccountedCauses = (run) => {
  if (run?.status !== 'failed') {
    return [];
  }

  const iteration = run.selectedIteration || 0;
  const nodes = run.steps?.[iteration] || {};
  return (run.decidedBy?.[iteration] || []).filter((stepId) => nodes[stepId]?.state !== 'failed');
};

const RunControls = ({ flow, description, run, configuration, onConfigurationChange }) => {
  const dispatch = useDispatch();
  const [starting, setStarting] = useState(false);

  const errors = description ? description.diagnostics.filter((entry) => entry.severity === 'error') : [];
  // §6: errors block the run control; warnings do not.
  const blocked = errors.length > 0 || !description;
  const isRunning = run?.state === 'running';

  const start = async () => {
    setStarting(true);
    try {
      await dispatch(runFlow({ flow, configuration }));
    } catch (error) {
      toast.error(error.message || 'The flow could not be started');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    await dispatch(cancelFlowRun(run.runId));
  };

  return (
    <StyledWrapper>
      {isRunning ? (
        <button type="button" className="run-control cancel" onClick={cancel} data-testid="flow-cancel">
          <IconPlayerStop size={14} strokeWidth={1.5} />
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className="run-control run"
          onClick={start}
          disabled={blocked || starting}
          title={blocked ? 'This flow has errors' : undefined}
          data-testid="flow-run"
        >
          <IconPlayerPlay size={14} strokeWidth={1.5} />
          Run
        </button>
      )}

      <label className="run-option">
        <input
          type="checkbox"
          checked={configuration.capture !== false}
          onChange={(event) => onConfigurationChange({ ...configuration, capture: event.target.checked })}
        />
        Capture
      </label>

      <label className="run-option">
        Concurrency
        <input
          type="number"
          min="1"
          value={configuration.concurrency || ''}
          placeholder="flow"
          onChange={(event) =>
            onConfigurationChange({ ...configuration, concurrency: Number(event.target.value) || undefined })}
        />
      </label>

      {/* §7.2: parameters are shown only for a library flow (001 §12.5). */}
      {description?.isLibrary
        ? description.params.map((param) => (
            <label key={param.name} className="run-option">
              {param.name}
              {param.required ? <span className="required">*</span> : null}
              <input
                type="text"
                value={configuration.params?.[param.name] ?? ''}
                onChange={(event) =>
                  onConfigurationChange({
                    ...configuration,
                    params: { ...configuration.params, [param.name]: event.target.value }
                  })}
              />
            </label>
          ))
        : null}

      {run?.summary ? (
        <div className="run-summary" data-testid="flow-run-summary">
          {/* §8.4: flow vocabulary here, step vocabulary on the nodes — 001 §14.6 keeps them
              lexically distinct precisely so a summary is unambiguous about what it describes. */}
          <span className={`run-status ${run.status}`}>{run.status}</span>
          <span>{`${run.summary.passed} passed`}</span>
          <span>{`${run.summary.failed} failed`}</span>
          <span>{`${run.summary.skipped} skipped`}</span>
          <span>{`${run.summary.cancelled} cancelled`}</span>

          {/* Selecting the step opens §9's pane on it, where its reason and 001 §14.6's message
              already are — so the shortest path from a red verdict to the sentence explaining it is
              one click, and the graph highlights the node on the way. */}
          {unaccountedCauses(run).map((stepId) => (
            <button
              key={stepId}
              type="button"
              className="run-cause"
              data-testid={`flow-run-cause-${stepId}`}
              onClick={() => dispatch(stepSelected({ pathname: flow.pathname, stepId }))}
            >
              {`caused by ${stepId}`}
            </button>
          ))}
        </div>
      ) : null}
    </StyledWrapper>
  );
};

export default RunControls;
