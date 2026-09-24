import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useEditModel } from 'fork/hooks/useEditModel';
import { applyFlowEdit } from '../../actions';
import { stepSelected } from '../../slice';
import OverviewTab from './OverviewTab';
import RequestTab from './RequestTab';
import OutputsTab from './OutputsTab';
import ScriptsTab from './ScriptsTab';
import AssertTab from './AssertTab';
import FlowTab from './FlowTab';
import SettingsTab from './SettingsTab';
import OpaqueFields from './OpaqueFields';
import StyledWrapper from './StyledWrapper';

/**
 * 005 §6 — the pane below the graph while the flow is editable: the selected step, as a form.
 *
 * Two components share the sheet and nothing else (§6.1): 002 §9's `StepDetail` is a machine over
 * attempts and captures, and this is one over a draft and a pending edit. It renders from the
 * engine's model of the draft (§9.2), never from the text, and every change it makes is one edit
 * through §9.1 — a field holds its own value while it is typed in and hands it over when the typing
 * stops (§6.3), and the moment the edit lands the field reads back from the model the engine
 * returns. Nothing here is painted from what the renderer expects the engine to say.
 */

const TABS = ['overview', 'scripts', 'request', 'flow', 'outputs', 'assert', 'settings'];

/**
 * A `uses:` step sends nothing itself, computes nothing before a request it does not send, and
 * asserts nothing of its own (001 §12.4), so the tabs about what a step sends, computes and checks
 * are not offered rather than offered empty.
 */
const tabsFor = (step) => (step.fields.uses === undefined ? TABS : TABS.filter((name) => !['scripts', 'request', 'assert'].includes(name)));

const StepEditor = ({ flow, source, stepId, height, scripts, onOpenDocument, onPickOperation }) => {
  const dispatch = useDispatch();
  const [tab, setTab] = useState('overview');
  /** §6.6: the id this step was renamed from, so what the rename dangled can be counted for it. */
  const [renamedFrom, setRenamedFrom] = useState(null);
  const { model, answered } = useEditModel({ flow, source });
  const step = model?.steps.find((entry) => entry.id === stepId);

  const edit = (edits) => dispatch(applyFlowEdit(flow, edits));
  const patch = (patchOf) => edit([{ kind: 'step.patch', id: stepId, patch: patchOf }]);
  const rename = async (to) => {
    const result = await edit([{ kind: 'step.rename', id: stepId, to }]);
    // The selection follows the step it named, or the pane would be describing a step that is no
    // longer in the file and the graph would highlight nothing.
    if (result.ok) {
      setRenamedFrom(stepId);
      dispatch(stepSelected({ pathname: flow.pathname, stepId: to }));
    }
  };

  /**
   * §6.6: a rename writes the new id and nothing else, and every `{{steps.<old>.…}}`, `depends:` and
   * `stages:` entry naming the old one now dangles. The engine reports each on the line that holds
   * it (001 §14.3's `unknown-step-reference`); this is the count, read off the draft's description,
   * so the author who renamed knows what to go and fix.
   */
  const dangled = renamedFrom
    ? (source.description?.diagnostics || []).filter(
        (diagnostic) =>
          diagnostic.code === 'unknown-step-reference'
          && new RegExp(`references (steps\\.)?${renamedFrom}\\b`).test(diagnostic.message)
      ).length
    : 0;

  const header = (
    <>
      <span className="editor-step">{stepId}</span>
      {step ? (
        <span className="editor-operation">{step.fields.operation ?? step.fields.uses ?? ''}</span>
      ) : null}
      {/* §6.3: a refusal in the engine's words, beside the step it was about. The document is
          unchanged, which the save state on the toolbar confirms. */}
      {source.editError ? (
        <span className="editor-refusal" data-testid="flow-step-refusal">
          {source.editError}
        </span>
      ) : null}
      {dangled ? (
        <span className="editor-dangled" data-testid="flow-step-dangled">
          {`${dangled} reference${dangled === 1 ? '' : 's'} to the old name, ${renamedFrom}`}
        </span>
      ) : null}
    </>
  );

  return (
    <StyledWrapper
      height={height}
      testId="flow-step-editor"
      header={header}
      tabs={step ? tabsFor(step) : []}
      activeTab={tab}
      onSelectTab={setTab}
      tabTestId={(name) => `flow-step-editor-tab-${name}`}
    >
      {!step && !answered ? <div className="editor-hint">Reading the step…</div> : null}
      {!step && answered ? <div className="editor-hint">{`${stepId} is not in the draft`}</div> : null}

      {step && tab === 'overview' ? (
        <OverviewTab step={step} onRename={rename} onPatch={patch} onPickOperation={onPickOperation} />
      ) : null}
      {step && tab === 'request' ? <RequestTab step={step} flow={flow} content={source.content} onPatch={patch} /> : null}
      {step && tab === 'flow' ? <FlowTab step={step} flow={flow} model={model} onPatch={patch} /> : null}
      {step && tab === 'outputs' ? (
        <OutputsTab step={step} flow={flow} model={model} node={(source.description?.nodes || []).find((entry) => entry.id === stepId)} onPatch={patch} />
      ) : null}
      {step && tab === 'scripts' && !step.opaque.some((entry) => entry.key === 'pre') ? (
        <ScriptsTab step={step} flow={flow} functions={model.functions || []} definitions={model.definitions} names={model.functionNames || []} scripts={scripts || []} onPatch={patch} onEdit={edit} />
      ) : null}
      {step && tab === 'settings' ? <SettingsTab step={step} onPatch={patch} /> : null}
      {step && tab === 'assert' && !step.opaque.some((entry) => entry.key === 'assert') ? <AssertTab step={step} model={model} onPatch={patch} /> : null}

      {step ? <OpaqueFields step={step} onOpenDocument={onOpenDocument} /> : null}
    </StyledWrapper>
  );
};

export default StepEditor;
