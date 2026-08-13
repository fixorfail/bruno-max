import reducer, {
  flowsLoaded,
  flowTreeUpdated,
  describeSucceeded,
  runEventsReceived,
  pastRunLoaded
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
        result: { id: 'charge', status: 'skipped', reason: 'unresolved-dependency', attempts: 0, assertions: [] }
      }
    ]);

    // 002-C R6: the vocabulary is 001 §14.6's, unparaphrased.
    expect(state.runs[pathname].steps[0].charge).toMatchObject({
      state: 'skipped',
      reason: 'unresolved-dependency'
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
                  { id: 'charge', status: 'failed', reason: 'assertion-failed', attempts: 1, assertions: [] }
                ]
              }
            ]
          }
        }
      })
    );

    expect(state.runs[pathname].steps[0].charge).toMatchObject({ state: 'failed', reason: 'assertion-failed' });
    expect(state.runs[pathname].status).toBe('failed');
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
});
