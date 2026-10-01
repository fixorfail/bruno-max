import React, { useMemo, useRef } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { withUnfinished } from '../../StepEditor/rows';
import { blockOf, unfinishedAmong } from '../entries';
import OpaqueEntries from '../OpaqueEntries';

/**
 * 001 §12.1's `exports:` — the values that the flow gives back to a step that uses it. The table has
 * one row for each export.
 *
 * One `exports.define` commits the full block, as `params.define` does for params. A source is free
 * text, because the format permits any `steps.<step>.<output>` or `shared.<slot>`. The engine's
 * diagnostics show a source that names nothing. The tab suggests the references that the flow can
 * export. They come from the engine's description of the draft, not from its text (002-C R4),
 * because only the engine reads the library of a `uses:` step.
 *
 * An opaque export (§6.4) shows under the table (`../entries`).
 */

let nextUid = 0;
const freshUid = () => `export-${(nextUid += 1)}`;

const rowsOf = (entries, previous) =>
  entries
    .filter((entry) => !entry.opaque)
    .map((entry, index) => ({
      uid: previous[index]?.uid || freshUid(),
      name: entry.name,
      heldAs: entry.name,
      source: entry.source
    }));

const sameRows = (left, right) =>
  left.length === right.length
  && left.every((row, index) => row.name === right[index].name && row.source === right[index].source);

const hasContent = (row) => row.source.trim() !== '';

/**
 * All references that an export can name, in declaration order: the outputs of each top-level step,
 * then each slot. The steps of a sub-flow have a `parent`. This flow cannot export them (001 §12.3).
 */
const exportableReferences = (description) => {
  const steps = (description?.nodes || [])
    .filter((node) => !node.parent)
    .flatMap((node) => [
      ...(node.outputs || []),
      ...(node.exports || []).map((entry) => entry.name)
    ].map((output) => `steps.${node.id}.${output}`));
  const slots = (description?.slots || []).map((slot) => `shared.${slot.name}`);
  return [...new Set([...steps, ...slots])];
};

const SUGGESTIONS_ID = 'flow-settings-export-sources';

const COLUMNS = [
  { key: 'name', name: 'Name', isKeyField: true, placeholder: 'Name', width: '30%' },
  {
    key: 'source',
    name: 'Source',
    render: ({ row, onChange }) => (
      <input
        type="text"
        autoComplete="off"
        spellCheck="false"
        list={SUGGESTIONS_ID}
        placeholder="steps.<step>.<output> or shared.<slot>"
        value={row.source}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`flow-export-source-${row.uid}`}
      />
    )
  }
];

const DEFAULT_ROW = { name: '', source: '' };

const ExportsTab = ({ exports, description, onEdit }) => {
  const references = useMemo(() => exportableReferences(description), [description]);

  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinishedAmong(exports, hasContent), (settled) => rowsOf(exports, settled)),
    [exports]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) =>
      onEdit([{ kind: 'exports.define', exports: blockOf(committed, exports, (row) => row.source.trim(), '') }])
  });
  previous.current = table.value;

  return (
    <div className="editor-section" data-testid="flow-settings-exports">
      <div className="editor-section-title">What this flow hands back</div>
      <div className="editor-hint mb-2">
        {'A step that uses this flow reads an export as '}
        <code>{'steps.<that step>.<name>'}</code>
        .
      </div>
      <div className="editor-table" onBlur={table.onBlur}>
        <EditableTable
          tableId="flow-settings-exports"
          testId="flow-settings-exports-table"
          columns={COLUMNS}
          rows={table.value}
          onChange={table.onChange}
          defaultRow={DEFAULT_ROW}
          showCheckbox={false}
        />
      </div>
      <datalist id={SUGGESTIONS_ID} data-testid="flow-settings-export-suggestions">
        {references.map((reference) => (
          <option key={reference} value={reference} />
        ))}
      </datalist>

      <OpaqueEntries entries={exports} kind="export" />
    </div>
  );
};

export default ExportsTab;
