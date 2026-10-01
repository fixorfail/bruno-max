import React, { useMemo, useRef } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { withUnfinished } from '../../StepEditor/rows';
import { valueOf } from '../../StepEditor/values';
import { blockOf, textOf, unfinishedAmong } from '../entries';
import OpaqueEntries from '../OpaqueEntries';

/**
 * 001 §7.3's `vars:` — the values that the flow computes before its first step. The table has one
 * row for each var, and one `vars.define` commits the full block.
 *
 * The section is on the Inputs tab, because the graph's inputs panel shows params and vars together.
 * It is a different table from the params, because a caller cannot set a var: a var has no
 * `required` or `default`, only a value or an expression.
 *
 * **A row goes back as the file wrote it until its value changes.** A number stays a number, and a
 * mapping stays a mapping while its text is still JSON. A var from a file (`!file`, §7.4) is opaque
 * and shows under the table (`../entries`).
 */

let nextUid = 0;
const freshUid = () => `var-${(nextUid += 1)}`;

const rowsOf = (vars, previous) =>
  vars
    .filter((entry) => !entry.opaque)
    .map((entry, index) => ({
      uid: previous[index]?.uid || freshUid(),
      name: entry.name,
      heldAs: entry.name,
      value: textOf(entry.value),
      original: entry.value
    }));

const sameRows = (left, right) =>
  left.length === right.length
  && left.every((row, index) => row.name === right[index].name && row.value === right[index].value);

const hasContent = (row) => row.value.trim() !== '';

const valueOfRow = (row) => (row.value === textOf(row.original) ? row.original : valueOf(row.value, row.original));

const COLUMNS = [
  { key: 'name', name: 'Name', isKeyField: true, placeholder: 'Name', width: '30%' },
  { key: 'value', name: 'Value', placeholder: 'A value, or an expression such as {{$randomUUID}}' }
];

const DEFAULT_ROW = { name: '', value: '' };

const VarsSection = ({ vars, onEdit }) => {
  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinishedAmong(vars, hasContent), (settled) => rowsOf(vars, settled)),
    [vars]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => onEdit([{ kind: 'vars.define', vars: blockOf(committed, vars, valueOfRow, null) }])
  });
  previous.current = table.value;

  return (
    <div className="editor-section" data-testid="flow-settings-vars">
      <div className="editor-section-title">What this flow computes before its first step</div>
      <div className="editor-hint mb-2">
        {'A caller cannot set a var. Reference a var with '}
        <code>{'{{<name>}}'}</code>
        {'. A var can read '}
        <code>{'{{params.*}}'}</code>
        {' and '}
        <code>{'{{row.*}}'}</code>
        {', but not '}
        <code>{'{{steps.*}}'}</code>
        .
      </div>
      <div className="editor-table" onBlur={table.onBlur}>
        <EditableTable
          tableId="flow-settings-vars"
          testId="flow-settings-vars-table"
          columns={COLUMNS}
          rows={table.value}
          onChange={table.onChange}
          defaultRow={DEFAULT_ROW}
          showCheckbox={false}
        />
      </div>
      <OpaqueEntries entries={vars} kind="var" />
    </div>
  );
};

export default VarsSection;
