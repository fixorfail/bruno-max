import reducer, {
  flowsLoaded,
  flowTreeUpdated,
  describeSucceeded,
  runEventsReceived,
  pastRunLoaded,
  requestLogsReceived
} from './slice';

/**
 * 002-C R4 — the renderer computes no semantics. These assert the slice *folds* what the engine
 * reports and derives nothing 001 defines.
 */

const workspaceRoot = '/workspace';
const pathname = '/workspace/flows/checkout.flow.yml';
const entry = { pathname, filename: 'checkout.flow.yml', workspaceRoot };

const withEvents = (state, runId, events) => reducer(state, runEventsReceived({ runId, events }));

const started = (state = undefined, extras = {}) =>
  withEvents(state, 'run-1', [
    { type: 'run:start', runId: 'run-1', flow: pathname, iterationCount: 1, ...extras }
  ]);

describe('the flows slice', () => {
  it('replaces one scope on reload without disturbing another', () => {
    const other = { pathname: '/other/flows/a.flow.yml', filename: 'a.flow.yml', workspaceRoot: '/other' };
    let state = reducer(undefined, flowsLoaded({ workspaceRoot: '/other', flows: [other] }));
    state = reducer(state, flowsLoaded({ workspaceRoot, flows: [entry] }));
    state = reducer(state, flowsLoaded({ workspaceRoot, flows: [] }));

    expect(state.flows).toEqual([other]);
  });

  it('drops a deleted flow and its description', () => {
    let state = reducer(undefined, flowsLoaded({ workspaceRoot, flows: [entry] }));
    state = reducer(state, describeSucceeded({ pathname, description: { nodes: [] } }));
    state = reducer(state, flowTreeUpdated({ event: 'unlinkFile', entry }));

    expect(state.flows).toEqual([]);
    expect(state.descriptions[pathname]).toBeUndefined();
  });

  it('invalidates the description when the file changes, so diagnostics refresh', () => {
    let state = reducer(undefined, flowsLoaded({ workspaceRoot, flows: [entry] }));
    state = reducer(state, describeSucceeded({ pathname, description: { nodes: [] } }));
    state = reducer(state, flowTreeUpdated({ event: 'changeFile', entry }));

    expect(state.descriptions[pathname]).toBeUndefined();
    expect(state.flows).toHaveLength(1);
  });

  it('keeps the capture directory the run reported at start', () => {
    const state = started(undefined, { captureDir: '/workspace/.bruno-runs/2026-a3f9' });

    expect(state.runs[pathname].dir).toBe('/workspace/.bruno-runs/2026-a3f9');
  });

  it('attributes a batch to its flow without the sender repeating the path', () => {
    let state = started();
    state = withEvents(state, 'run-1', [{ type: 'step:start', id: 'login', index: 0 }]);

    expect(state.runs[pathname].steps[0].login.state).toBe('running');
  });

  it('only calls a step retrying from the second attempt', () => {
    let state = started();
    state = withEvents(state, 'run-1', [
      { type: 'step:start', id: 'poll', index: 0 },
      { type: 'step:attempt', id: 'poll', index: 0, attempt: 1 }
    ]);
    expect(state.runs[pathname].steps[0].poll.state).toBe('running');

    state = withEvents(state, 'run-1', [{ type: 'step:attempt', id: 'poll', index: 0, attempt: 2 }]);
    expect(state.runs[pathname].steps[0].poll).toMatchObject({ state: 'retrying', attempt: 2 });
  });

  it('stores a terminal status and reason verbatim', () => {
    let state = started();
    state = withEvents(state, 'run-1', [
      {
        type: 'step:end',
        id: 'charge',
        index: 0,
        result: {
          id: 'charge',
          status: 'skipped',
          reason: 'unresolved-dependency',
          message: 'never produced: steps.login.token',
          attempts: 0,
          assertions: []
        }
      }
    ]);

    // 002-C R6: the vocabulary is 001 §14.6's, unparaphrased — and the message that names the
    // occurrence travels with it, since the reason alone says which rule fired and nothing else.
    expect(state.runs[pathname].steps[0].charge).toMatchObject({
      state: 'skipped',
      reason: 'unresolved-dependency',
      message: 'never produced: steps.login.token'
    });
  });

  /**
   * 001 §11.2 fails a run through a *skipped* step, so the counts under the word `failed` can read
   * `0 failed` — and only the engine knows which step it acted on.
   */
  describe('the verdict names the steps that decided it (§8.4)', () => {
    const ended = (iterations) =>
      withEvents(started(), 'run-1', [
        {
          type: 'run:end',
          result: {
            status: 'failed',
            summary: { total: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0 },
            iterations
          }
        }
      ]);

    it('keys them by iteration, the way the steps are', () => {
      const state = ended([
        { index: 0, status: 'passed', decidedBy: [] },
        { index: 1, status: 'failed', decidedBy: ['charge'] }
      ]);

      expect(state.runs[pathname].decidedBy).toEqual({ 0: [], 1: ['charge'] });
    });

    /** A run stored before the field existed reports none, which is not "nothing decided it". */
    it('folds a stored run the same way, and an iteration that reported none as none', () => {
      const state = reducer(
        undefined,
        pastRunLoaded({
          pathname,
          stored: {
            runId: 'run-old',
            dir: '/workspace/.bruno-runs/old',
            state: 'complete',
            status: 'failed',
            capturedSteps: [],
            result: { iterations: [{ index: 0, steps: [], decidedBy: ['charge'] }, { index: 1, steps: [] }] }
          }
        })
      );

      expect(state.runs[pathname].decidedBy).toEqual({ 0: ['charge'], 1: [] });
    });

    it('leaves an interrupted run, which has no summary to report one in, with none', () => {
      const state = reducer(
        undefined,
        pastRunLoaded({
          pathname,
          stored: { runId: 'run-old', dir: '/runs/old', state: 'interrupted', capturedSteps: ['login'] }
        })
      );

      expect(state.runs[pathname].decidedBy).toEqual({});
    });
  });

  it('keeps two iterations of the same step apart', () => {
    let state = started();
    state = withEvents(state, 'run-1', [
      { type: 'step:start', id: 'login', index: 0 },
      { type: 'step:start', id: 'login', index: 1 }
    ]);
    state = withEvents(state, 'run-1', [
      { type: 'step:end', id: 'login', index: 0, result: { status: 'success', assertions: [] } }
    ]);

    expect(state.runs[pathname].steps[0].login.state).toBe('success');
    expect(state.runs[pathname].steps[1].login.state).toBe('running');
  });

  it('ignores events for a run it never saw start', () => {
    const state = withEvents(undefined, 'run-elsewhere', [{ type: 'step:start', id: 'login', index: 0 }]);

    expect(state.runs).toEqual({});
  });

  it('folds a stored run into the same shape a live one has', () => {
    const state = reducer(
      undefined,
      pastRunLoaded({
        pathname,
        stored: {
          runId: 'run-old',
          dir: '/workspace/.bruno-runs/old',
          state: 'complete',
          status: 'failed',
          summary: { total: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0 },
          capturedSteps: ['login'],
          result: {
            iterations: [
              {
                index: 0,
                steps: [
                  { id: 'login', status: 'success', attempts: 1, assertions: [] },
                  {
                    id: 'charge',
                    status: 'failed',
                    reason: 'assertion-failed',
                    message: 'res.body.ok eq true — expected true, got false',
                    attempts: 1,
                    assertions: []
                  }
                ]
              }
            ]
          }
        }
      })
    );

    expect(state.runs[pathname].steps[0].charge).toMatchObject({
      state: 'failed',
      reason: 'assertion-failed',
      message: 'res.body.ok eq true — expected true, got false'
    });
    expect(state.runs[pathname].status).toBe('failed');
  });

  /**
   * §4.3 makes editing a running flow a two-second operation, and saving clears the stored
   * description — so a run that did not pin its own graph would be redrawn from the edit while it
   * was still executing.
   */
  describe('a live run pins the graph it started with', () => {
    const description = { nodes: [{ id: 'login' }], edges: [], slots: [], diagnostics: [] };

    it('keeps the description run:start reported', () => {
      const state = started(undefined, { description });

      expect(state.runs[pathname].description).toEqual(description);
    });

    it('holds it while the file behind it changes', () => {
      let state = started(undefined, { description });
      state = reducer(state, flowTreeUpdated({ event: 'changeFile', entry }));

      // The stored description is cleared so §6 re-describes the file; the run's own is not.
      expect(state.descriptions[pathname]).toBeUndefined();
      expect(state.runs[pathname].description).toEqual(description);
    });

    /** Under --no-capture there is no snapshot to report, and the view falls back to the file. */
    it('leaves it undefined when the run recorded none', () => {
      const state = started();

      expect(state.runs[pathname].description).toBeUndefined();
    });
  });

  /**
   * 001 §14.5's snapshot. Without it a past run is drawn on today's graph, so a step renamed since
   * loses its outcome silently and one added since reads as a step that never ran.
   */
  it('keeps the graph the run executed, so it is not drawn on the current one', () => {
    const description = { nodes: [{ id: 'login' }], edges: [], slots: [], diagnostics: [] };
    const state = reducer(
      undefined,
      pastRunLoaded({
        pathname,
        stored: {
          runId: 'run-old',
          dir: '/workspace/.bruno-runs/old',
          state: 'complete',
          status: 'passed',
          capturedSteps: ['login'],
          description,
          source: 'steps:\n  - id: login\n',
          result: { iterations: [{ index: 0, steps: [{ id: 'login', status: 'success', attempts: 1, assertions: [] }] }] }
        }
      })
    );

    expect(state.runs[pathname].description).toEqual(description);
    expect(state.runs[pathname].source).toContain('login');
  });

  /** A run written before snapshots existed has none, and falls back to the current graph. */
  it('leaves the description undefined for a run that recorded none', () => {
    const state = reducer(
      undefined,
      pastRunLoaded({
        pathname,
        stored: { runId: 'run-old', dir: '/d', state: 'complete', capturedSteps: [], result: undefined }
      })
    );

    expect(state.runs[pathname].description).toBeUndefined();
  });

  it('renders an interrupted run from its captures without claiming an outcome', () => {
    const state = reducer(
      undefined,
      pastRunLoaded({
        pathname,
        stored: {
          runId: 'run-killed',
          dir: '/workspace/.bruno-runs/killed',
          state: 'interrupted',
          capturedSteps: ['login'],
          result: undefined
        }
      })
    );

    expect(state.runs[pathname].status).toBeUndefined();
    expect(state.runs[pathname].steps[0].login).toEqual({ state: 'ran' });
    expect(state.runs[pathname].steps[0].charge).toBeUndefined();
  });

  describe('the network log (§8.5)', () => {
    const logs = (count, from = 0) =>
      Array.from({ length: count }, (unused, offset) => ({ runId: 'run-1', attempt: from + offset }));

    it('keeps batches in the order they arrived', () => {
      const first = reducer(undefined, requestLogsReceived({ requests: logs(2) }));
      const state = reducer(first, requestLogsReceived({ requests: logs(1, 2) }));

      expect(state.requestLogs.map((log) => log.attempt)).toEqual([0, 1, 2]);
    });

    it('drops the oldest rather than growing without bound', () => {
      const state = reducer(undefined, requestLogsReceived({ requests: logs(600) }));

      expect(state.requestLogs).toHaveLength(500);
      expect(state.requestLogs[0].attempt).toBe(100);
      expect(state.requestLogs[499].attempt).toBe(599);
    });
  });
});
