import React from 'react';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import CodeMarker from '../CodeMarker';
import { SHEET_EDITOR_ATTRIBUTE } from '../BodyField/sheetScrollGuard';
import DependsEditor from '../DependsEditor';
import WhenEditor from '../WhenEditor';
import { numberOf, textOf } from '../values';

/**
 * 005 §6.2's Flow tab — when the step runs and how long it may take: `depends`, `when`, `retry`,
 * `timeout`, `maxDuration`. A blank field means the flow's own default (§6.5): what `config:` says,
 * or 001 §5.3's, and a value cleared is a key removed.
 */

const NUMBERS = [
  { field: 'timeout', label: 'Timeout (ms, per attempt)' },
  { field: 'maxDuration', label: 'Max duration (ms, whole step)' }
];

const RETRY_NUMBERS = [
  { field: 'maxAttempts', label: 'Attempts' },
  { field: 'delay', label: 'Delay (ms)' },
  { field: 'maxDelay', label: 'Max delay (ms)' }
];

const inputProps = {
  className: 'block textbox w-full',
  autoComplete: 'off',
  spellCheck: 'false'
};

const NumberField = ({ label, value, testId, onCommit }) => {
  const field = useCommittedField({ value: value === undefined ? '' : String(value), onCommit });
  return (
    <>
      <label className="editor-label" htmlFor={testId}>
        {label}
      </label>
      <div className="editor-field">
        <input
          {...inputProps}
          id={testId}
          type="number"
          min="0"
          placeholder="inherit"
          value={field.value}
          onChange={(event) => field.onChange(event.target.value)}
          onBlur={field.onBlur}
          onKeyDown={field.onKeyDown}
          data-testid={testId}
        />
      </div>
    </>
  );
};

const SelectField = ({ label, value, options, testId, onCommit }) => (
  <>
    <label className="editor-label" htmlFor={testId}>
      {label}
    </label>
    <div className="editor-field">
      <select
        id={testId}
        className="textbox"
        value={value === undefined ? '' : String(value)}
        onChange={(event) => onCommit(event.target.value)}
        data-testid={testId}
      >
        <option value="">inherit</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  </>
);

const FlowTab = ({ step, flow, model, onPatch }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const retry = step.fields.retry && typeof step.fields.retry === 'object' ? step.fields.retry : {};

  /** One key, `retry:`, rewritten whole; every field gone is the key gone. */
  const setRetry = (field, value) => {
    const next = { ...retry };
    if (value === undefined || value === '') {
      delete next[field];
    } else {
      next[field] = value;
    }
    onPatch(Object.keys(next).length ? { set: { retry: next } } : { unset: ['retry'] });
  };

  const shouldRetry = useCommittedField({
    value: textOf(retry.shouldRetry),
    onCommit: (text) => setRetry('shouldRetry', text.trim() ? text : undefined)
  });

  const number = (field, text) => onPatch(numberOf(text) === undefined ? { unset: [field] } : { set: { [field]: numberOf(text) } });

  return (
    <>
      <DependsEditor step={step} model={model} onPatch={onPatch} />

      <WhenEditor step={step} flow={flow} names={model?.functionNames} onPatch={onPatch} />

      <div className="editor-section" data-testid="flow-step-retry">
        <div className="editor-section-title">Retry</div>
        <div className="editor-fields">
          {RETRY_NUMBERS.map(({ field, label }) => (
            <NumberField
              key={field}
              label={label}
              value={retry[field]}
              testId={`flow-step-field-retry-${field}`}
              onCommit={(text) => setRetry(field, numberOf(text))}
            />
          ))}
          <SelectField
            label="Backoff"
            value={retry.backoff}
            options={model.vocabulary.backoff || []}
            testId="flow-step-field-retry-backoff"
            onCommit={(value) => setRetry('backoff', value)}
          />
          <SelectField
            label="Jitter"
            value={retry.jitter}
            options={model.vocabulary.jitter || []}
            testId="flow-step-field-retry-jitter"
            onCommit={(value) => setRetry('jitter', value)}
          />
          <label className="editor-label" htmlFor="flow-step-field-retry-shouldRetry">
            Retry when
            <CodeMarker kind="script" />
          </label>
          {/* §8.2's script, in the editor every other script position gets: a predicate is a
              function, and a function is not written in a two-row box. */}
          <div
            className="editor-field editor-body editor-script-body"
            onBlur={shouldRetry.onBlur}
            data-testid="flow-step-field-retry-shouldRetry"
            {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}
          >
            <CodeEditor
              docKey={`flow-step-shouldRetry:${flow.pathname}:${step.id}`}
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

      <div className="editor-section" data-testid="flow-step-limits">
        <div className="editor-section-title">Limits</div>
        <div className="editor-fields">
          {NUMBERS.map(({ field, label }) => (
            <NumberField key={field} label={label} value={step.fields[field]} testId={`flow-step-field-${field}`} onCommit={(text) => number(field, text)} />
          ))}
        </div>
      </div>
    </>
  );
};

export default FlowTab;
