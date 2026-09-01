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
      fireEvent.click(screen.getByTestId('flows-header-add-menu-create-flow'));
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
      fireEvent.click(screen.getByTestId('flows-header-add-menu-create-flow'));
      await screen.findByTestId('create-flow-api-auth-v2.yaml');

      expect(screen.queryByTestId('create-flow-api-other.yaml')).not.toBeInTheDocument();
    });
  });
});
