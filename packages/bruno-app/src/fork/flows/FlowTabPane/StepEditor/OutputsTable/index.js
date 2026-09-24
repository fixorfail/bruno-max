import React, { useMemo, useRef, useState } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import CodeMarker from '../CodeMarker';
import { heldByName, repeats, withUnfinished } from '../rows';
import OutputScript from './OutputScript';

/**
 * 005 §6.2's `outputs:` block — 001 §8.1's five kinds of output, one row each.
 *
 * It is not a name/value mapping and cannot be edited as one. An output is a *name* and a *source*:
 * a path into the body, into the headers, the status on its own, a value the step computed before
 * its request (§8.7), or a script. The format spells four of those as `{ from, path }` and the fifth
 * as `{ script }`, and gives the commonest — a body path — a shorthand where the value is the path
 * itself. Edited as one value column, that shorthand becomes a trap: a script typed into the cell is
 * a *string*, the engine reads it as a path, the path selects nothing, and every output is undefined
 * with nothing said. So the kind is a control rather than an inference.
 *
 * **A row is written back as the file wrote it until one of its parts changes**, the same rule the
 * assert tab follows: a table that re-serialized every row would turn each body shorthand into its
 * long form the first time any row was touched.
 *
 * **A script is written under the table, not in it, and only while one is being worked on.** A cell
 * of a table sets the width a value may use and moves every row around it whenever its height
 * changes, which is what a function does as it is typed. So the scripts are written below, in a
 * single editor that follows the focused row — a step publishing four of them is a table of four
 * rows and at most one editor, and a step nobody is editing is a table and nothing else.
 *
 * **Focus, not selection**, because the editor is part of what has focus rather than a pane opened
 * beside it: it appears when a script row is entered and goes when focus leaves the section
 * altogether. Moving from the row into the editor keeps it, which is the whole reason the test is
 * "somewhere in this section" rather than "on this row". The heading names the output being edited,
 * the row keeps the line its script starts with, and the box grows with the script by the
 * measurement the body editor uses.
 */

const SOURCE_LABELS = {
  body: 'Body path',
  headers: 'Header',
  status: 'Status',
  pre: 'Computed before',
  script: 'Script'
};

const PLACEHOLDERS = {
  body: 'data.id',
  headers: 'x-request-id',
  pre: 'the pre: name — defaults to this output’s',
  script: '(res) => res.body.data.id'
};

const DEFAULT_SOURCES = ['body', 'headers', 'status', 'pre', 'script'];

/**
 * What the file holds for one output, as the row that edits it. One `value` beside the source rather
 * than a field per kind: a row is one of the five, so the text it holds is the path or the script
 * depending on which — and a source changed under typed text keeps the text, which is what lets a
 * script be pasted and then named as one.
 */
const partsOf = (value) => {
  if (value && typeof value === 'object') {
    if (typeof value.script === 'string') return { source: 'script', value: value.script };
    return { source: String(value.from || 'body'), value: value.path === undefined ? '' : String(value.path) };
  }
  return { source: 'body', value: value === undefined || value === null ? '' : String(value) };
};

/**
 * The shortest form that says what the row says — §5.2's shorthand for a body path, and `{ from }`
 * alone for the two sources whose path is implied: a status has none, and a `pre:` value taken under
 * the name it already has is the block's own default (§8.7).
 */
const writtenAs = ({ name, source, value }) => {
  if (source === 'script') return { script: value };
  if (source === 'status') return { from: 'status' };
  if (source === 'body') return value;
  if (source === 'pre') return value.trim() === '' || value.trim() === name ? { from: 'pre' } : { from: 'pre', path: value };
  return { from: source, path: value };
};

const samePart = (left, right) => left.source === right.source && left.value === right.value;

/** A row keeps its uid across a re-seed, for `KeyValueSection`'s reason: a remount under the caret drops keystrokes. */
let nextUid = 0;
const freshUid = () => `output-${(nextUid += 1)}`;

const rowsOf = (mapping, previous) =>
  Object.entries(mapping || {}).map(([name, value], index) => ({
    uid: previous[index]?.uid || freshUid(),
    name,
    // The name the document holds this row under, so a name typed onto another row is the one
    // that gives way rather than the one already published.
    heldAs: name,
    ...partsOf(value),
    entry: value
  }));

const sameRows = (left, right) =>
  left.length === right.length
  && left.every((row, index) => row.name === right[index].name && samePart(row, right[index]));

/**
 * A row being filled in that the document cannot hold yet — §8.1 publishes an output under its name,
 * and holds one output per name. A row holding nothing but its defaults is not one: that is the
 * table's own add-row.
 */
const unnamed = (row) => !row.name.trim() && ((row.value || '').trim() !== '' || row.source !== 'body');
const unfinished = (row, index, rows) => unnamed(row) || repeats(row, index, rows);

