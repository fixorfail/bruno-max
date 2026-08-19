import React from 'react';

// `jest.setup.js` stubs nanoid with only `nanoid`, and `uuid()` reaches for `customAlphabet` — so a
// tab cannot be opened in a test without this. Counting rather than a constant, because two tabs
// sharing a uid is exactly what `addTab` treats as reopening the first one.
let mockUid = 0;
jest.mock('utils/common', () => ({
  ...jest.requireActual('utils/common'),
  uuid: () => `uid-${++mockUid}`
}));

import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import { SidebarAccordionProvider } from 'components/Sidebar/SidebarAccordionContext';
import flowsReducer from 'fork/flows/slice';
import tabsReducer from 'providers/ReduxStore/slices/tabs';
import themes from 'themes/index';
import FlowSidebarSection from './index';

/**
 * 002 §4.1. The section is about one workspace — the active one — the way upstream's collection list
 * is. `state.flows.flows` is not: every scope the app has watched since launch accumulates there, and
 * nothing unwatches one when the workspace changes.
 */

const theme = themes.dark || Object.values(themes)[0];

const flowIn = (workspaceRoot, filename, collectionRoot, extra = {}) => ({
  pathname: `${collectionRoot || workspaceRoot}/flows/${filename}`,
  filename,
  workspaceRoot,
  collectionRoot,
  ...extra
});

const renderSection = ({ flows, workspaces, activeWorkspaceUid }) => {
  const store = configureStore({
    reducer: {
      flows: flowsReducer,
      tabs: tabsReducer,
      collections: () => ({ collections: [] }),
      workspaces: () => ({ workspaces, activeWorkspaceUid })
    },
    preloadedState: {
      flows: { flows, descriptions: {}, runs: {}, flowByRunId: {}, selectedStep: {}, requestLogs: [], sources: {} }
    }
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <SidebarAccordionProvider defaultExpanded={['flows']}>
            <FlowSidebarSection />
          </SidebarAccordionProvider>
        </ThemeProvider>
      </Provider>
    )
  };
};

