import React from 'react';

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
import RenameScript from './index';

/** 002 §4.5 — the rename, and what the renamed file's open tab does about it. */

const theme = themes.dark || Object.values(themes)[0];

const script = {
  pathname: '/home/dev/workspace-one/flows/scripts/text.js',
  filename: 'text.js',
  workspaceRoot: '/home/dev/workspace-one',
  script: true
};

const renamed = '/home/dev/workspace-one/flows/scripts/digits.js';

const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

const renderDialog = (flowsState = {}) => {
  const store = configureStore({
    reducer: { flows: flowsReducer, tabs: tabsReducer },
    preloadedState: { flows: { ...initialFlowsState(), flows: [script], ...flowsState } }
  });

  return {
    store,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <RenameScript script={script} onClose={() => {}} />
        </ThemeProvider>
      </Provider>
    )
  };
};

const submit = () => fireEvent.click(screen.getByTestId('rename-script-submit-btn'));
const typeName = (value) => fireEvent.change(screen.getByTestId('rename-script-file-name'), { target: { value } });
const sent = (invoke) => invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-rename-script')[1];

describe('RenameScript', () => {
  let invoke;

  beforeEach(() => {
    mockUid = 0;
    invoke = jest.fn(async (channel, request) =>
      (channel === 'renderer:flow-rename-script'
        ? `/home/dev/workspace-one/flows/scripts/${request.filename}`
        : undefined));
    window.ipcRenderer = { invoke };
  });

  it('opens on the stem and appends the extension itself', async () => {
    renderDialog();

    expect(screen.getByTestId('rename-script-file-name')).toHaveValue('text');
    typeName('digits');
    submit();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('renderer:flow-rename-script', expect.anything()));
    expect(sent(invoke)).toMatchObject({ entry: script.pathname, filename: 'digits.js' });
  });

  it('refuses a name the filesystem would not take, and sends nothing', async () => {
    renderDialog();

    typeName('  ');
    submit();

    expect(await screen.findByText('File name cannot be empty.')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('renderer:flow-rename-script', expect.anything());
  });

  it('points the script tab at where it went, renamed', async () => {
    const { store } = renderDialog();
    store.dispatch(
      addTab({
        uid: 'tab-script',
        type: 'flow-script',
        pathname: script.pathname,
        tabName: 'text.js',
        collectionUid: 'c1',
        preview: false
      })
    );

    typeName('digits');
    submit();

    await waitFor(() =>
      expect(store.getState().tabs.tabs.map((tab) => [tab.type, tab.pathname, tab.tabName])).toEqual([
        ['flow-script', renamed, 'digits.js']
      ]));
  });

  /** The editing session is keyed by path, so an open editor keeps its text across the rename. */
  it('carries the editor session across with the file', async () => {
    const { store } = renderDialog({
      sources: { [script.pathname]: { content: 'const a = 2;\n', saved: 'const a = 1;\n' } }
    });

    typeName('digits');
    submit();

    await waitFor(() => expect(store.getState().flows.sources[renamed]).toBeDefined());
    expect(store.getState().flows.sources[renamed].content).toBe('const a = 2;\n');
    expect(store.getState().flows.sources[script.pathname]).toBeUndefined();
  });
});
