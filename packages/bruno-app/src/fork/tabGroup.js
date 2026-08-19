import { isForkTab } from './tabTypes';

/** A leaf, like `tabTypes` — upstream's tab strip imports it, and must not pull the fork's UI in. */

/**
 * Which tabs share a strip with the active one — 002 §4.2.
 *
 * Upstream groups by `collectionUid` alone, which is right while every tab in a collection is a
 * request. A flow tab borrows a collection to exist in the tab model at all, and a workspace-scoped
 * one borrows the *scratch* collection — where the workspace's permanent Overview and Environments
 * tabs live. Grouped by collection alone, a flow opens into a strip containing two tabs that have
 * nothing to do with it, and the workspace's own tabs gain a flow they did not ask for.
 *
 * So the group is the collection **and** which side of the fork boundary the tab is on. The
 * relationship is symmetric on purpose: neither strip shows the other's tabs, whichever is active.
 */
export const tabsSharingStripWith = (tabs, activeTab) => {
  const wantsForkTabs = isForkTab(activeTab);
  return tabs.filter((tab) => tab.collectionUid === activeTab?.collectionUid && isForkTab(tab) === wantsForkTabs);
};
