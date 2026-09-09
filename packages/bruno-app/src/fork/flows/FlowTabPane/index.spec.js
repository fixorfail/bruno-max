import React from 'react';

// §9's pane reaches the real editor, which pulls the store in through its CodeMirror setup. None of
// these scenarios open a step, and the editor is not what they are about.
jest.mock('components/CodeEditor', () => ({ value }) => <pre>{value}</pre>);
jest.mock('providers/Theme', () => ({
  useTheme: () => ({ theme: jest.requireActual('themes/index').dark, displayedTheme: 'dark' })
}));

// `jest.setup.js` stubs nanoid with only `nanoid`, and `uuid()` reaches for `customAlphabet` — so
// §6's diagnostic cannot open §4.3's tab in a test without this.
let mockUid = 0;
jest.mock('utils/common', () => ({
  ...jest.requireActual('utils/common'),
  uuid: () => `uid-${++mockUid}`
}));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';

import themes from 'themes/index';
import FlowTabPane from './index';

/** The slice's own initial state, so a key added to it does not break every fixture below. */
const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

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
      workspaces: () => ({ workspaces: [] }),
      // §6's diagnostic opens §4.3's tab, which is upstream's slice — stubbed to what these
      // scenarios read of it rather than mounted, since the strip is not what they are about.
      tabs: (state = { tabs: [] }, action) =>
        (action.type === 'tabs/addTab' ? { tabs: [...state.tabs, action.payload] } : state)
    },
    preloadedState: {
      flows: {
        ...initialFlowsState(),
        flows: [entry],
        descriptions: { [pathname]: { loading: false, description: describedWith(diagnostics) } },
        runs: run ? { [pathname]: run } : {}
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
  return { store, ...utils };
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

  /**
   * 002 §10 — where the run on screen came from. A `.bruno-runs/` directory downloaded from a build
   * artifact opens here exactly as a local run does, so the run's own record is the only thing that
   * can say which host started it and against what.
   */
  describe('the run\'s origin (§10)', () => {
    const run = {
      runId: 'run-1',
      state: 'complete',
      status: 'passed',
      summary: { total: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0 },
      selectedIteration: 0,
      steps: {},
      diagnostics: []
    };

    it('names the host and the environments the run had', async () => {
      await renderPane([], { ...run, origin: { host: 'app', environment: 'staging' } });

      expect(screen.getByTestId('flow-run-origin')).toHaveTextContent('app · staging');
    });

    it('names a global environment after the collection one', async () => {
      await renderPane([], {
        ...run,
        origin: { host: 'cli', environment: 'staging', globalEnvironment: 'shared' }
      });

      expect(screen.getByTestId('flow-run-origin')).toHaveTextContent('cli · staging · shared');
    });

    /** A host that selected no environment ran against none; the badge is the host alone. */
    it('names the host on its own where no environment was selected', async () => {
      await renderPane([], { ...run, origin: { host: 'cli' } });

      expect(screen.getByTestId('flow-run-origin')).toHaveTextContent('cli');
    });

    /** A run recorded before the field existed: nothing rather than a guess about where it came from. */
    it('says nothing about a run that recorded none', async () => {
      await renderPane([], run);

      expect(screen.queryByTestId('flow-run-origin')).not.toBeInTheDocument();
    });

    /** §10's `current` is the flow as it stands, not a run — there is no provenance to state. */
    it('says nothing with no run open', async () => {
      await renderPane([]);

      expect(screen.queryByTestId('flow-run-origin')).not.toBeInTheDocument();
    });
  });

  it('shows neither on a flow with nothing to report', async () => {
    await renderPane([]);

    expect(screen.queryByTestId('flow-diagnostics')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-warnings')).not.toBeInTheDocument();
  });
});

/**
 * 002 §6: *the document view — anchored at `line`/`column` … this is the primary surface: a
 * diagnostic about `depends` is most useful next to the `depends` that caused it.*
 *
 * The document view is §4.3's tab rather than a second view in this one — §4.2 is explicit about
 * that — so the line a diagnostic names is a control that goes there. Before this it was a label
 * with no click handler, anchored to nothing.
 */
describe('anchoring a diagnostic in the document (§6)', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn().mockResolvedValue([]) };
  });

  /**
   * A `flows/connectors.yml` entry (001 §8.5) carries that file and its own line. The app has no tab
   * that can open it (002 §15.2), so the line is stated with the file named and is not a control —
   * the alternative, offered until now, opened the flow's YAML at a line number from another file.
   */
  it('names another file rather than opening the flow at its line', async () => {
    const elsewhere = {
      severity: 'error',
      code: 'unknown-output-path',
      message: 'token is not a path in the response',
      file: '/w/flows/connectors.yml',
      line: 3
    };
    const { store } = await renderPane([elsewhere]);

    expect(screen.getByTestId('flow-diagnostic-file-3')).toHaveTextContent('connectors.yml, line 3');
    expect(screen.queryByTestId('flow-diagnostic-line-3')).toBeNull();
    expect(store.getState().flows.documentAnchors[pathname]).toBeUndefined();
  });

  /** The flow's own file is still a control — `file` set to the flow itself changes nothing. */
  it('keeps the control when the diagnostic names the flow itself', async () => {
    await renderPane([{ ...error, file: pathname }]);

    expect(screen.getByTestId('flow-diagnostic-line-4')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-diagnostic-file-4')).toBeNull();
  });

  it('records the line the reader asked for', async () => {
    const { store } = await renderPane([error]);

    fireEvent.click(screen.getByTestId('flow-diagnostic-line-4'));

    expect(store.getState().flows.documentAnchors[pathname]).toMatchObject({ line: 4 });
  });

  /** Asking twice for the same line is two requests: the second is what somebody clicks after scrolling away. */
  it('counts a second request for the same line', async () => {
    const { store } = await renderPane([error]);

    fireEvent.click(screen.getByTestId('flow-diagnostic-line-4'));
    fireEvent.click(screen.getByTestId('flow-diagnostic-line-4'));

    expect(store.getState().flows.documentAnchors[pathname].nonce).toBe(2);
  });

  /** §4.2 puts the document in its own tab, so anchoring one has to open it. */
  it('opens the flow\'s YAML tab on the same file, in the same collection', async () => {
    const { store } = await renderPane([error]);

    fireEvent.click(screen.getByTestId('flow-diagnostic-line-4'));

    expect(store.getState().tabs.tabs).toEqual([
      expect.objectContaining({ type: 'flow-yaml', pathname, preview: false })
    ]);
  });

  /** A warning is anchored the same way; only its listing differs (§6). */
  it('anchors a warning too', async () => {
    const { store } = await renderPane([warning]);

    fireEvent.click(screen.getByTestId('flow-diagnostic-line-12'));

    expect(store.getState().flows.documentAnchors[pathname]).toMatchObject({ line: 12 });
  });

  /** §6: a diagnostic with no position has nowhere to go, so it is stated rather than offered. */
  it('offers nothing for a diagnostic that names no line', async () => {
    await renderPane([{ severity: 'error', code: 'unresolved-api', message: 'httpbin is not bound' }]);

    expect(screen.getByTestId('flow-diagnostics')).toHaveTextContent('unresolved-api');
    expect(screen.queryByTestId(/flow-diagnostic-line-/)).not.toBeInTheDocument();
  });
});
