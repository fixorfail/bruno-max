import React, { useMemo, useRef } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { heldByName, repeats, withUnfinished } from '../rows';
import { structured, valueOf } from '../values';

/**
 * 005 §6.2 — one of a step's mappings as a table: `headers`, `query`, `pathParams`, `with`, `pre`.
 *
 * Upstream's editable table takes rows and reports changes and touches no store, which is what
 * makes it the right reuse where its request-pane callers are not (§6.2). It reports every keystroke;
 * the whole table is committed as one edit when the typing stops (§6.3), because a mapping is one
 * key in the document and a row half-typed is not a header anyone meant to send.
 *
 * Values are read as written and written as strings. A row with no name is not a key and is left
 * out; a table with no rows unsets the key, so a mapping emptied is a mapping absent (§9.1's
 * default-as-absence).
 */

const COLUMNS = [
  { key: 'name', name: 'Name', isKeyField: true, placeholder: 'Name', width: '35%' },
  { key: 'value', name: 'Value', placeholder: 'Value' }
];

const DEFAULT_ROW = { name: '', value: '' };

/**
 * `shared:` may be written as a list of slot names (001 §9.1) — the output published is the slot's
 * own name — and a list reads here as that mapping. Written back it becomes the mapping form,
 * which means the same thing and is what a table can say.
 */
const entriesOf = (mapping) => (Array.isArray(mapping) ? mapping.map((name) => [name, name]) : Object.entries(mapping || {}));

/**
 * A row keeps the uid it was given for as long as it exists. The table assigns one to the row an
 * author starts typing into, and it re-seeds from the model after every commit — a row keyed by
 * anything that changed with the commit would remount under the caret, mid-word, at the pause that
 * wrote the name, and a keystroke landing on the old element would be dropped. A mapping keeps its
 * order through an edit, so a re-seeded row takes the uid of the row at its position.
 */
let nextUid = 0;
const freshUid = () => `kv-${(nextUid += 1)}`;

const rowsOf = (mapping, previous) =>
  entriesOf(mapping).map(([name, value], index) => ({
    uid: previous[index]?.uid || freshUid(),
    name,
    // The name the document holds this row under, so a name typed onto another row is the one
    // that gives way rather than the one already published.
    heldAs: name,
    value: value === null || value === undefined ? '' : structured(value) ? JSON.stringify(value) : String(value),
    // What the file held, so an untouched value goes back as it was — a mapping stays a mapping
    // rather than becoming the text of one.
    original: value
  }));

/**
 * A row being filled in: a value typed before the key it will be written under, or a key typed
 * towards one that is free through one another row already holds.
 */
const unfinished = (row, index, rows) => (!row.name.trim() && row.value.trim() !== '') || repeats(row, index, rows);

const mappingOf = (rows) =>
  Object.fromEntries(heldByName(rows).map((row) => [row.name.trim(), valueOf(row.value, row.original)]));

const sameRows = (left, right) =>
  left.length === right.length && left.every((row, index) => row.name === right[index].name && row.value === right[index].value);

const KeyValueSection = ({ label, note, field, value, testId, onPatch }) => {
  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(value, settled)),
    [value]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => {
      const mapping = mappingOf(committed);
      onPatch(Object.keys(mapping).length ? { set: { [field]: mapping } } : { unset: [field] });
    }
  });
  previous.current = table.value;

  return (
    <div className="editor-section" data-testid={testId}>
      <div className="editor-section-title">{label}</div>
      {note ? <div className="editor-hint mb-2">{note}</div> : null}
      {/* The table's own scroll box, so its virtualiser measures against this and not the sheet:
          it scrolls its scroll parent to follow a row as it is added, and with the sheet as that
          parent the row just typed into went above the sheet's top and out of the drawing. */}
      <div className="editor-table" onBlur={table.onBlur}>
        <EditableTable
          tableId={testId}
          testId={`${testId}-table`}
          columns={COLUMNS}
          rows={table.value}
          onChange={table.onChange}
          defaultRow={DEFAULT_ROW}
          showCheckbox={false}
        />
      </div>
    </div>
  );
};

export default KeyValueSection;
