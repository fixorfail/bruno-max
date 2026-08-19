import React from 'react';

// §9's pane reaches the real editor, which pulls the store in through its CodeMirror setup. None of
// these scenarios open a step, and the editor is not what they are about.
jest.mock('components/CodeEditor', () => ({ value }) => <pre>{value}</pre>);
jest.mock('providers/Theme', () => ({
  useTheme: () => ({ theme: jest.requireActual('themes/index').dark, displayedTheme: 'dark' })
}));

import { act, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import FlowTabPane from './index';

/**
 * 002 §6 — where a flow's diagnostics surface in the run view.
 *
 * Errors block the run control, so they are listed. Warnings do not, and 001 §5.4's
 * forward-compatibility posture means a flow can carry them indefinitely — listed above the graph
 * they push the drawing down on every open and read like the errors that *do* stop a run.
 */

const theme = themes.dark || Object.values(themes)[0];
const pathname = '/workspace/flows/checkout.flow.yml';
const entry = { pathname, filename: 'checkout.flow.yml', workspaceRoot: '/workspace' };

const describedWith = (diagnostics) => ({
  id: 'checkout.flow.yml',
  name: 'checkout',
  isLibrary: false,
  params: [],
  nodes: [],
  edges: [],
  slots: [],
  diagnostics
});

const renderPane = async (diagnostics, run) => {
  const store = configureStore({
    // §7.2's environment control is the app's own dropdown, so this pane reaches the environments,
    // and the collections and workspaces its Configure action resolves a tab through.
    reducer: {
      flows: flowsReducer,
      globalEnvironments: () => ({ globalEnvironments: [], activeGlobalEnvironmentUid: null }),
      collections: () => ({ collections: [] }),
      workspaces: () => ({ workspaces: [] })
    },
    preloadedState: {
      flows: {
        flows: [entry],
        descriptions: { [pathname]: { loading: false, description: describedWith(diagnostics) } },
        runs: run ? { [pathname]: run } : {},
        flowByRunId: {},
        selectedStep: {},
        requestLogs: [],
        sources: {}
      }
    }
  });

  const utils = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <FlowTabPane tab={{ uid: 'tab-1', pathname, type: 'flow' }} />
      </ThemeProvider>
    </Provider>
  );

  // §10's run list resolves after the render; letting it land here keeps every scenario below
  // asserting on a settled pane rather than on one mid-update.
  await act(async () => {});
  return utils;
};

const warning = { severity: 'warning', code: 'undeclared-dependency', message: 'create is read raw', line: 12 };
const error = { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', line: 4 };

describe('the run view diagnostics (§6)', () => {
  beforeEach(() => {
    // `RunSelector` asks the host for this flow's past runs as it mounts (§10).
    window.ipcRenderer = { invoke: jest.fn().mockResolvedValue([]) };
  });

  it('states how many warnings there are without listing them', async () => {
    await renderPane([warning, warning]);

    expect(screen.getByTestId('flow-warnings')).toHaveTextContent('2 warnings');
    expect(screen.queryByTestId('flow-diagnostics')).not.toBeInTheDocument();
  });

  /** Hidden rather than absent: the list is in the document for a hover to reveal, and for a reader. */
  it('keeps each warning available to the count that summarises them', async () => {
    await renderPane([warning]);

    expect(screen.getByTestId('flow-warnings')).toHaveTextContent('1 warning');
    expect(screen.getByTestId('flow-warnings-list')).toHaveTextContent('undeclared-dependency');
    expect(screen.getByTestId('flow-warnings-list')).toHaveTextContent('line 12');
  });

  /**
   * On the toolbar row with the flow's other controls, at its end. Over the graph it was the only
   * one of them that moved with the drawing, and it took a corner of the drawing with it.
   */
  it('sits at the end of the row the other controls are on', async () => {
    await renderPane([warning]);

    const toolbar = document.querySelector('.flow-toolbar');
    expect(toolbar).toContainElement(screen.getByTestId('flow-warnings'));
    // Last on the row, and pushed there by the row rather than placed at a coordinate.
    expect(toolbar.lastElementChild).toBe(screen.getByTestId('flow-warnings'));
  });

  /** Reachable without a pointer, or the list is unreachable for anyone who does not use one. */
  it('is focusable', async () => {
    await renderPane([warning]);

    expect(screen.getByTestId('flow-warnings')).toHaveAttribute('tabindex', '0');
  });

  /** An error stops the run, so it stays where it cannot be missed. */
  it('lists errors above the graph, as before', async () => {
    await renderPane([error]);

    expect(screen.getByTestId('flow-diagnostics')).toHaveTextContent('unknown-operation');
    expect(screen.getByTestId('flow-diagnostics')).toHaveTextContent('nope is not in httpbin.yml');
    expect(screen.queryByTestId('flow-warnings')).not.toBeInTheDocument();
  });

  it('keeps the two apart when a flow has both', async () => {
    await renderPane([error, warning]);

    expect(screen.getByTestId('flow-diagnostics')).not.toHaveTextContent('undeclared-dependency');
    expect(screen.getByTestId('flow-warnings-list')).toHaveTextContent('undeclared-dependency');
  });

  /**
   * 001 §13.2's run diagnostics — what happened while the flow executed, as against §6's, which are
   * about the file. They belong to no step, so no node and no step pane will ever carry them: an
   * artifact write that failed, or the failure a run that died on its own could not attach anywhere.
   * Unshown, a run's whole account of itself is the word `failed`.
   */
  describe('the run\'s own diagnostics (001 §13.2)', () => {
    const run = {
      runId: 'run-1',
      state: 'complete',
      status: 'failed',
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0 },
      selectedIteration: 0,
      steps: {},
      diagnostics: [
        {
          severity: 'warning',
          code: 'capture-write-failed',
          message: 'await_seed attempt 3: EACCES',
          file: pathname,
          stepId: 'await_seed'
        }
      ]
    };

    it('lists them with the file\'s, and counts them apart', async () => {
      await renderPane([], run);

      expect(screen.getByTestId('flow-diagnostics')).toHaveTextContent('capture-write-failed');
      expect(screen.getByTestId('flow-diagnostics')).toHaveTextContent('await_seed attempt 3: EACCES');
      expect(screen.getByTestId('flow-run-diagnostics')).toHaveTextContent('1 from this run');
    });

    it('shows them on a flow whose file has nothing wrong with it', async () => {
      await renderPane([], run);

      expect(screen.queryByTestId('flow-warnings')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-diagnostics')).toBeInTheDocument();
    });

    it('says nothing where a run reported none', async () => {
      await renderPane([], { ...run, diagnostics: [] });

      expect(screen.queryByTestId('flow-diagnostics')).not.toBeInTheDocument();
    });
  });

  it('shows neither on a flow with nothing to report', async () => {
    await renderPane([]);

    expect(screen.queryByTestId('flow-diagnostics')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-warnings')).not.toBeInTheDocument();
  });
});
