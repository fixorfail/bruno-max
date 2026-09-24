import React from 'react';

// §9's pane reaches the real editor, which pulls the store in through its CodeMirror setup. None of
// these scenarios open a step, and the editor is not what they are about.
jest.mock('components/CodeEditor', () => ({ value, onEdit }) => (
  <textarea data-testid="code-editor" value={value} onChange={(event) => onEdit(event.target.value)} />
));
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

/**
 * The host, as this pane reaches it: §10's run list, and — under 005 §7.1 — the flow's own text and
 * the engine's description of it, which the pane reads on open so the designer has a draft to edit.
 * The describe answers about whatever text it is handed, so a scenario can preload a draft and see
 * the pane draw it.
 */
const mockHost = ({
  text = 'version: 1\nsteps: []\n',
  describe = () => describedWith([]),
  operations = () => ({ apis: [] }),
  apply = () => ({ ok: true, text: 'edited\n', changed: true }),
  editModel = () => ({ steps: [], apis: [], authProfiles: [], config: {}, vocabulary: {} })
} = {}) => {
  window.ipcRenderer = {
    invoke: jest.fn((channel, request) => {
      if (channel === 'renderer:flow-read-source') return Promise.resolve(text);
      if (channel === 'renderer:flow-describe') return Promise.resolve(describe(request));
      if (channel === 'renderer:flow-list-operations') return Promise.resolve(operations(request));
      if (channel === 'renderer:flow-apply-edit') return Promise.resolve(apply(request));
      if (channel === 'renderer:flow-read-edit-model') return Promise.resolve(editModel(request));
      return Promise.resolve([]);
    })
  };
  return window.ipcRenderer.invoke;
};

