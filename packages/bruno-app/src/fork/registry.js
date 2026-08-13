import React from 'react';
import flowsReducer from './flows/slice';
import { registerFlowIpcEvents } from './flows/ipcEvents';
import FlowSidebarSection from './flows/FlowSidebarSection';
import FlowTabPane from './flows/FlowTabPane';
import FlowTabLabel from './flows/FlowTabLabel';

/**
 * The single delegation surface upstream files call into — 001 §13.3.
 *
 * Every upstream touchpoint is one line calling something here, so a second fork feature registers
 * beside the first and costs **zero** new upstream edits. That is the whole justification for the
 * indirection: the cost is paid once and the saving recurs at every merge from upstream. The
 * manifest of what those lines are is 001 §13.4 plus 002 §12.1, and 002-C R5 re-checks it.
 */

/** Tab types this fork owns. `flow` is 002 §4.2's, keyed on the flow's pathname. */
export const FORK_TAB_TYPES = ['flow'];

/**
 * §4.2: a flow is a file, so its tab is ordinary and closable. It is singleton per pathname, which
 * upstream's `addTab` already gives us by matching on `pathname` before it consults this list.
 */
export const FORK_NON_CLOSABLE_TAB_TYPES = [];
export const FORK_NON_REPLACEABLE_TAB_TYPES = ['flow'];

export const forkReducers = {
  flows: flowsReducer
};

export const forkSidebarSections = [{ id: 'flows', component: FlowSidebarSection }];

export const isForkTab = (tab) => FORK_TAB_TYPES.includes(tab?.type);

export const ForkTabPane = ({ tab }) => (tab.type === 'flow' ? <FlowTabPane tab={tab} /> : null);

export const ForkTabLabel = ({ type, tabName }) => (type === 'flow' ? <FlowTabLabel tabName={tabName} /> : null);

/**
 * Registers every fork IPC listener and returns **one** disposer. The count in 002 §12.1's manifest
 * stays at two lines in `useIpcEvents.js` however many channels 002 §11.3 grows, and the teardown
 * line is not optional: without it a listener leaks across hot reloads and re-mounts.
 */
export const registerForkIpcEvents = (dispatch) => registerFlowIpcEvents(dispatch);
