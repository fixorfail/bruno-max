import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { useEditModel } from 'fork/hooks/useEditModel';
import { applyFlowEdit } from '../../actions';
import { FLAGS } from '../flags';
import CodeMarker from '../StepEditor/CodeMarker';
import { SHEET_EDITOR_ATTRIBUTE } from '../StepEditor/BodyField/sheetScrollGuard';
import { numberOf } from '../StepEditor/values';
import StyledWrapper from '../StepEditor/StyledWrapper';

/**
 * 005 §6.8 — the pane over 001 §5.2's `config:`, where the step editor's pane is over one step.
 *
 * It opens on the seam the step editor leaves: the sheet below the graph shows the selected step,
 * and a flow with nothing selected had nothing there at all. The flow's own defaults are what
 * belongs in that space — every flag the step pane offers has a flow-level setting a step inherits,
 * and until this pane existed that setting was reachable only by opening the YAML.
 *
 * **The flags read *default* · *on* · *off*, not *inherit*.** A step's silence means "whatever
 * `config:` says", which is a value the author can go and look at. A flow's silence has nothing
 * above it — it means 001 §5.2's own default — so the state is named for what it does and the
 * default is spelled out beside it. `../flags` carries both the list and each one's fallback.
 *
 * **A cleared field deletes its key.** §5.2 writes a default as an absence, so emptying
 * `concurrency` removes the line rather than writing `5`; the engine's `config.patch` takes the
 * `unset` that says so, and removes the block when its last key goes.
 */

const RETRY_NUMBERS = [
  { field: 'maxAttempts', label: 'Attempts' },
  { field: 'delay', label: 'Delay (ms)' },
  { field: 'maxDelay', label: 'Max delay (ms)' }
];

const NUMBERS = [
  { field: 'concurrency', label: 'Concurrency (steps in flight)', placeholder: '5' },
  { field: 'maxRunDuration', label: 'Max run duration (ms)', placeholder: 'no limit' },
  { field: 'cleanupGrace', label: 'Cleanup grace (ms)', placeholder: '30000' },
  { field: 'capturePreviewBytes', label: 'Capture preview (bytes)', placeholder: '8192' }
];

const inputProps = { className: 'block textbox w-full', autoComplete: 'off', spellCheck: 'false' };

const stateOf = (value) => (value === true ? 'on' : value === false ? 'off' : 'default');

const Field = ({ label, testId, children }) => (
  <>
    <label className="editor-label" htmlFor={testId}>
      {label}
    </label>
    <div className="editor-field">{children}</div>
  </>
);

const TextField = ({ label, value, testId, placeholder, onCommit }) => {
  const field = useCommittedField({ value, onCommit });
  return (
    <Field label={label} testId={testId}>
      <input
        {...inputProps}
        id={testId}
        placeholder={placeholder}
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
        onKeyDown={field.onKeyDown}
        data-testid={testId}
      />
    </Field>
  );
};

const NumberField = ({ label, value, testId, placeholder, onCommit }) => (
  <TextField
    label={label}
    testId={testId}
    placeholder={placeholder}
    value={value === undefined ? '' : String(value)}
    onCommit={onCommit}
  />
);

