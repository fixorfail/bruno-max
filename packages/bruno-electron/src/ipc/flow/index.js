const { ipcMain } = require('electron');
const { runFlow, describeFlow, listRuns, readRun, readCapture } = require('@bruno-max/flow');
const FlowsWatcher = require('../../app/flowsWatcher');
const { createPorts } = require('./ports');
const { buildVariables } = require('./variables');

/**
 * The Electron host for API Flows — 002 §11.3.
 *
 * The main process owns an `AbortController` per run, assembles `RunOptions.variables` from the
 * tiers the renderer sends (002 §7.2) and supplies the seven ports of 001 §13.2. The renderer holds
 * no engine state beyond what its slice folds from events.
 */

/**
 * 002 §8.1 batches events per frame. A run at `concurrency: 5` with polling steps emits
 * `step:attempt` at request rate, and one IPC message per frame is the difference between a smooth
 * graph and a renderer that spends the run in reconciliation.
 */
const EVENT_FLUSH_MS = 16;

/** runId -> { controller, done } — `done` is the `runFlow` promise, which quit has to wait on. */
const running = new Map();
const pendingEvents = new Map();
let flushTimer = null;
let watcher;

/**
 * A hang guard, not a policy. 001 §11.3 already bounds cleanup by `config.cleanupGrace` (default
 * 30000 ms) and `runFlow` resolves as soon as the cleanup steps finish, so this only matters if a
 * port never settles. Capping it lower would silently truncate the very window §4.2 promises.
 */
const SHUTDOWN_CAP_MS = 30000;

const flushEvents = (win) => {
  flushTimer = null;

  for (const [runId, events] of pendingEvents) {
    // One message per run: 001 §13.2 guarantees order within a run and nothing across two, so a
    // batch mixing them would invent an ordering the engine never promised.
    if (events.length && !win.isDestroyed()) {
      win.webContents.send('main:flow-run-event', { runId, events });
    }
  }

  pendingEvents.clear();
};

const queueEvent = (win, runId, event) => {
  pendingEvents.set(runId, [...(pendingEvents.get(runId) || []), event]);

  if (!flushTimer) {
    flushTimer = setTimeout(() => flushEvents(win), EVENT_FLUSH_MS);
  }
};

const requireScope = (scope) => {
  if (!scope || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot) {
    throw new Error('a flow scope needs a workspaceRoot');
  }
  return scope;
};

const describeFlowHandler = ({ entry, scope }) => {
  const { readFile, readSpec } = createPorts({ collectionRoot: scope?.collectionRoot });
  return describeFlow({ entry, scope: requireScope(scope), ports: { readFile, readSpec } });
};

const listRunsHandler = ({ scopeRoot, flow }) => {
  const { readFile, listDirectory } = createPorts({});
  return listRuns({ scopeRoot, flow, ports: { readFile, listDirectory } });
};

const readRunHandler = ({ dir, stepIds, iteration }) => {
  const { readFile, listDirectory } = createPorts({});
  return readRun({ dir, stepIds, iteration, ports: { readFile, listDirectory } });
};

const readCaptureHandler = ({ dir, stepId, iteration, attempt }) => {
  const { readFile } = createPorts({});
  return readCapture({ dir, stepId, iteration, attempt, ports: { readFile } });
};

/**
 * Resolves as soon as the run has an identity rather than when it finishes, because the renderer
 * needs the `runId` to attach the events already arriving. A failure before `run:start` — a flow
 * that does not parse — has no run to report and rejects instead.
 */
const startRun = async (win, { entry, scope, tiers, params, overrides }) => {
  requireScope(scope);
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    let runId;
    // The record exists before `runFlow` is called so `onEvent` can register it without depending
    // on whether `run:start` is emitted before or after the call returns its promise.
    const record = { controller, done: undefined };

    record.done = runFlow({
      entry,
      scope,
      ports: createPorts({ collectionRoot: scope.collectionRoot }),
      variables: buildVariables({ tiers, scope }),
      params,
      overrides,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'run:start') {
          runId = event.runId;
          running.set(runId, record);
          resolve({ runId });
        }
        queueEvent(win, runId, event);
      }
    })
      .catch((error) => {
        if (!runId) {
          reject(error);
        }
      })
      .finally(() => {
        running.delete(runId);
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushEvents(win);
        }
      });
  });
};

/**
 * `false` rather than a throw for an unknown run: 002 §10 lists runs this process is not executing —
 * a CLI run, or one from a previous launch — so being asked to cancel one is an ordinary race
 * between the run ending and the click landing.
 */
const cancelRun = ({ runId }) => {
  const run = running.get(runId);
  if (!run) {
    return false;
  }

  run.controller.abort();
  return true;
};

/**
 * 002 §4.2 — quitting with a run in flight cancels it through 001 §11.3's path rather than letting
 * the engine die with the process: in-flight requests are aborted, steps declaring
 * `status: [cancelled]` get their cleanup, and the run is recorded `cancelled`.
 *
 * **This runs at `before-quit`, not at `main:start-quit-flow`.** That event fires when quit is
 * *initiated*, and `ConfirmAppClose` lets the user dismiss the dialog and stay — so doing anything
 * destructive there kills a run for a quit that never happens.
 *
 * The comparison that settles the behaviour is the CLI: Ctrl-C on `bru flow run` runs cleanup, and
 * an app that skipped it would be strictly worse than the terminal at the one thing 001 §11.3
 * exists to guarantee.
 */
const shutdown = async () => {
  const inFlight = [...running.values()];
  for (const { controller } of inFlight) {
    controller.abort();
  }

  await Promise.race([
    Promise.allSettled(inFlight.map((run) => run.done)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_CAP_MS))
  ]);

  await watcher?.closeAllWatchers();
};

const registerFlowIpc = (mainWindow) => {
  watcher = new FlowsWatcher();

  ipcMain.handle('renderer:flow-describe', (event, request) => describeFlowHandler(request));
  ipcMain.handle('renderer:flow-run', (event, request) => startRun(mainWindow, request));
  ipcMain.handle('renderer:flow-cancel', (event, request) => cancelRun(request));
  ipcMain.handle('renderer:flow-list-runs', (event, request) => listRunsHandler(request));
  ipcMain.handle('renderer:flow-read-run', (event, request) => readRunHandler(request));
  ipcMain.handle('renderer:flow-read-capture', (event, request) => readCaptureHandler(request));

  ipcMain.handle('renderer:flow-watch-scope', (event, scope) => {
    watcher.addWatcher(mainWindow, requireScope(scope));
    return watcher.listFlows(scope);
  });
  ipcMain.handle('renderer:flow-unwatch-scope', (event, scope) => watcher.removeWatcher(requireScope(scope)));
};

module.exports = registerFlowIpc;
module.exports.describeFlowHandler = describeFlowHandler;
module.exports.listRunsHandler = listRunsHandler;
module.exports.readRunHandler = readRunHandler;
module.exports.readCaptureHandler = readCaptureHandler;
module.exports.startRun = startRun;
module.exports.cancelRun = cancelRun;
module.exports.shutdown = shutdown;
