import React, { useMemo, useRef } from 'react';
import EditableTable from 'components/EditableTable';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import CodeMarker from '../CodeMarker';
import { withUnfinished } from '../rows';
import OperatorSelect from './OperatorSelect';

/**
 * 005 §6.2's Assert tab — the step's `assert:` list, as the three things an assertion is.
 *
 * 001 §10.2 writes an assertion as one line — `res.status eq 201` — or, less often, as a mapping of
 * `expr`, `op` and `value`. Either way it is an expression, an operator and an operand, and the
 * collections pane already edits that shape as three columns; this is the same table over the flow
 * dialect, so an author moving between the two panes is not learning a second way to write the same
 * thing.
 *
 * **The line is split by the engine's own rule, not by a second parser.** `parseAssertion` finds the
 * first token after the expression that the dialect knows as an operator; doing anything else here
 * would mean two answers to what `res.body.contains eq 1` says. The operator list comes from the
 * model for the same reason (002-C R4) — it is the engine's, aliases and all.
 *
 * **A row is written back as the line it came from until its parts change.** Splitting a file's
 * assertions into columns and rejoining them would rewrite `res.body.ok` as `res.body.ok isTruthy`
 * and a mapping as a line, in every row, the first time any row was touched — a reformat nobody
 * asked for. So each row keeps what it was read from and hands it back untouched unless one of its
 * three fields moved. The list is committed whole when the typing stops (§6.3), and emptied it is
 * unset (§9.1).
 */

const DEFAULT_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isTruthy'];
/** Shared rather than built per render: it is a dependency of the columns below. */
const NO_OPERATORS = [];

/** §10.2's own reading of a line, mirrored: the first token after the expression that is an operator. */
const partsOf = (entry, operators) => {
  if (entry && typeof entry === 'object') {
    return {
      expr: String(entry.expr ?? ''),
      op: String(entry.op ?? ''),
      value: entry.value === undefined ? '' : String(entry.value)
    };
  }

  const tokens = String(entry).trim().split(/\s+/);
  const at = tokens.findIndex((token, index) => index > 0 && operators.includes(token));
  // A line with no operator in it is an expression on its own, which the dialect reads as isTruthy.
  if (at === -1) return { expr: String(entry).trim(), op: 'isTruthy', value: '' };

  return {
    expr: tokens.slice(0, at).join(' '),
    op: tokens[at],
    value: tokens.slice(at + 1).join(' ')
  };
};

const lineOf = ({ expr, op, value }) => [expr, op, value].filter((part) => part !== '').join(' ');

const samePart = (left, right) => left.expr === right.expr && left.op === right.op && left.value === right.value;

/** A row keeps its uid across a re-seed, for `KeyValueSection`'s reason: a remount under the caret drops keystrokes. */
let nextUid = 0;
const freshUid = () => `assert-${(nextUid += 1)}`;

const rowsOf = (assertions, operators, previous) =>
  (assertions || []).map((entry, index) => ({
    uid: previous[index]?.uid || freshUid(),
    ...partsOf(entry, operators),
    entry
  }));

/**
  * A row being filled in: §10.2 has no assertion without an expression, so one is not written — and an
  * operator chosen or an operand typed first is work the table has to keep.
  */
const unfinished = (row) => !row.expr.trim() && (row.value.trim() !== '' || row.op !== 'eq');

const sameRows = (left, right) => left.length === right.length && left.every((row, index) => samePart(row, right[index]));

const AssertTab = ({ step, model, onPatch }) => {
  const operators = model?.vocabulary?.operators?.length ? model.vocabulary.operators : DEFAULT_OPERATORS;
  const unary = model?.vocabulary?.unaryOperators || NO_OPERATORS;

  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(step.fields.assert, operators, settled)),
    [step.fields.assert, operators]
  );
  const table = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => {
      const assertions = committed
        .filter((row) => row.expr.trim())
        .map((row) => {
          const parts = { expr: row.expr.trim(), op: row.op, value: unary.includes(row.op) ? '' : row.value.trim() };
          // Untouched: hand back what the file held, whichever of the two forms it was written in.
          if (row.entry !== undefined && samePart(partsOf(row.entry, operators), parts)) return row.entry;
          return lineOf(parts);
        });
      onPatch(assertions.length ? { set: { assert: assertions } } : { unset: ['assert'] });
    }
  });
  previous.current = table.value;

  const columns = useMemo(
    () => [
      { key: 'expr', name: 'Expr', isKeyField: true, placeholder: 'res.status', width: '40%' },
      {
        key: 'op',
        name: 'Operator',
        width: '150px',
        render: ({ row, onChange }) => (
          <OperatorSelect
            operator={row.op || 'eq'}
            operators={operators}
            onChange={onChange}
            testId={`flow-step-assert-op-${row.uid}`}
          />
        )
      },
      {
        key: 'value',
        name: 'Value',
        render: ({ row, value, onChange }) =>
          // §10.2's unary operators compare against nothing, so the row has no operand to type.
          (unary.includes(row.op) ? (
            <input type="text" className="cursor-default" disabled data-testid={`flow-step-assert-value-${row.uid}`} />
          ) : (
            <input
              type="text"
              autoComplete="off"
              spellCheck="false"
              placeholder="201"
              value={value || ''}
              onChange={(event) => onChange(event.target.value)}
              data-testid={`flow-step-assert-value-${row.uid}`}
            />
          ))
      }
    ],
    [operators, unary]
  );

  return (
    <div className="editor-section" data-testid="flow-step-assert">
      <div className="editor-section-title">
        Assertions
        <CodeMarker kind="expression" />
      </div>
      <div className="editor-table" onBlur={table.onBlur}>
        <EditableTable
          tableId="flow-step-assert"
          testId="flow-step-assert-table"
          columns={columns}
          rows={table.value}
          onChange={table.onChange}
          defaultRow={{ expr: '', op: 'eq', value: '' }}
          showCheckbox={false}
        />
      </div>
    </div>
  );
};

export default AssertTab;