const renderPane = async (diagnostics, run, { sources, autoSave, text, describe, operations, apply, editModel, flows } = {}) => {
  // The engine answers about the draft with what the scenario said the flow has, unless it says
  // otherwise — so a diagnostic preloaded for the file is also what the draft's describe reports.
  const invoke = mockHost({ text, describe: describe || (() => describedWith(diagnostics)), operations, apply, editModel });
  const store = configureStore({
    // §7.2's environment control is the app's own dropdown, so this pane reaches the environments,
    // and the collections and workspaces its Configure action resolves a tab through.
    reducer: {
      flows: flowsReducer,
      app: () => ({ preferences: { autoSave: autoSave || { enabled: false, interval: 500 } } }),
      globalEnvironments: () => ({ globalEnvironments: [], activeGlobalEnvironmentUid: null }),
      collections: () => ({ collections: [] }),
      apiSpec: () => ({ apiSpecs: [{ uid: 'spec-1', name: 'Orders API', filename: 'orders-v1.yml', pathname: '/workspace/apispec/orders-v1.yml' }] }),
      workspaces: () => ({ activeWorkspaceUid: 'ws-1', workspaces: [{ uid: 'ws-1', apiSpecs: [{ name: 'Orders API', path: '/workspace/apispec/orders-v1.yml' }] }] }),
      // §6's diagnostic opens §4.3's tab, which is upstream's slice — stubbed to what these
      // scenarios read of it rather than mounted, since the strip is not what they are about.
      tabs: (state = { tabs: [] }, action) =>
        (action.type === 'tabs/addTab' ? { tabs: [...state.tabs, action.payload] } : state)
    },
    preloadedState: {
      flows: {
        ...initialFlowsState(),
        flows: flows || [entry],
        descriptions: { [pathname]: { loading: false, description: describedWith(diagnostics) } },
        runs: run ? { [pathname]: run } : {},
        ...(sources ? { sources } : {})
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
  return { store, invoke, ...utils };
};

const warning = { severity: 'warning', code: 'undeclared-dependency', message: 'create is read raw', line: 12 };
const error = { severity: 'error', code: 'unknown-operation', message: 'nope is not in httpbin.yml', line: 4 };

describe('the run view diagnostics (§6)', () => {
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

/**
 * 005 §4, §7.1, §8 — the tab is the designer's surface: it reads the flow's text on open, draws the
 * draft's graph while no run is open and the run's while one is, says which it is doing, and runs
 * what is on screen rather than what was last saved.
 */
describe('the flow tab as the designer (005 §4, §7.1)', () => {
  const draftText = 'version: 1\nsteps:\n  - id: draft_step\n';
  const fileDescription = () => ({ ...describedWith([]), nodes: [{ id: 'saved_step', kind: 'operation', rank: 0, outputs: [], pre: [], markers: {}, position: { line: 3, column: 3 } }] });
  const draftDescription = () => ({ ...describedWith([]), nodes: [{ id: 'draft_step', kind: 'operation', rank: 0, outputs: [], pre: [], markers: {}, position: { line: 3, column: 3 } }] });
  const loadedSource = (content, extra = {}) => ({
    [pathname]: {
      content,
      saved: content,
      opened: content,
      loading: false,
      saving: false,
      staleOnDisk: false,
      describedContent: content,
      parses: true,
      description: draftDescription(),
      diagnostics: [],
      ...extra
    }
  });

  const draft = (sources, extra = {}) => ({ sources, text: draftText, describe: () => draftDescription(), ...extra });

  it('reads the flow\'s text on open, and describes it', async () => {
    const { store, invoke } = await renderPane([], undefined, draft());
    await act(async () => {});

    expect(invoke.mock.calls.some(([channel]) => channel === 'renderer:flow-read-source')).toBe(true);
    expect(invoke.mock.calls.some(([channel, request]) => channel === 'renderer:flow-describe' && request.content === draftText)).toBe(true);
    expect(store.getState().flows.sources[pathname].description).toBeDefined();
  });

  /** §7.1: with no run open the graph is the draft's, which is the document being made here. */
  it('draws the draft\'s description while no run is open', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText)));

    expect(screen.getByTestId('flow-node-draft_step')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-node-saved_step')).not.toBeInTheDocument();
  });

  /** Until the draft has been read, the file's own description stands in — the same graph. */
  it('draws the file\'s description until the draft is described', async () => {
    mockHost({ text: draftText, describe: () => new Promise(() => {}) });
    const store = configureStore({
      reducer: { flows: flowsReducer, app: () => ({ preferences: {} }), globalEnvironments: () => ({ globalEnvironments: [] }), collections: () => ({ collections: [] }), workspaces: () => ({ workspaces: [] }), tabs: () => ({ tabs: [] }) },
      preloadedState: { flows: { ...initialFlowsState(), flows: [entry], descriptions: { [pathname]: { loading: false, description: fileDescription() } } } }
    });
    render(<Provider store={store}><ThemeProvider theme={theme}><FlowTabPane tab={{ uid: 'tab-1', pathname, type: 'flow' }} /></ThemeProvider></Provider>);
    await act(async () => {});

    expect(screen.getByTestId('flow-node-saved_step')).toBeInTheDocument();
  });

  /** §10 unchanged: a run draws the graph it executed, whatever the draft says now. */
  it('draws the run\'s description while a run is open', async () => {
    const run = { runId: 'run-1', state: 'complete', status: 'passed', selectedIteration: 0, steps: {}, description: fileDescription() };
    await renderPane([], run, draft(loadedSource(draftText)));

    expect(screen.getByTestId('flow-node-saved_step')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-node-draft_step')).not.toBeInTheDocument();
  });

  it('states the save state, and offers Save when auto-save is off', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText)));

    expect(screen.getByTestId('flow-designer-state')).toHaveTextContent('Saved');
    expect(screen.getByTestId('flow-designer-save')).toBeDisabled();
    expect(screen.queryByTestId('flow-designer-readonly')).not.toBeInTheDocument();
  });

  it('withholds Save while auto-save owns the writing', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText), { autoSave: { enabled: true, interval: 500 } }));

    expect(screen.getByTestId('flow-designer-state')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-designer-save')).not.toBeInTheDocument();
  });

  it('B5.3 says the draft is unsaved, and that the file also changed on disk', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText, { saved: 'version: 1\n', staleOnDisk: true })));

    expect(screen.getByTestId('flow-designer-diverged')).toHaveTextContent('the file also changed on disk');
    expect(screen.getByTestId('flow-designer-save')).toBeEnabled();
  });

  /** B5.9 — §7.4's revert, offered here because this is the surface the edits were made on. */
  it('B5.9 reverts the draft to the text the session opened with, after asking', async () => {
    const { store } = await renderPane([], undefined, draft(loadedSource(draftText, { opened: 'version: 1\n' })));

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-designer-revert'));
    });
    expect(store.getState().flows.sources[pathname].content).toEqual(draftText);

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-flow-revert-discard'));
    });

    expect(store.getState().flows.sources[pathname].content).toEqual('version: 1\n');
  });

  it('offers no revert when the draft is the text it opened with', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText)));

    expect(screen.queryByTestId('flow-designer-revert')).not.toBeInTheDocument();
  });

  it('saves on ⌘S', async () => {
    const { invoke } = await renderPane([], undefined, draft(loadedSource(draftText, { saved: 'version: 1\n' })));

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('flow-designer-state'), { key: 's', metaKey: true });
    });

    expect(invoke.mock.calls.some(([channel, request]) => channel === 'renderer:flow-write-source' && request.content === draftText)).toBe(true);
  });

  /** §4: a run open in the tab is a record. A finished one stays open — its results are what the
   *  reader is looking at — and Edit flow is the same act as choosing `current`. */
  it('is read-only while a run is open, and Edit flow closes it', async () => {
    const run = { runId: 'run-1', state: 'complete', status: 'passed', selectedIteration: 0, steps: {}, description: fileDescription() };
    const { store } = await renderPane([], run, draft(loadedSource(draftText)));

    expect(screen.getByTestId('flow-designer-readonly')).toHaveTextContent('Reviewing a run');
    expect(screen.queryByTestId('flow-designer-state')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('flow-designer-edit'));

    expect(store.getState().flows.runs[pathname]).toBeUndefined();
    expect(screen.getByTestId('flow-designer-state')).toHaveTextContent('Saved');
    expect(screen.getByTestId('flow-node-draft_step')).toBeInTheDocument();
  });

  it('refuses Edit flow while the run is executing', async () => {
    const run = { runId: 'run-1', state: 'running', selectedIteration: 0, steps: {} };
    await renderPane([], run, draft(loadedSource(draftText)));

    expect(screen.getByTestId('flow-designer-readonly')).toHaveTextContent('Running');
    expect(screen.getByTestId('flow-designer-edit')).toBeDisabled();
  });

  /** §4's third clause: text the engine says is not a document is not editable, and says why. */
  it('B5.7 is read-only while the draft does not parse', async () => {
    await renderPane([], undefined, draft(loadedSource(draftText, { parses: false })));

    expect(screen.getByTestId('flow-designer-readonly')).toHaveTextContent('does not parse');
  });

  describe('running from the designer (005 §8)', () => {
    it('saves a dirty draft, then runs', async () => {
      const { invoke } = await renderPane([], undefined, draft(loadedSource(draftText, { saved: 'version: 1\n' })));

      expect(screen.getByTestId('flow-run-saves-first')).toHaveTextContent('Save & run');

      await act(async () => {
        fireEvent.click(screen.getByTestId('flow-run'));
      });

      const channels = invoke.mock.calls.map(([channel]) => channel).filter((channel) => ['renderer:flow-write-source', 'renderer:flow-run'].includes(channel));
      expect(channels).toEqual(['renderer:flow-write-source', 'renderer:flow-run']);
    });

    it('runs a clean draft without saving', async () => {
      const { invoke } = await renderPane([], undefined, draft(loadedSource(draftText)));

      expect(screen.queryByTestId('flow-run-saves-first')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('flow-run'));
      });

      expect(invoke.mock.calls.some(([channel]) => channel === 'renderer:flow-write-source')).toBe(false);
      expect(invoke.mock.calls.some(([channel]) => channel === 'renderer:flow-run')).toBe(true);
    });

    it('B5.7 is disabled while the draft does not parse', async () => {
      await renderPane([], undefined, draft(loadedSource(draftText, { saved: 'version: 1\n', parses: false })));

      expect(screen.getByTestId('flow-run')).toBeDisabled();
      expect(screen.getByTestId('flow-run')).toHaveAttribute('title', 'The draft does not parse');
    });
  });
});

