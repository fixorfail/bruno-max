import React from 'react';

// `jest.setup.js` stubs nanoid with only `nanoid`, and `uuid()` reaches for `customAlphabet` — so a
// tab cannot be opened in a test without this. Counting rather than a constant, because two tabs
// sharing a uid is exactly what `addTab` treats as reopening the first one.
let mockUid = 0;
jest.mock('utils/common', () => ({
  ...jest.requireActual('utils/common'),
  uuid: () => `uid-${++mockUid}`
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import { SidebarAccordionProvider } from 'components/Sidebar/SidebarAccordionContext';
import flowsReducer from 'fork/flows/slice';
import tabsReducer from 'providers/ReduxStore/slices/tabs';
import themes from 'themes/index';
import FlowSidebarSection from './index';

/** The slice's own initial state, so a key added to it does not break every fixture below. */
const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

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

const renderSection = ({ flows, workspaces, activeWorkspaceUid, apiSpecs = [], sources = {} }) => {
  const store = configureStore({
    reducer: {
      flows: flowsReducer,
      tabs: tabsReducer,
      apiSpec: () => ({ apiSpecs }),
      collections: () => ({ collections: [] }),
      workspaces: () => ({ workspaces, activeWorkspaceUid })
    },
    preloadedState: {
      flows: { ...initialFlowsState(), flows, sources }
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

  /**
   * 002 §4.5 — the `.js` helpers `use:` names, listed so they are visible without opening a flow.
   * Last, below the libraries: the list answers "what can I run here" from the top down, and a
   * script is the furthest thing from an answer to it.
   */
  describe('scripts (§4.5)', () => {
    const scriptIn = (root, filename) => ({
      pathname: `${root}/flows/scripts/${filename}`,
      filename,
      workspaceRoot: root,
      script: true
    });

    const mixed = [
      flowIn('/home/dev/workspace-one', 'checkout.flow.yml'),
      flowIn('/home/dev/workspace-one', 'login.flow.yml', undefined, { library: true }),
      scriptIn('/home/dev/workspace-one', 'text.js')
    ];

    const rowOrder = () =>
      [...document.querySelectorAll('.flow-subgroup-label, .flow-row')].map((element) =>
        (element.classList.contains('flow-row') ? element.dataset.testid : element.textContent));

    it('lists them last, under their own label', () => {
      renderSection({ flows: mixed, workspaces, activeWorkspaceUid: 'one' });

      expect(rowOrder()).toEqual([
        'flow-row-checkout.flow.yml',
        'Libraries',
        'flow-row-login.flow.yml',
        'Scripts',
        'flow-row-text.js'
      ]);
    });

    it('labels nothing when a scope has no scripts', () => {
      renderSection({ flows: [mixed[0]], workspaces, activeWorkspaceUid: 'one' });

      expect(screen.queryByTestId('flow-subgroup-scripts')).not.toBeInTheDocument();
    });

    it('opens the script in its own editor tab, named by its file', () => {
      const { store } = renderSection({ flows: mixed, workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-row-text.js'));

      expect(store.getState().tabs.tabs).toHaveLength(1);
      expect(store.getState().tabs.tabs[0]).toMatchObject({
        type: 'flow-script',
        pathname: '/home/dev/workspace-one/flows/scripts/text.js',
        tabName: 'text.js'
      });
    });

    /**
     * §4.5: one item, because a `.js` has one thing about it to change. `Edit Yaml` and the flow
     * properties both act on a `meta:` block a script does not have.
     */
    it('carries a row menu holding Rename and nothing else', () => {
      renderSection({ flows: [mixed[2]], workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-menu-trigger'));

      expect(screen.getByTestId('script-rename-text.js')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-edit-yaml-text.js')).not.toBeInTheDocument();
      expect(screen.queryByTestId('flow-properties-text.js')).not.toBeInTheDocument();
    });

    it('opens the rename dialog on the name the file already has', async () => {
      window.ipcRenderer = { invoke: jest.fn(async () => undefined) };
      renderSection({ flows: [mixed[2]], workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-menu-trigger'));
      fireEvent.click(screen.getByTestId('script-rename-text.js'));

      // The stem, not the filename — the extension is the form's, not the author's.
      expect(await screen.findByTestId('rename-script-file-name')).toHaveValue('text');
    });

    /** A click meant for the menu must not also open the script behind it. */
    it('does not open the script when the menu itself is clicked', () => {
      const { store } = renderSection({ flows: [mixed[2]], workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-menu-trigger'));

      expect(store.getState().tabs.tabs).toHaveLength(0);
    });

    /** A script is named by its file and nothing else — the watcher reads no `meta:` from one. */
    it('is listed by its filename', () => {
      renderSection({ flows: [mixed[2]], workspaces, activeWorkspaceUid: 'one' });

      expect(screen.getByText('text.js')).toBeInTheDocument();
    });
  });

  /**
   * 002 §4.4 — the row menu's second item: the `meta:` block and the file's own name, together,
   * because they are the two things that carry a flow's name and neither is editable anywhere else.
   */
  describe('the properties dialog (§4.4)', () => {
    const named = { ...flowIn('/home/dev/workspace-one', 'checkout.flow.yml'), name: 'Checkout' };

    let invoke;

    beforeEach(() => {
      invoke = jest.fn(async (channel) =>
        (channel === 'renderer:flow-read-properties'
          ? { filename: 'checkout.flow.yml', name: 'Checkout', description: 'the happy path', tags: ['smoke'], library: false }
          : undefined));
      window.ipcRenderer = { invoke };
    });

    const openMenu = (sources = {}) => {
      const rendered = renderSection({ flows: [named], workspaces, activeWorkspaceUid: 'one', sources });
      fireEvent.click(screen.getByTestId('flow-menu-trigger'));
      return rendered;
    };

    it('opens on what the file says, not on what the sidebar row shows', async () => {
      openMenu();

      fireEvent.click(screen.getByTestId('flow-properties-checkout.flow.yml'));

      await screen.findByTestId('flow-properties-name');
      expect(screen.getByTestId('flow-properties-name')).toHaveValue('Checkout');
      expect(screen.getByTestId('flow-properties-description')).toHaveValue('the happy path');
      expect(screen.getByTestId('flow-properties-tags')).toHaveValue('smoke');
      // The extension is the form's, not the author's — the field holds the stem.
      expect(screen.getByTestId('flow-properties-file-name')).toHaveValue('checkout');
      expect(invoke).toHaveBeenCalledWith('renderer:flow-read-properties', expect.objectContaining({
        entry: named.pathname
      }));
    });

    /**
     * The dialog writes the text on disk. A dirty editor means the disk is already behind what the
     * author is looking at, and the next auto-save would put the draft back over the properties
     * they had just set — with nothing on either surface saying so.
     */
    it('refuses to open over a raw editor with unsaved changes', async () => {
      openMenu({ [named.pathname]: { content: 'version: 2\n', saved: 'version: 1\n' } });

      fireEvent.click(screen.getByTestId('flow-properties-checkout.flow.yml'));

      await waitFor(() => expect(invoke).not.toHaveBeenCalledWith('renderer:flow-read-properties', expect.anything()));
      expect(screen.queryByTestId('flow-properties-name')).not.toBeInTheDocument();
    });

    /** A clean editor has nothing to lose, so having one open is not a reason to refuse. */
    it('opens over a raw editor whose text matches the file', async () => {
      openMenu({ [named.pathname]: { content: 'version: 1\n', saved: 'version: 1\n' } });

      fireEvent.click(screen.getByTestId('flow-properties-checkout.flow.yml'));

      await screen.findByTestId('flow-properties-name');
    });
  });

  /**
   * 002 §4.7 — the row menu's third item: the create form, opened over the flow that was clicked.
   */
  describe('duplicating a flow (§4.7)', () => {
    const named = { ...flowIn('/home/dev/workspace-one', 'checkout.flow.yml'), name: 'Checkout' };

    let invoke;

    beforeEach(() => {
      invoke = jest.fn(async (channel) =>
        (channel === 'renderer:flow-read-properties'
          ? {
              filename: 'checkout.flow.yml',
              name: 'Checkout',
              description: 'the happy path',
              tags: ['smoke'],
              library: true
            }
          : undefined));
      window.ipcRenderer = { invoke };
    });

    const openDuplicate = (sources = {}) => {
      const rendered = renderSection({ flows: [named], workspaces, activeWorkspaceUid: 'one', sources });
      fireEvent.click(screen.getByTestId('flow-menu-trigger'));
      fireEvent.click(screen.getByTestId('flow-duplicate-checkout.flow.yml'));
      return rendered;
    };

    it('opens the create form on the source flow, named as a copy', async () => {
      openDuplicate();

      expect(await screen.findByTestId('create-flow-name')).toHaveValue('Checkout copy');
      expect(screen.getByTestId('create-flow-file-name')).toHaveValue('checkout-copy');
      expect(screen.getByTestId('create-flow-description')).toHaveValue('the happy path');
      expect(screen.getByTestId('create-flow-tags')).toHaveValue('smoke');
      expect(screen.getByTestId('create-flow-library')).toBeChecked();
    });

    /** The copy lands beside its original unless the author browses somewhere else. */
    it('offers the source flow\'s own directory', async () => {
      openDuplicate();

      expect(await screen.findByTestId('create-flow-location')).toHaveValue('/home/dev/workspace-one/flows');
    });

    /**
     * A duplicate binds what its source binds, so there is nothing to choose — and a list that could
     * only show the specs open in this workspace would read as complete while missing the rest.
     */
    it('offers no api spec list, and says what is carried over instead', async () => {
      openDuplicate();

      expect(await screen.findByTestId('create-flow-duplicate-note')).toHaveTextContent('checkout.flow.yml');
      expect(screen.queryByTestId('create-flow-api-list')).not.toBeInTheDocument();
    });

    it('duplicates through the host, sending the form\'s meta and no document', async () => {
      openDuplicate();
      await screen.findByTestId('create-flow-name');

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Checkout nightly' } });
      fireEvent.click(screen.getByText('Duplicate'));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('renderer:flow-duplicate', {
          entry: named.pathname,
          scope: { workspaceRoot: '/home/dev/workspace-one', collectionRoot: undefined },
          directory: '/home/dev/workspace-one/flows',
          filename: 'checkout-copy.flow.yml',
          properties: { name: 'Checkout nightly', description: 'the happy path', tags: ['smoke'], library: true }
        }));
      expect(invoke).not.toHaveBeenCalledWith('renderer:flow-create', expect.anything());
    });

    /**
     * The host copies the file on disk, so a draft the author is looking at would be silently
     * missing from the duplicate — in a file they would go on to edit as though it had it.
     */
    it('refuses to open over a raw editor with unsaved changes', async () => {
      openDuplicate({ [named.pathname]: { content: 'version: 2\n', saved: 'version: 1\n' } });

      await waitFor(() => expect(invoke).not.toHaveBeenCalledWith('renderer:flow-read-properties', expect.anything()));
      expect(screen.queryByTestId('create-flow-name')).not.toBeInTheDocument();
    });

    /** §4.5's scripts and §4.6's fixtures have no document with a `meta:` to rewrite. */
    it('is not offered on a script', () => {
      renderSection({
        flows: [{
          pathname: '/home/dev/workspace-one/flows/scripts/text.js',
          filename: 'text.js',
          workspaceRoot: '/home/dev/workspace-one',
          script: true
        }],
        workspaces,
        activeWorkspaceUid: 'one'
      });
      fireEvent.click(screen.getByTestId('flow-menu-trigger'));

      expect(screen.queryByTestId('flow-duplicate-text.js')).not.toBeInTheDocument();
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
  /**
   * 002 §4.1 — starting a flow from the section header, rather than by hand-writing the file.
   *
   * The assertions are on what reaches `renderer:flow-create`, because that payload *is* the flow:
   * the sidebar row that follows arrives through the watcher, which this test has no way to run.
   */
  describe('creating a flow', () => {
    const workspaceWithSpecs = [
      {
        uid: 'one',
        type: 'default',
        pathname: '/home/dev/workspace-one',
        collections: [],
        apiSpecs: [{ path: '/home/dev/workspace-one/apispec/auth-v2.yaml' }]
      }
    ];

    const loadedSpecs = [
      {
        uid: 'spec-1',
        name: 'Auth API',
        filename: 'auth-v2.yaml',
        pathname: '/home/dev/workspace-one/apispec/auth-v2.yaml'
      }
    ];

    let invoke;

    beforeEach(() => {
      invoke = jest.fn(async (channel, request) =>
        (channel === 'renderer:flow-folder' ? `${request.scopeRoot}/flows` : undefined));
      window.ipcRenderer = { invoke };
    });

    const openForm = async () => {
      renderSection({
        flows: [],
        workspaces: workspaceWithSpecs,
        activeWorkspaceUid: 'one',
        apiSpecs: loadedSpecs
      });

      fireEvent.click(screen.getByTestId('flows-header-add'));
      await screen.findByTestId('create-flow-name');
    };

    it('opens the form on the workspace flows folder', async () => {
      await openForm();

      expect(invoke).toHaveBeenCalledWith('renderer:flow-folder', { scopeRoot: '/home/dev/workspace-one' });
      expect(screen.getByTestId('create-flow-location')).toHaveValue('/home/dev/workspace-one/flows');
    });

    it('writes the name, the description and the checked specs', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Checkout' } });
      fireEvent.change(screen.getByTestId('create-flow-description'), { target: { value: 'the happy path' } });
      fireEvent.click(screen.getByTestId('create-flow-api-auth-v2.yaml'));
      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request).toMatchObject({
        directory: '/home/dev/workspace-one/flows',
        filename: 'checkout.flow.yml'
      });
      expect(request.content).toContain('name: Checkout');
      expect(request.content).toContain('description: the happy path');
      expect(request.content).toContain('auth-v2: ../apispec/auth-v2.yaml');
    });

    /**
     * The name is prose and the file name is a filename; a blank file name is the author saying
     * "call it after the flow", not the author leaving a required field empty.
     */
    it('names the file after the flow when the file name is left blank', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Order Fulfillment' } });
      fireEvent.blur(screen.getByTestId('create-flow-name'));

      expect(screen.getByTestId('create-flow-file-name')).toHaveValue('order-fulfillment');

      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request.filename).toBe('order-fulfillment.flow.yml');
      expect(request.content).toContain('name: Order Fulfillment');
    });

    it('keeps a file name the author typed', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-file-name'), { target: { value: 'f2-checkout' } });
      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Order Fulfillment' } });
      fireEvent.blur(screen.getByTestId('create-flow-name'));

      expect(screen.getByTestId('create-flow-file-name')).toHaveValue('f2-checkout');

      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request.filename).toBe('f2-checkout.flow.yml');
      expect(request.content).toContain('name: Order Fulfillment');
    });

    /** The name is YAML text, so what it may contain is not what a filename may contain. */
    it('accepts a name no filename could hold, and files it under a name one can', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Order: fulfillment / v2' } });
      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request.filename).toBe('order-fulfillment-v2.flow.yml');
      expect(request.content).toContain('name: \'Order: fulfillment / v2\'');
    });

    /** Version suffixes are how the flows and specs on disk are named; `auth-v-2` is not one. */
    it('keeps a version suffix whole when deriving the file name', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Auth V2' } });
      fireEvent.blur(screen.getByTestId('create-flow-name'));

      expect(screen.getByTestId('create-flow-file-name')).toHaveValue('auth-v2');
    });

    /** A file name that survives neither typing nor derivation is the one case with nothing to use. */
    it('refuses a file name that cannot be derived or typed', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: '///' } });
      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(document.querySelector('.text-red-500')).toBeInTheDocument());
      expect(document.querySelector('.text-red-500').textContent).toBe('File name cannot be empty.');
      expect(invoke).not.toHaveBeenCalledWith('renderer:flow-create', expect.anything());
    });

    /** §12.5: a library is one because its author said so, which is the only place that is said. */
    it('marks the flow a library when the box is checked', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Login' } });
      fireEvent.click(screen.getByTestId('create-flow-library'));
      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request.content).toContain('library: true');
    });

    /** A spec left unchecked is one the flow does not bind, not one it binds and never uses. */
    it('binds no api when none is checked', async () => {
      await openForm();

      fireEvent.change(screen.getByTestId('create-flow-name'), { target: { value: 'Checkout' } });
      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-create', expect.anything()));
      const [, request] = invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-create');
      expect(request.content).not.toContain('apis:');
    });

    it('creates nothing without a name', async () => {
      await openForm();

      fireEvent.click(screen.getByTestId('create-flow-submit-btn'));

      await waitFor(() => expect(document.querySelector('.text-red-500')).toBeInTheDocument());
      expect(document.querySelector('.text-red-500').textContent).toBe('Name is required');
      expect(invoke).not.toHaveBeenCalledWith('renderer:flow-create', expect.anything());
    });

    /** The list is the sidebar's own pairing, so a spec that is not the workspace's is not offered. */
    it('offers only the api specs the workspace holds', async () => {
      renderSection({
        flows: [],
        workspaces: workspaceWithSpecs,
        activeWorkspaceUid: 'one',
        apiSpecs: [...loadedSpecs, { uid: 'spec-2', filename: 'other.yaml', pathname: '/elsewhere/other.yaml' }]
      });

      fireEvent.click(screen.getByTestId('flows-header-add'));
      await screen.findByTestId('create-flow-api-auth-v2.yaml');

      expect(screen.queryByTestId('create-flow-api-other.yaml')).not.toBeInTheDocument();
    });
  });

  /**
   * 002 §4.1a. The watcher has always reported a flow at any depth under `flows/`, so these entries
   * are nothing new — what is new is that the directory holding one says something in the sidebar.
   */
  describe('folders', () => {
    const nested = (workspaceRoot, relativePath, collectionRoot, extra = {}) => ({
      pathname: `${collectionRoot || workspaceRoot}/flows/${relativePath}`,
      filename: relativePath.split('/').pop(),
      workspaceRoot,
      collectionRoot,
      ...extra
    });

    const inFolders = [
      nested('/home/dev/workspace-one', 'checkout.flow.yml'),
      nested('/home/dev/workspace-one', 'company/create_company.flow.yml'),
      nested('/home/dev/workspace-one', 'company/billing/invoice.flow.yml')
    ];

    const openFolder = (path) => fireEvent.click(screen.getByTestId(`flow-folder-${path}`));

    const rowOrder = () =>
      [...document.querySelectorAll('.flow-folder, .flow-row')].map((element) => element.dataset.testid);

    it('names each directory as a row of its own', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.getByTestId('flow-folder-company')).toBeInTheDocument();
    });

    /**
     * Collapsed is what upstream's collection folders do — `slices/collections` creates every folder
     * item collapsed — so it is what a reader of this sidebar already expects of a folder row.
     */
    it('starts collapsed, showing nothing inside', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.queryByTestId('flow-row-company/create_company.flow.yml')).not.toBeInTheDocument();
      expect(screen.queryByTestId('flow-folder-company/billing')).not.toBeInTheDocument();
    });

    it('shows what is inside when it is opened, one level at a time', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      openFolder('company');

      expect(screen.getByTestId('flow-row-company/create_company.flow.yml')).toBeInTheDocument();
      expect(screen.getByTestId('flow-folder-company/billing')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-row-company/billing/invoice.flow.yml')).not.toBeInTheDocument();

      openFolder('company/billing');

      expect(screen.getByTestId('flow-row-company/billing/invoice.flow.yml')).toBeInTheDocument();
    });

    it('closes again on a second click', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      openFolder('company');
      openFolder('company');

      expect(screen.queryByTestId('flow-row-company/create_company.flow.yml')).not.toBeInTheDocument();
    });

    it('lists folders above the flows beside them', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      expect(rowOrder()).toEqual(['flow-folder-company', 'flow-row-checkout.flow.yml']);
    });

    /** A flow at the top of its bucket is identified the way it was before folders existed. */
    it('leaves an unnested flow identified by its filename', () => {
      renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.getByTestId('flow-row-checkout.flow.yml')).toBeInTheDocument();
    });

    /**
     * Two folders holding the same filename is the ordinary reason to have folders at all, and a
     * duplicate `data-testid` does not fail where it is created — it fails in whichever test reaches
     * for it second.
     */
    it('distinguishes the same filename in two folders, on the row and in its menu', async () => {
      renderSection({
        flows: [
          nested('/home/dev/workspace-one', 'company/create.flow.yml'),
          nested('/home/dev/workspace-one', 'user/create.flow.yml')
        ],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      openFolder('company');
      openFolder('user');

      expect(screen.getByTestId('flow-row-company/create.flow.yml')).toBeInTheDocument();
      expect(screen.getByTestId('flow-row-user/create.flow.yml')).toBeInTheDocument();

      fireEvent.click(screen.getAllByTestId('flow-menu-trigger')[0]);
      expect(await screen.findByTestId('flow-edit-yaml-company/create.flow.yml')).toBeInTheDocument();
    });

    it('opens a nested flow in its run view', () => {
      const { store } = renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

      openFolder('company');
      fireEvent.click(screen.getByTestId('flow-row-company/create_company.flow.yml'));

      expect(store.getState().tabs.tabs).toEqual([
        expect.objectContaining({
          type: 'flow',
          pathname: '/home/dev/workspace-one/flows/company/create_company.flow.yml'
        })
      ]);
    });

    /** §4.1: a library is bucketed apart, and its own directory is a folder inside that bucket. */
    it('nests a library under the Libraries label', () => {
      renderSection({
        flows: [
          nested('/home/dev/workspace-one', 'checkout.flow.yml'),
          nested('/home/dev/workspace-one', 'auth/login.flow.yml', undefined, { library: true })
        ],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      expect(rowOrder()).toEqual(['flow-row-checkout.flow.yml', 'flow-folder-auth']);
      expect(screen.getByTestId('flow-subgroup-libraries')).toBeInTheDocument();

      openFolder('auth');

      expect(screen.getByTestId('flow-row-auth/login.flow.yml')).toBeInTheDocument();
    });

    /**
     * One directory holding both kinds is drawn as two rows, either side of the `Libraries` label —
     * so they open independently. A row that opens because a different row was clicked is an
     * unexplained jump, whatever the two share on disk.
     */
    it('opens a folder independently of its twin in another bucket', () => {
      renderSection({
        flows: [
          nested('/home/dev/workspace-one', 'company/create.flow.yml'),
          nested('/home/dev/workspace-one', 'company/login.flow.yml', undefined, { library: true })
        ],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      const [inFlows, inLibraries] = screen.getAllByTestId('flow-folder-company');
      expect(inLibraries).toBeInTheDocument();

      fireEvent.click(inFlows);

      expect(screen.getByTestId('flow-row-company/create.flow.yml')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-row-company/login.flow.yml')).not.toBeInTheDocument();
    });

    /**
     * §4.5: a helper's folders are counted from `flows/scripts/`, so the `Scripts` label is not
     * immediately restated as a `scripts` folder row underneath it.
     */
    it('counts a script folder from the scripts directory', () => {
      renderSection({
        flows: [nested('/home/dev/workspace-one', 'scripts/auth/sign.js', undefined, { script: true })],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      expect(screen.queryByTestId('flow-folder-scripts')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-folder-auth')).toBeInTheDocument();
    });

    /** A folder is keyed by its absolute path, so opening one does not open another that shares a name. */
    it('opens only the folder that was clicked when two scopes name one alike', () => {
      renderSection({
        flows: [
          nested('/home/dev/workspace-one', 'company/create.flow.yml'),
          nested('/home/dev/payments', 'company/refund.flow.yml', '/home/dev/payments')
        ],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      fireEvent.click(screen.getAllByTestId('flow-folder-company')[0]);

      expect(screen.getByTestId('flow-row-company/create.flow.yml')).toBeInTheDocument();
      expect(screen.queryByTestId('flow-row-company/refund.flow.yml')).not.toBeInTheDocument();
    });

    describe('the header actions', () => {
      const openHeaderMenu = () => fireEvent.click(screen.getByTestId('flows-header-actions'));

      it('open every folder at every depth', () => {
        renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

        openHeaderMenu();
        fireEvent.click(screen.getByTestId('flows-header-actions-menu-expand-folders'));

        expect(screen.getByTestId('flow-row-company/create_company.flow.yml')).toBeInTheDocument();
        expect(screen.getByTestId('flow-row-company/billing/invoice.flow.yml')).toBeInTheDocument();
      });

      it('close every folder again', () => {
        renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

        openHeaderMenu();
        fireEvent.click(screen.getByTestId('flows-header-actions-menu-expand-folders'));
        openHeaderMenu();
        fireEvent.click(screen.getByTestId('flows-header-actions-menu-collapse-folders'));

        expect(screen.queryByTestId('flow-row-company/create_company.flow.yml')).not.toBeInTheDocument();
        expect(screen.queryByTestId('flow-folder-company')).toBeInTheDocument();
      });

      /**
       * They are the overflow menu's only items, so with no folders to fold there is nothing behind
       * the control and it is not drawn — rather than opening onto an empty list.
       */
      it('take the menu with them when the section holds no folders', () => {
        renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });

        expect(screen.queryByTestId('flows-header-actions')).not.toBeInTheDocument();
        expect(screen.getByTestId('flows-header-add')).toBeInTheDocument();
      });

      /** The `+` creates; folding lives next to it rather than inside it. */
      it('are not in the create menu', () => {
        renderSection({ flows: inFolders, workspaces, activeWorkspaceUid: 'one' });

        fireEvent.click(screen.getByTestId('flows-header-add'));

        expect(screen.queryByTestId('flows-header-actions-menu-expand-folders')).not.toBeInTheDocument();
      });
    });
  });

  /**
   * 002 §4.6. The data a flow reads through `!file`, `bodyFile` and `dataset:` — listed last, because
   * the section answers "what can I run here" from the top down and a fixture is an input rather than
   * anything that runs.
   */
  describe('fixtures (§4.6)', () => {
    const fixtureIn = (workspaceRoot, relativePath, collectionRoot) => ({
      pathname: `${collectionRoot || workspaceRoot}/flows/fixtures/${relativePath}`,
      filename: relativePath.split('/').pop(),
      workspaceRoot,
      collectionRoot,
      fixture: true
    });

    const withFixtures = [
      flowIn('/home/dev/workspace-one', 'checkout.flow.yml'),
      flowIn('/home/dev/workspace-one', 'login.flow.yml', undefined, { library: true }),
      {
        pathname: '/home/dev/workspace-one/flows/scripts/text.js',
        filename: 'text.js',
        workspaceRoot: '/home/dev/workspace-one',
        script: true
      },
      fixtureIn('/home/dev/workspace-one', 'catalog.json')
    ];

    const rowOrder = () =>
      [...document.querySelectorAll('.flow-subgroup-label, .flow-row')].map((element) =>
        (element.classList.contains('flow-row') ? element.dataset.testid : element.textContent));

    it('lists them last, under their own label', () => {
      renderSection({ flows: withFixtures, workspaces, activeWorkspaceUid: 'one' });

      expect(rowOrder()).toEqual([
        'flow-row-checkout.flow.yml',
        'Libraries',
        'flow-row-login.flow.yml',
        'Scripts',
        'flow-row-text.js',
        'Fixtures',
        'flow-row-catalog.json'
      ]);
    });

    it('labels nothing when a scope has no fixtures', () => {
      renderSection({ flows, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.queryByTestId('flow-subgroup-fixtures')).not.toBeInTheDocument();
    });

    it('is listed by its filename', () => {
      renderSection({ flows: withFixtures, workspaces, activeWorkspaceUid: 'one' });

      expect(screen.getByTestId('flow-row-catalog.json')).toHaveTextContent('catalog.json');
    });

    it('opens the fixture in its own editor tab, named by its file', () => {
      const { store } = renderSection({ flows: withFixtures, workspaces, activeWorkspaceUid: 'one' });

      fireEvent.click(screen.getByTestId('flow-row-catalog.json'));

      expect(store.getState().tabs.tabs).toEqual([
        expect.objectContaining({
          type: 'flow-fixture',
          pathname: '/home/dev/workspace-one/flows/fixtures/catalog.json',
          tabName: 'catalog.json'
        })
      ]);
    });

    /**
     * Neither of §4.3's items means anything for a data file, and §4.5's rename does not either: a
     * fixture is named by the path written into every flow that reads it, and nothing here rewrites
     * those.
     */
    it('carries no row menu', () => {
      renderSection({ flows: [fixtureIn('/home/dev/workspace-one', 'catalog.json')], workspaces, activeWorkspaceUid: 'one' });

      expect(screen.queryByTestId('flow-menu-trigger')).not.toBeInTheDocument();
    });

    /** §4.6's folders are counted from `flows/fixtures/`, so the label is not restated as a row. */
    it('folds a nested fixture from the fixtures directory', () => {
      renderSection({
        flows: [fixtureIn('/home/dev/workspace-one', 'orders/large.json')],
        workspaces,
        activeWorkspaceUid: 'one'
      });

      expect(screen.queryByTestId('flow-folder-fixtures')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('flow-folder-orders'));

      expect(screen.getByTestId('flow-row-orders/large.json')).toBeInTheDocument();
    });
  });
});