describe('FlowSidebarSection', () => {
  const workspaces = [
    { uid: 'one', type: 'default', pathname: '/home/dev/workspace-one', collections: [{ path: '/home/dev/payments' }] },
    { uid: 'two', pathname: '/home/dev/workspace-two', collections: [{ path: '/home/dev/billing' }] }
  ];

  const flows = [
    flowIn('/home/dev/workspace-one', 'checkout.flow.yml'),
    flowIn('/home/dev/workspace-two', 'onboarding.flow.yml'),
    // A collection's scope records the collection's own path as its workspace root, because no
    // emitter of `main:collection-opened` passes a workspace path for it to use instead.
    flowIn('/home/dev/payments', 'refund.flow.yml', '/home/dev/payments'),
    flowIn('/home/dev/billing', 'invoice.flow.yml', '/home/dev/billing')
  ];

  it('lists the active workspace, and its collections, and nothing else', () => {
    renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });

    expect(screen.getByTestId('flow-row-checkout.flow.yml')).toBeInTheDocument();
    expect(screen.getByTestId('flow-row-refund.flow.yml')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-row-onboarding.flow.yml')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-row-invoice.flow.yml')).not.toBeInTheDocument();
  });

  /** The defect: every workspace was watched at once, so the section never changed with the choice. */
  it('changes with the active workspace', () => {
    renderSection({ flows, workspaces, activeWorkspaceUid: 'two' });

    expect(screen.getByTestId('flow-row-onboarding.flow.yml')).toBeInTheDocument();
    expect(screen.getByTestId('flow-row-invoice.flow.yml')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-row-checkout.flow.yml')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-row-refund.flow.yml')).not.toBeInTheDocument();
  });

  /**
   * §4.1: a library flow is a different kind of thing to run — 001 §12.5 keeps it out of a glob run,
   * and running one directly means supplying its params first — so it is listed apart rather than
   * interleaved with the flows above it.
   */
  describe('libraries', () => {
    const withLibraries = [
      flowIn('/home/dev/workspace-one', 'checkout.flow.yml'),
      flowIn('/home/dev/workspace-one', 'login.flow.yml', undefined, { library: true }),
      flowIn('/home/dev/payments', 'refund.flow.yml', '/home/dev/payments')
    ];

    const rowOrder = () =>
      [...document.querySelectorAll('.flow-subgroup-label, .flow-row')].map((element) =>
        (element.classList.contains('flow-row') ? element.dataset.testid : element.textContent));

    it('lists them last, under their own label', () => {
      renderSection({ flows: withLibraries, workspaces, activeWorkspaceUid: 'one' });

      expect(rowOrder()).toEqual([
        'flow-row-checkout.flow.yml',
        'Libraries',
        'flow-row-login.flow.yml',
        'flow-row-refund.flow.yml'
      ]);
    });

    /**
     * The flag rides the watcher's tree entry, so it is known for a flow nobody has opened — which
     * is every flow in this list. Read from a description instead, the label would appear only after
     * the flow had been opened, which is exactly when the reader no longer needs it.
     */
    it('groups a library nobody has opened', () => {
      renderSection({ flows: withLibraries, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.getByTestId('flow-subgroup-libraries')).toBeInTheDocument();
    });

    it('labels nothing when a scope has no libraries', () => {
      renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.queryByTestId('flow-subgroup-libraries')).not.toBeInTheDocument();
    });

    /** A scope holding only libraries still says so, rather than listing them as ordinary flows. */
    it('labels them in a scope that holds nothing else', () => {
      renderSection({
        flows: [flowIn('/home/dev/workspace-one', 'login.flow.yml', undefined, { library: true })],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      expect(rowOrder()).toEqual(['Libraries', 'flow-row-login.flow.yml']);
    });
  });

  /** One workspace is shown at a time, so there is one group that can be called "Workspace". */
  it('has a single workspace group, whatever else is watched', () => {
    renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });

    expect(screen.getAllByText('Workspace')).toHaveLength(1);
    expect(screen.getByText('payments')).toBeInTheDocument();
  });

  it('falls back to the default workspace when the active one is not loaded', () => {
    renderSection({ flows, workspaces, activeWorkspaceUid: 'closed-since' });

    expect(screen.getByTestId('flow-row-checkout.flow.yml')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-row-onboarding.flow.yml')).not.toBeInTheDocument();
  });

  /**
   * 002 §4.3. Raw YAML editing is reached from the row's menu rather than by opening the flow, which
   * is what keeps it the non-standard way in.
   */
  describe('the row menu (§4.3)', () => {
    const open = () => {
      const { store } = renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });
      fireEvent.click(screen.getAllByTestId('flow-menu-trigger')[0]);
      return store;
    };

    it('opens the raw editor as its own tab, not the run view', () => {
      const store = open();

      fireEvent.click(screen.getByTestId('flow-edit-yaml-checkout.flow.yml'));

      const tabs = store.getState().tabs.tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ type: 'flow-yaml', pathname: '/home/dev/workspace-one/flows/checkout.flow.yml' });
    });

    /** Upstream dedupes on pathname *and* type, which is what lets one flow have both open at once. */
    it('leaves the flow openable in the run view as well', () => {
      const store = open();
      fireEvent.click(screen.getByTestId('flow-edit-yaml-checkout.flow.yml'));

      fireEvent.click(screen.getByTestId('flow-row-checkout.flow.yml'));

      expect(store.getState().tabs.tabs.map((tab) => tab.type)).toEqual(['flow-yaml', 'flow']);
    });

    /** The row underneath opens the flow; a click meant for the menu must not do that as well. */
    it('does not open the run view when the menu itself is clicked', () => {
      const store = open();

      expect(store.getState().tabs.tabs).toHaveLength(0);
    });
  });

  /** §4.1: the filename is the fallback, not the label — a flow that names itself reads by that name. */
  describe('the row label', () => {
    const named = { ...flowIn('/home/dev/workspace-one', 'checkout.flow.yml'), name: 'Checkout' };

    it('uses the declared name, and the filename for a flow without one', () => {
      renderSection({
        flows: [named, flowIn('/home/dev/workspace-one', 'refund.flow.yml')],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      expect(screen.getByText('Checkout')).toBeInTheDocument();
      expect(screen.getByText('refund.flow.yml')).toBeInTheDocument();
    });

    it('names the run tab the same way, and the raw editor by its file', () => {
      const { store } = renderSection({ flows: [named], workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-row-checkout.flow.yml'));
      fireEvent.click(screen.getByTestId('flow-menu-trigger'));
      fireEvent.click(screen.getByTestId('flow-edit-yaml-checkout.flow.yml'));

      expect(store.getState().tabs.tabs.map((tab) => [tab.type, tab.tabName])).toEqual([
        ['flow', 'Checkout'],
        ['flow-yaml', 'checkout.flow.yml']
      ]);
    });
  });

  /** Another workspace's watched flows are not this one's, so the section is empty rather than full. */
  it('says so when the active workspace has no flows of its own', () => {
    renderSection({
      flows: [flowIn('/home/dev/workspace-one', 'checkout.flow.yml')],
      workspaces,
      activeWorkspaceUid: 'two'
    });

    expect(screen.getByText('No flows found')).toBeInTheDocument();
  });
});
