import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import RunSelector from './index';

/**
 * 002 §10. A past run opens into the graph *it* executed (001 §14.5), so the selector has to say
 * when a run was made against text the flow no longer has — the two are otherwise indistinguishable
 * in a list of timestamps.
 */

const theme = themes.dark || Object.values(themes)[0];

const flow = { pathname: '/w/flows/checkout.flow.yml', workspaceRoot: '/w' };

const entry = (runId, extra) => ({
  runId,
  dir: `/w/.bruno-runs/${runId}`,
  flow: flow.pathname,
  startedAt: '2026-08-16T10:00:00.000Z',
  state: 'complete',
  status: 'passed',
  summary: { total: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0 },
  ...extra
});

const renderSelector = async (entries) => {
  window.ipcRenderer = { invoke: jest.fn().mockResolvedValue(entries) };
  const store = configureStore({ reducer: { flows: flowsReducer } });

  const rendered = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RunSelector flow={flow} description={undefined} run={undefined} />
      </ThemeProvider>
    </Provider>
  );

  await screen.findByTestId('flow-run-selector');
  return rendered;
};

describe('RunSelector', () => {
  it('marks a run whose flow has been edited since', async () => {
    await renderSelector([entry('a', { flowChanged: true })]);

    expect(screen.getByText(/flow edited since/)).toBeInTheDocument();
  });

  it('says nothing about a run that matches the flow as it is', async () => {
    await renderSelector([entry('a', { flowChanged: false })]);

    expect(screen.queryByText(/edited since/)).not.toBeInTheDocument();
  });

  /**
   * `flowChanged` is three-valued (001 §14.5): unknown is a run that predates the digest, or a flow
   * that can no longer be read. Marking those would put a claim on every old run in the history.
   */
  it('says nothing when whether it changed is unknown', async () => {
    await renderSelector([entry('a', { flowChanged: undefined })]);

    expect(screen.queryByText(/edited since/)).not.toBeInTheDocument();
  });
});
