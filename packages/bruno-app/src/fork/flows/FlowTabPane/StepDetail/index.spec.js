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
// 001 §13.2 reports `capturePath` on a step whose capture reached disk, and §9 reads one only where
// the run says there is one — a fixture without it is a step that ran and recorded nothing.
const node = { state: 'success', attempts: 1, assertions: [], outputs: {}, capturePath: '/runs/one/login' };

const renderPane = (props) => {
  // `state.app.preferences` is where the code font comes from, exactly as every other
  // CodeEditor consumer reads it.
  const store = configureStore({
    reducer: { flows: flowsReducer, app: () => ({ preferences: { font: {} } }) }
  });
  const tree = (extra) => (
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <StepDetail stepId="login" node={node} running runDir="/runs/one" {...props} {...extra} />
      </ThemeProvider>
    </Provider>
  );

  const utils = render(tree());
  // `update` is how a scenario advances the run: node state is what the events fold into, and the
  // pane has to react to it rather than to being reopened.
  return { ...utils, update: (extra) => utils.rerender(tree(extra)) };
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

  /**
   * The defect this guards: select a step, then start the run. `run:start` reports the capture
   * directory before any step has written to it, so the pane read immediately, failed, and stayed
   * failed — nothing re-read when the step finished, and reopening the pane was the only cure.
   */
  it('waits for the attempt to finish instead of reading a capture that cannot exist yet', () => {
    renderPane({ iteration: undefined, node: { state: 'running', assertions: [], outputs: {} } });

    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(screen.getByText('Attempt 1 has not finished')).toBeInTheDocument();
  });

  it('reads the capture when the step ends, without the pane being reopened', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
    const { update } = renderPane({ iteration: undefined, node: { state: 'running', assertions: [], outputs: {} } });

    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();

    update({ node: { state: 'success', attempts: 1, assertions: [], outputs: {}, capturePath: '/runs/one/login' } });

    await waitFor(() => expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:flow-read-capture', {
      dir: '/runs/one',
      stepId: 'login',
      iteration: undefined,
      attempt: 1
    }));
  });

  /** An earlier attempt has settled and been written, even though the step is still going. */
  it('reads an earlier attempt while a later one is in flight', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
    renderPane({ iteration: undefined, node: { state: 'retrying', attempt: 2, assertions: [], outputs: {} } });

    await waitFor(() => expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
      'renderer:flow-read-capture',
      expect.objectContaining({ attempt: 1 })
    ));
  });

  /**
   * §9's attempts. The control is on the header rather than a tab because what it changes — the
   * request and the response — is on the tabs, and a chooser that lived on a tab of its own showed
   * nothing happening when you used it.
   */
  describe('the attempt selector (§9)', () => {
    const polled = { state: 'success', attempts: 3, assertions: [], outputs: {}, capturePath: '/runs/one/login' };

    const captureFor = (attempt) => ({
      response: {
        status: 200,
        headers: {},
        responseTimeMs: 12,
        body: { kind: 'text', contentType: 'application/json', text: `{"state":"${attempt < 3 ? 'pending' : 'ready'}"}` }
      }
    });

    it('sits between the step and its outcome, where the request and response it selects are read', () => {
      renderPane({ iteration: undefined, node: polled });

      const header = [...document.querySelector('.detail-header').children];
      expect(header.map((element) => element.className)).toEqual([
        'detail-step',
        'detail-attempt',
        `detail-status ${polled.state}`
      ]);
    });

    it('offers every attempt the step made, opening on the one that settled it', () => {
      renderPane({ iteration: undefined, node: polled });

      const options = [...screen.getByTestId('flow-step-attempt').options].map((option) => option.text);
      expect(options).toEqual(['Attempt 1', 'Attempt 2', 'Attempt 3']);
      // The final attempt is the one `StepResult` was built from, so the pane opens on the step's
      // own verdict rather than on the first of two that did not settle it.
      expect(screen.getByTestId('flow-step-attempt')).toHaveValue('3');
    });

    /** 001 §14.5 captures each retry separately because that is the only way to see what changed. */
    it('re-reads the response from the attempt chosen', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve(captureFor(attempt))
      );
      renderPane({ iteration: undefined, node: polled });
      fireEvent.click(screen.getByTestId('flow-step-tab-response'));

      expect(await screen.findByTestId('body')).toHaveTextContent('ready');

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });

      await waitFor(() => expect(screen.getByTestId('body')).toHaveTextContent('pending'));
    });

    /** A running step follows its newest *settled* attempt, so a poll's responses arrive as it goes. */
    it('follows the attempts of a running step until one is chosen', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve(captureFor(attempt))
      );
      const { update } = renderPane({
        iteration: undefined,
        node: { state: 'retrying', attempt: 2, assertions: [], outputs: {} }
      });

      await waitFor(() => expect(screen.getByTestId('flow-step-attempt')).toHaveValue('1'));

      update({ node: { state: 'retrying', attempt: 3, assertions: [], outputs: {} } });

      expect(screen.getByTestId('flow-step-attempt')).toHaveValue('2');

      // Chosen, and it stops following.
      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });
      update({ node: { state: 'retrying', attempt: 4, assertions: [], outputs: {} } });

      expect(screen.getByTestId('flow-step-attempt')).toHaveValue('1');
    });

    /**
     * The defect: `StepResult` carries the outcome of the attempt that *settled* the step, so a poll
     * that failed twice and then passed showed a passing assertion against attempt 1's response.
     * 001 §14.5 records each attempt's own outcomes in its capture, which is what makes an attempt
     * readable as one call.
     */
    it('shows the assertions the chosen attempt was given, not the step\'s', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve({
          ...captureFor(attempt),
          assertions: [{ expr: 'res.body.state', expected: 'ready', actual: attempt < 3 ? 'pending' : 'ready', passed: attempt === 3 }]
        })
      );
      renderPane({
        iteration: undefined,
        // The step's own assertions — what the pane used to show for every attempt.
        node: { ...polled, assertions: [{ expr: 'res.body.state', expected: 'ready', actual: 'ready', passed: true }] }
      });
      fireEvent.click(screen.getByTestId('flow-step-tab-assertions'));

      await waitFor(() => expect(document.querySelector('.detail-table tr')).toHaveClass('passed'));

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });

      expect(await screen.findByText('"pending"')).toBeInTheDocument();
      expect(document.querySelector('.detail-table tr')).toHaveClass('failed');
    });

    /** Validation is per-attempt for the same reason, and travels in the same file. */
    it('shows the validation the chosen attempt was given', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve({
          ...captureFor(attempt),
          validation: attempt === 3 ? undefined : { response: { valid: false, errors: [{ path: '/state', message: 'not ready' }] } }
        })
      );
      renderPane({ iteration: undefined, node: polled });
      fireEvent.click(screen.getByTestId('flow-step-tab-validation'));

      expect(await screen.findByText('No schema validation ran')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '2' } });

      expect(await screen.findByText('not ready')).toBeInTheDocument();
    });

    /**
     * Status, total duration and outputs describe the step — `run.ts` builds them from the attempt
     * that settled it and measures the duration across all of them. On an earlier attempt they are a
     * different call's, and the step's verdict is on its node in the graph regardless.
     */
    it('withholds the step-level outcome while an earlier attempt is being read', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve(captureFor(attempt))
      );
      renderPane({
        iteration: undefined,
        node: { ...polled, durationMs: 4200, outputs: { orderId: 'ord_1' } }
      });
      fireEvent.click(screen.getByTestId('flow-step-tab-response'));

      expect(await screen.findByText('success')).toBeInTheDocument();
      expect(screen.getByText('4200ms')).toBeInTheDocument();
      expect(screen.getByText('orderId')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });

      await waitFor(() => expect(screen.queryByText('success')).not.toBeInTheDocument());
      expect(screen.queryByText('4200ms')).not.toBeInTheDocument();
      expect(screen.queryByText('orderId')).not.toBeInTheDocument();
    });

    /** No captures, no attempt-level record — so there is nothing to choose between. */
    it('is absent when the run has no captures, where every outcome is the step\'s', () => {
      renderPane({ iteration: undefined, runDir: undefined, node: { ...polled, durationMs: 4200 } });

      expect(screen.queryByTestId('flow-step-attempt')).not.toBeInTheDocument();
      expect(screen.getByText('success')).toBeInTheDocument();
      expect(screen.getByText('4200ms')).toBeInTheDocument();
    });

    /** The one still in flight is offered too, and says what it is rather than failing a read. */
    it('offers the attempt a polling step is on, and reports it as unfinished', () => {
      renderPane({ iteration: undefined, node: { state: 'retrying', attempt: 2, assertions: [], outputs: {} } });

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '2' } });

      expect(screen.getByText('Attempt 2 has not finished')).toBeInTheDocument();
    });

    /** §10 swaps a past run under a step that stays selected; its attempt 1 is not this run's. */
    it('drops the chosen attempt when another run is opened', async () => {
      window.ipcRenderer.invoke.mockImplementation((channel, { attempt }) =>
        Promise.resolve(captureFor(attempt))
      );
      const { update } = renderPane({ iteration: undefined, node: polled });
      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });

      await waitFor(() =>
        expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
          'renderer:flow-read-capture',
          expect.objectContaining({ attempt: 1 })
        )
      );

      update({
        runDir: '/runs/two',
        node: { state: 'success', attempts: 2, assertions: [], outputs: {}, capturePath: '/runs/two/login' }
      });

      // The new run's own final attempt, not the number chosen against the run before it.
      expect(screen.getByTestId('flow-step-attempt')).toHaveValue('2');
      await waitFor(() =>
        expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
          'renderer:flow-read-capture',
          expect.objectContaining({ dir: '/runs/two', attempt: 2 })
        )
      );
    });
  });

  /**
   * §8.2's in-flight states, in the header. A running step shows no status and no duration here —
   * neither is its own until it settles — so without this its header reads like a finished step's.
   */
  describe('the in-flight spinner (§9)', () => {
    it('turns beside the attempt being read while the step is running', () => {
      window.ipcRenderer.invoke.mockResolvedValue({});
      renderPane({ iteration: undefined, node: { state: 'running', attempt: 1, assertions: [], outputs: {} } });

      expect(screen.getByTestId('flow-step-in-flight')).toBeInTheDocument();
    });

    /** A retry is the same request still in flight; a spinner that stopped would say it had landed. */
    it('stays up across the retries of a poll', () => {
      window.ipcRenderer.invoke.mockResolvedValue({});
      const { update } = renderPane({
        iteration: undefined,
        node: { state: 'running', attempt: 1, assertions: [], outputs: {} }
      });

      update({ node: { state: 'retrying', attempt: 4, assertions: [], outputs: {} } });

      expect(screen.getByTestId('flow-step-in-flight')).toBeInTheDocument();
    });

    /**
     * A node's state is the last thing the engine said, so a step that announced `step:start` and
     * never announced its end reads `running` for as long as the tab is open. Beside a run that has
     * ended, a spinner is the pane claiming a request is in flight that stopped minutes ago.
     */
    it('stops when the run ends without the step reporting, and says so instead', () => {
      window.ipcRenderer.invoke.mockResolvedValue({});
      renderPane({
        iteration: undefined,
        running: false,
        node: { state: 'running', attempt: 1, assertions: [], outputs: {} }
      });

      expect(screen.queryByTestId('flow-step-in-flight')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-step-unreported')).toBeInTheDocument();
      expect(screen.queryByText('running')).not.toBeInTheDocument();
    });

    it('stops when the step settles', () => {
      window.ipcRenderer.invoke.mockResolvedValue({});
      const { update } = renderPane({
        iteration: undefined,
        node: { state: 'retrying', attempt: 4, assertions: [], outputs: {} }
      });

      update({ node: { state: 'success', attempts: 4, durationMs: 900, assertions: [], outputs: {} } });

      expect(screen.queryByTestId('flow-step-in-flight')).not.toBeInTheDocument();
    });
  });

  /**
   * 001 §14.6's message. The reason names the rule; without the message a skipped step says
   * `unresolved-dependency` and never says which reference — and it has no capture that could.
   */
  describe('the reason and its message (§9)', () => {
    const skipped = {
      state: 'skipped',
      reason: 'unresolved-dependency',
      message: 'never produced: steps.login.token',
      attempts: 0,
      assertions: [],
      outputs: {}
    };

    it('shows the message beside the outcome it explains', () => {
      renderPane({ iteration: undefined, node: skipped });

      expect(screen.getByText(/skipped · unresolved-dependency/)).toBeInTheDocument();
      expect(screen.getByTestId('flow-step-message')).toHaveTextContent('never produced: steps.login.token');
    });

    /** The step's verdict, so it belongs with the attempt that settled the step and no other. */
    it('withholds it on an earlier attempt', () => {
      window.ipcRenderer.invoke.mockResolvedValue({});
      renderPane({
        iteration: undefined,
        node: {
          state: 'failed',
          reason: 'unexpected-status',
          message: 'got 503',
          attempts: 3,
          assertions: [],
          outputs: {},
          capturePath: '/runs/one/login'
        }
      });

      expect(screen.getByTestId('flow-step-message')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('flow-step-attempt'), { target: { value: '1' } });

      expect(screen.queryByTestId('flow-step-message')).not.toBeInTheDocument();
    });

    it('renders nothing where the engine had nothing to add', () => {
      renderPane({ iteration: undefined });

      expect(screen.queryByTestId('flow-step-message')).not.toBeInTheDocument();
    });
  });

  /**
   * 001 §14.5 lets an artifact write fail without failing the run, so a step can have dispatched,
   * been judged, and have nothing on disk. Reading anyway rendered that as "the capture could not be
   * read" — this pane blamed for a file that was never written, with the reason sitting unmentioned
   * on the run's own diagnostics.
   */
  it('says a capture was never written rather than that it could not be read', () => {
    renderPane({
      iteration: undefined,
      // §13.2 reports `capturePath` on a step that has one; this step made two attempts and has none.
      node: { state: 'failed', reason: 'assertion-failed', attempts: 2, assertions: [], outputs: {} }
    });

    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(screen.getByText(/capture was not written/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  /** 001 §11.2's skips never dispatch, so there is no capture and never will be one. */
  it('says a step that dispatched nothing sent nothing, rather than failing a read', () => {
    renderPane({
      iteration: undefined,
      node: { state: 'skipped', reason: 'condition-false', attempts: 0, assertions: [], outputs: {} }
    });

    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing was sent')).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
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

  describe('headers (§9)', () => {
    it('shows what the host reported sending, which a step declaring none still has', async () => {
      window.ipcRenderer.invoke.mockResolvedValue({
        request: {
          method: 'POST',
          url: 'https://x',
          // The capture records the sent set (001 §13.2's `requestHeaders`); a step that declared no
          // headers of its own still sent these, and the pane showed an empty gap for them.
          headers: { 'content-type': 'application/json', 'Authorization': '••••' }
        }
      });
      renderPane({ iteration: undefined });

      expect(await screen.findByText('Headers')).toBeInTheDocument();
      expect(screen.getByText('content-type')).toBeInTheDocument();
      expect(screen.getByText('Authorization')).toBeInTheDocument();
    });

    it('says so when a capture recorded none, rather than showing a gap', async () => {
      window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
      renderPane({ iteration: undefined });

      expect(await screen.findByText('None recorded')).toBeInTheDocument();
    });

    /** §13.2 types a response header `string | string[]`, and Set-Cookie genuinely repeats. */
    it('joins a repeated response header rather than rendering an array', async () => {
      window.ipcRenderer.invoke.mockResolvedValue({
        response: {
          status: 200,
          responseTimeMs: 3,
          headers: { 'set-cookie': ['a=1', 'b=2'] }
        }
      });
      renderPane({ iteration: undefined });
      fireEvent.click(screen.getByTestId('flow-step-tab-response'));

      expect(await screen.findByText('a=1, b=2')).toBeInTheDocument();
    });
  });

  describe('declared outputs (§9)', () => {
    const withOutputs = {
      state: 'success',
      attempts: 1,
      assertions: [],
      outputs: { paymentId: 'pay_1' },
      capturePath: '/runs/one/login'
    };

    const openResponse = () => fireEvent.click(screen.getByTestId('flow-step-tab-response'));

    it('sits directly above the response body, not above the tabs', async () => {
      window.ipcRenderer.invoke.mockResolvedValue({
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          responseTimeMs: 12,
          body: { kind: 'text', contentType: 'application/json', text: '{"id":"pay_1"}' }
        }
      });
      renderPane({ iteration: undefined, node: withOutputs });
      openResponse();

      const body = await screen.findByTestId('body');
      const rendered = [...document.querySelectorAll('.detail-outputs, [data-testid="body"]')];
      expect(rendered).toHaveLength(2);
      // Above the body it was read out of, and nothing between them.
      expect(rendered[0]).toHaveClass('detail-outputs');
      expect(rendered[1]).toBe(body);
    });

    /** It was on all of them, including three that have nothing to do with a value read off a response. */
    it.each(['request', 'assertions', 'validation'])('stays off the %s tab', (name) => {
      window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
      renderPane({ iteration: undefined, node: withOutputs });

      fireEvent.click(screen.getByTestId(`flow-step-tab-${name}`));

      expect(document.querySelector('.detail-outputs')).toBeNull();
    });

    /** Outputs arrive in `StepResult`, so a run with no capture still has them to show. */
    it('renders with captures disabled, where there is no body at all', () => {
      renderPane({ iteration: undefined, node: withOutputs, runDir: undefined });
      openResponse();

      expect(screen.getByText('paymentId')).toBeInTheDocument();
      expect(screen.getByText('Captures were disabled for this run')).toBeInTheDocument();
    });
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

  describe('which runs have captures (§9)', () => {
    /** 001 §13.2 omits `captureDir` at `run:start` when capture was off; its absence is the answer. */
    it('says so when the run reported no capture directory at all', async () => {
      renderPane({ runDir: undefined, iteration: undefined });

      expect(await screen.findByText('Captures were disabled for this run')).toBeInTheDocument();
      expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    /**
     * The defect: the pane read the run control's checkbox, so unchecking it to configure the *next*
     * run blanked the captures of the run on screen — and a stored run written by `bru` last week
     * inherited whatever the control happened to say now.
     */
    /**
     * The defect: the pane read the run control's checkbox, so unchecking it to configure the *next*
     * run blanked the captures of the run on screen — and a stored run written by `bru` last week
     * inherited whatever the control happened to say now. `captureEnabled` is passed here precisely
     * because it must be inert: on the old code this render showed "Captures were disabled".
     */
    it('shows a finished run captures whatever the next run is configured to do', async () => {
      window.ipcRenderer.invoke.mockResolvedValue({ request: { method: 'GET', url: 'https://x', headers: {} } });
      renderPane({ iteration: undefined, captureEnabled: false });

      expect(await screen.findByText('URL')).toBeInTheDocument();
      expect(screen.queryByText('Captures were disabled for this run')).not.toBeInTheDocument();
    });
  });
});
