import React, { useMemo, useRef } from 'react';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import CodeMarker from '../CodeMarker';
import { heldByName, repeats, withUnfinished } from '../rows';
import Button from 'ui/Button';
import { useTheme } from 'providers/Theme';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { SHEET_EDITOR_ATTRIBUTE } from '../BodyField/sheetScrollGuard';

/**
 * 005 §6.2's Scripts tab — what the step computes before its request is built: 001 §8.7's `pre:`,
 * a mapping of name to script, each handed `(ctx)` and read back as `{{pre.<name>}}`.
 *
 * This is the flow format's pre-request script. It is not one script that mutates a request but a
 * set of named values, because §8.7 makes `pre:` "`outputs:` one stage earlier": one value per
 * name, read by interpolation, with nothing to mutate. So the tab is a list of named editors rather
 * than one editor, and a value is only written once it has a name. The whole mapping is committed
 * when the typing stops (§6.3), and emptied it is unset (§9.1).
 */

/** A row keeps its uid across a re-seed, for `KeyValueSection`'s reason: a remount under the caret drops keystrokes. */
let nextUid = 0;
const freshUid = () => `script-${(nextUid += 1)}`;

const rowsOf = (pre, previous) =>
  Object.entries(pre && typeof pre === 'object' && !Array.isArray(pre) ? pre : {}).map(([name, script], index) => ({
    uid: previous[index]?.uid || freshUid(),
    name,
    // The name the document holds this row under, so a name typed onto another row is the one
    // that gives way rather than the one already published.
    heldAs: name,
    script: script === null || script === undefined ? '' : String(script)
  }));

const mappingOf = (rows) => Object.fromEntries(heldByName(rows).map((row) => [row.name.trim(), row.script]));

const sameRows = (left, right) =>
  left.length === right.length && left.every((row, index) => row.name === right[index].name && row.script === right[index].script);

/**
 * A script written before the value it computes was named — §8.7 and §8.6 both write an entry under
 * its name, so neither block can hold one without it. A row added and not yet typed into stays too:
 * the author asked for it with a control, and it writes nothing until it has a name. A name another
 * row already holds is the same state: both blocks hold one script per name.
 */
const unfinished = (row, index, rows) => !row.name.trim() || repeats(row, index, rows);

/**
 * 001 §8.6's `functions.use:` — the shared scripts every script in the flow may call into. Listed
 * here because this is where a script is written and the helpers it reaches for are what it needs
 * to see, and edited here because the tab is the one place the author is thinking about scripts;
 * the block is the flow's, so the list is the same on every step. What is offered is 002 §4.5's
 * `flows/scripts/` files under the flow's scope root, by the path the watcher lists them under,
 * relativized by the host (§9.4). A script already used is not offered again.
 */
const SharedScripts = ({ flow, functions, scripts, onEdit }) => {
  const offered = scripts.filter((script) => !functions.some((used) => script.pathname.endsWith(used.replace(/^\.\//, '/'))));

  return (
    <div className="editor-section editor-shared-scripts" data-testid="flow-step-shared-scripts">
      <div className="editor-section-title flex items-center gap-2">
        Shared scripts
        <span className="editor-tag">whole flow</span>
      </div>
      <div className="editor-hint mb-2">
        Functions every script in this flow can call by name — the files under <code>functions.use:</code>.
      </div>
      {functions.map((source, index) => (
        <div key={source} className="editor-shared-script" data-testid={`flow-step-shared-script-${index}`}>
          <code>{source}</code>
          <Button
            size="xs"
            variant="outline"
            color="secondary"
            onClick={() => onEdit([{ kind: 'functions.unuse', source }])}
            data-testid={`flow-step-shared-script-remove-${index}`}
          >
            Remove
          </Button>
        </div>
      ))}
      {!functions.length ? <div className="editor-hint">This flow uses no shared script.</div> : null}
      {/* Where the next entry will appear, so adding one reads as continuing the list. */}
      <select
        className="textbox editor-shared-script-add"
        value=""
        onChange={(event) => event.target.value && onEdit([{ kind: 'functions.use', source: event.target.value }])}
        data-testid="flow-step-shared-script-add"
      >
        <option value="">{offered.length ? 'Add a shared script…' : scripts.length ? 'Every script is in use' : 'No scripts under flows/scripts/'}</option>
        {offered.map((script) => (
          <option key={script.pathname} value={script.pathname}>
            {script.pathname.startsWith(flow.workspaceRoot) ? script.pathname.slice(flow.workspaceRoot.length).replace(/^[\\/]/, '') : script.filename}
          </option>
        ))}
      </select>
    </div>
  );
};

/**
 * §8.6's other half: the functions the flow defines inline, beside the files it reads. Same shape as
 * a `pre:` entry — a name and a function — because that is what it is, one level up: these are in
 * scope in every script position of every step, which is why they sit with the block that lists the
 * files rather than on a tab of their own.
 *
 * Committed whole through one `functions.define`, which leaves `use:` alone — a rename is the
 * commonest edit to a named script, and one-at-a-time edits would make it a removal and an addition.
 */
const Definitions = ({ flow, definitions, names, onEdit, displayedTheme, preferences }) => {
  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(definitions, settled)),
    [definitions]
  );
  const list = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => onEdit([{ kind: 'functions.define', define: mappingOf(committed) }])
  });
  previous.current = list.value;

  const update = (uid, change) => list.onChange(list.value.map((row) => (row.uid === uid ? { ...row, ...change } : row)));

  return (
    <div className="editor-section" data-testid="flow-step-definitions">
      <div className="editor-section-title">
        Functions defined in this flow
        <CodeMarker kind="script" />
      </div>
      <div className="editor-hint mb-2">
        Each is in scope by name in every script this flow runs, beside the ones the files above bring.
      </div>

      {list.value.map((row, index) => (
        <div key={row.uid} className="editor-script-entry" data-testid={`flow-step-definition-${index}`}>
          <div className="editor-script-head">
            <input
              type="text"
              className="textbox editor-script-name"
              autoComplete="off"
              spellCheck="false"
              placeholder="name"
              value={row.name}
              onChange={(event) => update(row.uid, { name: event.target.value })}
              onBlur={list.onBlur}
              data-testid={`flow-step-definition-name-${index}`}
            />
            <Button
              size="xs"
              variant="outline"
              color="secondary"
              onClick={() => list.onChange(list.value.filter((entry) => entry.uid !== row.uid))}
              data-testid={`flow-step-definition-remove-${index}`}
            >
              Remove
            </Button>
          </div>
          <div className="editor-body editor-script-body" onBlur={list.onBlur} data-testid={`flow-step-definition-editor-${index}`} {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}>
            <CodeEditor
              docKey={`flow-definition:${flow.pathname}:${row.uid}`}
              theme={displayedTheme}
              font={get(preferences, 'font.codeFont', 'default')}
              fontSize={get(preferences, 'font.codeFontSize')}
              value={row.script}
              mode="javascript"
              knownGlobals={names}
              enableVariableHighlighting={false}
              enableBrunoVarInfo={false}
              onEdit={(script) => update(row.uid, { script })}
              onRun={() => {}}
            />
          </div>
        </div>
      ))}

      {!list.value.length ? <div className="editor-hint mb-2">This flow defines none.</div> : null}
      <Button
        size="xs"
        variant="outline"
        color="secondary"
        onClick={() => list.onChange([...list.value, { uid: `definition-${Date.now()}`, name: '', script: '' }])}
        data-testid="flow-step-definition-add"
      >
        Add a function
      </Button>
    </div>
  );
};

