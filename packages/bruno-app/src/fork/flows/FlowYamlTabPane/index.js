import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import get from 'lodash/get';
import yaml from 'js-yaml';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { usePersistedState } from 'hooks/usePersistedState';
import { useVerticalSplit } from 'fork/hooks/useVerticalSplit';
import { useAutoSave } from 'fork/hooks/useAutoSave';
import { describeFlowDraft, readFlowSource, saveFlowSource } from '../actions';
import { sourceEdited } from '../slice';
import { FLOW_YAML_SCHEMA } from '../yamlSchema';
import FlowGraph from '../FlowTabPane/FlowGraph';
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

const MIN_GRAPH_HEIGHT = 120;
const MIN_EDITOR_HEIGHT = 200;
const DEFAULT_EDITOR_HEIGHT = 320;

/**
 * Whether the draft is a YAML document at all.
 *
 * Deliberately the narrow question. A flow that parses but declares a step twice is *invalid as a
 * flow* and still draws, with its diagnostics on the nodes, exactly as §6 requires of the run view —
 * being told what is wrong with a flow is most of what this view is for. Text that does not parse
 * has no document to describe, and that is the only case where the graph holds still.
 */
const parses = (content) => {
  try {
    // §5.4's local tags are part of the format, so a parser without them calls a `!file` fixture a
    // syntax error — see `yamlSchema`.
    yaml.load(content, { schema: FLOW_YAML_SCHEMA });
    return true;
  } catch {
    return false;
  }
};

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
    return <span className="yaml-state dirty">Unsaved changes</span>;
  }
  return <span className="yaml-state">Saved</span>;
};

const FlowYamlTabPane = ({ tab }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();
  const [expandedSubflows, setExpandedSubflows] = useState([]);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const source = useSelector((state) => state.flows.sources[tab.pathname]);
  const preferences = useSelector((state) => state.app.preferences);
  const autoSaveEnabled = Boolean(preferences?.autoSave?.enabled);

  const splitRef = useRef(null);
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
  const valid = source?.valid;
  const loading = source?.loading;

  // Redraws from the draft, debounced. The dependency on `content` is what re-arms it, so a pause in
  // typing is what triggers the describe rather than a timer running through it.
  useEffect(() => {
    if (!flow || loading || !valid || content === undefined) {
      return undefined;
    }

    const timer = setTimeout(() => dispatch(describeFlowDraft(flow, content)), DESCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dispatch, flow, content, valid, loading]);

  const dirty = Boolean(source) && source.content !== source.saved;

  /**
   * §4.3: auto-save writes only a draft that parses. The alternative — writing whatever is in the
   * buffer on a timer — saves a half-typed line to a file the watcher is reporting and the run view
   * is describing, so a flow briefly becomes unrunnable because someone paused mid-word.
   */
  useAutoSave({
    trigger: source?.content,
    armed: dirty && Boolean(valid) && !source?.saving,
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
        {source.valid ? null : <span className="yaml-state error">Invalid YAML — the graph is not updating</span>}
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
              onSelectStep={() => {}}
              onToggleSubflow={toggleSubflow}
            />
          ) : null}
        </div>

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
            theme={displayedTheme}
            font={get(preferences, 'font.codeFont', 'default')}
            fontSize={get(preferences, 'font.codeFontSize')}
            value={source.content}
            mode="yaml"
            enableVariableHighlighting={false}
            enableBrunoVarInfo={false}
            onEdit={(edited) =>
              dispatch(sourceEdited({ pathname: flow.pathname, content: edited, valid: parses(edited) }))}
            onRun={() => {}}
          />
        </div>
      </div>
    </StyledWrapper>
  );
};

export default FlowYamlTabPane;
