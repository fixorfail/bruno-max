import React, { useMemo, useRef } from 'react';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import Button from 'ui/Button';
import { useTheme } from 'providers/Theme';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import CodeMarker from '../CodeMarker';
import { withUnfinished } from '../rows';
import { SHEET_EDITOR_ATTRIBUTE } from '../BodyField/sheetScrollGuard';

/**
 * 005 §6.2's `when:` — 001 §9.3's conditions, one row each, and an implicit AND between them.
 *
 * A condition is written two ways and they are not the same kind of thing: an **expression**, which
 * is evaluated on its own, and a **script**, which runs through the engine's script runner with the
 * flow's shared functions in scope (§8.2). Held in one text field the second was reachable only by
 * typing its JSON, which is the trap `outputs:` had — a shape the file accepts, spelled in a box
 * that says nothing about which of the two it is reading.
 *
 * A row nobody touched is written back as the file wrote it, and a lone expression stays the bare
 * string §9.3 also accepts rather than becoming a list of one.
 */

const KINDS = [
  { kind: 'expression', label: 'Expression' },
  { kind: 'script', label: 'Script' }
];

let nextUid = 0;
const freshUid = () => `when-${(nextUid += 1)}`;

const partsOf = (entry) =>
  (entry && typeof entry === 'object' && typeof entry.script === 'string'
    ? { kind: 'script', value: entry.script }
    : { kind: 'expression', value: entry === undefined || entry === null ? '' : String(entry) });

const writtenAs = ({ kind, value }) => (kind === 'script' ? { script: value } : value);

const samePart = (left, right) => left.kind === right.kind && left.value === right.value;

/** §9.3 reads a bare condition as a list of one, and the model carries the field as written. */
const asList = (when) => (Array.isArray(when) ? when : when === undefined || when === null ? [] : [when]);

const rowsOf = (when, previous) =>
  asList(when).map((entry, index) => ({ uid: previous[index]?.uid || freshUid(), ...partsOf(entry), entry }));

/**
  * A condition with nothing in it yet. Unlike the tables, a row here is added by an explicit control,
  * so the author asked for it — an empty one stays until they take it back, and writes nothing.
  */
const unfinished = (row) => !row.value.trim();

const sameRows = (left, right) => left.length === right.length && left.every((row, index) => samePart(row, right[index]));

const WhenEditor = ({ step, flow, names, onPatch }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);

  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(step.fields.when, settled)),
    [step.fields.when]
  );
  const list = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => {
      const conditions = committed
        .filter((row) => row.value.trim())
        .map((row) => {
          const parts = { kind: row.kind, value: row.value };
          // Untouched: hand back what the file held, in the form it was written in.
          if (row.entry !== undefined && samePart(partsOf(row.entry), parts)) return row.entry;
          return writtenAs(parts);
        });

      if (!conditions.length) {
        onPatch({ unset: ['when'] });
        return;
      }
      // §9.3 reads a bare condition as a list of one, and that is how a file with a single one reads.
      onPatch({ set: { when: conditions.length === 1 && typeof conditions[0] === 'string' ? conditions[0] : conditions } });
    }
  });
  previous.current = list.value;

  const update = (uid, change) => list.onChange(list.value.map((row) => (row.uid === uid ? { ...row, ...change } : row)));

  return (
    <div className="editor-section" data-testid="flow-step-when">
      <div className="editor-section-title">Runs only when</div>
      <div className="editor-hint mb-2">
        Every condition has to hold. An expression is evaluated on its own; a script runs with the
        flow&apos;s shared functions in scope.
      </div>

      {list.value.map((row, index) => (
        <div key={row.uid} className="editor-script-entry" data-testid={`flow-step-when-${index}`}>
          <div className="editor-script-head">
            <select
              className="textbox mousetrap"
              value={row.kind}
              onChange={(event) => update(row.uid, { kind: event.target.value })}
              onBlur={list.onBlur}
              data-testid={`flow-step-when-kind-${index}`}
            >
              {KINDS.map(({ kind, label }) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            <CodeMarker kind={row.kind} />
            <Button
              size="xs"
              variant="outline"
              color="secondary"
              onClick={() => list.onChange(list.value.filter((entry) => entry.uid !== row.uid))}
              data-testid={`flow-step-when-remove-${index}`}
            >
              Remove
            </Button>
          </div>

          {row.kind === 'script' ? (
            <div
              className="editor-body editor-script-body"
              onBlur={list.onBlur}
              data-testid={`flow-step-when-editor-${index}`}
              {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}
            >
              <CodeEditor
                docKey={`flow-step-when:${flow.pathname}:${step.id}:${row.uid}`}
                theme={displayedTheme}
                font={get(preferences, 'font.codeFont', 'default')}
                fontSize={get(preferences, 'font.codeFontSize')}
                value={row.value}
                mode="javascript"
                knownGlobals={names}
                enableVariableHighlighting={false}
                enableBrunoVarInfo={false}
                onEdit={(value) => update(row.uid, { value })}
                onRun={() => {}}
              />
            </div>
          ) : (
            <input
              type="text"
              className="block textbox w-full"
              autoComplete="off"
              spellCheck="false"
              placeholder="steps.login.status eq 200"
              value={row.value}
              onChange={(event) => update(row.uid, { value: event.target.value })}
              onBlur={list.onBlur}
              data-testid={`flow-step-when-value-${index}`}
            />
          )}
        </div>
      ))}

      {!list.value.length ? <div className="editor-hint mb-2">This step always runs.</div> : null}
      <Button
        size="xs"
        variant="outline"
        color="secondary"
        onClick={() => list.onChange([...list.value, { uid: freshUid(), kind: 'expression', value: '' }])}
        data-testid="flow-step-when-add"
      >
        Add a condition
      </Button>
    </div>
  );
};

export default WhenEditor;
