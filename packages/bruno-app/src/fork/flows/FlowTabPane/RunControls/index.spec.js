import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import RunControls from './index';

/**
 * 002 §8.4 — the run summary.
 *
 * 001 §11.2's `failOnUnresolved` fails a run through a step that is *skipped*, so the counts here
 * can read `0 failed` under the word `failed` with nothing on screen connecting the two.
 */

const theme = themes.dark || Object.values(themes)[0];
const pathname = '/workspace/flows/checkout.flow.yml';
const flow = { pathname, filename: 'checkout.flow.yml', workspaceRoot: '/workspace' };

const summary = { total: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0 };

const renderControls = (run) => {
  const store = configureStore({ reducer: { flows: flowsReducer } });

  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RunControls
          flow={flow}
          description={{ diagnostics: [], params: [], isLibrary: false }}
          run={run}
          configuration={{ capture: true }}
          onConfigurationChange={() => {}}
        />
      </ThemeProvider>
    </Provider>
  );

  return store;
};

/** The run this is all about: nothing red, and a red verdict. */
const skipDecided = {
  runId: 'run-1',
  state: 'complete',
  status: 'failed',
  summary,
  selectedIteration: 0,
  decidedBy: { 0: ['echo'] },
  steps: {
    0: {
      bearer_check: { state: 'success' },
      echo: { state: 'skipped', reason: 'unresolved-dependency', message: 'never produced: steps.bearer_check.token' }
    }
  }
};

/**
 * 002 §7.2's Environment control. §4.2's flow header carries no environment selector — a collection's
 * does — so without this there is nowhere to choose one while looking at a flow, and a run silently
 * uses whatever was last selected elsewhere in the app.
 */
describe('the run summary', () => {
  it('names the step a failed run with no failed step fell on', () => {
    renderControls(skipDecided);

    expect(screen.getByTestId('flow-run-cause-echo')).toBeInTheDocument();
  });

  /** One click from the verdict to §9's pane, where the reason and its message already render. */
  it('selects that step, which is where the explanation is', () => {
    const store = renderControls(skipDecided);

    fireEvent.click(screen.getByTestId('flow-run-cause-echo'));

    expect(store.getState().flows.selectedStep[pathname]).toBe('echo');
  });

  /** A red node says it itself, in the place that shows what it was; a chip would say it twice. */
  it('says nothing about a step the graph already draws red', () => {
    renderControls({
      ...skipDecided,
      summary: { ...summary, failed: 1, skipped: 0 },
      decidedBy: { 0: ['echo'] },
      steps: { 0: { echo: { state: 'failed', reason: 'unexpected-status' } } }
    });

    expect(screen.queryByTestId('flow-run-cause-echo')).not.toBeInTheDocument();
  });

  /** §8.3 shows one iteration at a time, so a cause is the displayed iteration's or it is misleading. */
  it('names the displayed iteration\'s causes, not another row\'s', () => {
    renderControls({
      ...skipDecided,
      selectedIteration: 1,
      decidedBy: { 0: ['echo'], 1: [] },
      steps: { 0: skipDecided.steps[0], 1: { bearer_check: { state: 'success' }, echo: { state: 'success' } } }
    });

    expect(screen.queryByTestId('flow-run-cause-echo')).not.toBeInTheDocument();
  });

  it('says nothing about a run that passed', () => {
    renderControls({ ...skipDecided, status: 'passed', decidedBy: { 0: [] } });

    expect(screen.queryByTestId('flow-run-cause-echo')).not.toBeInTheDocument();
  });

  /** A run stored before `decidedBy` existed, which is not a run nothing decided. */
  it('says nothing where the run reported no causes at all', () => {
    renderControls({ ...skipDecided, decidedBy: undefined });

    expect(screen.queryByTestId('flow-run-cause-echo')).not.toBeInTheDocument();
  });
});
