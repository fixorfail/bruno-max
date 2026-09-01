import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the pane
// does with the text, not about highlighting it.
jest.mock('components/CodeEditor', () => ({ value, onEdit, mode }) => (
  <textarea data-testid="script-editor" data-mode={mode} value={value} onChange={(event) => onEdit(event.target.value)} />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import FlowScriptTabPane from './index';

/**
 * 002 §4.5. The pane edits a `.js` helper with §4.3's editing session and none of its graph.
 *
 * The validity gate is what these mostly pin down, and it matters more here than it does for YAML: a
 * script is composed into the prelude of every script position in every flow that names it (001
 * §8.6), so auto-saving a half-typed line breaks all of them at once.
 */

const theme = themes.dark || Object.values(themes)[0];

const pathname = '/home/dev/workspace-one/flows/scripts/text.js';
const script = { pathname, filename: 'text.js', workspaceRoot: '/home/dev/workspace-one', script: true };

const VALID = 'const lastFour = (v) => String(v).slice(-4);\n';

const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

const renderPane = ({ autoSave = false, flows = [script] } = {}) => {
  const store = configureStore({
    reducer: {
      flows: flowsReducer,
      app: () => ({ preferences: { autoSave: { enabled: autoSave, interval: 100 }, font: {} } })
    },
    preloadedState: { flows: { ...initialFlowsState(), flows } }
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <FlowScriptTabPane tab={{ uid: 'tab-1', type: 'flow-script', pathname }} />
        </ThemeProvider>
      </Provider>
    )
  };
};

const type = (text) => fireEvent.change(screen.getByTestId('script-editor'), { target: { value: text } });

const invoked = (channel) => window.ipcRenderer.invoke.mock.calls.filter((call) => call[0] === channel);

describe('FlowScriptTabPane', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.ipcRenderer = {
      invoke: jest.fn((channel) => (channel === 'renderer:flow-read-source' ? Promise.resolve(VALID) : Promise.resolve()))
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const settle = async (ms) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it('opens on the file as it is on disk, in javascript mode', async () => {
    renderPane();
    await act(async () => {});

    expect(invoked('renderer:flow-read-source')[0][1]).toMatchObject({ entry: pathname });
    expect(screen.getByTestId('script-editor')).toHaveValue(VALID);
    expect(screen.getByTestId('script-editor')).toHaveAttribute('data-mode', 'javascript');
  });

  it('never describes it — a script has no graph to draw', async () => {
    renderPane();
    await act(async () => {});
    type('const a = 1;\n');
    await settle(500);

    expect(invoked('renderer:flow-describe')).toHaveLength(0);
  });

  it('writes the draft on the save button', async () => {
    renderPane();
    await act(async () => {});
    type('const a = 1;\n');

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-script-save'));
    });

    expect(invoked('renderer:flow-write-source')[0][1]).toMatchObject({ entry: pathname, content: 'const a = 1;\n' });
  });

  it('offers no save button when auto-save owns the writing', async () => {
    renderPane({ autoSave: true });
    await act(async () => {});

    expect(screen.queryByTestId('flow-script-save')).not.toBeInTheDocument();
  });

  describe('the validity gate', () => {
    it('auto-saves javascript that parses', async () => {
      renderPane({ autoSave: true });
      await act(async () => {});

      type('const a = 1;\n');
      await settle(500);

      expect(invoked('renderer:flow-write-source')).toHaveLength(1);
    });

    /** A half-typed line composed into the prelude fails every script position in every flow. */
    it('does not auto-save javascript that does not parse, and says so', async () => {
      renderPane({ autoSave: true });
      await act(async () => {});

      type('const a = (x) => {\n');
      await settle(500);

      expect(invoked('renderer:flow-write-source')).toHaveLength(0);
      expect(screen.getByTestId('flow-script-invalid')).toBeInTheDocument();
    });

    /** The gate is auto-save's. Asking for a save explicitly is the author overruling it. */
    it('still writes broken javascript when the author asks for it', async () => {
      renderPane();
      await act(async () => {});
      type('const a = (x) => {\n');

      await act(async () => {
        fireEvent.click(screen.getByTestId('flow-script-save'));
      });

      expect(invoked('renderer:flow-write-source')).toHaveLength(1);
    });
  });

  it('says the draft and the file diverged when the file moved underneath it', async () => {
    const { store } = renderPane();
    await act(async () => {});
    type('const a = 1;\n');

    await act(async () => {
      store.dispatch({ type: 'flows/sourceDivergedOnDisk', payload: { pathname } });
    });

    expect(screen.getByTestId('flow-script-diverged')).toBeInTheDocument();
  });

  it('says so when the script is gone rather than rendering an editor', async () => {
    renderPane({ flows: [] });
    await act(async () => {});

    expect(screen.getByText('This script is no longer on disk.')).toBeInTheDocument();
    expect(screen.queryByTestId('script-editor')).not.toBeInTheDocument();
  });
});
