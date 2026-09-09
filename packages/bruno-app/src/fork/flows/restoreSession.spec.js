// `jest.setup.js` stubs nanoid with only `nanoid`, and `uuid()` reaches for `customAlphabet` — so a
// restored tab cannot be opened in a test without this.
let mockUid = 0;
jest.mock('utils/common', () => ({
  ...jest.requireActual('utils/common'),
  uuid: () => `uid-${++mockUid}`
}));

import flowsReducer, { configurationChanged } from './slice';
import { restoreForkWorkspaceTabs, serializeForkSnapshot } from 'fork/registry';
import { restoreFlowConfiguration, restoreFlowTabs } from './restoreSession';

/**
 * 002 §7.2 — *configuration is per flow and remembered across app restarts through the existing
 * snapshot middleware* — and §4.2's tabs, which reopen through the ordinary tab-restore path.
 *
 * Asserted as a **round trip** rather than as two halves: a serializer and a hydrator that agree with
 * their own specs and not with each other is precisely the failure that only shows up on somebody's
 * next launch.
 */

const workspaceFlow = {
  pathname: '/w/flows/checkout.flow.yml',
  filename: 'checkout.flow.yml',
  workspaceRoot: '/w'
};

const collectionFlow = {
  pathname: '/w/payments/flows/refund.flow.yml',
  filename: 'refund.flow.yml',
  workspaceRoot: '/w',
  collectionRoot: '/w/payments'
};

const flowsState = (actions) =>
  actions.reduce((state, action) => flowsReducer(state, action), flowsReducer(undefined, { type: '@@INIT' }));

const snapshotOf = ({ configurations = [], tabs = [], flows = [workspaceFlow, collectionFlow] }) => ({
  extras: {
    flows: serializeForkSnapshot(
      {
        flows: { ...flowsState(configurations.map((entry) => configurationChanged(entry))), flows },
        tabs: { tabs }
      },
      null
    )
  }
});

const dispatched = (thunk, state) => {
  const dispatch = jest.fn();
  thunk(dispatch, () => state);
  return dispatch.mock.calls.map(([action]) => action);
};

describe('the run configuration across a restart', () => {
  it('comes back for the flow it was set on', () => {
    const snapshot = snapshotOf({
      configurations: [{ pathname: workspaceFlow.pathname, configuration: { concurrency: 4, dataset: './rows.csv' } }]
    });

    const restored = flowsReducer(
      undefined,
      dispatched(restoreFlowConfiguration(snapshot), {})[0]
    );

    expect(restored.configurations[workspaceFlow.pathname]).toEqual({ concurrency: 4, dataset: './rows.csv' });
  });

  /**
   * A library flow's params hold a password and an `--env-var` override is the app's equivalent of
   * typing one on a command line. The snapshot is a plaintext file under `userData`, and Bruno keeps
   * everything that can hold a secret in the `secrets` store instead.
   */
  it('writes neither the params nor the variable overrides', () => {
    const snapshot = snapshotOf({
      configurations: [
        {
          pathname: workspaceFlow.pathname,
          configuration: {
            concurrency: 2,
            params: { password: 'hunter2' },
            variableOverrides: [{ name: 'token', value: 'sk-live-1' }]
          }
        }
      ]
    });

    expect(snapshot.extras.flows.configurations[workspaceFlow.pathname]).toEqual({ concurrency: 2 });
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
    expect(JSON.stringify(snapshot)).not.toContain('sk-live-1');
  });

  /** The store holds only the scopes this session opened; the file holds every flow ever configured. */
  it('keeps the settings of a flow this session never opened', () => {
    const existing = { extras: { flows: { configurations: { '/other/flows/a.flow.yml': { concurrency: 9 } } } } };
    const section = serializeForkSnapshot({ flows: flowsState([]), tabs: { tabs: [] } }, existing);

    expect(section.configurations['/other/flows/a.flow.yml']).toEqual({ concurrency: 9 });
  });

  /** What is on screen wins: this arrives asynchronously, after the reader may have typed. */
  it('does not overwrite a configuration set since the app started', () => {
    const snapshot = snapshotOf({
      configurations: [{ pathname: workspaceFlow.pathname, configuration: { concurrency: 4 } }]
    });
    const typed = flowsReducer(
      undefined,
      configurationChanged({ pathname: workspaceFlow.pathname, configuration: { concurrency: 1 } })
    );

    const restored = flowsReducer(typed, dispatched(restoreFlowConfiguration(snapshot), {})[0]);

    expect(restored.configurations[workspaceFlow.pathname]).toEqual({ concurrency: 1 });
  });
});