/**
 * 005 §5 — the canvas edits the document. Every affordance writes through the engine; what these
 * assert is that the right edit is sent for the place that was clicked, and that nothing is drawn
 * that the engine has not described.
 */
describe('the canvas edits the document (005 §5)', () => {
  const chainText = 'version: 1\nsteps:\n  - id: a\n  - id: b\n  - id: c\n';
  const step = (id, line, rank) => ({
    id,
    kind: 'operation',
    operation: { api: 'api', method: 'GET', path: '/x' },
    rank,
    outputs: [],
    pre: [],
    markers: {},
    position: { line, column: 5 }
  });
  const chain = () => ({
    ...describedWith([]),
    apis: [{ alias: 'api' }],
    nodes: [step('a', 3, 0), step('b', 4, 1), step('c', 5, 2)],
    edges: [
      { from: 'a', to: 'b', kind: 'sequence' },
      { from: 'b', to: 'c', kind: 'sequence' }
    ]
  });
  const chainSource = (extra = {}) => ({
    [pathname]: {
      content: chainText,
      saved: chainText,
      loading: false,
      saving: false,
      describedContent: chainText,
      parses: true,
      description: chain(),
      diagnostics: [],
      ...extra
    }
  });
  const withOperations = {
    apis: [
      {
        alias: 'api',
        source: './api.yml',
        operations: [
          { reference: 'createThing', operationId: 'createThing', method: 'POST', path: '/things', summary: 'Make one', tags: [], deprecated: false, ambiguous: false },
          { reference: 'GET /things/{id}', operationId: 'getThing', method: 'GET', path: '/things/{id}', tags: [], deprecated: false, ambiguous: true }
        ]
      }
    ]
  };
  const modelStep = (id, line, extra = {}) => ({
    id,
    fields: { id, operation: 'api#op', ...extra.fields },
    opaque: extra.opaque || [],
    position: { line, column: 5 },
    keyPositions: { id: { line, column: 5 }, operation: { line: line + 1, column: 5 }, ...extra.keyPositions }
  });
  const chainModel = () => ({
    steps: [modelStep('a', 3), modelStep('b', 4, { fields: { name: 'Second' }, opaque: [{ key: 'body', tag: '!file' }, { key: 'retryPolicy' }], keyPositions: { body: { line: 9, column: 5 } } }), modelStep('c', 5)],
    apis: [{ alias: 'api', source: './api.yml', opaque: [] }],
    authProfiles: [],
    config: {},
    vocabulary: { operators: ['eq'], statuses: ['success', 'failed', 'skipped', 'cancelled'], authModes: [], backoff: [], jitter: [], stepKeys: ['id', 'name', 'operation'], configKeys: ['baseUrl', 'validateSchema', 'concurrency'] }
  });
  const editable = (extra = {}) => ({
    sources: chainSource(extra.source),
    text: chainText,
    describe: extra.describe || (() => chain()),
    operations: () => withOperations,
    apply: extra.apply,
    editModel: extra.editModel || (() => chainModel())
  });

  it('offers an insert on every sequence edge, before the first step and after the last', async () => {
    await renderPane([], undefined, editable());

    expect(screen.getByTestId('flow-insert-before-a')).toBeInTheDocument();
    expect(screen.getByTestId('flow-insert-after-a')).toBeInTheDocument();
    expect(screen.getByTestId('flow-insert-after-b')).toBeInTheDocument();
    expect(screen.getByTestId('flow-insert-after-c')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-insert-first')).not.toBeInTheDocument();
  });

  /** §5.1: the step just added is selected, so the editor opens on it without a second click. */
  it('selects the inserted step by the id the engine reports', async () => {
    const { store } = await renderPane([], undefined, editable({ apply: () => ({ ok: true, text: 'edited\n', changed: true, inserted: ['create_thing'] }) }));

    fireEvent.click(screen.getByTestId('flow-insert-after-a'));
    const row = await screen.findByTestId('flow-operation-createThing');
    await act(async () => {
      fireEvent.click(row);
    });

    expect(store.getState().flows.selectedStep[pathname]).toBe('create_thing');
    expect(screen.getByTestId('flow-step-editor')).toHaveTextContent('create_thing');
  });

  /** B2.13: a new first step is spliced before the file's first, and the sequence does the rest. */
  it('inserts before the first step from the leading +', async () => {
    const { invoke } = await renderPane([], undefined, editable());

    fireEvent.click(screen.getByTestId('flow-insert-before-a'));
    const row = await screen.findByTestId('flow-operation-createThing');
    await act(async () => {
      fireEvent.click(row);
    });

    const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-apply-edit');
    expect(request.edits).toEqual([{ kind: 'step.insert', step: { operation: 'api#createThing' }, before: 'a' }]);
  });

  it('offers nothing while a run is open', async () => {
    const run = { runId: 'run-1', state: 'complete', status: 'passed', selectedIteration: 0, steps: {}, description: chain() };
    await renderPane([], run, editable());

    expect(screen.queryByTestId('flow-edit-layer')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/flow-insert-/)).not.toBeInTheDocument();
  });

  it('offers nothing while the draft does not parse', async () => {
    await renderPane([], undefined, editable({ source: { parses: false } }));

    expect(screen.queryByTestId('flow-edit-layer')).not.toBeInTheDocument();
  });

  /**
   * B2.6 — the graph waits for the engine. The renderer draws no node the engine has not described
   * (002-C R4): between the edit landing and the describe answering, the drawing holds.
   */
  it('B2.6 draws the inserted step only once the engine has described it', async () => {
    let answer;
    const describe = jest.fn(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const { store } = await renderPane([], undefined, { ...editable(), describe: (request) => (request.content === 'edited\n' ? describe() : chain()) });

    fireEvent.click(screen.getByTestId('flow-insert-after-a'));
    const row = await screen.findByTestId('flow-operation-createThing');
    await act(async () => {
      fireEvent.click(row);
    });

    expect(store.getState().flows.sources[pathname].content).toBe('edited\n');
    expect(screen.queryByTestId('flow-node-create_thing')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-node-a')).toBeInTheDocument();

    await act(async () => {
      answer({ ...chain(), nodes: [...chain().nodes, step('create_thing', 6, 3)] });
    });

    expect(screen.getByTestId('flow-node-create_thing')).toBeInTheDocument();
  });

  /** §5.1: the `+` opens the picker for its place; picking writes two lines through the engine. */
  it('inserts a picked operation after the step the + belongs to', async () => {
    const { invoke, store } = await renderPane([], undefined, editable());

    fireEvent.click(screen.getByTestId('flow-insert-after-a'));
    expect(await screen.findByTestId('flow-operation-createThing')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-operation-createThing'));
    });

    const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-apply-edit');
    expect(request).toMatchObject({
      entry: pathname,
      content: chainText,
      edits: [{ kind: 'step.insert', step: { operation: 'api#createThing' }, after: 'a' }]
    });
    expect(store.getState().flows.sources[pathname].content).toBe('edited\n');
    expect(screen.queryByTestId('flow-operation-picker')).not.toBeInTheDocument();
  });

  it('B2.11 lists the picker from the draft\'s bindings, and marks an ambiguous id unselectable', async () => {
    const { invoke } = await renderPane([], undefined, editable());

    fireEvent.click(screen.getByTestId('flow-insert-after-b'));
    await screen.findByTestId('flow-operation-api-api');

    const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-list-operations');
    expect(request).toMatchObject({ entry: pathname, content: chainText });
    expect(screen.getByTestId('flow-operation-ambiguous-GET /things/{id}')).toBeDisabled();
    expect(screen.getByTestId('flow-operation-createThing')).toBeEnabled();
  });

  it('says to bind an API first when the flow binds none', async () => {
    await renderPane([], undefined, { ...editable(), operations: () => ({ apis: [] }) });

    fireEvent.click(screen.getByTestId('flow-insert-after-a'));

    expect(await screen.findByTestId('flow-operation-picker-empty')).toHaveTextContent('add one on the legend');
  });

  /** §5.1: the rail's last entry is the libraries the flow can reach, and picking one writes a `uses:` step. */
  describe('B2.12 the libraries', () => {
    const library = { pathname: '/workspace/flows/shared/sign-in.flow.yml', filename: 'sign-in.flow.yml', name: 'Sign in', library: true, workspaceRoot: '/workspace' };
    const elsewhere = { pathname: '/elsewhere/login.flow.yml', filename: 'login.flow.yml', name: 'Login', library: true, workspaceRoot: '/elsewhere' };
    const plain = { pathname: '/workspace/flows/other.flow.yml', filename: 'other.flow.yml', workspaceRoot: '/workspace' };

    it('offers the reachable libraries, and inserts the picked one by its path', async () => {
      const { invoke } = await renderPane([], undefined, { ...editable(), flows: [entry, library, elsewhere, plain] });

      fireEvent.click(screen.getByTestId('flow-insert-after-a'));
      fireEvent.click(await screen.findByTestId('flow-operation-libraries'));

      expect(screen.getByTestId('flow-library-sign-in.flow.yml')).toHaveTextContent('Sign in');
      expect(screen.queryByTestId('flow-library-login.flow.yml')).not.toBeInTheDocument();
      expect(screen.queryByTestId('flow-library-other.flow.yml')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('flow-library-sign-in.flow.yml'));
      });

      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-apply-edit');
      expect(request.edits).toEqual([{ kind: 'step.insert', step: { uses: library.pathname }, after: 'a' }]);
    });

    it('offers them to a flow that binds no API', async () => {
      await renderPane([], undefined, { ...editable(), operations: () => ({ apis: [] }), flows: [entry, library] });

      fireEvent.click(screen.getByTestId('flow-insert-after-a'));

      expect(await screen.findByTestId('flow-library-sign-in.flow.yml')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-operation-picker-empty')).not.toBeInTheDocument();
    });

    it('does not offer one in place of an operation', async () => {
      await renderPane([], undefined, { ...editable(), flows: [entry, library] });
      fireEvent.click(screen.getByTestId('flow-node-b'));
      await screen.findByTestId('flow-step-field-id');

      fireEvent.click(screen.getByTestId('flow-step-pick-operation'));
      await screen.findByTestId('flow-operation-createThing');

      expect(screen.queryByTestId('flow-operation-libraries')).not.toBeInTheDocument();
    });
  });

  /** §5.1: an empty flow's one control, and an insert with no `after` lands at the end. */
  it('offers the first request on an empty flow, at the end', async () => {
    const emptyText = 'version: 1\n';
    const empty = () => ({ ...describedWith([]), apis: [{ alias: 'api' }] });
    const { invoke } = await renderPane([], undefined, {
      sources: { [pathname]: { content: emptyText, saved: emptyText, loading: false, saving: false, describedContent: emptyText, parses: true, description: empty(), diagnostics: [] } },
      text: emptyText,
      describe: empty,
      operations: () => withOperations
    });

    fireEvent.click(screen.getByTestId('flow-insert-first'));
    const row = await screen.findByTestId('flow-operation-createThing');
    await act(async () => {
      fireEvent.click(row);
    });

    const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-apply-edit');
    expect(request.edits).toEqual([{ kind: 'step.insert', step: { operation: 'api#createThing' } }]);
  });

  /** §5.2: the selected step carries the delete; removing it takes the selection with it. */
  it('removes the selected step, and clears the selection', async () => {
    const { invoke, store } = await renderPane([], undefined, editable());

    fireEvent.click(screen.getByTestId('flow-node-b'));
    expect(screen.getByTestId('flow-delete-b')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-delete-a')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-delete-b'));
    });

    const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-apply-edit');
    expect(request.edits).toEqual([{ kind: 'step.remove', id: 'b' }]);
    expect(store.getState().flows.selectedStep[pathname]).toBeNull();
  });

  it('removes the selected step on the Delete key, but not from inside a field', async () => {
    const { invoke } = await renderPane([], undefined, editable());
    fireEvent.click(screen.getByTestId('flow-node-c'));

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('flow-graph'), { key: 'Delete' });
    });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit')).toHaveLength(1);

    const input = document.createElement('input');
    screen.getByTestId('flow-graph-viewport').appendChild(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Delete' });
    });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit')).toHaveLength(1);
  });

  /** §6.3: a refusal is said in the engine's words and the document stands. */
  it('shows a refused edit and leaves the draft alone', async () => {
    const { store } = await renderPane([], undefined, editable({ apply: () => ({ ok: false, reason: 'no-such-step', message: 'there is no step called b' }) }));

    fireEvent.click(screen.getByTestId('flow-node-b'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-delete-b'));
    });

    expect(await screen.findByTestId('flow-step-refusal')).toHaveTextContent('there is no step called b');
    expect(store.getState().flows.sources[pathname].content).toBe(chainText);
    expect(screen.getByTestId('flow-designer-state')).toHaveTextContent('Saved');
  });

  it('shows a refusal on the toolbar when no step is selected', async () => {
    await renderPane([], undefined, editable({ apply: () => ({ ok: false, reason: 'no-such-api', message: 'nothing is bound as api' }) }));

    fireEvent.click(screen.getByTestId('flow-insert-after-a'));
    const row = await screen.findByTestId('flow-operation-createThing');
    await act(async () => {
      fireEvent.click(row);
    });

    expect(screen.getByTestId('flow-designer-refusal')).toHaveTextContent('nothing is bound as api');
  });

  /** §7.3: ⌘Z is the structured history, and only outside a field. */
  it('undoes and redoes a structured edit on ⌘Z and ⌘⇧Z', async () => {
    const { store } = await renderPane([], undefined, editable());
    fireEvent.click(screen.getByTestId('flow-node-b'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-delete-b'));
    });
    expect(store.getState().flows.sources[pathname].content).toBe('edited\n');

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('flow-graph'), { key: 'z', metaKey: true });
    });
    expect(store.getState().flows.sources[pathname].content).toBe(chainText);

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('flow-graph'), { key: 'z', metaKey: true, shiftKey: true });
    });
    expect(store.getState().flows.sources[pathname].content).toBe('edited\n');

    const input = document.createElement('input');
    screen.getByTestId('flow-graph-viewport').appendChild(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'z', metaKey: true });
    });
    expect(store.getState().flows.sources[pathname].content).toBe('edited\n');
  });

  /**
   * 005 §6 — the step editor. Rendered from the engine's model, writing through the engine, one
   * edit per committed field.
   */
  describe('the step editor (005 §6)', () => {
    const openEditor = async (options = {}) => {
      const rendered = await renderPane([], undefined, editable(options));
      fireEvent.click(screen.getByTestId('flow-node-b'));
      await screen.findByTestId('flow-step-field-id');
      return rendered;
    };
    const applied = (invoke) => invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit').map(([, request]) => request.edits);

    it('offers the tabs the step can carry', async () => {
      await openEditor();

      expect(['overview', 'scripts', 'request', 'flow', 'outputs', 'assert', 'settings'].map((name) => screen.getByTestId(`flow-step-editor-tab-${name}`))).toHaveLength(7);
    });

    /** B4.7 — a `uses:` step sends nothing and asserts nothing of its own (001 §12.4). */
    it('B4.7 offers a uses: step neither a request nor assertions', async () => {
      await renderPane([], undefined, editable({
        editModel: () => ({ ...chainModel(), steps: [modelStep('a'), { ...modelStep('b'), fields: { id: 'b', uses: './login.flow.yml' } }, modelStep('c')] })
      }));
      fireEvent.click(screen.getByTestId('flow-node-b'));
      await screen.findByTestId('flow-step-field-id');

      expect(screen.getByTestId('flow-step-field-uses')).toHaveValue('./login.flow.yml');
      expect(screen.queryByTestId('flow-step-editor-tab-request')).not.toBeInTheDocument();
      expect(screen.queryByTestId('flow-step-editor-tab-assert')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-step-editor-tab-flow')).toBeInTheDocument();
    });

    /** B4.5 — a rename says what it dangled, from the engine's anchored diagnostics. */
    it('B4.5 counts the references a rename left dangling', async () => {
      const dangling = { severity: 'error', code: 'unknown-step-reference', message: 'c.when references steps.b.status, which is not a step', line: 5 };
      const { store } = await renderPane([], undefined, editable({
        apply: () => ({ ok: true, text: 'renamed\n', changed: true }),
        describe: (request) => (request.content === 'renamed\n' ? { ...chain(), diagnostics: [dangling] } : chain())
      }));
      fireEvent.click(screen.getByTestId('flow-node-b'));
      await screen.findByTestId('flow-step-field-id');

      fireEvent.change(screen.getByTestId('flow-step-field-id'), { target: { value: 'fetch' } });
      await act(async () => {
        fireEvent.blur(screen.getByTestId('flow-step-field-id'));
      });

      expect(store.getState().flows.selectedStep[pathname]).toBe('fetch');
      expect(await screen.findByTestId('flow-step-dangled')).toHaveTextContent('1 reference to the old name, b');
    });

    it('opens on the selected step, from the model of the draft', async () => {
      const { invoke } = await openEditor();

      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-read-edit-model');
      expect(request).toMatchObject({ entry: pathname, content: chainText });
      expect(screen.getByTestId('flow-step-editor')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-step-detail')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-step-field-id')).toHaveValue('b');
      expect(screen.getByTestId('flow-step-field-name')).toHaveValue('Second');
      expect(screen.getByTestId('flow-step-field-operation')).toHaveTextContent('api#op');
    });

    /** §6.4: the keys the editor will not touch, each with a way to the YAML at its line. */
    it('names the opaque keys and opens the YAML at one', async () => {
      const { store } = await openEditor();

      expect(screen.getByTestId('flow-step-opaque-body')).toHaveTextContent('!file');
      expect(screen.getByTestId('flow-step-opaque-retryPolicy')).toHaveTextContent('not a key this version edits');

      fireEvent.click(screen.getByTestId('flow-step-open-yaml-body'));

      expect(store.getState().flows.documentAnchors[pathname]).toMatchObject({ line: 9, column: 5 });
      expect(store.getState().tabs.tabs.map((entry) => entry.type)).toContain('flow-yaml');
    });

    /** §6.3: a field commits on blur, and on a pause; §5.1: the id follows the rename. */
    it('renames on blur, and the selection follows', async () => {
      const { invoke, store } = await openEditor();

      fireEvent.change(screen.getByTestId('flow-step-field-id'), { target: { value: 'fetch' } });
      expect(applied(invoke)).toEqual([]);
      await act(async () => {
        fireEvent.blur(screen.getByTestId('flow-step-field-id'));
      });

      expect(applied(invoke)).toEqual([[{ kind: 'step.rename', id: 'b', to: 'fetch' }]]);
      expect(store.getState().flows.selectedStep[pathname]).toBe('fetch');
    });

    it('patches a field after a pause in typing, and unsets one cleared', async () => {
      jest.useFakeTimers();
      try {
        const { invoke } = await openEditor();

        fireEvent.change(screen.getByTestId('flow-step-field-name'), { target: { value: 'Second step' } });
        await act(async () => {
          jest.advanceTimersByTime(500);
        });
        expect(applied(invoke)).toEqual([[{ kind: 'step.patch', id: 'b', patch: { set: { name: 'Second step' } } }]]);

        fireEvent.change(screen.getByTestId('flow-step-field-name'), { target: { value: '' } });
        await act(async () => {
          fireEvent.keyDown(screen.getByTestId('flow-step-field-name'), { key: 'Enter' });
        });
        expect(applied(invoke)[1]).toEqual([{ kind: 'step.patch', id: 'b', patch: { unset: ['name'] } }]);
      } finally {
        jest.useRealTimers();
      }
    });

    /** §6.2: the operation is looked up, not typed; changing it leaves the id alone. */
    it('B4.8 changes the operation through the picker without renaming the step', async () => {
      const { invoke } = await openEditor();

      fireEvent.click(screen.getByTestId('flow-step-pick-operation'));
      const row = await screen.findByTestId('flow-operation-createThing');
      await act(async () => {
        fireEvent.click(row);
      });

      expect(applied(invoke)).toEqual([[{ kind: 'step.patch', id: 'b', patch: { set: { operation: 'api#createThing' } } }]]);
    });
  });
});