const FlowSettings = ({ flow, source, height }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const [tab, setTab] = useState('defaults');
  const { model, answered } = useEditModel({ flow, source });
  const config = model?.config;

  const patch = (patchOf) => dispatch(applyFlowEdit(flow, [{ kind: 'config.patch', patch: patchOf }]));
  /** A field emptied is a key removed (§5.2), which is the whole reason `unset` exists beside `set`. */
  const write = (field, value) =>
    patch(value === undefined || value === '' ? { unset: [field] } : { set: { [field]: value } });

  /**
   * `retry:` is one key holding a mapping, so a field inside it rewrites the whole map — the pane
   * reads what the block has, replaces the one entry and writes it back, and clears the key
   * altogether when nothing is left under it.
   */
  const writeRetry = (field, value) => {
    const next = { ...(config?.retry || {}) };
    if (value === undefined || value === '') delete next[field];
    else next[field] = value;
    return patch(Object.keys(next).length ? { set: { retry: next } } : { unset: ['retry'] });
  };

  const shouldRetry = useCommittedField({
    value: config?.retry?.shouldRetry === undefined ? '' : String(config.retry.shouldRetry),
    onCommit: (text) => writeRetry('shouldRetry', text.trim())
  });

  const header = (
    <>
      <span className="editor-step">The flow&apos;s defaults</span>
      <span className="editor-operation">config:</span>
      {source?.editError ? (
        <span className="editor-refusal" data-testid="flow-settings-refusal">
          {source.editError}
        </span>
      ) : null}
    </>
  );

  return (
    <StyledWrapper
      height={height}
      testId="flow-settings"
      header={header}
      tabs={config ? ['defaults', 'runs'] : []}
      activeTab={tab}
      onSelectTab={setTab}
      tabTestId={(name) => `flow-settings-tab-${name}`}
    >
      {!config && !answered ? <div className="editor-hint">Reading the flow…</div> : null}
      {!config && answered ? (
        <div className="editor-hint">This flow does not parse, so its config cannot be edited here.</div>
      ) : null}

      {config && tab === 'defaults' ? (
        <div className="editor-section" data-testid="flow-settings-defaults">
          <div className="editor-section-title">Every step, unless the step says otherwise</div>
          <div className="editor-fields">
            {FLAGS.map(({ field, label, fallback }) => (
              <Field key={field} label={label} testId={`flow-config-flag-${field}`}>
                <select
                  id={`flow-config-flag-${field}`}
                  className="textbox"
                  value={stateOf(config[field])}
                  onChange={(event) => {
                    const next = event.target.value;
                    patch(next === 'default' ? { unset: [field] } : { set: { [field]: next === 'on' } });
                  }}
                  data-testid={`flow-config-flag-${field}`}
                >
                  <option value="default">{`default — ${fallback ? 'on' : 'off'}`}</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
                <code className="editor-hint">{field}</code>
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      {config && tab === 'runs' ? (
        <>
          <div className="editor-section" data-testid="flow-settings-runs">
            {/* Plural, and it matters: these are what *every* run of this flow starts with, and the
                tab strip sits beside a run selector where "the run" means the one on screen. */}
            <div className="editor-section-title">Every run of this flow</div>
            <div className="editor-fields">
              <TextField
                label="Base URL"
                testId="flow-config-baseUrl"
                placeholder="the document's servers[0]"
                value={config.baseUrl === undefined ? '' : String(config.baseUrl)}
                onCommit={(text) => write('baseUrl', text.trim())}
              />
              {NUMBERS.map(({ field, label, placeholder }) => (
                <NumberField
                  key={field}
                  label={label}
                  testId={`flow-config-${field}`}
                  placeholder={placeholder}
                  value={config[field]}
                  onCommit={(text) => write(field, numberOf(text))}
                />
              ))}
              {/* §14.4's additions to the built-in denylist, written the way `meta.tags` is — one
                  line, because that is how §5.2 spells a sequence of names and a row of chips would
                  be a second way to read the value the YAML tab shows on one. */}
              <TextField
                label="Redact headers (comma separated)"
                testId="flow-config-redactHeaders"
                placeholder="beyond the built-in denylist"
                value={(config.redactHeaders || []).join(', ')}
                onCommit={(text) => {
                  const names = text.split(',').map((name) => name.trim()).filter(Boolean);
                  return write('redactHeaders', names.length ? names : undefined);
                }}
              />
            </div>
          </div>

          <div className="editor-section" data-testid="flow-settings-retry">
            <div className="editor-section-title">Retry, unless the step says otherwise</div>
            <div className="editor-fields">
              {RETRY_NUMBERS.map(({ field, label }) => (
                <NumberField
                  key={field}
                  label={label}
                  testId={`flow-config-retry-${field}`}
                  placeholder="default"
                  value={config.retry?.[field]}
                  onCommit={(text) => writeRetry(field, numberOf(text))}
                />
              ))}
              {[
                { field: 'backoff', options: ['fixed', 'exponential'] },
                { field: 'jitter', options: ['none', 'full'] }
              ].map(({ field, options }) => (
                <Field
                  key={field}
                  label={field === 'backoff' ? 'Backoff' : 'Jitter'}
                  testId={`flow-config-retry-${field}`}
                >
                  <select
                    id={`flow-config-retry-${field}`}
                    className="textbox"
                    value={config.retry?.[field] ?? ''}
                    onChange={(event) => writeRetry(field, event.target.value || undefined)}
                    data-testid={`flow-config-retry-${field}`}
                  >
                    <option value="">{`default — ${options[0]}`}</option>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
              {/* §8.2's script, in the editor every script position gets — the flow-wide counterpart
                  of the step's own *Retry when*, and inherited by every step that declares none. */}
              <label className="editor-label" htmlFor="flow-config-retry-shouldRetry">
                Retry when
                <CodeMarker kind="script" />
              </label>
              <div
                className="editor-field editor-body editor-script-body"
                onBlur={shouldRetry.onBlur}
                data-testid="flow-config-retry-shouldRetry"
                {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}
              >
                <CodeEditor
                  docKey={`flow-config-shouldRetry:${flow.pathname}`}
                  theme={displayedTheme}
                  font={get(preferences, 'font.codeFont', 'default')}
                  fontSize={get(preferences, 'font.codeFontSize')}
                  value={shouldRetry.value}
                  mode="javascript"
                  knownGlobals={model?.functionNames}
                  enableVariableHighlighting={false}
                  enableBrunoVarInfo={false}
                  onEdit={shouldRetry.onChange}
                  onRun={() => {}}
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </StyledWrapper>
  );
};

export default FlowSettings;
