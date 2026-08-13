/**
 * The delegation surface must load in **either** evaluation order.
 *
 * Fork components import `addTab` from `slices/tabs.js`, so anything that made `tabs.js` import
 * `registry.js` back — the registry pulls in the whole component tree — was a cycle: whichever
 * module the bundler reached first left the other's binding `undefined`. It fails at module init
 * with "undefined is not iterable", in only one of the two orders, which is the kind of break that
 * passes locally and fails on someone else's machine.
 *
 * `tabs.js` no longer imports fork code at all, and `fork/tabTypes.js` is a leaf for anything that
 * later needs to. Both orders below must stay green.
 */

const expectBothLoaded = (registry, tabs) => {
  expect(typeof tabs.addTab).toBe('function');
  expect(tabs.NON_CLOSABLE_TAB_TYPES).toEqual(expect.arrayContaining(['workspaceOverview']));
  expect(registry.forkReducers.flows).toBeDefined();
  expect(registry.forkSidebarSections).toHaveLength(1);
};

describe('the fork registry', () => {
  it('loads when the registry is evaluated first', () => {
    jest.isolateModules(() => {
      const registry = require('fork/registry');
      const tabs = require('providers/ReduxStore/slices/tabs');
      expectBothLoaded(registry, tabs);
    });
  });

  it('loads when the tabs slice is evaluated first', () => {
    jest.isolateModules(() => {
      const tabs = require('providers/ReduxStore/slices/tabs');
      const registry = require('fork/registry');
      expectBothLoaded(registry, tabs);
    });
  });

  it('recognises a flow tab and nothing else', () => {
    const { isForkTab } = require('fork/registry');

    expect(isForkTab({ type: 'flow' })).toBe(true);
    expect(isForkTab({ type: 'collection-settings' })).toBe(false);
    expect(isForkTab(undefined)).toBe(false);
  });
});
