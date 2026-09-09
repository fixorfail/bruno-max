import React from 'react';

/**
 * The CodeMirror instance the pane reaches through the ref, stubbed down to the calls §4.3's gutter
 * makes on it (`diagnosticGutter.js`) — enough to read back what was drawn into the gutter, since
 * jsdom cannot lay a real editor out.
 */
const mockEditorState = { gutters: [], markers: new Map() };

const mockEditor = {
  getOption: (name) => (name === 'gutters' ? mockEditorState.gutters : undefined),
  setOption: (name, value) => {
    if (name === 'gutters') {
      mockEditorState.gutters = value;
    }
  },
  setGutterMarker: jest.fn((line, gutterId, element) => mockEditorState.markers.set(line, element)),
  clearGutter: jest.fn(() => mockEditorState.markers.clear()),
  setCursor: jest.fn(),
  scrollIntoView: jest.fn(),
  focus: jest.fn()
};

// The real YAML editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the
// pane does with the text, not about highlighting it.
jest.mock('components/CodeEditor', () => {
  const { Component } = require('react');

  return class MockCodeEditor extends Component {
    /** Upstream's editor keeps its CodeMirror instance here, which is how the pane reaches it. */
    editor = mockEditor;

    render() {
      return (
        <textarea
          data-testid="yaml-editor"
          value={this.props.value}
          onChange={(event) => this.props.onEdit(event.target.value)}
        />
      );
    }
  };
});
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));
jest.mock('../FlowTabPane/FlowGraph', () => ({ description, onSelectStep }) => (
  <div data-testid="flow-graph">
    {description.nodes.map((node) => (
      <button key={node.id} type="button" data-testid={`graph-node-${node.id}`} onClick={() => onSelectStep(node.id)}>
        {node.id}
      </button>
    ))}
  </div>
));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import { FLOW_GUTTER_ID } from './diagnosticGutter';
import FlowYamlTabPane from './index';

/** The slice's own initial state, so a key added to it does not break every fixture below. */
const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

/**
 * 002 §4.3. The graph follows the draft, the file follows the app's save preference, and neither
 * follows text that does not parse.
 */

const theme = themes.dark || Object.values(themes)[0];

const flow = {
  pathname: '/w/flows/checkout.flow.yml',
  filename: 'checkout.flow.yml',
  workspaceRoot: '/w'
};

const VALID = 'steps:\n  - id: login\n';
const INVALID = 'steps:\n  - id: login\n :::\n';

const descriptionWith = (...ids) => ({ nodes: ids.map((id) => ({ id })), edges: [], slots: [], diagnostics: [] });

/**
 * What `describeFlow` returns for text that is not a document: the shell, and 001 §14.6's anchored
 * `parse-error`. 002-C R4 leaves the renderer no parser, so this — rather than a `js-yaml` call in
 * the pane — is what tells it the draft is broken.
 */
const unparseable = () => ({
  nodes: [],
  edges: [],
  slots: [],
  diagnostics: [{ severity: 'error', code: 'parse-error', message: 'bad indentation', line: 3, column: 2 }]
});

/** The engine's answer for a given draft, which is what the pane's verdict is now taken from. */
const describeOf = (content) => (content.includes(':::') ? unparseable() : descriptionWith('login'));

const renderPane = ({ autoSave } = {}) => {
  const store = configureStore({
    reducer: {
      flows: flowsReducer,
      app: () => ({ preferences: { font: {}, autoSave: autoSave || { enabled: false, interval: 500 } } })
    },
    preloadedState: {
      flows: { ...initialFlowsState(), flows: [flow] }
    }
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <FlowYamlTabPane tab={{ pathname: flow.pathname, type: 'flow-yaml' }} />
        </ThemeProvider>
      </Provider>
    )
  };
};

const type = (text) => fireEvent.change(screen.getByTestId('yaml-editor'), { target: { value: text } });

const invoked = (channel) => window.ipcRenderer.invoke.mock.calls.filter((call) => call[0] === channel);

