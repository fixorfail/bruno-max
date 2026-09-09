import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { usePersistedState } from 'hooks/usePersistedState';
import { useVerticalSplit } from 'fork/hooks/useVerticalSplit';
import { useAutoSave } from 'fork/hooks/useAutoSave';
import { describeFlowDraft, readFlowSource, saveFlowSource } from '../actions';
import { documentAnchored, sourceEdited } from '../slice';
import FlowGraph from '../FlowTabPane/FlowGraph';
import { renderDiagnosticGutter, inThisDocument } from './diagnosticGutter';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.3 — editing a flow's YAML directly, with its graph above it.
 *
 * **This is the non-standard way to edit a flow**, and the view says so: it is reached from the row
 * menu rather than by opening the flow, and its tab is marked (§4.3). The flow's own surfaces are
 * where a flow is meant to be built; this is for the edit they do not cover, and for reading what a
 * generated flow actually says.
 *
 * The graph is the same component the run view draws, from the same `describeFlow` — a second
 * drawing derived from the draft some other way could disagree with the one a run would execute,
 * which is the disagreement §11.1 exists to rule out.
 */

/**
 * Long enough that a burst of typing is one describe rather than one per character, short enough
 * that the graph reads as following the text. Each keystroke re-arms it, so this is the pause after
 * typing rather than a fixed refresh rate.
 */
const DESCRIBE_DEBOUNCE_MS = 300;

/**
 * One identity for "nothing to mark", so a render that changes nothing does not redraw the gutter.
 */
const NO_DIAGNOSTICS = [];

const MIN_GRAPH_HEIGHT = 120;
const MIN_EDITOR_HEIGHT = 200;
const DEFAULT_EDITOR_HEIGHT = 320;

/**
 * Whether the draft is a YAML document at all is **asked of the engine**, not answered here.
 *
 * 002-C R4 leaves the renderer no parser of its own, and the reason is the same one §11.1 gives for
 * the graph: a second reader of the format is a second opinion about it, and this one would have had
 * to be taught 001 §5.4's local tags or call every flow carrying a `!file` fixture a syntax error.
 * `describeFlow` already reads the draft (§11.3 overlays the port with it) and reports a document
 * that did not parse as 001 §14.6's `parse-error`, anchored — so the verdict is a field of a result
 * this pane is already asking for, and the slice records it beside the text it was taken from.
 *
 * Deliberately the narrow question. A flow that parses but declares a step twice is *invalid as a
 * flow* and still draws, with its diagnostics on the nodes, exactly as §6 requires of the run view —
 * being told what is wrong with a flow is most of what this view is for.
 */

/**
 * §4.3's save state, in words rather than an icon: this view writes to a file the rest of the app is
 * watching, so what has and has not reached disk is the one thing it must never be coy about.
 */
const SaveState = ({ source }) => {
  if (source.saving) {
    return <span className="yaml-state">Saving…</span>;
  }
  if (source.error) {
    return <span className="yaml-state error">{`Not saved — ${source.error}`}</span>;
  }
  if (source.content !== source.saved) {
    /**
     * The file moved on while there was unsaved work here, so neither side can be taken silently:
     * the editor kept what was typed, and saving from here will overwrite what is on disk. Saying
     * so is the whole of the handling — choosing for the author is what an editor must not do.
     */
    return source.staleOnDisk ? (
      <span className="yaml-state error" data-testid="flow-yaml-diverged">
        Unsaved changes — the file also changed on disk
      </span>
    ) : (
      <span className="yaml-state dirty">Unsaved changes</span>
    );
  }
  return <span className="yaml-state">Saved</span>;
};

