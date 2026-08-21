import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import { runFlow } from 'fork/flows/actions';
import RunControls from './index';

jest.mock('fork/flows/actions', () => ({
  ...jest.requireActual('fork/flows/actions'),
  // The thunk reaches IPC; what this file is about is the argument it is called with.
  runFlow: jest.fn(() => () => Promise.resolve()),
  cancelFlowRun: jest.fn(() => () => Promise.resolve())
}));

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

const renderControls = (run, configuration = {}) => {
  const store = configureStore({ reducer: { flows: flowsReducer } });

  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RunControls
          flow={flow}
          description={{ diagnostics: [], params: [], isLibrary: false }}
          run={run}
          configuration={configuration}
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

/**
 * 002 §7.1 — the run control, and the kinds of run hanging off it.
 *
 * Capture was a checkbox beside the button, which made the ordinary run a two-part act and left the
 * box's state to be remembered between runs: the run that wrote nothing looked exactly like the one
 * that did until you went looking for it.
 */
describe('the run control', () => {
  const captureOf = () => runFlow.mock.calls.at(-1)[0].configuration.capture;

  it('captures, on a single click, with nothing else to read first', () => {
    renderControls(undefined);

    fireEvent.click(screen.getByTestId('flow-run'));

    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(captureOf()).toBe(true);
  });

  it('offers running without capture, and runs on the click that chooses it', () => {
    renderControls(undefined);

    fireEvent.click(screen.getByTestId('flow-run-options'));
    fireEvent.click(screen.getByTestId('flow-run-without-capture'));

    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(captureOf()).toBe(false);
  });

  /** The point of taking it off a checkbox: a run that wrote nothing cannot silently become the default. */
  it('does not remember it — the next Run captures again', async () => {
    renderControls(undefined);

    fireEvent.click(screen.getByTestId('flow-run-options'));
    fireEvent.click(screen.getByTestId('flow-run-without-capture'));

    // The control disables itself until the run has started, which is the state the second click
    // would otherwise land in.
    await waitFor(() => expect(screen.getByTestId('flow-run')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('flow-run'));

    expect(runFlow).toHaveBeenCalledTimes(2);
    expect(captureOf()).toBe(true);
  });

  it('keeps the rest of the run configuration on both', () => {
    renderControls(undefined, { concurrency: 3 });

    fireEvent.click(screen.getByTestId('flow-run-options'));
    fireEvent.click(screen.getByTestId('flow-run-without-capture'));

    expect(runFlow.mock.calls.at(-1)[0].configuration).toEqual({ concurrency: 3, capture: false });
  });

  it('has no capture control of its own left beside the button', () => {
    renderControls(undefined);

    expect(screen.queryByLabelText('Capture')).toBeNull();
    expect(screen.queryByText('Capture')).toBeNull();
  });

  /** §6: errors block the run, and they block the other ways of starting one with it. */
  it('blocks both halves while the flow has errors', () => {
    render(
      <Provider store={configureStore({ reducer: { flows: flowsReducer } })}>
        <ThemeProvider theme={theme}>
          <RunControls
            flow={flow}
            description={{ diagnostics: [{ severity: 'error', code: 'x', message: 'y' }], params: [], isLibrary: false }}
            run={undefined}
            configuration={{}}
            onConfigurationChange={() => {}}
          />
        </ThemeProvider>
      </Provider>
    );

    expect(screen.getByTestId('flow-run')).toBeDisabled();
    expect(screen.getByTestId('flow-run-options').className).toContain('is-disabled');
  });
});
