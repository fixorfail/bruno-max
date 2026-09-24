import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import { usePersistedState } from 'hooks/usePersistedState';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import { useVerticalSplit } from 'fork/hooks/useVerticalSplit';
import { useAutoSave } from 'fork/hooks/useAutoSave';
import { useDraftDescribe } from 'fork/hooks/useDraftDescribe';
import { useEditModel } from 'fork/hooks/useEditModel';
import { applyFlowEdit, describeFlow, readFlowSource, saveFlowSource, scopeRootOf } from '../actions';
import { documentAnchored, stepSelected, iterationSelected, configurationChanged, runClosed, sourceReverted, editUndone, editRedone } from '../slice';
import { collectionUidForScope } from '../collectionScope';
import SaveState from '../SaveState';
import FlowGraph from './FlowGraph';
import IterationStrip from './IterationStrip';
import SuiteStrip from './SuiteStrip';
import RunControls from './RunControls';
import FlowSettings from './FlowSettings';
import StepDetail from './StepDetail';
import StepEditor from './StepEditor';
import OperationPicker from './OperationPicker';
import { reachableLibraries, reachableScripts } from './OperationPicker/libraries';
import ApiBindingDialog from './ApiLegend/ApiBindingDialog';
import { readDepends, writeDepends } from './StepEditor/DependsEditor';
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

/**
 * §6 anchors a diagnostic at its line, and the document view is the primary surface for it — which
 * is §4.3's tab, not this one: §4.2 is explicit that the raw `.flow.yml` is a separate tab rather
 * than a second view here. So the line is a control that *goes* there, opening the editor if it is
 * not already open and putting the reader on the line the diagnostic names.
 *
 * A diagnostic with no position — a bad `apis:` binding, a scope-root escape (§6) — has nowhere to
 * go and is stated rather than offered.
 */
/**
 * A diagnostic names its file (001 §13.2), and §6's "line N" opens *that* file. Today the app can
 * open only the flow's own document — a `flows/connectors.yml` entry (001 §8.5) has no tab type to
 * land in (002 §15.2) — so a line in another file is stated, with the file named, and is not a
 * control: a control that opened the flow's YAML at a connector file's line number would jump to
 * the wrong text with every appearance of having answered.
 */
const inAnotherFile = (diagnostic, flowPathname) =>
  Boolean(diagnostic.file && flowPathname && diagnostic.file !== flowPathname);

const basenameOf = (file) => file.split('/').pop();