/**
 * §6's list, in the surface §6 calls the primary one for it.
 *
 * Errors and warnings together and undivided, unlike §4.2's run view — which lists the errors and
 * counts the warnings, because there an error is the answer to why the run control is disabled.
 * Nothing runs from this tab, so the distinction that governs there does not apply: what a reader is
 * doing here is fixing the file, and a warning is a thing to fix.
 *
 * Each row is a button because it goes somewhere. A diagnostic with no position has nowhere to go
 * and is stated rather than offered — and so is one whose position is in *another* file, a
 * `flows/connectors.yml` entry (001 §8.5): this editor holds the flow, so "line 3" there is a line
 * of a file it cannot show, and a button that scrolled the flow to line 3 would answer with the
 * wrong text. The gutter applies the same test (§6), so the two surfaces in this tab agree.
 */
const Diagnostics = ({ diagnostics, pathname, onAnchor }) => {
  if (!diagnostics.length) {
    return null;
  }

  return (
    <div className="yaml-diagnostics" data-testid="flow-yaml-diagnostics">
      {diagnostics.map((diagnostic, index) => {
        const anchorable = inThisDocument(diagnostic, pathname);
        const content = (
          <>
            <span className="yaml-diagnostic-code">{diagnostic.code}</span>
            <span className="yaml-diagnostic-message">{diagnostic.message}</span>
            {diagnostic.line ? (
              <span className="yaml-diagnostic-line" title={anchorable ? undefined : diagnostic.file}>
                {anchorable ? `line ${diagnostic.line}` : `${diagnostic.file.split('/').pop()}, line ${diagnostic.line}`}
              </span>
            ) : null}
          </>
        );

        return anchorable ? (
          <button
            key={index}
            type="button"
            className={`yaml-diagnostic ${diagnostic.severity}`}
            data-testid={`flow-yaml-diagnostic-${index}`}
            onClick={() => onAnchor(diagnostic)}
          >
            {content}
          </button>
        ) : (
          <div key={index} className={`yaml-diagnostic ${diagnostic.severity}`} data-testid={`flow-yaml-diagnostic-${index}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
};

const FlowYamlTabPane = ({ tab }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();
  const [expandedSubflows, setExpandedSubflows] = useState([]);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const source = useSelector((state) => state.flows.sources[tab.pathname]);
  const preferences = useSelector((state) => state.app.preferences);
  const autoSaveEnabled = Boolean(preferences?.autoSave?.enabled);

  const anchor = useSelector((state) => state.flows.documentAnchors[tab.pathname]);

  const splitRef = useRef(null);
  /**
   * §6 and §11.1: the editor, so a diagnostic and a node can put the reader on the line they name.
   *
   * The instance rather than a controlled prop, because scrolling is not state: the document is not
   * *at* a line, somebody was shown one. Expressing it as a prop would leave the view pinned there
   * and make scrolling away a change the pane had to write down.
   */
  const editorRef = useRef(null);
  // The same stored size as §9's split, deliberately separate: the two views balance different
  // things, and a height chosen for reading a response body is not one chosen for editing YAML.
  const [editorHeight, setEditorHeight] = usePersistedState({
    key: 'flows-yaml-editor-height',
    default: DEFAULT_EDITOR_HEIGHT
  });
  const { dragging, dragHeight, dragbarProps } = useVerticalSplit({
    containerRef: splitRef,
    height: editorHeight,
    onHeightChange: setEditorHeight,
    minTop: MIN_GRAPH_HEIGHT,
    minBottom: MIN_EDITOR_HEIGHT
  });

  useEffect(() => {
    if (flow && !source) {
      dispatch(readFlowSource(flow));
    }
  }, [dispatch, flow, source]);

  const content = source?.content;
  const loading = source?.loading;
  const diagnostics = source?.diagnostics || NO_DIAGNOSTICS;

  /**
   * Whether the engine has answered about *this* text, and what it said.
   *
   * `undefined` while a describe is outstanding — the answer arrives over IPC, so between a keystroke
   * and the reply nothing is known about what is in the editor. Everything reading this treats
   * not-yet-known as not-yet-valid, which is the safe direction: auto-save stays disarmed rather than
   * writing text nobody has checked.
   */
  const answered = Boolean(source) && source.describedContent === content;
  const valid = answered ? source.parses : undefined;

  // Redraws from the draft, debounced. The dependency on `content` is what re-arms it, so a pause in
  // typing is what triggers the describe rather than a timer running through it.
  useEffect(() => {
    if (!flow || loading || content === undefined || answered) {
      return undefined;
    }

    const timer = setTimeout(() => dispatch(describeFlowDraft(flow, content)), DESCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dispatch, flow, content, answered, loading]);

  /**
   * §6: the document view is the primary diagnostic surface, so an anchor is honoured by putting the
   * caret on the line and scrolling it into view — which is also what makes the line *findable*
   * rather than merely visible.
   *
   * 001 §13.2's positions are one-based, as an editor's error messages are; CodeMirror's are zero-
   * based. The conversion is here because it is the only place either convention is visible.
   */
  useEffect(() => {
    const editor = editorRef.current?.editor;
    if (!editor || !anchor || loading) {
      return;
    }

    const position = { line: Math.max(anchor.line - 1, 0), ch: Math.max((anchor.column || 1) - 1, 0) };
    editor.setCursor(position);
    editor.scrollIntoView(position, 100);
    editor.focus();
  }, [anchor, loading]);

  /**
   * §6's diagnostics, marked in the gutter beside the lines they name — the pay-off §4.3 kept the
   * `line` anchors for, and the one surface that puts the statement next to the text it is about.
   *
   * Driven by the diagnostics rather than by the draft: they are the engine's answer for the text it
   * was given (§11.1), so redrawing on a keystroke would only move a mark to a line the engine has
   * not read yet. Between an edit and the next describe CodeMirror carries each mark along with the
   * line it is attached to, which is the same lag §6's list already has and the honest one — the
   * marks move when the answer does.
   */
  useEffect(() => {
    const editor = editorRef.current?.editor;
    if (!editor || loading) {
      return;
    }

    renderDiagnosticGutter({
      editor,
      diagnostics,
      pathname: tab.pathname,
      onAnchor: (diagnostic) =>
        dispatch(documentAnchored({ pathname: tab.pathname, line: diagnostic.line, column: diagnostic.column }))
    });
  }, [dispatch, diagnostics, loading, tab.pathname]);

  const dirty = Boolean(source) && source.content !== source.saved;

  /**
   * §4.3: auto-save writes only a draft that parses. The alternative — writing whatever is in the
   * buffer on a timer — saves a half-typed line to a file the watcher is reporting and the run view
   * is describing, so a flow briefly becomes unrunnable because someone paused mid-word.
   */
  useAutoSave({
    trigger: source?.content,
    armed: dirty && valid && !source?.saving,
    // The failure is already on screen — the thunk records it and the toolbar states it. Letting the
    // rejection escape an unattended timer would add an unhandled rejection and say nothing more.
    onSave: () => dispatch(saveFlowSource(flow)).catch(() => undefined)
  });

  if (!flow) {
    return <div className="pb-4 px-4">This flow is no longer on disk.</div>;
  }

  if (!source || source.loading) {
    return <div className="pb-4 px-4">Reading the flow…</div>;
  }

  if (source.error && source.saved === '' && source.content === '') {
    return <div className="pb-4 px-4">{`This flow could not be read — ${source.error}`}</div>;
  }

  const save = () => dispatch(saveFlowSource(flow)).catch(() => undefined);

  /**
   * The save key is bound here rather than through the app's keybindings, which have no single-tab
   * `save` action to join — every editing surface in the app binds its own. Capture, so the key is
   * taken before CodeMirror's own keymap sees it.
   */
  const onKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  };

  const toggleSubflow = (id) =>
    setExpandedSubflows((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const description = source.description;

  return (
    <StyledWrapper onKeyDownCapture={onKeyDown} data-testid="flow-yaml-pane">
      <div className="yaml-toolbar">
        <span className="yaml-filename">{flow.filename}</span>
        <span className="yaml-badge">raw yaml</span>

        {/* §4.3: what the graph is currently drawn from, whenever that is not the text on screen. */}
        {/* Only once the engine has said so. While a describe is outstanding the pane knows nothing
            about the text, and claiming it is broken on every keystroke would be the state that
            actually is not updating. */}
        {valid === false ? <span className="yaml-state error">Invalid YAML — the graph is not updating</span> : null}
        {source.describeError ? <span className="yaml-state error">{source.describeError}</span> : null}

        <div className="yaml-toolbar-right">
          <SaveState source={source} />
          {/* Auto-save owns the writing when it is on; a button beside it would be a second answer to
              "is this saved" and the two would disagree the moment one of them was mid-flight. */}
          {autoSaveEnabled ? null : (
            <button type="button" className="yaml-save" onClick={save} disabled={!dirty} data-testid="flow-yaml-save">
              Save
            </button>
          )}
        </div>
      </div>

      <div className={`yaml-split${dragging ? ' is-dragging' : ''}`} ref={splitRef}>
        <div className="yaml-graph">
          {/* §6: a flow with errors still draws — the diagnostics ride on the nodes. Before the first
              describe there is nothing to draw, which is a moment rather than a state. */}
          {description ? (
            <FlowGraph
              description={description}
              nodeStates={{}}
              diagnostics={description.diagnostics}
              expandedSubflows={expandedSubflows}
              showDataEdges
              /* §11.1: clicking a node scrolls the document to its step, which is what
                 `FlowNode.position` is returned for. A sub-flow's internals carry their own file's
                 positions, so only a step of *this* document is followed. */
              onSelectStep={(stepId) => {
                const node = description.nodes.find((entry) => entry.id === stepId && !entry.parent);
                dispatch(documentAnchored({ pathname: flow.pathname, ...node?.position }));
              }}
              onToggleSubflow={toggleSubflow}
            />
          ) : null}
        </div>

        {/* §6: the diagnostics, anchored — the document view is the primary surface for them, and a
            diagnostic about `depends` is most useful next to the `depends` that caused it. They are
            the engine's own set (§11.1), so this view and `bru flow validate` cannot disagree. */}
        <Diagnostics
          diagnostics={diagnostics}
          pathname={flow.pathname}
          onAnchor={(diagnostic) =>
            dispatch(documentAnchored({ pathname: flow.pathname, line: diagnostic.line, column: diagnostic.column }))}
        />

        <div
          className="yaml-split-handle"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize · double-click to reset"
          data-testid="flow-yaml-split-handle"
          {...dragbarProps}
        />

        <div className="yaml-editor" style={{ height: dragging ? dragHeight : editorHeight }}>
          {/**
           * The app's own editor, which §9's step pane also uses, rather than the API-spec panel's:
           * that one hard-codes `height: calc(100vh - 9rem)` on its CodeMirror because it is a
           * full-page editor, so inside a pane the split has sized it renders taller than its box and
           * scrolls nothing — the content past the fold is simply unreachable. This one carries no
           * height of its own and is sized by its container, which is what the split hands it.
           *
           * Variable highlighting and the Bruno var tooltip are off for the reason §9 turns them off:
           * both resolve against a collection, and a flow has none (001 §6).
           */}
          <CodeEditor
            ref={editorRef}
            theme={displayedTheme}
            font={get(preferences, 'font.codeFont', 'default')}
            fontSize={get(preferences, 'font.codeFontSize')}
            value={source.content}
            mode="yaml"
            enableVariableHighlighting={false}
            enableBrunoVarInfo={false}
            onEdit={(edited) =>
              dispatch(sourceEdited({ pathname: flow.pathname, content: edited }))}
            onRun={() => {}}
          />
        </div>
      </div>
    </StyledWrapper>
  );
};

export default FlowYamlTabPane;
