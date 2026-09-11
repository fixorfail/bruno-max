import React, { Suspense, lazy } from 'react';
import flowsReducer from './flows/slice';
import { registerFlowIpcEvents } from './flows/ipcEvents';
import { serializeFlowsSnapshot } from './snapshot';
import { FORK_TAB_TYPES, isForkTab } from './tabTypes';

/**
 * The single delegation surface upstream files call into — 001 §13.3.
 *
 * Every upstream touchpoint is one line calling something here, so a second fork feature registers
 * beside the first and costs **zero** new upstream edits. That is the whole justification for the
 * indirection: the cost is paid once and the saving recurs at every merge from upstream. The
 * manifest of what those lines are is 001 §13.4 plus 002 §12.1, and 002-C R5 re-checks it.
 *
 * **The components are loaded lazily, and that is structural rather than a performance choice.**
 * This module is imported by `providers/ReduxStore/index.js` for its reducers, and fork components
 * legitimately import upstream ones — `StepDetail` uses `components/CodeEditor`, which reaches the
 * store. Importing them eagerly here closes that loop: the store's module would be entered while
 * this one was still evaluating, `forkReducers` would read as `undefined`, and `{...undefined}` is
 * *legal* — so the app would build a store with no `flows` reducer and fail later, somewhere else.
 * Deferring the component graph keeps this module's own imports free of anything upstream.
 */

const withSuspense = (Component) => (props) => (
  <Suspense fallback={null}>
    <Component {...props} />
  </Suspense>
);

const FlowSidebarSection = withSuspense(lazy(() => import('./flows/FlowSidebarSection')));
const FlowTabPane = withSuspense(lazy(() => import('./flows/FlowTabPane')));
const FlowTabLabel = withSuspense(lazy(() => import('./flows/FlowTabLabel')));
const FlowTabHeader = withSuspense(lazy(() => import('./flows/FlowTabHeader')));
const FlowYamlTabPane = withSuspense(lazy(() => import('./flows/FlowYamlTabPane')));
const FlowYamlTabLabel = withSuspense(lazy(() => import('./flows/FlowYamlTabLabel')));
const FlowSourceTabPane = withSuspense(lazy(() => import('./flows/FlowSourceTabPane')));
const FlowScriptTabLabel = withSuspense(lazy(() => import('./flows/FlowScriptTabLabel')));
const FlowFixtureTabLabel = withSuspense(lazy(() => import('./flows/FlowFixtureTabLabel')));
const FlowConnectorsTabLabel = withSuspense(lazy(() => import('./flows/FlowConnectorsTabLabel')));
const FlowSpecialTab = withSuspense(lazy(() => import('./flows/ForkSpecialTab')));

export const forkReducers = {
  flows: flowsReducer
};

/**
 * The DevTools network tab's list, collection timelines and flow requests merged — 002 §8.5. Both
 * halves of the panel select through this, so neither has to know which sources exist.
 */
export { selectDevtoolsRequests } from './flows/networkRequests';

export const forkSidebarSections = [{ id: 'flows', component: FlowSidebarSection }];

export { isForkTab } from './tabTypes';
export { tabsSharingStripWith } from './tabGroup';

export const ForkTabPane = ({ tab }) => {
  if (tab.type === 'flow') {
    return <FlowTabPane tab={tab} />;
  }
  if (tab.type === 'flow-yaml') {
    return <FlowYamlTabPane tab={tab} />;
  }
  // §4.5's script, §4.6's fixture and §8.5's connector file are one pane: each edits a plain file
  // with §4.3's session and none of them has a graph.
  return ['flow-script', 'flow-fixture', 'flow-connectors'].includes(tab.type) ? <FlowSourceTabPane tab={tab} /> : null;
};

export const ForkTabLabel = ({ type, tabName }) => {
  if (type === 'flow') {
    return <FlowTabLabel tabName={tabName} />;
  }
  if (type === 'flow-yaml') {
    return <FlowYamlTabLabel tabName={tabName} />;
  }
  if (type === 'flow-script') {
    return <FlowScriptTabLabel tabName={tabName} />;
  }
  if (type === 'flow-connectors') {
    return <FlowConnectorsTabLabel tabName={tabName} />;
  }
  return type === 'flow-fixture' ? <FlowFixtureTabLabel tabName={tabName} /> : null;
};

/**
 * The strip's header for a fork tab, standing in for upstream's `CollectionHeader` (002 §4.2). Both
 * flow tab types share it: the strip is the feature's, not the view's.
 */
export const ForkTabHeader = ({ tab }) => (isForkTab(tab) ? <FlowTabHeader tab={tab} /> : null);

/**
 * The strip's tab itself for a fork tab (002 §4.3) — upstream's `SpecialTab` plus the unsaved state
 * only the fork can see. `null` for anything else, so the caller falls through to its own branch.
 */
export const ForkSpecialTab = ({ tab, onClose }) =>
  (isForkTab(tab) ? <FlowSpecialTab tab={tab} onClose={onClose} /> : null);

/**
 * Registers every fork IPC listener and returns **one** disposer. The count in 002 §12.1's manifest
 * stays flat however many channels 002 §11.3 grows, and the teardown line is not optional: without
 * it a listener leaks across hot reloads and re-mounts.
 */
export const registerForkIpcEvents = (dispatch) => registerFlowIpcEvents(dispatch);

/**
 * §4.2's workspace-scoped flow tabs, reopened at the point the workspace they belong to has one.
 *
 * **A known point rather than a retry.** These tabs live in the workspace's *scratch* collection, so
 * restoring one needs that collection's uid — and the fork learns of a workspace by watching its flow
 * scope, which runs alongside the workspace switch rather than after it. So the restore used to fire
 * whenever a scope was watched, skip every workspace whose scratch collection had not been mounted
 * yet, and depend on another scope being watched later to try again: a tab that came back or did not
 * according to which of two unordered paths finished first. `switchWorkspace` mounts the scratch
 * collection and then hydrates its tabs, and this is one line in that sequence.
 *
 * The snapshot is the one the caller already read — a second `renderer:snapshot:get` for the same
 * file would be a second answer to a question with one.
 */
export const restoreForkWorkspaceTabs = (snapshot) => async (dispatch) => {
  const { restoreFlowTabs } = await import('./flows/restoreSession');
  dispatch(restoreFlowTabs(snapshot));
};

/**
 * What the fork adds to the app's snapshot — 002 §7.2's run configuration and §4.2's workspace-scoped
 * flow tabs, under `extras.flows`.
 *
 * One line in upstream's serializer, for the reason every other touchpoint is one: the shape is the
 * fork's and stays in `fork/snapshot.js`, so a second fork feature persisting something costs no new
 * upstream edit. The snapshot already on disk is merged in there rather than replaced — the store
 * holds only the scopes this session opened.
 */
export const serializeForkSnapshot = (state, existingSnapshot) =>
  serializeFlowsSnapshot({
    state: state.flows,
    tabs: state.tabs?.tabs,
    forkTabTypes: FORK_TAB_TYPES,
    existing: existingSnapshot?.extras?.flows
  });
