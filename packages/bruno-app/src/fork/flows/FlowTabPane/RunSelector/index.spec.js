import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const stored = (runId) => ({
  runId,
  dir: `/w/.bruno-runs/${runId}`,
  state: 'complete',
  status: 'passed',
  summary: { total: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0 },
  result: { iterations: [{ index: 0, steps: [] }] },
  capturedSteps: []
});

const renderSelector = async (entries, run) => {
  window.ipcRenderer = { invoke: jest.fn().mockResolvedValue(entries) };
  const store = configureStore({ reducer: { flows: flowsReducer } });

  if (run) {
    store.dispatch({ type: 'flows/pastRunLoaded', payload: { pathname: flow.pathname, stored: run } });
  }

  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RunSelector flow={flow} description={undefined} run={store.getState().flows.runs[flow.pathname]} />
      </ThemeProvider>
    </Provider>
  );

  const select = await screen.findByTestId('flow-run-selector');
  // The list arrives after the first render, and every assertion here is about what it holds.
  if (entries.length) {
    await screen.findByText(new RegExp(entries[0].startedAt.slice(0, 10)));
  }

  return { store, select };
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

  /**
   * §10: `current` is the flow as it stands, and the file can have been edited since the newest run
   * in the list — so it has to stay reachable *after* a run, not only before the first one.
   */
  it('offers current while a finished run is open', async () => {
    const { select } = await renderSelector([entry('a')], stored('a'));

    expect(within(select).getByText('current')).toBeInTheDocument();
    expect(select.value).toBe('/w/.bruno-runs/a');
  });

  it('drops the open run when current is chosen', async () => {
    const { store, select } = await renderSelector([entry('a')], stored('a'));

    fireEvent.change(select, { target: { value: '' } });

    expect(store.getState().flows.runs[flow.pathname]).toBeUndefined();
    expect(store.getState().flows.flowByRunId.a).toBeUndefined();
  });

  /**
   * The run that just finished stays selected: returning to `current` is a second act, not what a
   * run ending does on its own.
   */
  it('keeps a run selected when it is not in the list yet', async () => {
    const { select } = await renderSelector([], stored('a'));

    expect(select.value).toBe('open');
    expect(within(select).getByText(/this run · passed/)).toBeInTheDocument();
  });

  /** A run started without capture has no directory to be listed from, and is still not `current`. */
  it('names an uncaptured run rather than showing it as current', async () => {
    const { select } = await renderSelector([], { ...stored('a'), dir: undefined });

    expect(select.value).toBe('open');
    expect(within(select).getByText(/not captured/)).toBeInTheDocument();
  });

  /**
   * Every option here replaces the run state events are folded into, and a live run has nowhere to
   * be restored from — its Cancel control (§7.1) would go with it, mid-run.
   */
  it('locks while a run is executing', async () => {
    const { select } = await renderSelector([entry('a')], { ...stored('a'), state: 'running', status: undefined });

    expect(select).toBeDisabled();
  });
});
