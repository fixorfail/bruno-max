import React from 'react';

// The environment list reaches `providers/Theme` through `ColorBadge` and `ToolHint`. These
// scenarios are about the selection, not about colour.
jest.mock('providers/Theme', () => ({
  useTheme: () => ({ theme: jest.requireActual('themes/index').dark, displayedTheme: 'dark' })
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import tabsReducer from 'providers/ReduxStore/slices/tabs';
import themes from 'themes/index';
import FlowTabHeader from './index';

/**
 * 002 §4.2 and §7.2 — the header above a flow tab's strip, standing in for a collection's.
 *
 * The environment selector is on it for the reason it is on that one: someone looking for the
 * environment looks where the app has always kept it.
 */

const theme = themes.dark || Object.values(themes)[0];
const tab = { uid: 'tab-1', type: 'flow', collectionUid: 'scratch-1', pathname: '/workspace/flows/checkout.flow.yml' };

const environments = {
  globalEnvironments: [
    { uid: 'env-1', name: 'staging', variables: [] },
    { uid: 'env-2', name: 'production', variables: [] }
  ],
  activeGlobalEnvironmentUid: 'env-1'
};

const renderHeader = (globalEnvironments = environments) => {
  const store = configureStore({
    reducer: { tabs: tabsReducer, globalEnvironments: () => globalEnvironments }
  });

  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <FlowTabHeader tab={tab} />
      </ThemeProvider>
    </Provider>
  );

  return store;
};

const open = (state) => {
  const store = renderHeader(state);
  fireEvent.click(screen.getByTestId('flow-environment'));
  return store;
};

describe('the flow tab header (§4.2)', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn().mockResolvedValue(undefined) };
  });

  it('names the feature, and carries the environment selector where a collection carries it', () => {
    renderHeader();

    expect(screen.getByText('API Flows')).toBeInTheDocument();
    expect(screen.getByTestId('flow-environment')).toHaveTextContent('staging');
  });

  /** Upstream's own empty-state class, which is what draws the dashed border everywhere else. */
  it('marks having no environment the way the app marks it everywhere', () => {
    renderHeader({ globalEnvironments: [], activeGlobalEnvironmentUid: null });

    const trigger = screen.getByTestId('flow-environment');
    expect(trigger).toHaveTextContent('No Environment');
    expect(trigger).toHaveClass('no-environments');
  });

  it('offers the workspace environments', () => {
    open();

    expect(screen.getAllByTestId('env-list-item').map((item) => item.textContent)).toEqual([
      'staging',
      'production'
    ]);
  });

  /**
   * The app's own selection, not a private one: every request in the app runs against the same
   * environment, and a flow choosing separately would run against different values than the request
   * beside it.
   */
  it('selects through the app, so a request in the next tab agrees with the run', async () => {
    open();

    fireEvent.click(screen.getByText('production'));

    await waitFor(() =>
      expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
        'renderer:select-global-environment',
        expect.objectContaining({ environmentUid: 'env-2' })
      ));
  });

  /** Running against none is a choice — a flow can take every value from `.env` or an override. */
  it('offers no environment at all, and can go back to it', async () => {
    open();

    fireEvent.click(screen.getByTestId('env-no-environment-item'));

    await waitFor(() =>
      expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
        'renderer:select-global-environment',
        expect.objectContaining({ environmentUid: null })
      ));
  });

  /** The list's own actions, pointed at the one surface where a workspace environment is edited. */
  it('opens the workspace environments from Configure, through the tab\'s own collection', () => {
    const store = open();

    fireEvent.click(screen.getByTestId('configure-env'));

    expect(store.getState().tabs.tabs).toEqual([
      expect.objectContaining({ type: 'workspaceEnvironments', collectionUid: 'scratch-1' })
    ]);
  });

  /** A workspace with none still needs the way in, which is what the list's empty state is for. */
  it('offers the way in where a workspace has no environments yet', () => {
    open({ globalEnvironments: [], activeGlobalEnvironmentUid: null });

    expect(screen.getByText(/Ready to get started/)).toBeInTheDocument();
  });
});