/** The gutter is drawn on the editor instance, which outlives a render and so is reset per test. */
beforeEach(() => {
  mockEditorState.gutters = ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'];
  mockEditorState.markers.clear();
  mockEditor.setGutterMarker.mockClear();
  mockEditor.clearGutter.mockClear();
});

describe('FlowYamlTabPane', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.ipcRenderer = {
      invoke: jest.fn((channel, request) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(describeOf(request.content));
        return Promise.resolve();
      })
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Advances both the debounce and any auto-save timer, then lets the IPC promises settle. */
  const settle = async (ms) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it('opens on the file as it is on disk', async () => {
    renderPane();
    await act(async () => {});

    expect(invoked('renderer:flow-read-source')[0][1]).toMatchObject({ entry: flow.pathname });
    expect(screen.getByTestId('yaml-editor')).toHaveValue(VALID);
  });

  it('redraws the graph from text that has not been saved', async () => {
    window.ipcRenderer.invoke.mockImplementation((channel, request) => {
      if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
      if (channel === 'renderer:flow-describe') {
        return Promise.resolve(descriptionWith(...(request.content.includes('pay') ? ['login', 'pay'] : ['login'])));
      }
      return Promise.resolve();
    });
    renderPane();
    await act(async () => {});
    await settle(400);

    type(`${VALID}  - id: pay\n`);
    await settle(400);

    // The draft went to the engine rather than being parsed here — §11.1's reason, applied to text
    // that is not on disk yet.
    expect(invoked('renderer:flow-describe').at(-1)[1].content).toContain('pay');
    await waitFor(() => expect(screen.getByTestId('graph-node-pay')).toBeInTheDocument());
  });

  /**
   * The engine is asked about the broken draft — that is where the verdict comes from — and what it
   * answers with is the empty shell. Drawing that would blank the graph on every half-typed line, so
   * the last draft that parsed stays on screen and the pane says it is not following.
   */
  it('holds the graph still while the yaml does not parse', async () => {
    renderPane();
    await act(async () => {});
    await settle(400);

    type(INVALID);
    await settle(400);

    expect(screen.getByTestId('graph-node-login')).toBeInTheDocument();
    expect(screen.getByText(/Invalid YAML/)).toBeInTheDocument();
  });

  /**
   * 001 §5.4's local tags are part of the format, so a parser without them calls a flow using
   * `!file` invalid — the graph stops following the draft and auto-save is disarmed on a document
   * `bru flow validate` passes.
   */
  it('takes a local tag for what it is rather than for a syntax error', async () => {
    renderPane();
    await act(async () => {});
    await settle(400);
    const before = invoked('renderer:flow-describe').length;

    type(`${VALID}vars:\n  documents: !file ../fixtures/documents.json\n`);
    await settle(400);

    expect(screen.queryByText(/Invalid YAML/)).not.toBeInTheDocument();
    expect(invoked('renderer:flow-describe').length).toBeGreaterThan(before);
  });

  /**
   * The verdict is derived from the text in the editor, so it cannot outlive that text.
   *
   * It used to be a field on the source written only by `sourceEdited`, which meant every other path
   * that moves `content` left the old verdict behind. `sourceRefreshed` is that path — the watcher
   * fires it after a save and after any edit made outside Bruno, and a clean editor takes the file's
   * text. So a flow saved unparseable and then fixed on disk kept the "Invalid YAML" banner and a
   * graph that had stopped following the draft, with auto-save disarmed, for the rest of the
   * session; closing the tab did not clear it, because nothing re-reads a source still in the store.
   */
  it('takes back the banner when the file is fixed underneath a clean editor', async () => {
    const { store } = renderPane({ autoSave: { enabled: true, interval: 500 } });
    await act(async () => {});

    type(INVALID);
    await settle(600);
    expect(screen.getByText(/Invalid YAML/)).toBeInTheDocument();

    // The author saves it anyway, so the editor is clean and holds unparseable text.
    await act(async () => {
      store.dispatch({ type: 'flows/sourceSaved', payload: { pathname: flow.pathname, content: INVALID } });
    });
    expect(screen.getByText(/Invalid YAML/)).toBeInTheDocument();

    // Fixed outside Bruno. A clean editor takes the file's text (§4.3).
    await act(async () => {
      store.dispatch({ type: 'flows/sourceRefreshed', payload: { pathname: flow.pathname, content: VALID } });
    });
    await settle(400);

    expect(screen.getByTestId('yaml-editor')).toHaveValue(VALID);
    expect(screen.queryByText(/Invalid YAML/)).not.toBeInTheDocument();

    // …and the graph follows the draft again, rather than staying frozen for the session.
    const before = invoked('renderer:flow-describe').length;
    type(`${VALID}  - id: pay\n`);
    await settle(400);
    await settle(600);
    expect(invoked('renderer:flow-describe').length).toBeGreaterThan(before);
    expect(invoked('renderer:flow-write-source')).toHaveLength(1);
  });

  describe('saving (§4.3)', () => {
    it('auto-saves a valid draft after the configured interval', async () => {
      renderPane({ autoSave: { enabled: true, interval: 500 } });
      await act(async () => {});

      type(`${VALID}  - id: pay\n`);
      // The engine answers first — auto-save waits for a verdict on the text it would write, rather
      // than writing it and finding out afterwards — and the interval runs from there.
      await settle(400);
      await settle(600);

      const writes = invoked('renderer:flow-write-source');
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({ entry: flow.pathname, content: `${VALID}  - id: pay\n` });
      expect(await screen.findByText('Saved')).toBeInTheDocument();
    });

    /** A half-typed line reaches the watcher, the run view and any run started from it. */
    it('never auto-saves a draft that does not parse', async () => {
      renderPane({ autoSave: { enabled: true, interval: 500 } });
      await act(async () => {});

      type(INVALID);
      await settle(400);
      await settle(2000);

      expect(invoked('renderer:flow-write-source')).toHaveLength(0);
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    it('waits for the save key when auto-save is off', async () => {
      renderPane();
      await act(async () => {});

      type(`${VALID}  - id: pay\n`);
      await settle(2000);
      expect(invoked('renderer:flow-write-source')).toHaveLength(0);

      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('yaml-editor'), { key: 's', ctrlKey: true });
      });

      expect(invoked('renderer:flow-write-source')).toHaveLength(1);
    });

    /** Two answers to "is this saved" is one too many, and the timer already owns it. */
    it('offers a save button only when auto-save is off', async () => {
      const { unmount } = renderPane();
      await act(async () => {});
      expect(screen.getByTestId('flow-yaml-save')).toBeDisabled();

      type(`${VALID}  - id: pay\n`);
      expect(screen.getByTestId('flow-yaml-save')).toBeEnabled();
      unmount();

      renderPane({ autoSave: { enabled: true, interval: 500 } });
      await act(async () => {});
      expect(screen.queryByTestId('flow-yaml-save')).not.toBeInTheDocument();
    });

    it('reports a save that failed rather than showing the draft as saved', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, request) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(describeOf(request.content));
        return Promise.reject(new Error('EACCES'));
      });
      renderPane();
      await act(async () => {});
      type(`${VALID}  - id: pay\n`);

      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('yaml-editor'), { key: 's', ctrlKey: true });
      });

      expect(screen.getByText(/Not saved — EACCES/)).toBeInTheDocument();
    });
  });

  /**
   * The run view draws the file a run would execute. An unsaved draft is not that file, and the
   * editor's own graph is kept out of the description the run view reads.
   */
  it('leaves the run view describing the file on disk', async () => {
    const { store } = renderPane();
    await act(async () => {});

    type(`${VALID}  - id: pay\n`);
    await settle(400);

    expect(store.getState().flows.descriptions[flow.pathname]).toBeUndefined();
    expect(store.getState().flows.sources[flow.pathname].description).toBeDefined();
  });
});