const ScriptsTab = ({ step, flow, functions, definitions, names, scripts, onPatch, onEdit }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const previous = useRef([]);
  const rows = useMemo(
    () => withUnfinished(previous.current, unfinished, (settled) => rowsOf(step.fields.pre, settled)),
    [step.fields.pre]
  );
  const list = useCommittedField({
    value: rows,
    equals: sameRows,
    onCommit: (committed) => {
      const mapping = mappingOf(committed);
      onPatch(Object.keys(mapping).length ? { set: { pre: mapping } } : { unset: ['pre'] });
    }
  });
  previous.current = list.value;

  const update = (uid, change) => list.onChange(list.value.map((row) => (row.uid === uid ? { ...row, ...change } : row)));

  return (
    <>
      <SharedScripts flow={flow} functions={functions} scripts={scripts} onEdit={onEdit} />
      <Definitions
        flow={flow}
        definitions={definitions}
        names={names}
        onEdit={onEdit}
        displayedTheme={displayedTheme}
        preferences={preferences}
      />

      <div className="editor-section" data-testid="flow-step-scripts">
        <div className="editor-section-title">
          Computed before the request
          <CodeMarker kind="script" />
        </div>
        <div className="editor-hint mb-2">
          Each script is a function of the run so far — <code>(ctx) =&gt; …</code> — and its value is read as{' '}
          <code>{'{{pre.<name>}}'}</code> in the request. It is written once it has a name.
        </div>

        {list.value.map((row, index) => (
          <div key={row.uid} className="editor-script-entry" data-testid={`flow-step-script-${index}`}>
            <div className="editor-script-head">
              <input
                type="text"
                className="textbox editor-script-name"
                autoComplete="off"
                spellCheck="false"
                placeholder="name"
                value={row.name}
                onChange={(event) => update(row.uid, { name: event.target.value })}
                onBlur={list.onBlur}
                data-testid={`flow-step-script-name-${index}`}
              />
              <Button
                size="xs"
                variant="outline"
                color="secondary"
                onClick={() => list.onChange(list.value.filter((entry) => entry.uid !== row.uid))}
                data-testid={`flow-step-script-remove-${index}`}
              >
                Remove
              </Button>
            </div>
            <div className="editor-body editor-script-body" onBlur={list.onBlur} data-testid={`flow-step-script-editor-${index}`} {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}>
              <CodeEditor
                docKey={`flow-step-script:${flow.pathname}:${step.id}:${row.uid}`}
                theme={displayedTheme}
                font={get(preferences, 'font.codeFont', 'default')}
                fontSize={get(preferences, 'font.codeFontSize')}
                value={row.script}
                mode="javascript"
                knownGlobals={names}
                enableVariableHighlighting={false}
                enableBrunoVarInfo={false}
                onEdit={(script) => update(row.uid, { script })}
                onRun={() => {}}
              />
            </div>
          </div>
        ))}

        {!list.value.length ? <div className="editor-hint mb-2">This step computes nothing before its request.</div> : null}
        <Button
          size="xs"
          variant="outline"
          color="secondary"
          onClick={() => list.onChange([...list.value, { uid: freshUid(), name: '', script: '' }])}
          data-testid="flow-step-script-add"
        >
          Add a script
        </Button>
      </div>
    </>
  );
};

export default ScriptsTab;