const DiagnosticLine = ({ diagnostic, flowPathname, onOpenDocument }) => (
  <div className={`diagnostic ${diagnostic.severity}`}>
    <span className="diagnostic-code">{diagnostic.code}</span>
    <span>{diagnostic.message}</span>
    {diagnostic.line && inAnotherFile(diagnostic, flowPathname) ? (
      <span
        className="diagnostic-file"
        title={diagnostic.file}
        data-testid={`flow-diagnostic-file-${diagnostic.line}`}
      >
        {`${basenameOf(diagnostic.file)}, line ${diagnostic.line}`}
      </span>
    ) : null}
    {diagnostic.line && !inAnotherFile(diagnostic, flowPathname) ? (
      <button
        type="button"
        className="diagnostic-line"
        title="Open this line in the flow's YAML"
        data-testid={`flow-diagnostic-line-${diagnostic.line}`}
        onClick={() => onOpenDocument(diagnostic)}
      >
        {`line ${diagnostic.line}`}
      </button>
    ) : null}
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
const Errors = ({ diagnostics, runDiagnostics, flowPathname, onOpenDocument }) => {
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
        <DiagnosticLine key={`file-${index}`} diagnostic={error} flowPathname={flowPathname} onOpenDocument={onOpenDocument} />
      ))}
      {fromRun.map((entry, index) => (
        <DiagnosticLine key={`run-${index}`} diagnostic={entry} flowPathname={flowPathname} onOpenDocument={onOpenDocument} />
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
const Warnings = ({ diagnostics, flowPathname, onOpenDocument }) => {
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
          <DiagnosticLine key={index} diagnostic={warning} flowPathname={flowPathname} onOpenDocument={onOpenDocument} />
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

/**
 * 005 §4 — what the tab is, said in words: the draft's save state while the flow is editable, and
 * why it is not while it is not.
 *
 * The save state is stated here as well as in the YAML tab because a designer may never open that
 * tab, and 002 §4.3's divergence notice — *the file also changed on disk* — is the one message that
 * must not be missed by whoever is about to overwrite it. The Save button follows the same rule the
 * YAML tab keeps: absent while auto-save owns the writing, since two controls answering "is this
 * saved" would disagree the moment one was mid-flight.
 *
 * A run open in the tab — live, finished, or stored — is a record rather than a document, and the
 * way back to editing is the same act as choosing `current` in §10's selector: closing the run.
 * Offered here as **Edit flow** so the return is one click and is named; refused while the run is
 * executing, as `runClosed` refuses it, because a running flow's results are still arriving.
 */
const DesignerState = ({ run, source, name, valid, dirty, autoSaveEnabled, onSave, onRevert, onEditFlow }) => {
  if (run) {
    const running = run.state === 'running';
    return (
      <span className="flow-designer-readonly" data-testid="flow-designer-readonly">
        {running ? 'Running — editing resumes when the run is closed' : 'Reviewing a run — the graph is the one it executed'}
        <button
          type="button"
          className="flow-designer-edit"
          onClick={onEditFlow}
          disabled={running}
          data-testid="flow-designer-edit"
        >
          Edit flow
        </button>
      </span>
    );
  }

  if (!source || source.loading) {
    return null;
  }

  if (source.error && source.content === '' && source.saved === '') {
    return (
      <span className="flow-designer-readonly" data-testid="flow-designer-readonly">
        {`The flow could not be read — ${source.error}`}
      </span>
    );
  }

  if (valid === false) {
    return (
      <span className="flow-designer-readonly" data-testid="flow-designer-readonly">
        The file does not parse — fix it in the YAML tab to edit here
      </span>
    );
  }

  return (
    <span className="flow-designer-state">
      <SaveState
        source={source}
        name={name}
        testId="flow-designer-state"
        divergedTestId="flow-designer-diverged"
        revertTestId="flow-designer-revert"
        onRevert={onRevert}
      />
      {autoSaveEnabled ? null : (
        <button type="button" className="flow-designer-save" onClick={onSave} disabled={!dirty} data-testid="flow-designer-save">
          Save
        </button>
      )}
    </span>
  );
};

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
  /**
   * 005 §5.1: the picker is open for one place in the flow — after the step named, the end when
   * none is, or (§6.2) in place of the operation a selected step already calls — and closes when
   * the step has been written or the author changes their mind. Local because it is a gesture in
   * progress rather than state of the flow.
   */
  const [picker, setPicker] = useState(null);
  /** 005 §5.5: the legend's dialog — adding a binding, or editing the one named. */
  const [bindingDialog, setBindingDialog] = useState(null);

  const flows = useSelector((state) => state.flows.flows);
  const flow = find(flows, (entry) => entry.pathname === tab.pathname);
  /** 005 §5.1: the picker's last rail entry — the libraries this flow could `uses:`. */
  const libraries = useMemo(() => reachableLibraries(flows, flow), [flows, flow]);
  /** 005 §6.2: the shared scripts a step's Scripts tab may add to the flow's `functions.use:`. */
  const scripts = useMemo(() => reachableScripts(flows, flow), [flows, flow]);
  const suiteRun = useSelector((state) => state.flows.suiteRun);
  const collections = useSelector((state) => state.collections.collections);
  const workspaces = useSelector((state) => state.workspaces.workspaces);

  /**
   * 003 §4: a chip opens its flow's run view. The scope travels on the roster rather than being
   * taken from this tab — a selection can span a workspace and the collections inside it, so the
   * flow behind a chip need not belong to the same collection as the one on screen.
   */
  const openSuiteFlow = (entry) => {
    if (entry.entry === flow?.pathname) {
      return;
    }

    dispatch(
      addTab({
        uid: uuid(),
        type: 'flow',
        pathname: entry.entry,
        tabName: entry.name || entry.id,
        collectionUid: collectionUidForScope({ ...entry.scope, collections, workspaces })
      })
    );
  };
  const described = useSelector((state) => state.flows.descriptions[tab.pathname]);
  const run = useSelector((state) => state.flows.runs[tab.pathname]);
  const selectedStep = useSelector((state) => state.flows.selectedStep[tab.pathname]);
  const source = useSelector((state) => state.flows.sources[tab.pathname]);
  const autoSaveEnabled = useSelector((state) => Boolean(state.app.preferences?.autoSave?.enabled));

  /**
   * §10: a run open in the tab — live or restored — is a record, so its inputs are shown rather than
   * edited and its graph is the one it executed (below). Returning to `current` drops the run
   * (`runClosed`) and the tab shows the flow as it stands, which under 005 §4 is the editable state.
   */
  const viewingRun = Boolean(run);

  /**
   * §10: a past run draws the graph **it** executed, not the flow's current one. 001 §14.5 records
   * the description at run start precisely so a run stays readable after the file moves on — without
   * it, a step renamed since loses its outcome silently and one added since reads as never-started.
   * A live run has no snapshot in the slice and falls through to the file's description, which is
   * the same file it is executing.
   *
   * With no run open the tab draws the **draft's** description (005 §7.1): this is where the draft
   * is being made, and a canvas showing the last saved graph while its author adds a step to it
   * would be drawing the wrong document. The file's own description keeps its place in the store —
   * it is what a run would execute — and stands in until the draft has been read and described,
   * during which the two are the same graph.
   */
  const description = viewingRun
    ? run.description || described?.description
    : source?.description || described?.description;

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

  // 005 §7.1: the designer edits 002 §4.3's draft, so the tab reads the flow's text as the YAML tab
  // does when it opens — and keeps the engine's description of that text in step with it.
  useEffect(() => {
    if (flow && !source) {
      dispatch(readFlowSource(flow));
    }
  }, [dispatch, flow, source]);

  const { valid } = useDraftDescribe({ flow, source, immediate: true });
  // §9.2's model, for the legend's dialog: the bindings as written, and the auth profiles it offers.
  const { model } = useEditModel({ flow, source });
  const dirty = Boolean(source) && source.content !== source.saved;

  /**
   * 002 §4.3's auto-save, from this surface too. The draft is one buffer, and the timer that writes
   * it lives in whichever pane is showing it — a draft typed in the YAML tab and then looked at
   * here would otherwise never reach disk, since switching tabs unmounts the pane whose timer it
   * was. Same gate: only a draft that parses.
   */
  useAutoSave({
    trigger: source?.content,
    armed: dirty && valid === true && !source?.saving,
    onSave: () => dispatch(saveFlowSource(flow)).catch(() => undefined)
  });

  if (!flow) {
    return <div className="pb-4 px-4">This flow is no longer on disk.</div>;
  }

  const iteration = run?.selectedIteration || 0;
  const isRunning = run?.state === 'running';
  const nodeStates = run?.steps?.[iteration] || {};

  const save = () => dispatch(saveFlowSource(flow)).catch(() => undefined);

  /**
   * 005 §4's predicate, in full: no run open, the text read, and the engine not having said it does
   * not parse — with not-yet-answered counting as not-yet-valid, the direction 002 §4.3 chose.
   */
  const editable = !viewingRun && Boolean(source) && !source.loading && !source.error && valid === true;

  /**
   * 005 §5.2: the step's entry is removed and nothing else — the sequence closes over the gap, and
   * what referenced the step is the engine's to report. A step removed while selected takes the
   * selection with it, or the pane below would be describing a step that is no longer drawn.
   */
  const deleteStep = async (stepId) => {
    const result = await dispatch(applyFlowEdit(flow, [{ kind: 'step.remove', id: stepId }]));
    if (result.ok && selectedStep === stepId) {
      dispatch(stepSelected({ pathname: flow.pathname, stepId: null }));
    }
  };

  /**
   * 005 §5.1: two lines, spliced where the `+` was — the position is the whole of the edit, and
   * 001 §9.1's implicit sequence does the wiring. The step is what the picker handed back, an
   * `operation:` or a library's `uses:`, and the engine derives the id from it. §6.2's *Change…*
   * reaches the same picker and writes the `operation:` line alone; the id does not follow it,
   * since an id is the author's once written.
   */
  const pickStep = async (step) => {
    const { after, before, replace } = picker;
    setPicker(null);
    const edit = replace
      ? { kind: 'step.patch', id: replace, patch: { set: { operation: step.operation } } }
      : { kind: 'step.insert', step, ...(after ? { after } : {}), ...(before ? { before } : {}) };
    const result = await dispatch(applyFlowEdit(flow, [edit]));
    // The step just added is the one the author is about to fill in, so it is selected and §6's
    // editor opens on it — by the id the engine derived and reported, which nothing here could know.
    if (!replace && result.ok && result.inserted?.length) {
      dispatch(stepSelected({ pathname: flow.pathname, stepId: result.inserted[0] }));
    }
  };

  /**
   * 005 §5.4: a connector dragged between two steps writes the source into the target's `depends:`,
   * in whatever form the target already uses; a declared edge's control takes it out again, and the
   * last one out leaves the step to the implicit sequence. Both read the target's `depends:` off
   * §9.2's model — the graph knows the edge, the model knows the spelling.
   */
  const dependsOf = (stepId) => readDepends(model?.steps.find((entry) => entry.id === stepId)?.fields.depends);
  const writeDependsOf = (stepId, next) => {
    const depends = writeDepends(next);
    return dispatch(applyFlowEdit(flow, [{ kind: 'step.patch', id: stepId, patch: depends === undefined ? { unset: ['depends'] } : { set: { depends } } }]));
  };
  const connectSteps = ({ from, to }) => {
    const current = dependsOf(to);
    if (current.entries.some((entry) => entry.on === from)) {
      return;
    }
    writeDependsOf(to, { ...current, root: false, entries: [...current.entries, { on: from, status: [] }] });
  };
  const disconnectSteps = ({ from, to }) => {
    const current = dependsOf(to);
    writeDependsOf(to, { ...current, entries: current.entries.filter((entry) => entry.on !== from) });
  };

  /**
   * 005 §5.5: the legend's edits. Removing a binding a step still calls is refused by the engine
   * with the steps named, and the refusal is shown where every other one is. An edit keeps the
   * alias's key when the alias is unchanged and renames it otherwise — one edit either way.
   */
  const removeApi = (alias) => dispatch(applyFlowEdit(flow, [{ kind: 'api.remove', alias }]));
  const submitBinding = async (binding) => {
    const { mode, alias } = bindingDialog;
    setBindingDialog(null);
    await dispatch(applyFlowEdit(flow, [mode === 'edit' ? { kind: 'api.update', alias, binding } : { kind: 'api.add', binding }]));
  };

  /**
   * The same binding the YAML tab makes for ⌘S, for the same reason: the app's keybindings have no
   * single-tab `save` action to join, so every editing surface binds its own. Delete removes the
   * selected step while the graph is editable — and only when the key was not meant for a field,
   * since the pane below is full of them. ⌘Z and ⌘⇧Z are 005 §7.3's structured undo and redo, bound
   * here rather than in the YAML tab, whose ⌘Z is the code editor's own; the two are never ambiguous
   * because a keystroke lands in one tab. A field's own undo is left to the field.
   */
  const onKeyDown = (event) => {
    const command = event.metaKey || event.ctrlKey;
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable;

    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }

    if (command && event.key.toLowerCase() === 'z' && editable && !inField) {
      event.preventDefault();
      dispatch(event.shiftKey ? editRedone({ pathname: flow.pathname }) : editUndone({ pathname: flow.pathname }));
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && editable && selectedStep && !inField && !picker) {
      event.preventDefault();
      deleteStep(selectedStep);
      return;
    }

    // §6.8: clearing the selection is what opens the pane over the flow's own settings, so it has a
    // key as well as the drawing's background. Not while a dialog is up — Escape is that dialog's.
    if (event.key === 'Escape' && selectedStep && !inField && !picker && !bindingDialog) {
      event.preventDefault();
      dispatch(stepSelected({ pathname: flow.pathname, stepId: null }));
    }
  };
  const selectedNode = selectedStep ? nodeStates[selectedStep] : undefined;

  const toggleSubflow = (id) =>
    setExpandedSubflows((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  /**
   * §6: a diagnostic is read next to the line that caused it, and the document view is §4.3's tab.
   *
   * The anchor is dispatched before the tab is opened, because the editor reads it when it mounts —
   * and it is dispatched whether or not the tab was already there, since `addTab` on an open
   * pathname focuses it rather than reopening it and would otherwise land the reader on the tab and
   * nowhere in particular in it.
   *
   * The tab borrows this one's `collectionUid` (§4.2): it is a view of the same file in the same
   * scope, and resolving the collection a second way is a second chance to disagree.
   */
  const openDocumentAt = (position) => {
    dispatch(documentAnchored({ pathname: flow.pathname, line: position.line, column: position.column }));
    dispatch(
      addTab({
        uid: uuid(),
        type: 'flow-yaml',
        pathname: flow.pathname,
        tabName: flow.filename,
        collectionUid: tab.collectionUid,
        preview: false
      })
    );
  };

  return (
    <StyledWrapper onKeyDownCapture={onKeyDown}>
      <RunControls
        flow={flow}
        description={description}
        run={run}
        configuration={configuration}
        onConfigurationChange={(next) =>
          dispatch(configurationChanged({ pathname: tab.pathname, configuration: next }))}
        draft={{ dirty, parses: valid, save: () => dispatch(saveFlowSource(flow)) }}
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

        <DesignerState
          run={run}
          source={source}
          name={flow.filename}
          valid={valid}
          dirty={dirty}
          autoSaveEnabled={autoSaveEnabled}
          onSave={save}
          onRevert={() => dispatch(sourceReverted({ pathname: flow.pathname }))}
          onEditFlow={() => dispatch(runClosed({ pathname: flow.pathname }))}
        />

        {/* At the end of the row the flow's other controls are on, rather than over the drawing:
            they are the same kind of thing — what this view is showing and what it is showing about
            — and a count that floated over the graph was the only one of them that moved with it. */}
        {description ? (
          <Warnings diagnostics={description.diagnostics} flowPathname={flow.pathname} onOpenDocument={openDocumentAt} />
        ) : null}
      </div>

      {/* 003 §4: the tab draws one flow of a suite; this says what all of them are doing, which
          under 003 §2 is several at once. Absent unless a suite of more than one is in play. */}
      <SuiteStrip suite={suiteRun} selectedEntry={flow?.pathname} onSelect={openSuiteFlow} />

      {/* §8.3: the selector says which iteration is drawn; the strip says what all of them are
          doing. Under `parallel: > 1` several rows advance at once and the drawing shows one. */}
      <IterationStrip
        run={run}
        onSelect={(index) => dispatch(iterationSelected({ pathname: flow.pathname, iteration: index }))}
      />

      {described?.loading ? <div className="flow-loading">Reading the flow…</div> : null}
      {described?.error ? <div className="flow-error">{described.error}</div> : null}
      {/* 005 §6.3: an edit the engine declined, in the engine's words. The document is unchanged,
          which the save state beside the toolbar confirms. The editor carries the refusal beside the
          step it was about while one is open; this is for a refusal with no step selected. */}
      {source?.editError && !(editable && selectedStep) ? (
        <div className="flow-error" data-testid="flow-designer-refusal">
          {source.editError}
        </div>
      ) : null}

      {description ? (
        <Errors
          diagnostics={description.diagnostics}
          runDiagnostics={run?.diagnostics}
          flowPathname={flow.pathname}
          onOpenDocument={openDocumentAt}
        />
      ) : null}

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
            editable={editable}
            onInsertStep={setPicker}
            onDeleteStep={deleteStep}
            onAddApi={() => setBindingDialog({ mode: 'add' })}
            onEditApi={(alias) => setBindingDialog({ mode: 'edit', alias })}
            onRemoveApi={removeApi}
            onConnect={connectSteps}
            onDisconnect={disconnectSteps}
          />
        ) : null}

        {/* §6.8: the sheet is the selected step's, and the flow's own `config:` when nothing is
            selected — one space, showing whichever of the two the author is looking at. A stored run
            with no selection has neither, and keeps the whole tab for the drawing. */}
        {selectedStep || editable ? (
          <>
            <div
              className="flow-split-handle"
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize · double-click to reset"
              data-testid="flow-split-handle"
              {...dragbarProps}
            />
            {/* 005 §6.1: the same selection opens the run's record while a run is open and the
                editor while the flow is editable — one predicate deciding which, so a step
                selected while reading a run stays selected when the run is closed. */}
            {editable && !selectedStep ? (
              <FlowSettings flow={flow} source={source} height={appliedDetailHeight} />
            ) : null}
            {editable && selectedStep ? (
              <StepEditor
                flow={flow}
                source={source}
                stepId={selectedStep}
                height={appliedDetailHeight}
                scripts={scripts}
                onOpenDocument={(position) => openDocumentAt(position)}
                onPickOperation={() => setPicker({ replace: selectedStep })}
              />
            ) : null}
            {!editable && selectedStep ? (
              <StepDetail
                stepId={selectedStep}
                node={selectedNode}
                /* §8.1's declared names, so an output that resolved to nothing is a row saying so
                   rather than a row that never appears. The run's own record carries only what was
                   extracted; what the step *declares* is the description's. */
                declaredOutputs={description?.nodes?.find((entry) => entry.id === selectedStep)?.outputs}
                running={isRunning}
                scopeRoot={flow ? scopeRootOf(flow) : undefined}
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
            ) : null}
          </>
        ) : null}
      </div>

      {picker ? (
        <OperationPicker
          flow={flow}
          content={source.content}
          libraries={picker.replace ? [] : libraries}
          onPick={pickStep}
          onClose={() => setPicker(null)}
        />
      ) : null}

      {bindingDialog ? (
        <ApiBindingDialog
          binding={bindingDialog.mode === 'edit' ? (model?.apis || []).find((entry) => entry.alias === bindingDialog.alias) : undefined}
          taken={(description?.apis || []).map((entry) => entry.alias)}
          authProfiles={model?.authProfiles || []}
          onSubmit={submitBinding}
          onClose={() => setBindingDialog(null)}
        />
      ) : null}
    </StyledWrapper>
  );
};

export default FlowTabPane;
