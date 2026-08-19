import { tabsSharingStripWith } from './tabGroup';

/**
 * 002 §4.2 — a flow tab borrows a collection to exist in the tab model, and a workspace-scoped one
 * borrows the scratch collection, where the workspace's permanent tabs live. Grouping by collection
 * alone puts them in one strip.
 */

const overview = { uid: 'overview', type: 'workspaceOverview', collectionUid: 'scratch-1' };
const environments = { uid: 'environments', type: 'workspaceEnvironments', collectionUid: 'scratch-1' };
const checkout = { uid: 'checkout', type: 'flow', collectionUid: 'scratch-1' };
const refunds = { uid: 'refunds', type: 'flow', collectionUid: 'scratch-1' };
const request = { uid: 'request', type: 'request', collectionUid: 'payments' };
const paymentsFlow = { uid: 'payments-flow', type: 'flow', collectionUid: 'payments' };

const tabs = [overview, environments, checkout, refunds, request, paymentsFlow];

const uidsFor = (activeTab) => tabsSharingStripWith(tabs, activeTab).map((tab) => tab.uid);

describe('which tabs share a strip', () => {
  it('shows a flow only the other flows of its collection', () => {
    expect(uidsFor(checkout)).toEqual(['checkout', 'refunds']);
  });

  /** Symmetric on purpose: the workspace's own tabs do not gain a flow they did not ask for. */
  it('keeps flows out of the strip a workspace tab is in', () => {
    expect(uidsFor(overview)).toEqual(['overview', 'environments']);
  });

  it('still separates the two inside an ordinary collection', () => {
    expect(uidsFor(request)).toEqual(['request']);
    expect(uidsFor(paymentsFlow)).toEqual(['payments-flow']);
  });

  it('groups by collection as well as by kind', () => {
    expect(uidsFor(paymentsFlow)).not.toContain('checkout');
  });

  it('returns nothing when there is no active tab', () => {
    expect(tabsSharingStripWith(tabs, undefined)).toEqual([]);
  });
});