const OutputsTable = ({ step, flow, model, onPatch }) => {
  const sources = model?.vocabulary?.outputSources?.length ? model.vocabulary.outputSources : DEFAULT_SOURCES;
  /** The script row focus is in, or `null` — which is a section nobody is working in. */
  const [chosen, setChosen] = useState(null);
  const sectionRef = useRef(null);

  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(step.fields.outputs, settled)),
    [step.fields.outputs]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => {
      const mapping = Object.fromEntries(
        heldByName(committed)
          .map((row) => {
            const parts = { name: row.name.trim(), source: row.source, value: row.value };
            // Untouched: hand back what the file held, in the form it was written in.
            if (row.entry !== undefined && samePart(partsOf(row.entry), parts)) return [parts.name, row.entry];
            return [parts.name, writtenAs(parts)];
          })
      );
      onPatch(Object.keys(mapping).length ? { set: { outputs: mapping } } : { unset: ['outputs'] });
    }
  });
  previous.current = table.value;

  const columns = useMemo(
    () => [
      { key: 'name', name: 'Name', isKeyField: true, placeholder: 'Name', width: '25%' },
      {
        key: 'source',
        name: 'From',
        width: '150px',
        render: ({ row, onChange }) => (
          <select
            className="mousetrap"
            value={row.source || 'body'}
            onChange={(event) => onChange(event.target.value)}
            data-testid={`flow-step-output-source-${row.uid}`}
          >
            {/* A source this build does not list is still shown, so opening the tab never re-points
                a row at another one. */}
            {(sources.includes(row.source) || !row.source ? sources : [row.source, ...sources]).map((name) => (
              <option key={name} value={name}>
                {SOURCE_LABELS[name] || name}
              </option>
            ))}
          </select>
        )
      },
      {
        key: 'value',
        name: 'Value',
        render: ({ row, onChange }) => {
          // §8.1: the status is the whole value, so the row has no path to type.
          if (row.source === 'status') {
            return <input type="text" className="cursor-default" disabled data-testid={`flow-step-output-value-${row.uid}`} />;
          }

          // A script's cell is the line it starts with, and the way its editor is chosen.
          if (row.source === 'script') {
            return (
              <button
                type="button"
                className="editor-script-summary"
                data-testid={`flow-step-output-value-${row.uid}`}
              >
                <span className="editor-script-summary-text">
                  {row.value.split('\n')[0] || PLACEHOLDERS.script}
                </span>
              </button>
            );
          }

          return (
            <input
              type="text"
              autoComplete="off"
              spellCheck="false"
              placeholder={PLACEHOLDERS[row.source] || PLACEHOLDERS.body}
              value={row.value}
              onChange={(event) => onChange(event.target.value)}
              data-testid={`flow-step-output-value-${row.uid}`}
            />
          );
        }
      }
    ],
    [sources]
  );

  // A row focused and then pointed at another source, or removed, leaves the choice behind.
  const editing = table.value.find((row) => row.uid === chosen && row.source === 'script');

  /** Which row an event happened in, read off the row the table drew it in. */
  const rowUidAt = (target) =>
    target.closest?.('[data-testid^="flow-step-output-row-"]')?.dataset.testid.replace('flow-step-output-row-', '');

  const onFocus = (event) => {
    const uid = rowUidAt(event.target);
    // Focus inside the editor is focus on the row it belongs to, and leaves the choice alone.
    if (uid) setChosen(uid);
  };

  /** Focus that left the section entirely — not focus moving from a row into its own editor. */
  const onBlur = (event) => {
    table.onBlur(event);
    if (!sectionRef.current?.contains(event.relatedTarget)) setChosen(null);
  };

  // The row each cell belongs to, so a focus event can be traced back to it.
  const rowConfig = useMemo(() => ({ testId: (row) => `flow-step-output-row-${row.uid}` }), []);

  return (
    <div
      ref={sectionRef}
      className="editor-section"
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="flow-step-outputs"
    >
      <div className="editor-section-title">
        Outputs
        <CodeMarker kind="script" />
      </div>
      <div className="editor-hint mb-2">
        {'Reference these outputs with '}
        <code>{`steps.${step.id}.<output>`}</code>
      </div>
      <div className="editor-table">
        <EditableTable
          tableId="flow-step-outputs"
          testId="flow-step-outputs-table"
          columns={columns}
          rows={table.value}
          rowConfig={rowConfig}
          onChange={table.onChange}
          defaultRow={{ name: '', source: 'body', value: '' }}
          showCheckbox={false}
        />
      </div>

      {editing ? (
        <OutputScript
          name={editing.name}
          value={editing.value}
          docKey={`flow-step-output:${flow.pathname}:${step.id}:${editing.uid}`}
          names={model?.functionNames}
          onEdit={(value) =>
            table.onChange(table.value.map((entry) => (entry.uid === editing.uid ? { ...entry, value } : entry)))}
        />
      ) : null}
    </div>
  );
};

export default OutputsTable;
