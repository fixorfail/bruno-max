jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), on: jest.fn() } }));
jest.mock('@bruno-max/flow', () => ({
  runFlow: jest.fn(),
  describeFlow: jest.fn(),
  listRuns: jest.fn(),
  readCapture: jest.fn()
}));
jest.mock('./ports', () => ({ createPorts: () => ({}) }));

const { ipcMain } = require('electron');
const { runFlow } = require('@bruno-max/flow');
const registerFlowIpc = require('./index');
const { startRun, cancelRun, shutdown } = require('./index');

const makeWindow = () => ({ isDestroyed: () => false, webContents: { send: jest.fn() } });

const runRequest = (entry) => ({ entry, scope: { workspaceRoot: '/workspace' }, tiers: {} });

/**
 * A run that announces itself, emits what the test asks for, and then waits to be cancelled — the
 * shape every scenario below needs from the engine.
 */
const scriptedRun = (runId, events = []) => (options) => {
  options.onEvent({ type: 'run:start', runId, flow: options.entry, iterationCount: 1 });
  for (const event of events) {
    options.onEvent(event);
  }
  return new Promise((resolve) => {
    options.signal.addEventListener('abort', () => resolve({ runId, status: 'cancelled' }));
  });
};

describe('the flow IPC host', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    runFlow.mockReset();
    ipcMain.on.mockClear();
    ipcMain.handle.mockClear();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  /** 002-C U5.4 */
  it('cancels the run it was given and no other', async () => {
    runFlow.mockImplementation((options) => scriptedRun(options.entry === 'a.flow.yml' ? 'run-a' : 'run-b')(options));

    const win = makeWindow();
    const { runId: a } = await startRun(win, runRequest('a.flow.yml'));
    const { runId: b } = await startRun(win, runRequest('b.flow.yml'));

    expect(cancelRun({ runId: a })).toBe(true);
    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(true);
    expect(runFlow.mock.calls[1][0].signal.aborted).toBe(false);

    cancelRun({ runId: b });
  });

  /** 002-C U5.4 */
  it('resolves false for a run this process is not executing', () => {
    expect(cancelRun({ runId: 'a-run-the-cli-started' })).toBe(false);
  });

  /** 002-C U5.5 */
  it('batches events per run, never mixing two', async () => {
    const stepEvent = (id) => ({ type: 'step:start', id, index: 0 });
    runFlow.mockImplementationOnce(scriptedRun('run-a', [stepEvent('one'), stepEvent('two')]));
    runFlow.mockImplementationOnce(scriptedRun('run-b', [stepEvent('three')]));

    const win = makeWindow();
    await startRun(win, runRequest('a.flow.yml'));
    await startRun(win, runRequest('b.flow.yml'));
    jest.advanceTimersByTime(20);

    const batches = win.webContents.send.mock.calls.filter(([channel]) => channel === 'main:flow-run-event');
    expect(batches).toHaveLength(2);

    const [{ runId: firstRun, events: firstEvents }] = batches.find(([, payload]) => payload.runId === 'run-a').slice(1);
    expect(firstRun).toBe('run-a');
    expect(firstEvents.map((event) => event.type)).toEqual(['run:start', 'step:start', 'step:start']);
    expect(firstEvents.slice(1).map((event) => event.id)).toEqual(['one', 'two']);

    const [{ events: secondEvents }] = batches.find(([, payload]) => payload.runId === 'run-b').slice(1);
    expect(secondEvents.every((event) => event.id === undefined || event.id === 'three')).toBe(true);

    cancelRun({ runId: 'run-a' });
    cancelRun({ runId: 'run-b' });
  });

  /** 002-C U5.8 */
  it('leaves a run alone when quit is only initiated', async () => {
    runFlow.mockImplementation(scriptedRun('run-a'));
    // Registering for real is the point: the defect was a `main:start-quit-flow` listener that
    // aborted every run, and `ConfirmAppClose` lets the user dismiss that dialog and stay.
    registerFlowIpc(makeWindow());

    const { runId } = await startRun(makeWindow(), runRequest('a.flow.yml'));
    for (const [channel, handler] of ipcMain.on.mock.calls) {
      if (channel === 'main:start-quit-flow') handler();
    }

    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(false);
    cancelRun({ runId });
  });

  /** 002-C U5.8 */
  it('aborts every run at shutdown and waits for its cleanup to finish', async () => {
    let cleanupFinished = false;
    runFlow.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onEvent({ type: 'run:start', runId: 'run-a', flow: options.entry, iterationCount: 1 });
          options.signal.addEventListener('abort', () => {
            // 001 §11.3 keeps `status: [cancelled]` steps running after the abort; the run resolves
            // only once that cleanup is done, and shutdown has to wait for it.
            setTimeout(() => {
              cleanupFinished = true;
              resolve({ runId: 'run-a', status: 'cancelled' });
            }, 50);
          });
        })
    );

    await startRun(makeWindow(), runRequest('a.flow.yml'));
    const shuttingDown = shutdown();
    jest.advanceTimersByTime(50);
    await shuttingDown;

    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(true);
    expect(cleanupFinished).toBe(true);
  });

  it('rejects a flow that fails before it has a run identity', async () => {
    runFlow.mockRejectedValue(new Error('flows/broken.flow.yml: could not be parsed'));

    await expect(startRun(makeWindow(), runRequest('broken.flow.yml'))).rejects.toThrow('could not be parsed');
  });

  it('refuses a request with no workspace root', async () => {
    await expect(startRun(makeWindow(), { entry: 'a.flow.yml', scope: {}, tiers: {} })).rejects.toThrow(
      'workspaceRoot'
    );
  });
});
