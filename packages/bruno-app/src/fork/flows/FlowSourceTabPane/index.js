import { useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import get from 'lodash/get';
import { JSHINT } from 'jshint';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { useAutoSave } from 'fork/hooks/useAutoSave';
import { readFlowSource, saveFlowSource } from '../actions';
import { sourceEdited } from '../slice';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.5 and §4.6 — editing a `.js` helper from `flows/scripts/`, and a data file from
 * `flows/fixtures/`.
 *
 * **The same editing session §4.3's raw editor has, without the half that has no meaning here.** The
 * text lives in the flows slice keyed by path, so an unsaved edit survives a tab switch; saving,
 * auto-save, the dirty comparison and the close prompt are all the ones the YAML editor already
 * uses. What is missing is the graph: neither file is a flow, neither has a `describeFlow` to draw
 * and no steps to draw it from, and a pane that showed one would be answering a question nobody
 * asked of this file.
 *
 * **One pane for both, because the two differ only in what they are called and how their text is
 * coloured and checked.** A second copy of the session, the save, the auto-save gate and the
 * divergence report would be four things kept in step by hand, and they would drift on the first
 * change made to one of them.
 *
 * **Neither view says anything about what its file declares.** 001 §8.6 lists a raw `use:` file as
 * the file it is, precisely because nothing in the toolchain parses JavaScript to find out what is
 * in it, and 001 §7.4's fixtures are read by whichever flow names them rather than by the app; this
 * keeps both honest rather than growing a second answer.
 */

/**
 * The lint the editor itself runs, asked as a yes/no. `esversion`, `expr` and `asi` are
 * `CodeEditor`'s own `lintOptions`, so the badge and the squiggles under the cursor cannot disagree
 * about what is broken.
 */
const LINT_OPTIONS = { esversion: 11, expr: true, asi: true };

/**
 * Whether the draft is JavaScript that parses — the narrow question §4.3 asks of YAML, asked of the
 * other language.
 *
 * It gates auto-save, and that matters more for a script than it does there: a script is composed
 * into the prelude of **every** script position in every flow that names it (001 §8.6), so writing a
 * half-typed line to disk breaks all of them at once, with `script-error` naming whichever step
 * happened to run first.
 *
 * **JSHint rather than `new Function`, because the renderer may not evaluate strings.** The app
 * serves itself under a CSP whose `script-src` carries no `'unsafe-eval'`
 * (`bruno-electron/src/index.js`), so `new Function` throws `EvalError` here on *every* input —
 * which a gate that reads a throw as a syntax error reports as invalid JavaScript for a file that is
 * perfectly fine, and then never auto-saves it again. JSHint parses without evaluating, and it is
 * already loaded: `utils/codemirror/javascript-lint` registers it as the lint helper for this very
 * editor.
 *
 * **Only `E` codes count.** JSHint returns style warnings in the same list as syntax errors, and a
 * `W` disarming auto-save would be the same bug wearing different clothes. Two things follow from
 * the prelude that are worth knowing: top-level `await` is reported (`composeLibrary` wraps the file
 * in a non-async arrow, so it genuinely would not compose), and ESM `export` is not (JSHint accepts
 * it, the prelude does not) — the gate is a safety net, not the run's verdict.
 */
const parses = (content) => {
  try {
    JSHINT(content, LINT_OPTIONS);
    return !(JSHINT.data().errors || []).some((error) => String(error?.code || '').startsWith('E'));
  } catch {
    // The linter itself failed, which says nothing about the draft. Failing *open* is deliberate:
    // the bug this replaced was an environment error read as a verdict on the file, and a gate that
    // cannot answer should get out of the author's way rather than silently stop saving their work.
    return true;
  }
};

/**
 * §4.6: the highlighting a fixture gets, by the extension it was filed under.
 *
 * `text/plain` for everything else, which is the honest answer for a CSV or an extensionless file
 * rather than a guess — the corpus holds whatever the operations under test take, and colouring one
 * as a language it is not reads as a parse error on every line.
 */
const FIXTURE_MODES = {
  css: 'css',
  gql: 'graphql',
  graphql: 'graphql',
  htm: 'htmlmixed',
  html: 'htmlmixed',
  js: 'javascript',
  json: 'application/ld+json',
  md: 'gfm',
  sh: 'shell',
  sql: 'sql',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
};

const fixtureMode = (filename) => {
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  return FIXTURE_MODES[extension] || 'text/plain';
};

/**
 * What the two kinds differ in, and nothing else.
 *
 * **A fixture has no validity gate.** §4.5's exists because a script has one language and a
 * half-typed line in it breaks every flow that names it; a fixture corpus is JSON, YAML, CSV and
 * whatever else an operation takes, so there is no question to ask of most of them. Gating only the
 * ones that happen to be JSON would be a rule that applies by file extension — surprising precisely
 * when it fires, and no protection at all the rest of the time. A fixture that does not parse fails
 * the flows that read it at start (001 §7.4), which names the file and is the report to act on.
 */
const KINDS = {
  'flow-script': {
    noun: 'script',
    modeFor: () => 'javascript',
    validate: parses,
    invalidMessage: 'Invalid JavaScript — not saving'
  },
  'flow-fixture': {
    noun: 'fixture',
    modeFor: fixtureMode
  }
};

const SaveState = ({ source, testId }) => {
  if (source.saving) {
    return <span className="script-state">Saving…</span>;
  }
  if (source.error) {
    return <span className="script-state error">{`Not saved — ${source.error}`}</span>;
  }
  if (source.content !== source.saved) {
    return source.staleOnDisk ? (
      <span className="script-state error" data-testid={`${testId}-diverged`}>
        Unsaved changes — the file also changed on disk
      </span>
    ) : (
      <span className="script-state dirty">Unsaved changes</span>
    );
  }
  return <span className="script-state">Saved</span>;
};

const FlowSourceTabPane = ({ tab }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();

  const kind = KINDS[tab.type];
  const entry = useSelector((state) => find(state.flows.flows, (flow) => flow.pathname === tab.pathname));
  const source = useSelector((state) => state.flows.sources[tab.pathname]);
  const preferences = useSelector((state) => state.app.preferences);
  const autoSaveEnabled = Boolean(get(preferences, 'autoSave.enabled'));

  useEffect(() => {
    if (entry && !source) {
      dispatch(readFlowSource(entry));
    }
  }, [dispatch, entry, source]);

  const dirty = Boolean(source) && source.content !== source.saved;

  // Derived rather than stored, so it is a verdict on the text that is actually in the editor —
  // including the text `sourceRefreshed` puts there when the file changes underneath a clean pane.
  // A kind with no gate answers yes: a fixture is whatever its operation takes, and linting a CSV
  // as JavaScript would disarm auto-save on every file in the corpus.
  const valid = useMemo(
    () => (kind.validate ? kind.validate(source?.content ?? '') : true),
    [kind, source?.content]
  );

  useAutoSave({
    trigger: source?.content,
    armed: dirty && valid && !source?.saving,
    onSave: () => dispatch(saveFlowSource(entry)).catch(() => undefined)
  });

  if (!entry) {
    return <div className="pb-4 px-4">{`This ${kind.noun} is no longer on disk.`}</div>;
  }

  if (!source || source.loading) {
    return <div className="pb-4 px-4">{`Reading the ${kind.noun}…`}</div>;
  }

  /**
   * §4.6: a fixture that is not text arrives here, because the read is what discovers it — the
   * sidebar lists a corpus holding whatever the operations under test take, and 001 §7.4's own
   * example attaches a `.pdf`. The refusal is the host's (`renderer:flow-read-source`), which is
   * where the bytes are, and this reports it the way it reports any file it could not read.
   */
  if (source.error && source.saved === '' && source.content === '') {
    return <div className="pb-4 px-4">{`This ${kind.noun} could not be read — ${source.error}`}</div>;
  }

  const save = () => dispatch(saveFlowSource(entry)).catch(() => undefined);

  // Bound here rather than through the app's keybindings for §4.3's reason: there is no single-tab
  // `save` action to join, and every editing surface in the app binds its own.
  const onKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  };

  return (
    <StyledWrapper onKeyDownCapture={onKeyDown} data-testid={`${tab.type}-pane`}>
      <div className="script-toolbar">
        <span className="script-filename">{entry.filename}</span>
        <span className="script-badge">{kind.noun}</span>

        {valid ? null : (
          <span className="script-state error" data-testid={`${tab.type}-invalid`}>
            {kind.invalidMessage}
          </span>
        )}

        <div className="script-toolbar-right">
          <SaveState source={source} testId={tab.type} />
          {autoSaveEnabled ? null : (
            <button
              type="button"
              className="script-save"
              onClick={save}
              disabled={!dirty}
              data-testid={`${tab.type}-save`}
            >
              Save
            </button>
          )}
        </div>
      </div>

      <div className="script-editor">
        {/* Variable highlighting and the Bruno var tooltip are off for §4.3's reason: both resolve
            against a collection, and a flow has none (001 §6). */}
        <CodeEditor
          theme={displayedTheme}
          font={get(preferences, 'font.codeFont', 'default')}
          fontSize={get(preferences, 'font.codeFontSize')}
          value={source.content}
          mode={kind.modeFor(entry.filename)}
          enableVariableHighlighting={false}
          enableBrunoVarInfo={false}
          onEdit={(edited) =>
            dispatch(sourceEdited({ pathname: tab.pathname, content: edited }))}
          onRun={() => {}}
        />
      </div>
    </StyledWrapper>
  );
};

export default FlowSourceTabPane;
