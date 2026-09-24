import React, { useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import Button from 'ui/Button';
import { useTheme } from 'providers/Theme';
import { useCommittedField } from 'fork/hooks/useCommittedField';
import { useContentHeight } from 'fork/hooks/useContentHeight';
import { readStepRequestExample } from '../../../actions';
import { SHEET_EDITOR_ATTRIBUTE } from './sheetScrollGuard';

/**
 * 005 §6.7 — the step's body, and the two keys beside it.
 *
 * A body the file wrote as a mapping (`amount: 9900`) is shown as the JSON it will be sent as and
 * written back as a mapping; one the file wrote as a string is shown and written as the string.
 * Which of the two a body *is* is read from the document and preserved on write, so an author who
 * wrote a JSON string does not find it turned into a mapping. A body written where there was none
 * takes its form from the text: JSON that parses to an object or a list is written structured,
 * anything else as a string.
 *
 * Text that is meant as JSON and is not yet valid JSON is not written — it is the one refusal the
 * editor makes on its own, because the alternative is a string body where a mapping was meant, and
 * the document would parse and the request would send the wrong thing.
 *
 * **The box is the size of what is in it** — `useContentHeight`, which the output scripts on the
 * Outputs tab are sized by too.
 */

/** Room for about three lines with nothing in it, and a ceiling a body scrolls inside rather than past. */
const MIN_BODY_HEIGHT = 96;
const MAX_BODY_HEIGHT = 900;

const structured = (value) => value !== null && typeof value === 'object';

const textOf = (value) => {
  if (value === undefined || value === null) return '';
  return structured(value) ? JSON.stringify(value, null, 2) : String(value);
};

/** What the typed text becomes in the document, or `undefined` when it cannot become anything yet. */
const valueOf = (text, wasStructured) => {
  if (!text.trim()) {
    return null;
  }
  if (!wasStructured) {
    return text;
  }
  try {
    const parsed = JSON.parse(text);
    return structured(parsed) ? parsed : undefined;
  } catch (error) {
    return undefined;
  }
};

const looksStructured = (text) => {
  try {
    return structured(JSON.parse(text));
  } catch (error) {
    return false;
  }
};

/** `stepRequestExample`'s `reason`s (005 §6.7), in the words the control shows under itself. */
const SEED_REASONS = {
  'no-such-step': 'This step is not in the saved draft yet',
  'not-an-operation': 'A uses: step sends nothing of its own',
  'unresolved-alias': 'The operation\'s API could not be resolved',
  'unknown-operation': 'The operation is not in the bound spec',
  'ambiguous-operation': 'The operation id is declared more than once in the spec',
  'no-request-body': 'The operation declares no request body',
  'no-example': 'The operation declares no example'
};

const BodyField = ({ step, flow, content, onPatch }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const [invalid, setInvalid] = useState(false);
  const [seedReason, setSeedReason] = useState(undefined);

  const boxRef = useRef(null);
  const boxHeight = useContentHeight({
    boxRef,
    key: `${flow.pathname}:${step.id}`,
    min: MIN_BODY_HEIGHT,
    max: MAX_BODY_HEIGHT
  });

  const body = step.fields.body;
  const bodyFile = step.fields.bodyFile;
  const contentType = step.fields.contentType;
  const wasStructured = structured(body);

  const editor = useCommittedField({
    value: textOf(body),
    onCommit: (text) => {
      // A body written where there was none takes its form from the text (above); a body that was
      // structured stays structured or is refused.
      const structuredNow = body === undefined ? looksStructured(text) : wasStructured;
      const next = valueOf(text, structuredNow);
      if (next === undefined) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      // `bodyFile:` and `body:` are exclusive (001 §5.3); writing one removes the other.
      onPatch(next === null ? { unset: ['body'] } : { set: { body: next }, unset: bodyFile === undefined ? [] : ['bodyFile'] });
    }
  });

  const file = useCommittedField({
    value: bodyFile === undefined ? '' : String(bodyFile),
    onCommit: (path) =>
      onPatch(path.trim() ? { set: { bodyFile: path.trim() }, unset: body === undefined ? [] : ['body'] } : { unset: ['bodyFile'] })
  });

  const media = useCommittedField({
    value: contentType === undefined ? '' : String(contentType),
    onCommit: (type) => onPatch(type.trim() ? { set: { contentType: type.trim() } } : { unset: ['contentType'] })
  });

  /**
   * §6.7's explicit act: the engine's own answer for what the run would send, never a schema-shaped
   * guess. `example` and `reason` are mutually exclusive on the result, so this either commits a
   * patch or reports why it did not — it never does both.
   */
  const onSeed = async () => {
    setSeedReason(undefined);
    const result = await dispatch(readStepRequestExample(flow, content, step.id));
    if (result.reason) {
      setSeedReason(result.reason);
      return;
    }
    onPatch({ set: { body: result.example }, unset: bodyFile === undefined ? [] : ['bodyFile'] });
  };

  return (
    <div className="editor-section" data-testid="flow-step-body">
      <div className="editor-section-title flex items-center justify-between">
        Body
        <Button size="xs" variant="outline" color="secondary" onClick={onSeed} data-testid="flow-step-seed-body">
          Seed from spec
        </Button>
      </div>
      {seedReason ? (
        <div className="editor-hint mb-2" data-testid="flow-step-seed-empty">
          {SEED_REASONS[seedReason] || 'The spec has nothing to seed the body with'}
        </div>
      ) : null}

      <div
        ref={boxRef}
        className="editor-body"
        style={boxHeight === null ? undefined : { height: boxHeight }}
        onBlur={editor.onBlur}
        data-testid="flow-step-field-body"
        {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}
      >
        {/* The key its cursor and folds persist under. Without one the editor would share a key
            with every other editor of its mode and inherit a stranger's cursor on mount. */}
        <CodeEditor
          docKey={`flow-step-body:${flow.pathname}:${step.id}`}
          theme={displayedTheme}
          font={get(preferences, 'font.codeFont', 'default')}
          fontSize={get(preferences, 'font.codeFontSize')}
          value={editor.value}
          mode={wasStructured || (body === undefined && looksStructured(editor.value)) ? 'application/ld+json' : 'text/plain'}
          enableVariableHighlighting={false}
          enableBrunoVarInfo={false}
          onEdit={editor.onChange}
          onRun={() => {}}
        />
      </div>
      {invalid ? (
        <div className="editor-error" data-testid="flow-step-body-error">
          The body is written as a mapping, and this is not valid JSON — it has not been saved
        </div>
      ) : null}

      <div className="editor-fields">
        <label className="editor-label" htmlFor="flow-step-field-bodyFile">
          Body file
        </label>
        <div className="editor-field">
          <input
            id="flow-step-field-bodyFile"
            type="text"
            className="block textbox w-full"
            autoComplete="off"
            spellCheck="false"
            placeholder="./fixtures/payload.json — instead of a body"
            value={file.value}
            onChange={(event) => file.onChange(event.target.value)}
            onBlur={file.onBlur}
            onKeyDown={file.onKeyDown}
            data-testid="flow-step-field-bodyFile"
          />
        </div>

        <label className="editor-label" htmlFor="flow-step-field-contentType">
          Content type
        </label>
        <div className="editor-field">
          <input
            id="flow-step-field-contentType"
            type="text"
            className="block textbox w-full"
            autoComplete="off"
            spellCheck="false"
            placeholder="as the operation declares — set it only where it declares more than one"
            value={media.value}
            onChange={(event) => media.onChange(event.target.value)}
            onBlur={media.onBlur}
            onKeyDown={media.onKeyDown}
            data-testid="flow-step-field-contentType"
          />
        </div>
      </div>
    </div>
  );
};

export default BodyField;
