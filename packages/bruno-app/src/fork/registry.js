import React, { Suspense, lazy } from 'react';
import flowsReducer from './flows/slice';
import { registerFlowIpcEvents } from './flows/ipcEvents';
import { FORK_TAB_TYPES } from './tabTypes';

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

export const forkReducers = {
  flows: flowsReducer
};

export const forkSidebarSections = [{ id: 'flows', component: FlowSidebarSection }];

export const isForkTab = (tab) => FORK_TAB_TYPES.includes(tab?.type);

export const ForkTabPane = ({ tab }) => (tab.type === 'flow' ? <FlowTabPane tab={tab} /> : null);

export const ForkTabLabel = ({ type, tabName }) => (type === 'flow' ? <FlowTabLabel tabName={tabName} /> : null);

/**
 * Registers every fork IPC listener and returns **one** disposer. The count in 002 §12.1's manifest
 * stays flat however many channels 002 §11.3 grows, and the teardown line is not optional: without
 * it a listener leaks across hot reloads and re-mounts.
 */
export const registerForkIpcEvents = (dispatch) => registerFlowIpcEvents(dispatch);
