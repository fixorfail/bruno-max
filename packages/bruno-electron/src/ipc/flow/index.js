const fs = require('fs');
const path = require('path');
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
const pendingRequests = [];
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
  if (win.isDestroyed()) {
    pendingEvents.clear();
    pendingRequests.length = 0;
    return;
  }

  for (const [runId, events] of pendingEvents) {
    // One message per run: 001 §13.2 guarantees order within a run and nothing across two, so a
    // batch mixing them would invent an ordering the engine never promised.
    if (events.length) {
      win.webContents.send('main:flow-run-event', { runId, events });
    }
  }

  // 002 §8.5's log is a chronological panel rather than a per-run stream, so unlike the events
  // above it batches across runs — which is also what lets two concurrent runs interleave in it.
  if (pendingRequests.length) {
    win.webContents.send('main:flow-request-log-batch', { requests: [...pendingRequests] });
  }

  pendingEvents.clear();
  pendingRequests.length = 0;
};

const scheduleFlush = (win) => {
  if (!flushTimer) {
    flushTimer = setTimeout(() => flushEvents(win), EVENT_FLUSH_MS);
  }
};

const queueEvent = (win, runId, event) => {
  pendingEvents.set(runId, [...(pendingEvents.get(runId) || []), event]);
  scheduleFlush(win);
};

const queueRequestLog = (win, log) => {
  pendingRequests.push(log);
  scheduleFlush(win);
};

const requireScope = (scope) => {
  if (!scope || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot) {
    throw new Error('a flow scope needs a workspaceRoot');
  }
  return scope;
};

/**
 * A flow file the renderer is allowed to read or write as text — 002 §4.3.
 *
 * The preload forwards any channel string and has no allowlist, so the two rules the raw editor
 * depends on are enforced here: it edits **a flow**, and it edits one **inside the scope it named**.
 * Without the second, a scope's own path is no constraint at all — `../../etc/anything.flow.yml`
 * satisfies the extension and nothing else.
 */
const requireFlowInScope = (entry, scope) => {
  requireScope(scope);
  if (typeof entry !== 'string' || !entry.endsWith('.flow.yml')) {
    throw new Error('not a flow file');
  }

  const root = path.resolve(scope.collectionRoot || scope.workspaceRoot);
  const resolved = path.resolve(entry);
  // `path.relative` rather than a prefix test: `/a/workspace-two` starts with `/a/workspace` as a
  // string and is not inside it.
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('flow is outside its scope');
  }
  return resolved;
};

/**
 * **`content` describes a draft rather than the file on disk** — 002 §4.3's editor redraws the graph
 * from unsaved text, so `describeFlow` has to be able to read the entry from somewhere other than
 * the filesystem. Overlaying the *port* rather than adding a parameter to the engine is what keeps
 * that a host concern: `describeFlow` still resolves sub-flows and OpenAPI documents through the same
 * `readFile`, and only the entry itself is answered from memory.
 */
const describeFlowHandler = ({ entry, scope, content }) => {
  const { readFile, readSpec } = createPorts({ collectionRoot: scope?.collectionRoot });
  if (typeof content !== 'string') {
    return describeFlow({ entry, scope: requireScope(scope), ports: { readFile, readSpec } });
  }

  const draft = requireFlowInScope(entry, scope);
  const readDraft = async (target, context) =>
    path.resolve(target) === draft ? Buffer.from(content, 'utf8') : readFile(target, context);

  return describeFlow({ entry, scope, ports: { readFile: readDraft, readSpec } });
};

/** 002 §4.3 — the flow's own text, for the raw editor. */
const readFlowSourceHandler = async ({ entry, scope }) =>
  fs.promises.readFile(requireFlowInScope(entry, scope), 'utf8');

/**
 * The editor writes the file the watcher is already watching, so the tree update, the re-describe
 * and the run view's refresh all follow from the write with nothing else to keep in step.
 */
const writeFlowSourceHandler = async ({ entry, scope, content }) => {
  if (typeof content !== 'string') {
    throw new Error('a flow needs text to be written');
  }
  await fs.promises.writeFile(requireFlowInScope(entry, scope), content, 'utf8');
};

