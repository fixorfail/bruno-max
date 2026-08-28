import React from 'react';

// The real YAML editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the
// pane does with the text, not about highlighting it.
jest.mock('components/CodeEditor', () => ({ value, onEdit }) => (
  <textarea data-testid="yaml-editor" value={value} onChange={(event) => onEdit(event.target.value)} />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));
jest.mock('../FlowTabPane/FlowGraph', () => ({ description }) => (
  <div data-testid="flow-graph">{description.nodes.map((node) => node.id).join(',')}</div>
));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
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

describe('FlowYamlTabPane', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.ipcRenderer = {
      invoke: jest.fn((channel) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(descriptionWith('login'));
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
    await waitFor(() => expect(screen.getByTestId('flow-graph')).toHaveTextContent('login,pay'));
  });

  it('holds the graph still while the yaml does not parse', async () => {
    renderPane();
    await act(async () => {});
    await settle(400);
    const before = invoked('renderer:flow-describe').length;

    type(INVALID);
    await settle(400);

    expect(invoked('renderer:flow-describe')).toHaveLength(before);
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

  describe('saving (§4.3)', () => {
    it('auto-saves a valid draft after the configured interval', async () => {
      renderPane({ autoSave: { enabled: true, interval: 500 } });
      await act(async () => {});

      type(`${VALID}  - id: pay\n`);
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
      window.ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'renderer:flow-read-source') return Promise.resolve(VALID);
        if (channel === 'renderer:flow-describe') return Promise.resolve(descriptionWith('login'));
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
