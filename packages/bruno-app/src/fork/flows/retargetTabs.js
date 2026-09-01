import { addTab, closeTabs } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import { FORK_TAB_TYPES } from 'fork/tabTypes';
import { flowPathRenamed } from './slice';

/**
 * 002 §4.4 and §4.5: a renamed file's open tabs, pointed at where it went.
 *
 * **A tab is keyed by pathname and type**, so a rename leaves every tab of that flow addressing a
 * file that is gone: the pane reads "This flow is no longer on disk", and reopening the flow makes a
 * second tab beside the dead one.
 *
 * **Closed and reopened rather than edited in place.** Retargeting a tab's `pathname` would mean a
 * reducer in upstream's `tabs.js`, which is a merge conflict re-paid at every upstream merge
 * (`.claude/rules/architecture.md`) for a strip position. `closeTabs` and `addTab` already exist and
 * already do exactly this, so the rename costs no upstream edit at all. What it costs instead is
 * that a retargeted tab moves to the end of the strip.
 *
 * **Nothing is lost by the round trip**, and that is a property of when this runs rather than of the
 * dispatches: §4.4 refuses to open on a flow whose raw editor has unsaved work, and §4.5's rename
 * carries the script's editing session across with `flowPathRenamed`, draft included. Everything else a tab shows — the run being watched, the params typed into the panel,
 * the selected step — lives in the flows slice keyed by path, and `flowPathRenamed` moves it.
 */
export const retargetFlowTabs = ({ from, to, tabNameFor }) => (dispatch, getState) => {
  dispatch(flowPathRenamed({ from, to }));

  const stale = getState().tabs.tabs.filter((tab) => tab.pathname === from && FORK_TAB_TYPES.includes(tab.type));
  if (!stale.length) {
    return;
  }

  dispatch(closeTabs({ tabUids: stale.map((tab) => tab.uid) }));

  for (const tab of stale) {
    dispatch(addTab({ ...tab, uid: uuid(), pathname: to, tabName: tabNameFor(tab.type) }));
  }
};
