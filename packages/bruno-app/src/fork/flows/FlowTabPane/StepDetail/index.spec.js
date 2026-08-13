import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import StepDetail from './index';

/**
 * 002 §9. The pane must never assert something about the run that it is in no position to know:
 * a capture it could not read is not a step that sent nothing.
 */

const theme = themes.dark || Object.values(themes)[0];
const node = { state: 'success', attempts: 1, assertions: [], outputs: {} };

const renderPane = (props) => {
  const store = configureStore({ reducer: { flows: flowsReducer } });
  return render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <StepDetail stepId="login" node={node} runDir="/runs/one" captureEnabled {...props} />
      </ThemeProvider>
    </Provider>
  );
};

describe('StepDetail', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn() };
  });

  it('asks for the capture the way a non-dataset run wrote it', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
    renderPane({ iteration: undefined });

    await waitFor(() => expect(window.ipcRenderer.invoke).toHaveBeenCalled());
    // 001 §14.5 nests under `iteration-N` only for a dataset flow; naming iteration 0 for a flow
    // without one reads a directory that was never created, and the step pane then reported the
    // step as having sent nothing.
    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:flow-read-capture', {
      dir: '/runs/one',
      stepId: 'login',
      iteration: undefined,
      attempt: 1
    });
  });

  it('says the read failed rather than claiming nothing was sent', async () => {
    window.ipcRenderer.invoke.mockRejectedValue(new Error('no capture for login attempt 1'));
    renderPane({ iteration: undefined });

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing was sent')).not.toBeInTheDocument();
  });

  it('says so when the run reported no capture directory at all', async () => {
    renderPane({ runDir: undefined, iteration: undefined });

    expect(await screen.findByText(/did not report a capture directory/)).toBeInTheDocument();
    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});
