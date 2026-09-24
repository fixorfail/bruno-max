import React, { forwardRef, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import { IconChevronDown, IconDatabaseOff, IconPlayerPlay, IconPlayerStop } from '@tabler/icons';
import Dropdown from 'components/Dropdown';
import { runFlow, cancelFlowRun } from '../../actions';
import { stepSelected } from '../../slice';
import RunConfiguration from '../RunConfiguration';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §7.1 — one control: **Run** while idle, **Cancel** while running.
 *
 * There is no "run from here" and no per-step run: a flow is a graph with declared dependencies, and
 * running a subset means inventing semantics 001 does not define (§14 records it as a real want).
 *
 * **Capture hangs off that control rather than sitting beside it as a setting** (§7.2). It was a
 * checkbox, which made the ordinary run a two-part act — read the state of a box, then press the
 * button — and left that state to be remembered between runs, so the run that wrote nothing looked
 * exactly like the one that did until you went looking. On the control it is what it actually is: a
 * *kind of run*, chosen as the run is started and never inherited by the next one. **Run** captures,
 * always.
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

/**
 * Why the run control is refusing, or `undefined` while it is not.
 *
 * §6: an error blocks the run control and a warning does not. 001 §12.5's required params block it
 * for a different reason with the same consequence — the engine refuses such a run before
 * `run:start` and answers with 001 §14.6's `run-refused`, so a control that offered it would spend a
 * click reaching a refusal everything on screen was already able to state.
 *
 * The predicate is the engine's, unchanged: a param with a default is supplied by that default, and
 * only an absent value is missing — absent meaning what a run is actually started with, since
 * `actions.js` drops a box that was typed into and then cleared before it sends the rest.
 *
 * Params gate **any flow that declares them**, which is every flow §7.2's panel and §5.6's inputs
 * offer boxes for. `library: true` says a flow is meant to be called by another one (001 §12.5) and
 * says nothing about whether it takes params: the engine refuses a run missing a required one either
 * way, so a control keyed on the flag offered a click that could only reach `run-refused`.
 */
const blockingReason = (description, configuration) => {
  if (!description || description.diagnostics.some((entry) => entry.severity === 'error')) {
    return 'This flow has errors';
  }

  const supplied = configuration.params || {};
  const missing = description.params
    .filter((param) => param.required && param.default === undefined)
    .filter((param) => String(supplied[param.name] ?? '').trim() === '')
    .map((param) => param.name);

  if (!missing.length) {
    return undefined;
  }
  return `No value for the required param${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`;
};

/**
 * The half of the split control that opens the menu. A ref-forwarding element because that is what
 * `Dropdown` hangs tippy off — the same shape §4.1's row menu uses, reused so the placement and the
 * dismissal behave identically here.
 */
const RunOptionsTrigger = forwardRef(({ disabled }, ref) => (
  <div
    ref={ref}
    className={`run-control run-options${disabled ? ' is-disabled' : ''}`}
    title="Other ways to run this flow"
    data-testid="flow-run-options"
  >
    <IconChevronDown size={14} strokeWidth={1.5} />
  </div>
));

/**
 * §8.4's elapsed time, from 001 §13.2's `RunResult.duration`.
 *
 * Seconds below a minute and `m s` above it, because a flow is the kind of thing that takes either —
 * and `184s` is a number a reader has to convert before it means anything. Absent for a run recorded
 * before the field existed, and for an interrupted one that never wrote a summary: nothing is drawn
 * rather than a zero, which would claim the run took no time at all.
 */
const elapsed = (duration) => {
  if (typeof duration !== 'number') {
    return undefined;
  }

  const seconds = duration / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

/**
 * 005 §8: `renderer:flow-run` executes the file on disk, and the graph above this control is the
 * draft's — so a run over an unsaved draft would execute the previous version of the flow being
 * looked at. A dirty draft that parses is written first, as one act with the run; one that does not
 * parse, or that the engine has not yet answered about, blocks the control the way §6's errors do,
 * because saving it would write text nobody has checked (002 §4.3's auto-save refuses the same).
 */
const draftBlockingReason = (draft) => {
  if (!draft?.dirty) {
    return undefined;
  }
  if (draft.parses === false) {
    return 'The draft does not parse';
  }
  if (draft.parses === undefined) {
    return 'Checking the draft…';
  }
  return undefined;
};

const RunControls = ({ flow, description, run, configuration, onConfigurationChange, draft }) => {
  const dispatch = useDispatch();
  const dropdownRef = useRef();
  const [menuOpen, setMenuOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const blockedReason = blockingReason(description, configuration) || draftBlockingReason(draft);
  const savesFirst = Boolean(draft?.dirty) && !blockedReason;
  const blocked = blockedReason !== undefined;
  const isRunning = run?.state === 'running';
  /**
   * §7.1: cancel has been asked for and 001 §11.3's cleanup steps are running. The control says so
   * rather than staying on Cancel — a flow with `depends: [{ status: [cancelled] }]` steps keeps
   * working for up to `config.cleanupGrace` after the click, and a button still offering to cancel
   * something that is already cancelling is the exact appearance of a hang §7.1 rules out.
   */
  const cleaningUp = isRunning && run.cleanupDeadline !== undefined;

  // Capture is decided per run and never stored: `configuration` is what the panel beside this keeps
  // between runs, and whether a run wrote to `.bruno-runs/` is a fact about that run (001 §14.5).
  const start = async (capture) => {
    setStarting(true);
    try {
      if (savesFirst) {
        await draft.save();
      }
      await dispatch(runFlow({ flow, configuration: { ...configuration, capture } }));
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
      {cleaningUp ? (
        <div className="run-control cleanup" data-testid="flow-cleanup" title="Cleanup steps are running">
          <IconPlayerStop size={14} strokeWidth={1.5} />
          Cleaning up…
        </div>
      ) : isRunning ? (
        <button type="button" className="run-control cancel" onClick={cancel} data-testid="flow-cancel">
          <IconPlayerStop size={14} strokeWidth={1.5} />
          Cancel
        </button>
      ) : (
        <div className={`run-split${menuOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="run-control run"
            onClick={() => start(true)}
            disabled={blocked || starting}
            title={blockedReason}
            data-testid="flow-run"
          >
            <IconPlayerPlay size={14} strokeWidth={1.5} />
            {savesFirst ? <span data-testid="flow-run-saves-first">Save & run</span> : 'Run'}
          </button>

          {/* The flow's other kinds of run, attached to the button that performs the ordinary one.
              An item runs on the click that chooses it: this is a way of starting a run, not a way
              of configuring the next one, and a chooser that only armed the button would be the
              checkbox again with a step in front of it. */}
          <Dropdown
            onCreate={(ref) => (dropdownRef.current = ref)}
            onShow={() => setMenuOpen(true)}
            onHide={() => setMenuOpen(false)}
            icon={<RunOptionsTrigger disabled={blocked || starting} />}
            placement="bottom-start"
          >
            <div
              className="dropdown-item"
              data-testid="flow-run-without-capture"
              onClick={() => {
                dropdownRef.current.hide();
                start(false);
              }}
            >
              <span className="dropdown-icon">
                <IconDatabaseOff size={16} strokeWidth={1.5} />
              </span>
              Run without capture
            </div>
          </Dropdown>
        </div>
      )}

      {/* §7.2's panel, beside the control it configures. */}
      <RunConfiguration
        description={description}
        configuration={configuration}
        onConfigurationChange={onConfigurationChange}
        disabled={isRunning}
      />

      {run?.summary ? (
        <div className="run-summary" data-testid="flow-run-summary">
          {/* §8.4: flow vocabulary here, step vocabulary on the nodes — 001 §14.6 keeps them
              lexically distinct precisely so a summary is unambiguous about what it describes. */}
          <span className={`run-status ${run.status}`}>{run.status}</span>
          <span data-testid="flow-run-total">{`${run.summary.total} steps`}</span>
          <span>{`${run.summary.passed} passed`}</span>
          <span>{`${run.summary.failed} failed`}</span>
          <span>{`${run.summary.skipped} skipped`}</span>
          <span>{`${run.summary.cancelled} cancelled`}</span>
          {elapsed(run.duration) ? (
            <span className="run-elapsed" data-testid="flow-run-elapsed">
              {elapsed(run.duration)}
            </span>
          ) : null}

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
