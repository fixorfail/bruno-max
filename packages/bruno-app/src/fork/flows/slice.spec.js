import reducer, {
  flowsLoaded,
  flowTreeUpdated,
  describeSucceeded,
  folderToggled,
  foldersCollapsed,
  foldersExpanded,
  runEventsReceived,
  suiteEventReceived,
  suiteRunCancelled,
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
  /**
   * 002 §5.6: the inputs node reports a *live* run, not only one read back from disk. The values
   * arrive on the stream — params at `run:start`, vars once per iteration as they resolve — so the
   * node stops showing boxes and starts showing the record the moment the run begins.
   */
  describe('a run\'s own inputs', () => {
    it('takes the params the run was started with from run:start', () => {
      const state = started(undefined, { params: { email: 'qa@example.com', password: '••••' } });

      expect(state.runs[pathname].params).toEqual({ email: 'qa@example.com', password: '••••' });
    });

    it('folds each iteration\'s vars under its own index', () => {
      let state = started(undefined, { params: {}, iterationCount: 2 });
      state = withEvents(state, 'run-1', [
        { type: 'iteration:vars', index: 0, vars: { runToken: 'a' } },
        { type: 'iteration:vars', index: 1, vars: { runToken: 'b' } }
      ]);

      expect(state.runs[pathname].vars).toEqual({ 0: { runToken: 'a' }, 1: { runToken: 'b' } });
    });

    /** A run reports nothing about vars until an iteration has resolved them. */
    it('starts a run with no vars rather than with none declared', () => {
      const state = started(undefined, { params: {} });

      expect(state.runs[pathname].vars).toEqual({});
    });
  });

  /**
   * 002 §10: a run's provenance — the host that started it and the environments it ran against
   * (001 §14.5). Folded, not derived: the app does not read its own environment dropdown to label a
   * run, because a run read back from disk may have come from `bru` on a build machine.
   */
  describe('where a run came from', () => {
    const origin = { host: 'app', environment: 'staging', globalEnvironment: 'shared' };

    it('takes it from run:start', () => {
      const state = started(undefined, { origin });

      expect(state.runs[pathname].origin).toEqual(origin);
    });

    it('carries a stored run\'s the same way', () => {
      const state = reducer(
        undefined,
        pastRunLoaded({
          pathname,
          stored: {
            runId: 'run-old',
            dir: '/workspace/.bruno-runs/old',
            state: 'complete',
            status: 'passed',
            capturedSteps: [],
            origin: { host: 'cli', environment: 'staging' }
          }
        })
      );

      expect(state.runs[pathname].origin).toEqual({ host: 'cli', environment: 'staging' });
    });

    /** A run recorded before the field existed has none, and the view shows nothing rather than guessing. */
    it('leaves it undefined where the run recorded none', () => {
      expect(started().runs[pathname].origin).toBeUndefined();
    });
  });

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

  /**
   * 002 §10's suite run, folded from `main:flow-suite-event`. The per-flow stream is untouched and
   * is still what every flow's own tab reads, so this holds the roster and its progress and nothing
   * that would be a second account of a run.
   */
  describe('a suite run (§10)', () => {
    const refund = '/workspace/flows/refund.flow.yml';
    const invoice = '/workspace/flows/invoice.flow.yml';

    const roster = [
      { entry: pathname, id: 'checkout', name: 'Checkout' },
      { entry: refund, id: 'refund', name: 'Refund' },
      { entry: invoice, id: 'invoice', name: 'Invoice' }
    ];

    const withSuite = (state, event, suiteId = 'suite-1') =>
      reducer(state, suiteEventReceived({ suiteId, event }));

    const startedSuite = (state = undefined, suiteId = 'suite-1') =>
      withSuite(state, { type: 'suite:start', startedAt: '2026-02-03T10:00:00.000Z', flows: roster }, suiteId);

    it('starts with nothing running', () => {
      expect(reducer(undefined, { type: '@@INIT' }).suiteRun).toBeNull();
    });

    it('opens on the roster the host named, every flow pending', () => {
      const state = startedSuite();

      expect(state.suiteRun).toEqual({
        suiteId: 'suite-1',
        startedAt: '2026-02-03T10:00:00.000Z',
        state: 'running',
        flows: [
          { entry: pathname, id: 'checkout', name: 'Checkout', state: 'pending' },
          { entry: refund, id: 'refund', name: 'Refund', state: 'pending' },
          { entry: invoice, id: 'invoice', name: 'Invoice', state: 'pending' }
        ]
      });
    });

    it('moves one flow at a time through running and done', () => {
      let state = startedSuite();
      state = withSuite(state, { type: 'suite:flow-start', entry: pathname, runId: 'run-1' });

      expect(state.suiteRun.flows[0]).toMatchObject({ state: 'running' });
      expect(state.suiteRun.flows[1]).toMatchObject({ state: 'pending' });

      state = withSuite(state, { type: 'suite:flow-end', entry: pathname, outcome: 'failed', runId: 'run-1' });

      expect(state.suiteRun.flows[0]).toMatchObject({ state: 'done', outcome: 'failed' });
    });

    /** 001 §14.6's outcome, unrenamed — the slice stores what the engine reported. */
    it('keeps the outcome the host reported', () => {
      let state = startedSuite();
      state = withSuite(state, { type: 'suite:flow-end', entry: refund, outcome: 'invalid', runId: 'run-2' });

      expect(state.suiteRun.flows[1].outcome).toBe('invalid');
    });

    it('completes on suite:end, recording the directory it wrote', () => {
      let state = startedSuite();
      state = withSuite(state, {
        type: 'suite:end',
        finishedAt: '2026-02-03T10:04:00.000Z',
        exitCode: 1,
        dir: '/workspace/.bruno-runs/suite-1770112800000-ab12'
      });

      expect(state.suiteRun.state).toBe('complete');
      expect(state.suiteRun.dir).toBe('/workspace/.bruno-runs/suite-1770112800000-ab12');
    });

    /**
     * `suite:end` reports a stopped suite and an exhausted one identically, so a cancel that an end
     * overwrote would leave the header calling a suite that was stopped complete.
     */
    it('stays cancelled once it has been stopped from here', () => {
      let state = startedSuite();
      state = reducer(state, suiteRunCancelled({ suiteId: 'suite-1' }));

      expect(state.suiteRun.state).toBe('cancelled');

      state = withSuite(state, { type: 'suite:end', finishedAt: '2026-02-03T10:01:00.000Z', exitCode: 2, dir: '/d' });

      expect(state.suiteRun.state).toBe('cancelled');
      expect(state.suiteRun.dir).toBe('/d');
    });

    it('cancels nothing when the id names a suite that is not the one running', () => {
      const state = reducer(startedSuite(), suiteRunCancelled({ suiteId: 'suite-2' }));

      expect(state.suiteRun.state).toBe('running');
    });

    /** One suite at a time: the runner opens a single suite directory and works through it. */
    it('replaces the run when a new suite starts', () => {
      let state = startedSuite();
      state = withSuite(state, { type: 'suite:flow-end', entry: pathname, outcome: 'passed', runId: 'run-1' });
      state = startedSuite(state, 'suite-2');

      expect(state.suiteRun.suiteId).toBe('suite-2');
      expect(state.suiteRun.flows.every((flow) => flow.state === 'pending')).toBe(true);
    });

    /** A suite the host is still finishing after another replaced it has nothing left to say here. */
    it('ignores events addressed to a suite it is no longer showing', () => {
      let state = startedSuite(undefined, 'suite-2');
      state = withSuite(state, { type: 'suite:flow-end', entry: pathname, outcome: 'failed', runId: 'run-1' }, 'suite-1');
      state = withSuite(state, { type: 'suite:end', finishedAt: '2026-02-03T10:01:00.000Z', exitCode: 1, dir: '/d' }, 'suite-1');

      expect(state.suiteRun.suiteId).toBe('suite-2');
      expect(state.suiteRun.state).toBe('running');
      expect(state.suiteRun.flows[0].state).toBe('pending');
    });

    /** The per-flow stream is what a flow tab folds, and a suite run must not disturb it. */
    it('leaves the per-flow runs alone', () => {
      let state = started();
      state = startedSuite(state);
      state = withSuite(state, { type: 'suite:flow-end', entry: pathname, outcome: 'failed', runId: 'run-9' });

      expect(state.runs[pathname].state).toBe('running');
      expect(state.flowByRunId).toEqual({ 'run-1': pathname });
    });
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

  /**
   * 002 §4.1a. Collapsed is the default, matching upstream's collection folders, so the map holds
   * only the folders someone has opened rather than a key per directory on disk.
   */
  describe('folder expansion (§4.1a)', () => {
    const company = '/workspace/flows/company';
    const billing = '/workspace/flows/company/billing';

    it('starts with nothing open', () => {
      expect(reducer(undefined, { type: '@@INIT' }).folderExpansion).toEqual({});
    });

    it('opens and closes one folder', () => {
      const opened = reducer(undefined, folderToggled({ key: company }));
      expect(opened.folderExpansion[company]).toBe(true);

      expect(reducer(opened, folderToggled({ key: company })).folderExpansion[company]).toBe(false);
    });

    it('opens every key it is given', () => {
      const state = reducer(undefined, foldersExpanded({ keys: [company, billing] }));

      expect(state.folderExpansion).toEqual({ [company]: true, [billing]: true });
    });

    /**
     * The store holds every scope watched since launch (§4.1) while the section shows one
     * workspace's, so the header's collapse must not reach past the folders in front of the reader.
     */
    it('closes only the keys it is given', () => {
      const other = '/elsewhere/flows/company';
      const state = reducer(undefined, foldersExpanded({ keys: [company, billing, other] }));

      expect(reducer(state, foldersCollapsed({ keys: [company, billing] })).folderExpansion).toEqual({
        [other]: true
      });
    });
  });
});