/**
 * 002 §6 and §11.1 — the document view is where a diagnostic is read, and *clicking a node scrolls
 * the document to its step*, which is what `FlowNode.position` is returned for. Neither was wired:
 * the position was never read by anything.
 */
describe('anchoring in the document (§6, §11.1)', () => {
  const withPositions = (diagnostics = []) => ({
    nodes: [
      { id: 'login', position: { line: 7, column: 5 } },
      { id: 'pay', position: { line: 21, column: 5 } }
    ],
    edges: [],
    slots: [],
    diagnostics
  });

  const anchorFor = (store) => store.getState().flows.documentAnchors[flow.pathname];

  beforeEach(() => {
    jest.useFakeTimers();
    window.ipcRenderer = {
      invoke: jest.fn((channel) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(withPositions([
          { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', line: 21, column: 3 },
          { severity: 'error', code: 'unresolved-api', message: 'httpbin is not bound' }
        ]));
        return Promise.resolve();
      })
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const openPane = async () => {
    const rendered = renderPane();
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    return rendered;
  };

  it('lists the engine\'s diagnostics', async () => {
    await openPane();

    const list = screen.getByTestId('flow-yaml-diagnostics');
    expect(list).toHaveTextContent('unknown-operation');
    expect(list).toHaveTextContent('unresolved-api');
  });

  it('anchors the document on the line a diagnostic names', async () => {
    const { store } = await openPane();

    fireEvent.click(screen.getByTestId('flow-yaml-diagnostic-0'));

    expect(anchorFor(store)).toMatchObject({ line: 21, column: 3 });
  });

  /** A diagnostic with no position has nowhere to go, so it is stated rather than offered (§6). */
  it('offers no anchor for a diagnostic that names no line', async () => {
    await openPane();

    expect(screen.getByTestId('flow-yaml-diagnostic-1').tagName).toBe('DIV');
    expect(screen.getByTestId('flow-yaml-diagnostic-0').tagName).toBe('BUTTON');
  });

  /**
   * A line in another file has nowhere to go *here* either: a `connectors.yml` entry's line is a
   * line of a file this editor cannot show, so it is stated with the file named — never a button
   * that would scroll the flow to that number. The gutter applies the same test.
   */
  it('names another file\'s diagnostic instead of offering to anchor it', async () => {
    window.ipcRenderer.invoke = jest.fn((channel) => {
      if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
      if (channel === 'renderer:flow-describe') return Promise.resolve(withPositions([
        { severity: 'error', code: 'unknown-output-path', message: 'token is not a path', file: '/w/flows/connectors.yml', line: 3, column: 5 }
      ]));
      return Promise.resolve();
    });
    const { store } = await openPane();

    const row = screen.getByTestId('flow-yaml-diagnostic-0');
    expect(row.tagName).toBe('DIV');
    expect(row).toHaveTextContent('connectors.yml, line 3');
    expect(anchorFor(store)).toBeUndefined();
  });

  /** §11.1: *clicking a node scrolls the document to its step*. */
  it('anchors the document on the step a node was drawn for', async () => {
    const { store } = await openPane();

    fireEvent.click(screen.getByTestId('graph-node-pay'));

    expect(anchorFor(store)).toMatchObject({ line: 21, column: 5 });
  });
});

/**
 * 002 §4.3 and §6 — the same diagnostics, marked in the editor's gutter beside the lines they are
 * about. §6's list says which line to go to; the gutter is what puts the statement next to the text.
 */
describe('diagnostics in the gutter (§4.3, §6)', () => {
  const markerAt = (line) =>
    [...mockEditorState.markers.values()].find((element) => element.getAttribute('data-testid') === `flow-gutter-${line}`);

  const describeWith = (diagnostics) => ({ nodes: [], edges: [], slots: [], diagnostics });

  const openPaneWith = async (diagnostics) => {
    window.ipcRenderer = {
      invoke: jest.fn((channel) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(describeWith(diagnostics));
        return Promise.resolve();
      })
    };

    const rendered = renderPane();
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    return rendered;
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks every line a diagnostic names, in a gutter of its own', async () => {
    await openPaneWith([
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16, column: 5 },
      { severity: 'warning', code: 'undeclared-dependency', message: 'reads steps.login', file: flow.pathname, line: 21, column: 5 }
    ]);

    // Upstream's two gutters are kept — the fork adds one rather than replacing the option.
    expect(mockEditorState.gutters).toEqual([FLOW_GUTTER_ID, 'CodeMirror-linenumbers', 'CodeMirror-foldgutter']);
    // 001 §13.2's lines are one-based; CodeMirror's are not.
    expect(mockEditor.setGutterMarker).toHaveBeenCalledWith(15, FLOW_GUTTER_ID, expect.anything());
    expect(mockEditor.setGutterMarker).toHaveBeenCalledWith(20, FLOW_GUTTER_ID, expect.anything());
  });

  it('says which severity is on the line, and what it says', async () => {
    await openPaneWith([
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16 },
      { severity: 'warning', code: 'undeclared-dependency', message: 'reads steps.login', file: flow.pathname, line: 21 }
    ]);

    expect(markerAt(16).getAttribute('data-severity')).toBe('error');
    expect(markerAt(16).className).toContain('error');
    expect(markerAt(16).title).toBe('unknown-operation: nope is not in httpbin.yml');
    expect(markerAt(21).getAttribute('data-severity')).toBe('warning');
    expect(markerAt(21).className).toContain('warning');
  });

  /** Two marks in one gutter cell would overlap, and a line with two problems is one place to go. */
  it('draws one mark for a line carrying more than one diagnostic, listing both', async () => {
    await openPaneWith([
      { severity: 'warning', code: 'undeclared-dependency', message: 'reads steps.login', file: flow.pathname, line: 16 },
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16 }
    ]);

    expect(mockEditorState.markers.size).toBe(1);
    expect(markerAt(16).title).toBe('undeclared-dependency: reads steps.login\nunknown-operation: nope is not in httpbin.yml');
    // The louder of the two, because severity is what decides whether the run is blocked (§6).
    expect(markerAt(16).getAttribute('data-severity')).toBe('error');
  });

  /**
   * §6: a connector-file diagnostic's line is a line in `connectors.yml`. Marking this document at
   * that number would put an authoritative mark on unrelated text.
   */
  it('leaves a diagnostic about another file out of the gutter', async () => {
    await openPaneWith([
      { severity: 'error', code: 'unknown-output', message: 'order_id is not produced', file: '/w/flows/connectors.yml', line: 3 },
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16 }
    ]);

    expect(mockEditorState.markers.size).toBe(1);
    expect(markerAt(3)).toBeUndefined();
    expect(markerAt(16)).toBeDefined();
  });

  /** The mark and §6's `line N` are two ways to the same place, so they anchor identically. */
  it('anchors the document where the list would', async () => {
    const { store } = await openPaneWith([
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16, column: 5 }
    ]);

    await act(async () => {
      markerAt(16).click();
    });

    expect(store.getState().flows.documentAnchors[flow.pathname]).toMatchObject({ line: 16, column: 5 });
  });

  it('takes the marks back when the diagnostics go', async () => {
    await openPaneWith([
      { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', file: flow.pathname, line: 16 }
    ]);
    expect(markerAt(16)).toBeDefined();

    // The draft is fixed, and the engine answers about the text now in the editor.
    window.ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
      if (channel === 'renderer:flow-describe') return Promise.resolve(describeWith([]));
      return Promise.resolve();
    });

    type(`${VALID}  - id: pay\n`);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(mockEditor.clearGutter).toHaveBeenCalledWith(FLOW_GUTTER_ID);
    expect(mockEditorState.markers.size).toBe(0);
  });

  /** §6's parse error is a diagnostic like any other, and the line it names is in this document. */
  it('marks the line a draft stopped parsing on', async () => {
    await openPaneWith([{ severity: 'error', code: 'parse-error', message: 'bad indentation', file: flow.pathname, line: 3, column: 2 }]);

    expect(markerAt(3).getAttribute('data-severity')).toBe('error');
    expect(mockEditor.setGutterMarker).toHaveBeenCalledWith(2, FLOW_GUTTER_ID, expect.anything());
  });
});
