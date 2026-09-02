import React from 'react';

// `jest.setup.js` stubs nanoid with only `nanoid`, and `uuid()` reaches for `customAlphabet` — so a
// retargeted tab cannot be opened in a test without this.
let mockUid = 0;
jest.mock('utils/common', () => ({
  ...jest.requireActual('utils/common'),
  uuid: () => `uid-${++mockUid}`
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import tabsReducer, { addTab } from 'providers/ReduxStore/slices/tabs';
import themes from 'themes/index';
import FlowProperties from './index';

/**
 * 002 §4.4 — what the dialog writes, and what a rename leaves behind.
 *
 * The rename half is the part worth testing here rather than through the IPC handler: the write is
 * one call, and everything after it is the app catching up with a file that moved — tabs addressing
 * a path that is gone, and a slice keyed by the same one.
 */

const theme = themes.dark || Object.values(themes)[0];

const flow = {
  pathname: '/home/dev/workspace-one/flows/checkout.flow.yml',
  filename: 'checkout.flow.yml',
  workspaceRoot: '/home/dev/workspace-one'
};

const renamed = '/home/dev/workspace-one/flows/settlement.flow.yml';

const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

const renderDialog = ({ properties, flowsState = {} }) => {
  const store = configureStore({
    reducer: { flows: flowsReducer, tabs: tabsReducer },
    preloadedState: { flows: { ...initialFlowsState(), flows: [flow], ...flowsState } }
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <FlowProperties flow={flow} properties={properties} onClose={() => {}} />
        </ThemeProvider>
      </Provider>
    )
  };
};

const SAVED = { name: 'Checkout', description: 'the happy path', tags: ['smoke'], library: false };

describe('FlowProperties', () => {
  let invoke;

  beforeEach(() => {
    mockUid = 0;
    invoke = jest.fn(async (channel, request) =>
      (channel === 'renderer:flow-update-properties'
        ? `/home/dev/workspace-one/flows/${request.filename}`
        : undefined));
    window.ipcRenderer = { invoke };
  });

  const submit = () => fireEvent.click(screen.getByTestId('flow-properties-submit-btn'));

  const updateRequest = () => invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-update-properties')[1];

  it('sends the meta block the form holds, tags split from the line', async () => {
    renderDialog({ properties: SAVED });

    fireEvent.change(screen.getByTestId('flow-properties-name'), { target: { value: 'Settlement' } });
    fireEvent.change(screen.getByTestId('flow-properties-tags'), { target: { value: 'checkout,  smoke ,' } });
    fireEvent.click(screen.getByTestId('flow-properties-library'));
    submit();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
    expect(updateRequest()).toMatchObject({
      entry: flow.pathname,
      filename: 'checkout.flow.yml',
      properties: {
        name: 'Settlement',
        description: 'the happy path',
        // Blanks between the commas are not tags, and neither is the one after the last comma.
        tags: ['checkout', 'smoke'],
        library: true
      }
    });
  });

  /**
   * §5.2's `meta.testId` — the case this flow stands for in a test-management tool. Nothing in the
   * run reads it; a report carries it, which is why it is a plain string the dialog passes through.
   */
  describe('the test id', () => {
    it('opens on the one the flow already declares', () => {
      renderDialog({ properties: { ...SAVED, testId: 'TC-4821' } });

      expect(screen.getByTestId('flow-properties-test-id')).toHaveValue('TC-4821');
    });

    it('sends it trimmed', async () => {
      renderDialog({ properties: SAVED });

      fireEvent.change(screen.getByTestId('flow-properties-test-id'), { target: { value: '  TC-4821  ' } });
      submit();

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
      expect(updateRequest().properties.testId).toBe('TC-4821');
    });

    /** Cleared is the empty string, which the writer removes the key for — not a case id of `''`. */
    it('sends an empty string when it is cleared', async () => {
      renderDialog({ properties: { ...SAVED, testId: 'TC-4821' } });

      fireEvent.change(screen.getByTestId('flow-properties-test-id'), { target: { value: '' } });
      submit();

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
      expect(updateRequest().properties.testId).toBe('');
    });
  });

  it('appends the extension to the stem rather than asking the author for it', async () => {
    renderDialog({ properties: SAVED });

    fireEvent.change(screen.getByTestId('flow-properties-file-name'), { target: { value: 'settlement' } });
    submit();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
    expect(updateRequest().filename).toBe('settlement.flow.yml');
  });

  it('refuses a file name the filesystem would not take, and sends nothing', async () => {
    renderDialog({ properties: SAVED });

    fireEvent.change(screen.getByTestId('flow-properties-file-name'), { target: { value: '' } });
    submit();

    expect(await screen.findByText('File name cannot be empty.')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything());
  });

  it('sends nothing without a name', async () => {
    renderDialog({ properties: SAVED });

    fireEvent.change(screen.getByTestId('flow-properties-name'), { target: { value: '  ' } });
    submit();

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything());
  });

  /**
   * A tab is keyed by pathname and type, so a rename otherwise leaves every tab of that flow
   * addressing a file that is gone — the pane reads "no longer on disk", and reopening the flow
   * makes a second tab beside the dead one.
   */
  describe('a rename', () => {
    // `preview: false` for the reason `openFlow` passes it: a preview tab is replaceable, so two
    // opened without it collapse into one and the fixture would not be the state being tested.
    const openTabs = (store) => {
      store.dispatch(
        addTab({ uid: 'tab-run', type: 'flow', pathname: flow.pathname, tabName: 'Checkout', collectionUid: 'c1', preview: false })
      );
      store.dispatch(
        addTab({ uid: 'tab-yaml', type: 'flow-yaml', pathname: flow.pathname, tabName: flow.filename, collectionUid: 'c1', preview: false })
      );
    };

    const rename = async () => {
      fireEvent.change(screen.getByTestId('flow-properties-name'), { target: { value: 'Settlement' } });
      fireEvent.change(screen.getByTestId('flow-properties-file-name'), { target: { value: 'settlement' } });
      submit();
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
    };

    it('points both of the flow\'s tabs at where it went, and renames each the way §4.1 does', async () => {
      const { store } = renderDialog({ properties: SAVED });
      openTabs(store);

      await rename();

      await waitFor(() =>
        expect(store.getState().tabs.tabs.map((tab) => [tab.type, tab.pathname, tab.tabName])).toEqual([
          // The run view is a view of the flow and reads by its name; the raw editor is a view of
          // the file and reads by that.
          ['flow', renamed, 'Settlement'],
          ['flow-yaml', renamed, 'settlement.flow.yml']
        ]));
    });

    it('moves the run being watched and the params typed into the panel', async () => {
      const { store } = renderDialog({
        properties: SAVED,
        flowsState: {
          runs: { [flow.pathname]: { state: 'running' } },
          configurations: { [flow.pathname]: { params: { email: 'qa@example.com' } } },
          flowByRunId: { 'run-1': flow.pathname }
        }
      });

      await rename();

      await waitFor(() => expect(store.getState().flows.runs[renamed]).toEqual({ state: 'running' }));
      const { flows: state } = store.getState();
      expect(state.configurations[renamed]).toEqual({ params: { email: 'qa@example.com' } });
      expect(state.flowByRunId['run-1']).toBe(renamed);
      expect(state.runs[flow.pathname]).toBeUndefined();
      expect(state.configurations[flow.pathname]).toBeUndefined();
    });

    /** Saving properties without touching the name is the common case and must disturb nothing. */
    it('leaves the tabs alone when only the meta changed', async () => {
      const { store } = renderDialog({ properties: SAVED });
      openTabs(store);

      fireEvent.change(screen.getByTestId('flow-properties-description'), { target: { value: 'now settled' } });
      submit();

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-update-properties', expect.anything()));
      expect(store.getState().tabs.tabs.map((tab) => [tab.uid, tab.pathname])).toEqual([
        ['tab-run', flow.pathname],
        ['tab-yaml', flow.pathname]
      ]);
    });
  });
});