/**
 * 002 §4.1's flows directory for a scope — the default location the Create Flow form offers.
 *
 * Joined here rather than in the renderer because the renderer's `path` is a POSIX shim: a Windows
 * workspace would be shown `C:\ws/flows`, and the form displays this string before sending it back
 * to be written.
 *
 * It does not create the directory. Opening a form and cancelling it should leave nothing behind,
 * and `createFlowHandler` has to make the directory on the write anyway — the user can browse to one
 * that does not exist yet.
 */
const flowsFolderHandler = ({ scopeRoot }) => {
  if (typeof scopeRoot !== 'string' || !scopeRoot) {
    throw new Error('a flows folder needs a scope root');
  }
  return path.join(scopeRoot, 'flows');
};

/**
 * Creating a flow from the sidebar (002 §4.1) — the file, and nothing else. The watcher is already
 * watching `<scope>/flows`, so the tree update and the sidebar row follow from the write.
 *
 * The extension is required rather than appended: `.flow.yml` is what `scanFlows` matches on, and a
 * file written without it would be created successfully and then be invisible to everything.
 */
const createFlowHandler = async ({ directory, filename, content }) => {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || !filename.endsWith('.flow.yml')) {
    throw new Error(`flow: ${filename} is not a valid flow filename`);
  }
  if (typeof directory !== 'string' || !directory) {
    throw new Error('a flow needs a directory to be created in');
  }
  if (typeof content !== 'string') {
    throw new Error('a flow needs text to be written');
  }

  const pathname = path.join(directory, filename);
  await fs.promises.mkdir(directory, { recursive: true });

  try {
    // `wx` rather than an existence check: the check and the write are not one operation, and the
    // race it loses is exactly the one that overwrites somebody's flow.
    await fs.promises.writeFile(pathname, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    // The form's own message for the one failure it can do something about — `EEXIST`'s text names
    // the syscall and the flag, which tells the author nothing about the name they just typed.
    throw error.code === 'EEXIST' ? new Error(`a flow already exists at ${pathname}`) : error;
  }

  return pathname;
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
      ports: createPorts({
        collectionRoot: scope.collectionRoot,
        // A workspace-scoped flow has no collection; its scripts still need a path to resolve
        // `require` against, and the scope root is it (002 §7.2).
        workspaceRoot: scope.workspaceRoot,
        onRequest: (log) => queueRequestLog(win, log)
      }),
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
  ipcMain.handle('renderer:flow-read-source', (event, request) => readFlowSourceHandler(request));
  ipcMain.handle('renderer:flow-write-source', (event, request) => writeFlowSourceHandler(request));
  ipcMain.handle('renderer:flow-run', (event, request) => startRun(mainWindow, request));
  ipcMain.handle('renderer:flow-cancel', (event, request) => cancelRun(request));
  ipcMain.handle('renderer:flow-list-runs', (event, request) => listRunsHandler(request));
  ipcMain.handle('renderer:flow-read-run', (event, request) => readRunHandler(request));
  ipcMain.handle('renderer:flow-read-capture', (event, request) => readCaptureHandler(request));
  ipcMain.handle('renderer:flow-folder', (event, request) => flowsFolderHandler(request));
  ipcMain.handle('renderer:flow-create', (event, request) => createFlowHandler(request));

  ipcMain.handle('renderer:flow-watch-scope', (event, scope) => {
    watcher.addWatcher(mainWindow, requireScope(scope));
    return watcher.listFlows(scope);
  });
  ipcMain.handle('renderer:flow-unwatch-scope', (event, scope) => watcher.removeWatcher(requireScope(scope)));
};

module.exports = registerFlowIpc;
module.exports.describeFlowHandler = describeFlowHandler;
module.exports.readFlowSourceHandler = readFlowSourceHandler;
module.exports.writeFlowSourceHandler = writeFlowSourceHandler;
module.exports.listRunsHandler = listRunsHandler;
module.exports.readRunHandler = readRunHandler;
module.exports.readCaptureHandler = readCaptureHandler;
module.exports.flowsFolderHandler = flowsFolderHandler;
module.exports.createFlowHandler = createFlowHandler;
module.exports.startRun = startRun;
module.exports.cancelRun = cancelRun;
module.exports.shutdown = shutdown;
