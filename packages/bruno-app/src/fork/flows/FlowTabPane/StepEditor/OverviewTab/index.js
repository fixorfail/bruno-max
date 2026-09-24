import React from 'react';
import Button from 'ui/Button';
import { useCommittedField } from 'fork/hooks/useCommittedField';

/**
 * 005 §6.2's first tab: what the step is — its id, its name, and the operation it calls or the
 * sub-flow it invokes.
 */

const inputProps = {
  type: 'text',
  className: 'block textbox w-full',
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: 'false'
};

const TextField = ({ label, value, placeholder, testId, pause, onCommit }) => {
  const field = useCommittedField({ value: value === undefined ? '' : String(value), onCommit, pause });

  return (
    <>
      <label className="editor-label" htmlFor={testId}>
        {label}
      </label>
      <div className="editor-field">
        <input
          {...inputProps}
          id={testId}
          value={field.value}
          placeholder={placeholder}
          onChange={(event) => field.onChange(event.target.value)}
          onBlur={field.onBlur}
          onKeyDown={field.onKeyDown}
          data-testid={testId}
        />
      </div>
    </>
  );
};

const OverviewTab = ({ step, onRename, onPatch, onPickOperation }) => {
  const usesSubflow = step.fields.uses !== undefined;

  return (
    <div className="editor-fields">
      {/* §5.1: the id is derived once and is the author's from then on. It commits on blur or Enter
          only, because every intermediate spelling of a rename would otherwise be written — and
          reported as dangling wherever the old name is read (§6.6). */}
      <TextField label="Id" value={step.id} testId="flow-step-field-id" pause={null} onCommit={onRename} />

      <TextField
        label="Name"
        value={step.fields.name}
        placeholder="A label for the step, shown on its box"
        testId="flow-step-field-name"
        onCommit={(name) => onPatch(name.trim() ? { set: { name: name.trim() } } : { unset: ['name'] })}
      />

      {usesSubflow ? (
        <TextField
          label="Uses"
          value={step.fields.uses}
          placeholder="./shared/login.flow.yml"
          testId="flow-step-field-uses"
          onCommit={(uses) => onPatch({ set: { uses } })}
        />
      ) : (
        <>
          <span className="editor-label">Operation</span>
          <div className="editor-field">
            <span className="editor-value" data-testid="flow-step-field-operation">
              {step.fields.operation === undefined ? '—' : String(step.fields.operation)}
            </span>
            {/* The picker again, for the same reason it is the way in: an operation is looked up,
                not typed. The id does not follow it — it is the author's once written. */}
            <Button size="xs" variant="outline" color="secondary" onClick={onPickOperation} data-testid="flow-step-pick-operation">
              Change…
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default OverviewTab;
