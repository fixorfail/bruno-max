import React, { useMemo, useRef } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { heldByName, withUnfinished } from '../../StepEditor/rows';
import { valueOf } from '../../StepEditor/values';
import { blockOf, textOf, unfinishedAmong } from '../entries';
import OpaqueEntries from '../OpaqueEntries';

/**
 * 001 §12.1's `params:` — the values that a run of the flow takes. The table has one row for each param.
 *
 * The table is the full block. One `params.define` commits it, thus a renamed param keeps its
 * position. **A row goes back as the file wrote it until a part of the row changes.** A `required:
 * false` that nobody changed stays in the file, and a numeric default stays a number. The engine keeps
 * the node of each entry that did not change, so a row must not make its entry again from the cells.
 *
 * An opaque param (§6.4) — for example a default with `!file`, or a key that this build does not
 * know — shows under the table, not in it (`../entries`).
 */

let nextUid = 0;
const freshUid = () => `param-${(nextUid += 1)}`;

const rowsOf = (params, previous) =>
  params
    .filter((param) => !param.opaque)
    .map((param, index) => ({
      uid: previous[index]?.uid || freshUid(),
      name: param.name,
      heldAs: param.name,
      required: Boolean(param.required),
      default: textOf(param.default),
      secret: Boolean(param.secret),
      original: param
    }));

const sameRows = (left, right) =>
  left.length === right.length
  && left.every(
    (row, index) =>
      row.name === right[index].name
      && row.required === right[index].required
      && row.default === right[index].default
      && row.secret === right[index].secret
  );

/**
 * The flag value for the file. If the checkbox agrees with the file, keep the file value. If the
 * checkbox is set, write `true`. If it is clear, write nothing, because §12.1's default is no key.
 */
const flagOf = (checked, written) => (checked === Boolean(written) ? written : checked || undefined);

const defaultOf = (text, written) => {
  if (text === textOf(written)) return written;
  return text.trim() === '' ? undefined : valueOf(text, written);
};

const draftOf = (row) => {
  const original = row.original || {};
  const draft = {
    required: flagOf(Boolean(row.required), original.required),
    default: defaultOf(row.default, original.default),
    secret: flagOf(Boolean(row.secret), original.secret)
  };
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined));
};

const checkboxColumn = (key, name) => ({
  key,
  name,
  width: '90px',
  render: ({ row, onChange }) => (
    <input
      type="checkbox"
      checked={Boolean(row[key])}
      onChange={(event) => onChange(event.target.checked)}
      data-testid={`flow-param-${key}-${row.uid}`}
    />
  )
});

const COLUMNS = [
  { key: 'name', name: 'Name', isKeyField: true, placeholder: 'Name', width: '30%' },
  checkboxColumn('required', 'Required'),
  { key: 'default', name: 'Default', placeholder: 'No default' },
  checkboxColumn('secret', 'Secret')
];

const DEFAULT_ROW = { name: '', required: false, default: '', secret: false };

const hasContent = (row) => row.default.trim() !== '' || row.required || row.secret;

const InputsTab = ({ params, isLibrary, onEdit }) => {
  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinishedAmong(params, hasContent), (settled) => rowsOf(params, settled)),
    [params]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) =>
      onEdit([{ kind: 'params.define', params: blockOf(committed, params, draftOf, {}) }])
  });
  previous.current = table.value;

  const unsafeToRunAlone
    = !isLibrary && heldByName(table.value).some((row) => row.required && row.default.trim() === '');

  return (
    <div className="editor-section" data-testid="flow-settings-inputs">
      <div className="editor-section-title">What a run of this flow takes</div>
      <div className="editor-hint mb-2">
        {'Reference a param with '}
        <code>{'{{params.<name>}}'}</code>
        {'. A step that uses this flow gives the values in its '}
        <code>with:</code>
        .
      </div>
      <div className="editor-table" onBlur={table.onBlur}>
        <EditableTable
          tableId="flow-settings-params"
          testId="flow-settings-params-table"
          columns={COLUMNS}
          rows={table.value}
          onChange={table.onChange}
          defaultRow={DEFAULT_ROW}
          showCheckbox={false}
        />
      </div>

      {/* 001 §12.5: `bru flow validate` gives the same warning. A folder run starts this flow with
          no value for the param. */}
      {unsafeToRunAlone ? (
        <div className="editor-dangled mt-2" data-testid="flow-settings-params-library-hint">
          A required param has no default, and this flow is not a library. A folder run starts it with no value.
          Mark it as a library in its properties to keep it out of folder runs.
        </div>
      ) : null}

      <OpaqueEntries entries={params} kind="param" />
    </div>
  );
};

export default InputsTab;
