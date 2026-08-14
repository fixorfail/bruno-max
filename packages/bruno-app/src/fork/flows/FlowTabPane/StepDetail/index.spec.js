import React from 'react';

// The real editor pulls the store in through its CodeMirror setup; these scenarios are about which
// capture the pane asks for and how it reports a read that failed, not about syntax highlighting.
jest.mock('components/CodeEditor', () => ({ value }) => <pre data-testid="body">{value}</pre>);
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // `state.app.preferences` is where the code font comes from, exactly as every other
  // CodeEditor consumer reads it.
  const store = configureStore({
    reducer: { flows: flowsReducer, app: () => ({ preferences: { font: {} } }) }
  });
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

  it('pretty-prints a JSON body and shows it last', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({
      request: {
        method: 'POST',
        url: 'https://x/pay',
        headers: { 'content-type': 'application/json' },
        // 002 §11.2's CapturedBody is a tagged union — the text kind carries `text`, and a captured
        // body is whatever went over the wire, which for JSON is usually one line.
        body: { kind: 'text', contentType: 'application/json', text: '{"amount":100,"currency":"GBP"}' }
      }
    });
    renderPane({ iteration: undefined });

    const body = await screen.findByTestId('body');
    expect(body).toHaveTextContent('"amount": 100');
    expect(body.textContent).toContain('\n');
    // §9 puts the payload last, after the headers and the declared outputs.
    const rendered = [...document.querySelectorAll('.detail-row, [data-testid="body"]')];
    expect(rendered[rendered.length - 1]).toBe(body);
  });

  it('names a binary body rather than trying to show it', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({
      response: {
        status: 200,
        headers: {},
        responseTimeMs: 12,
        body: { kind: 'binary', contentType: 'application/pdf', byteLength: 2048, file: 'attempt-1.response.pdf' }
      }
    });
    renderPane({ iteration: undefined });
    fireEvent.click(screen.getByTestId('flow-step-tab-response'));

    // 001 §14.5 never inlines a binary body; it names the sibling artifact it wrote instead.
    expect(await screen.findByText(/attempt-1\.response\.pdf/)).toBeInTheDocument();
  });

  it('says so when the run reported no capture directory at all', async () => {
    renderPane({ runDir: undefined, iteration: undefined });

    expect(await screen.findByText(/did not report a capture directory/)).toBeInTheDocument();
    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});
