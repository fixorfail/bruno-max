import React, { Suspense, lazy } from 'react';
import flowsReducer from './flows/slice';
import { registerFlowIpcEvents } from './flows/ipcEvents';
import { isForkTab } from './tabTypes';

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
const FlowScriptTabPane = withSuspense(lazy(() => import('./flows/FlowScriptTabPane')));
const FlowScriptTabLabel = withSuspense(lazy(() => import('./flows/FlowScriptTabLabel')));
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
  return tab.type === 'flow-script' ? <FlowScriptTabPane tab={tab} /> : null;
};

export const ForkTabLabel = ({ type, tabName }) => {
  if (type === 'flow') {
    return <FlowTabLabel tabName={tabName} />;
  }
  if (type === 'flow-yaml') {
    return <FlowYamlTabLabel tabName={tabName} />;
  }
  return type === 'flow-script' ? <FlowScriptTabLabel tabName={tabName} /> : null;
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