describe('a flow tab across a restart', () => {
  const workspaces = [{ uid: 'ws', pathname: '/w', scratchCollectionUid: 'scratch' }];
  const collections = [{ uid: 'payments', pathname: '/w/payments' }];

  const openTabs = [
    { uid: 't1', type: 'flow', pathname: workspaceFlow.pathname, collectionUid: 'scratch' },
    { uid: 't2', type: 'flow-yaml', pathname: workspaceFlow.pathname, collectionUid: 'scratch' },
    { uid: 't3', type: 'flow', pathname: collectionFlow.pathname, collectionUid: 'payments' },
    { uid: 't4', type: 'http-request', pathname: '/w/payments/refund.bru', collectionUid: 'payments' }
  ];

  /**
   * §4.2's borrowed collection is the workspace's scratch one, which upstream's serializer skips
   * entirely — so without this the tab of every workspace-scoped flow is gone after a restart.
   */
  it('records the workspace-scoped ones, and only those', () => {
    const { tabs } = snapshotOf({ tabs: openTabs }).extras.flows;

    expect(tabs).toEqual([
      { pathname: workspaceFlow.pathname, type: 'flow', workspaceRoot: '/w' },
      { pathname: workspaceFlow.pathname, type: 'flow-yaml', workspaceRoot: '/w' }
    ]);
  });

  it('reopens them into the collection the workspace lends a flow', () => {
    const snapshot = snapshotOf({ tabs: openTabs });

    const actions = dispatched(restoreFlowTabs(snapshot), {
      flows: flowsState([]),
      collections: { collections },
      workspaces: { workspaces }
    });

    expect(actions.filter((action) => action.type === 'tabs/addTab').map(({ payload }) => ({
      type: payload.type,
      pathname: payload.pathname,
      collectionUid: payload.collectionUid,
      preview: payload.preview
    }))).toEqual([
      { type: 'flow', pathname: workspaceFlow.pathname, collectionUid: 'scratch', preview: false },
      { type: 'flow-yaml', pathname: workspaceFlow.pathname, collectionUid: 'scratch', preview: false }
    ]);
  });

  /**
   * The scratch collection is mounted by the workspace-switch path, which runs alongside the watcher
   * rather than before it — so an attempt that cannot resolve it must leave the scope open to a later
   * one rather than marking it done.
   */
  it('leaves a workspace whose collection is not mounted yet for the next attempt', () => {
    const snapshot = snapshotOf({ tabs: openTabs });
    const before = flowsState([]);

    const actions = dispatched(restoreFlowTabs(snapshot), {
      flows: before,
      collections: { collections: [] },
      workspaces: { workspaces: [] }
    });

    expect(actions).toEqual([]);
    expect(before.restoredTabScopes).toEqual([]);
  });

  /**
   * §4.2's restore has a **known point**: `switchWorkspace` mounts the workspace's scratch collection,
   * hydrates its tabs, and then calls this. Before it, the restore hung off watching a flow scope —
   * which runs alongside the switch rather than after it, so whether a tab came back on the first pass
   * or on a later one depended on which of two unordered paths finished first.
   */
  describe('the hook the workspace switch calls (§4.2)', () => {
    const mounted = {
      flows: flowsState([]),
      collections: { collections },
      workspaces: { workspaces }
    };

    const run = async (thunk, state) => {
      const actions = [];
      const dispatch = (action) =>
        (typeof action === 'function' ? action(dispatch, () => state) : actions.push(action));
      await thunk(dispatch, () => state);
      return actions;
    };

    it('restores every workspace-scoped tab on the pass that follows the mount', async () => {
      const actions = await run(restoreForkWorkspaceTabs(snapshotOf({ tabs: openTabs })), mounted);

      expect(actions.filter((action) => action.type === 'tabs/addTab').map(({ payload }) => payload.type)).toEqual([
        'flow',
        'flow-yaml'
      ]);
      expect(actions.some((action) => action.type === 'flows/flowTabsRestored')).toBe(true);
    });

    /** The switch has already read the snapshot; a second read is a second answer to one question. */
    it('reads the snapshot it was handed rather than the file again', async () => {
      const invoke = jest.fn();
      window.ipcRenderer = { invoke };

      await run(restoreForkWorkspaceTabs(snapshotOf({ tabs: openTabs })), mounted);

      expect(invoke).not.toHaveBeenCalled();
    });

    /**
     * Called before the mount there is no collection to reopen a tab into — which is the state the
     * scope watcher's retry still covers, and the reason the hook sits after the scratch collection
     * rather than at the top of the switch.
     */
    it('restores nothing, and marks nothing, before the scratch collection is mounted', async () => {
      const actions = await run(restoreForkWorkspaceTabs(snapshotOf({ tabs: openTabs })), {
        ...mounted,
        workspaces: { workspaces: [{ uid: 'ws', pathname: '/w' }] }
      });

      expect(actions).toEqual([]);
    });

    /** A first launch, and a snapshot the user has reset: there is simply nothing to restore. */
    it('restores nothing when there is no snapshot', async () => {
      expect(await run(restoreForkWorkspaceTabs(null), mounted)).toEqual([]);
    });
  });

  /** Reopening a tab the reader has since closed is the failure the mark exists to prevent. */
  it('reopens a workspace only once', () => {
    const snapshot = snapshotOf({ tabs: openTabs });
    const state = {
      flows: flowsState([]),
      collections: { collections },
      workspaces: { workspaces }
    };

    const first = dispatched(restoreFlowTabs(snapshot), state);
    const marked = first.find((action) => action.type === 'flows/flowTabsRestored');
    const after = { ...state, flows: flowsReducer(state.flows, marked) };

    expect(dispatched(restoreFlowTabs(snapshot), after)).toEqual([]);
  });
});