/**
 * 005 §5.4 — a connector dragged between two steps writes a dependency; a declared edge's control
 * removes one. The pair the sequence already joins offers no drop.
 */
describe('connecting steps (005 §5.4)', () => {
  const chainText = 'version: 1\nsteps:\n  - id: a\n  - id: b\n  - id: c\n    depends: [a]\n';
  const step = (id, line, rank) => ({ id, kind: 'operation', operation: { api: 'api', method: 'GET', path: '/x' }, rank, outputs: [], pre: [], markers: {}, position: { line, column: 5 } });
  const described = () => ({
    ...describedWith([]),
    apis: [{ alias: 'api' }],
    nodes: [step('a', 3, 0), step('b', 4, 1), step('c', 5, 1)],
    edges: [
      { from: 'a', to: 'b', kind: 'sequence' },
      { from: 'a', to: 'c', kind: 'depends' }
    ]
  });
  const modelStep = (id, fields = {}) => ({ id, fields: { id, operation: 'api#op', ...fields }, opaque: [], position: { line: 3, column: 5 }, keyPositions: {} });
  const options = (apply) => ({
    sources: { [pathname]: { content: chainText, saved: chainText, loading: false, saving: false, describedContent: chainText, parses: true, description: described(), diagnostics: [] } },
    text: chainText,
    describe: described,
    editModel: () => ({ steps: [modelStep('a'), modelStep('b'), modelStep('c', { depends: ['a'] })], apis: [], authProfiles: [], vocabulary: {} }),
    apply
  });
  const applied = (invoke) => invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit').map(([, request]) => request.edits);

  const dragPort = async (from, to) => {
    const target = to ? screen.getByTestId(`flow-port-in-${to}`) : null;
    document.elementFromPoint = () => target;
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId(`flow-port-out-${from}`), { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(screen.getByTestId(`flow-port-out-${from}`), { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(screen.getByTestId(`flow-port-out-${from}`), { clientX: 10, clientY: 10, pointerId: 1 });
    });
    delete document.elementFromPoint;
  };

  it('draws a port on each side of every step while editable', async () => {
    await renderPane([], undefined, options());

    for (const id of ['a', 'b', 'c']) {
      expect(screen.getByTestId(`flow-port-in-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`flow-port-out-${id}`)).toBeInTheDocument();
    }
  });

  it('writes the source into the target\'s depends, in the form the target uses', async () => {
    const { invoke } = await renderPane([], undefined, options());
    await screen.findByTestId('flow-port-out-b');

    await dragPort('b', 'c');

    expect(applied(invoke)).toEqual([[{ kind: 'step.patch', id: 'c', patch: { set: { depends: ['a', 'b'] } } }]]);
  });

  it('gives a step with no depends an explicit one', async () => {
    const { invoke } = await renderPane([], undefined, options());
    await screen.findByTestId('flow-port-out-c');

    await dragPort('c', 'b');

    expect(applied(invoke)).toEqual([[{ kind: 'step.patch', id: 'b', patch: { set: { depends: ['c'] } } }]]);
  });

  it('offers no drop on a pair the sequence already joins, nor on the step itself', async () => {
    const { invoke } = await renderPane([], undefined, options());
    await screen.findByTestId('flow-port-out-a');

    await dragPort('a', 'b');
    await dragPort('a', 'a');
    await dragPort('a', undefined);

    expect(applied(invoke)).toEqual([]);
  });

  it('removes a declared dependency from the edge, back to the sequence', async () => {
    const { invoke } = await renderPane([], undefined, options());

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-edge-remove-a-c'));
    });

    expect(applied(invoke)).toEqual([[{ kind: 'step.patch', id: 'c', patch: { unset: ['depends'] } }]]);
    expect(screen.queryByTestId('flow-edge-remove-a-b')).not.toBeInTheDocument();
  });
});

/**
 * 005 §5.5 — the legend is where a flow's APIs are managed. Editable, it lists what the file
 * declares; read-only, only what the drawing uses.
 */
describe('the API legend (005 §5.5)', () => {
  const chainText = 'version: 1\napis:\n  api: ./api.yml\n  spare: ./spare.yml\nsteps:\n  - id: a\n';
  const node = { id: 'a', kind: 'operation', operation: { api: 'api', method: 'GET', path: '/x' }, rank: 0, outputs: [], pre: [], markers: {}, position: { line: 6, column: 5 } };
  const described = () => ({ ...describedWith([]), apis: [{ alias: 'api' }, { alias: 'spare' }], nodes: [node], edges: [] });
  const withSource = (extra = {}) => ({
    sources: {
      [pathname]: { content: chainText, saved: chainText, loading: false, saving: false, describedContent: chainText, parses: true, description: described(), diagnostics: [], ...extra }
    },
    text: chainText,
    describe: described,
    editModel: () => ({ steps: [], apis: [{ alias: 'api', source: './api.yml', opaque: [] }, { alias: 'spare', source: './spare.yml', color: '#123456', opaque: [] }], authProfiles: ['service'], vocabulary: {} })
  });
  const applied = (invoke) => invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit').map(([, request]) => request.edits);

  it('lists only the bindings the drawing uses while a run is open', async () => {
    const run = { runId: 'run-1', state: 'complete', status: 'passed', selectedIteration: 0, steps: {}, description: described() };
    await renderPane([], run, withSource());

    expect(screen.getByTestId('flow-legend')).toHaveTextContent('api');
    expect(screen.getByTestId('flow-legend')).not.toHaveTextContent('spare');
    expect(screen.queryByTestId('flow-legend-add')).not.toBeInTheDocument();
  });

  it('lists every declared binding while editable, with a way to add one', async () => {
    await renderPane([], undefined, withSource());

    expect(screen.getByTestId('flow-legend-menu-api')).toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-menu-spare')).toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-add')).toBeInTheDocument();
  });

  it('adds a binding from the workspace\'s documents, sending the path as the renderer knows it', async () => {
    const { invoke } = await renderPane([], undefined, withSource());

    fireEvent.click(screen.getByTestId('flow-legend-add'));
    fireEvent.change(screen.getByTestId('flow-api-source'), { target: { value: 'spec-1' } });
    expect(screen.getByTestId('flow-api-alias')).toHaveValue('orders-v1');

    fireEvent.change(screen.getByTestId('flow-api-color'), { target: { value: '#8ab4f8' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-api-dialog-submit-btn'));
    });

    expect(applied(invoke)).toEqual([[{ kind: 'api.add', binding: { alias: 'orders-v1', source: '/workspace/apispec/orders-v1.yml', color: '#8ab4f8' } }]]);
  });

  it('refuses an alias another binding already uses', async () => {
    await renderPane([], undefined, withSource());

    fireEvent.click(screen.getByTestId('flow-legend-add'));
    fireEvent.change(screen.getByTestId('flow-api-source'), { target: { value: 'spec-1' } });
    fireEvent.change(screen.getByTestId('flow-api-alias'), { target: { value: 'spare' } });

    expect(screen.getByText('Another binding already uses this alias')).toBeInTheDocument();
    expect(screen.getByTestId('flow-api-dialog-submit-btn')).toBeDisabled();
  });

  it('edits a binding, keeping the source the file wrote', async () => {
    const { invoke } = await renderPane([], undefined, withSource());

    fireEvent.click(screen.getByTestId('flow-legend-menu-spare'));
    fireEvent.click(await screen.findByTestId('flow-legend-spare-edit'));
    expect(screen.getByTestId('flow-api-color')).toHaveValue('#123456');

    fireEvent.change(screen.getByTestId('flow-api-auth'), { target: { value: 'service' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-api-dialog-submit-btn'));
    });

    expect(applied(invoke)).toEqual([[{ kind: 'api.update', alias: 'spare', binding: { alias: 'spare', source: './spare.yml', auth: 'service', color: '#123456' } }]]);
  });

  /**
   * B2.14 — `api.update` replaces the binding with what the dialog hands it (§9.1), so a field the
   * form does not draw is a field an edit to the colour would delete. The two it still does not draw
   * ride through untouched; the ones it now does are written.
   */
  it('carries a binding\'s unedited fields, and writes the ones it draws', async () => {
    const carried = {
      alias: 'spare',
      source: './spare.yml',
      color: '#123456',
      rateLimit: { requests: 100, per: 'minute' },
      defaultHeaders: { 'X-Tenant': 'acme' },
      opaque: []
    };
    const { invoke } = await renderPane([], undefined, {
      ...withSource(),
      editModel: () => ({
        steps: [],
        apis: [{ alias: 'api', source: './api.yml', opaque: [] }, carried],
        authProfiles: ['service'],
        config: {},
        vocabulary: {}
      })
    });

    fireEvent.click(screen.getByTestId('flow-legend-menu-spare'));
    fireEvent.click(await screen.findByTestId('flow-legend-spare-edit'));

    // The rate the file wrote is in the form, not lost in a field the form never had.
    expect(screen.getByTestId('flow-api-rate-requests')).toHaveValue(100);
    expect(screen.getByTestId('flow-api-rate-per')).toHaveValue('minute');

    fireEvent.change(screen.getByTestId('flow-api-strictNulls'), { target: { value: 'off' } });
    fireEvent.change(screen.getByTestId('flow-api-baseUrl'), { target: { value: 'https://qa.example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-api-dialog-submit-btn'));
    });

    expect(applied(invoke)).toEqual([[{
      kind: 'api.update',
      alias: 'spare',
      binding: {
        alias: 'spare',
        source: './spare.yml',
        baseUrl: 'https://qa.example.com',
        color: '#123456',
        rateLimit: { requests: 100, per: 'minute' },
        defaultHeaders: { 'X-Tenant': 'acme' },
        strictNulls: false
      }
    }]]);
  });

  it('removes a binding through the engine, and shows its refusal', async () => {
    const { invoke } = await renderPane([], undefined, {
      ...withSource(),
      apply: () => ({ ok: false, reason: 'api-in-use', message: 'api is called by a', steps: ['a'] })
    });

    fireEvent.click(screen.getByTestId('flow-legend-menu-api'));
    const remove = await screen.findByTestId('flow-legend-api-remove');
    await act(async () => {
      fireEvent.click(remove);
    });

    expect(applied(invoke)).toEqual([[{ kind: 'api.remove', alias: 'api' }]]);
    expect(screen.getByTestId('flow-designer-refusal')).toHaveTextContent('api is called by a');
  });
});

/**
 * B2.15 — the pane over 001 §5.2's `config:`, and the gesture that opens it.
 *
 * The sheet below the graph is the selected step's; with nothing selected it was empty, and the
 * flow's own defaults — the value every one of the step editor's *inherit* states points at — were
 * reachable only by opening the YAML.
 */
describe('the flow\'s own settings (005 §6.8)', () => {
  const chainText = 'version: 1\nsteps:\n  - id: a\n';
  const node = { id: 'a', kind: 'operation', operation: { api: 'api', method: 'GET', path: '/x' }, rank: 0, outputs: [], pre: [], markers: {}, position: { line: 3, column: 5 } };
  const described = () => ({ ...describedWith([]), apis: [{ alias: 'api' }], nodes: [node], edges: [] });
  const withConfig = (config = {}) => ({
    sources: {
      [pathname]: { content: chainText, saved: chainText, loading: false, saving: false, describedContent: chainText, parses: true, description: described(), diagnostics: [] }
    },
    text: chainText,
    describe: described,
    editModel: () => ({
      steps: [{ id: 'a', fields: { id: 'a', operation: 'api#op' }, opaque: [], position: { line: 3, column: 5 }, keyPositions: {} }],
      apis: [{ alias: 'api', source: './api.yml', opaque: [] }],
      authProfiles: [],
      config,
      vocabulary: { operators: [], statuses: [], authModes: [], backoff: [], jitter: [], stepKeys: ['id'], configKeys: ['baseUrl', 'validateSchema', 'concurrency'] }
    })
  });
  const applied = (invoke) => invoke.mock.calls.filter(([channel]) => channel === 'renderer:flow-apply-edit').map(([, request]) => request.edits);

  it('fills the sheet while no step is selected', async () => {
    await renderPane([], undefined, withConfig());

    expect(screen.getByTestId('flow-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-step-editor')).not.toBeInTheDocument();
  });

  it('reads an unwritten flag as the format\'s default, not as off', async () => {
    await renderPane([], undefined, withConfig());

    expect(screen.getByTestId('flow-config-flag-validateSchema')).toHaveValue('default');
    expect(screen.getByTestId('flow-config-flag-validateSchema')).toHaveTextContent('default — on');
    // `strictSchema` defaults the other way, and says so rather than saying "default".
    expect(screen.getByTestId('flow-config-flag-strictSchema')).toHaveTextContent('default — off');
  });

  it('writes a flag the flow does not declare', async () => {
    const { invoke } = await renderPane([], undefined, withConfig());

    await act(async () => {
      fireEvent.change(screen.getByTestId('flow-config-flag-validateSchema'), { target: { value: 'off' } });
    });

    expect(applied(invoke)).toEqual([[{ kind: 'config.patch', patch: { set: { validateSchema: false } } }]]);
  });

  it('deletes the key rather than writing the default out', async () => {
    const { invoke } = await renderPane([], undefined, withConfig({ validateSchema: false }));

    expect(screen.getByTestId('flow-config-flag-validateSchema')).toHaveValue('off');
    await act(async () => {
      fireEvent.change(screen.getByTestId('flow-config-flag-validateSchema'), { target: { value: 'default' } });
    });

    expect(applied(invoke)).toEqual([[{ kind: 'config.patch', patch: { unset: ['validateSchema'] } }]]);
  });

  it('writes a run setting on blur, and unsets one cleared', async () => {
    const { invoke } = await renderPane([], undefined, withConfig({ concurrency: 4 }));

    fireEvent.click(screen.getByTestId('flow-settings-tab-runs'));
    const field = screen.getByTestId('flow-config-concurrency');
    expect(field).toHaveValue('4');

    fireEvent.change(field, { target: { value: '2' } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(applied(invoke)).toEqual([[{ kind: 'config.patch', patch: { set: { concurrency: 2 } } }]]);

    // §5.2 writes a default as an absence, so a field emptied removes the key rather than
    // spelling `5` out — which is the whole reason `config.patch` has an `unset` beside its `set`.
    fireEvent.change(field, { target: { value: '' } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(applied(invoke)).toContainEqual([{ kind: 'config.patch', patch: { unset: ['concurrency'] } }]);
  });

  /** §5.2's flow-wide predicate, inherited by every step that declares none — and a script. */
  it('edits the flow-wide retry predicate in a script editor', async () => {
    const { invoke } = await renderPane([], undefined, withConfig({ retry: { maxAttempts: 3, shouldRetry: '(res) => res.status === 429' } }));

    fireEvent.click(screen.getByTestId('flow-settings-tab-runs'));
    const editor = screen.getByTestId('code-editor');
    expect(editor).toHaveValue('(res) => res.status === 429');

    fireEvent.change(editor, { target: { value: '(res) => res.status >= 500' } });
    await act(async () => {
      fireEvent.blur(screen.getByTestId('flow-config-retry-shouldRetry'));
    });

    expect(applied(invoke)).toContainEqual([
      { kind: 'config.patch', patch: { set: { retry: { maxAttempts: 3, shouldRetry: '(res) => res.status >= 500' } } } }
    ]);
  });

  it('rewrites the retry map around the one field it edits', async () => {
    const { invoke } = await renderPane([], undefined, withConfig({ retry: { maxAttempts: 3, delay: 1000 } }));

    fireEvent.click(screen.getByTestId('flow-settings-tab-runs'));
    const field = screen.getByTestId('flow-config-retry-delay');
    fireEvent.change(field, { target: { value: '2000' } });
    await act(async () => {
      fireEvent.blur(field);
    });

    expect(applied(invoke)).toEqual([[{ kind: 'config.patch', patch: { set: { retry: { maxAttempts: 3, delay: 2000 } } } }]]);
  });

  it('opens from the drawing\'s background, which is what clearing the selection is for', async () => {
    const { store } = await renderPane([], undefined, withConfig());

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-node-a'));
    });
    expect(store.getState().flows.selectedStep[pathname]).toBe('a');
    expect(screen.getByTestId('flow-step-editor')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-graph'));
    });

    expect(store.getState().flows.selectedStep[pathname]).toBe(null);
    expect(screen.getByTestId('flow-settings')).toBeInTheDocument();
  });

  it('opens from Escape as well, since the background is a gesture nothing announces', async () => {
    const { store } = await renderPane([], undefined, withConfig());

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-node-a'));
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('flow-graph'), { key: 'Escape' });
    });

    expect(store.getState().flows.selectedStep[pathname]).toBe(null);
    expect(screen.getByTestId('flow-settings')).toBeInTheDocument();
  });
});
