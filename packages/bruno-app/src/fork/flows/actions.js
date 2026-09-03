import get from 'lodash/get';
import find from 'lodash/find';
import { uuid } from 'utils/common';
import brunoPath from 'utils/common/path';
import {
  describeStarted,
  describeSucceeded,
  describeFailed,
  flowsLoaded,
  pastRunLoaded,
  sourceLoaded,
  sourceLoadFailed,
  sourceRefreshed,
  sourceDivergedOnDisk,
  sourceDescribed,
  sourceDescribeFailed,
  sourceSaving,
  sourceSaved,
  sourceSaveFailed,
  suiteRunCancelled
} from './slice';

/**
 * Everything that crosses 002 §11.3's channels. The renderer sends a selection and values; the main
 * process resolves the ports and the `.env` tier and hands `RunOptions` to the engine (§7.2).
 */

const ipc = () => window.ipcRenderer;

/**
 * §7.2's tier table. The renderer sends each tier's **variable entries**, unmerged and unflattened,
 * so `secret: true` survives for 001 §14.4 and so precedence stays 001 §7.3's — in the engine.
 *
 * A workspace-scoped flow has no collection, and therefore gets the active global/workspace
 * environment and nothing else. That absence is the point rather than an omission: a workspace flow
 * spans services, so binding it to one collection's environment would be arbitrary and would have no
 * CI equivalent.
 */
export const tiersFor = ({ collection, globalEnvironments, envVarOverrides }) => {
  const globalEnvironment = find(
    globalEnvironments.globalEnvironments,
    (environment) => environment.uid === globalEnvironments.activeGlobalEnvironmentUid
  );

  const tiers = { envVarOverrides };
  if (globalEnvironment) {
    tiers.globalEnvironment = { name: globalEnvironment.name, variables: globalEnvironment.variables };
  }
  if (!collection) {
    return tiers;
  }

  const environment = find(collection.environments, (entry) => entry.uid === collection.activeEnvironmentUid);
  if (environment) {
    tiers.environment = { name: environment.name, variables: environment.variables };
  }
  tiers.collectionVars = get(collection, 'root.request.vars.req', []);
  return tiers;
};

export const watchScope = (scope) => async (dispatch) => {
  const flows = await ipc().invoke('renderer:flow-watch-scope', scope);
  dispatch(flowsLoaded({ ...scope, flows }));
};

export const unwatchScope = (scope) => async () => {
  await ipc().invoke('renderer:flow-unwatch-scope', scope);
};

/**
 * §6: this is the only source of correctness feedback in the UI, and it runs on open and on every
 * watcher change. A flow that does not parse still resolves — its diagnostics are the result.
 */
export const describeFlow = (flow) => async (dispatch) => {
  const scope = { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot };
  dispatch(describeStarted({ pathname: flow.pathname }));

  try {
    const description = await ipc().invoke('renderer:flow-describe', { entry: flow.pathname, scope });
    dispatch(describeSucceeded({ pathname: flow.pathname, description }));
  } catch (error) {
    dispatch(describeFailed({ pathname: flow.pathname, error: error.message }));
  }
};

/**
 * 002 §4.3 — the same description, from text that is not on disk yet.
 *
 * The engine is asked rather than the renderer parsing the draft itself, for the reason §11.1 gives
 * for the saved file: a graph the app derived on its own could differ from the one the CLI executes,
 * and the whole point of drawing it while editing is to see what will run.
 */
export const describeFlowDraft = (flow, content) => async (dispatch) => {
  const scope = { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot };

  try {
    const description = await ipc().invoke('renderer:flow-describe', { entry: flow.pathname, scope, content });
    dispatch(sourceDescribed({ pathname: flow.pathname, description }));
  } catch (error) {
    dispatch(sourceDescribeFailed({ pathname: flow.pathname, error: error.message }));
  }
};

/** §4.3: the flow's own text, for the raw editor. */
export const readFlowSource = (flow) => async (dispatch) => {
  const scope = { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot };

  try {
    const content = await ipc().invoke('renderer:flow-read-source', { entry: flow.pathname, scope });
    dispatch(sourceLoaded({ pathname: flow.pathname, content }));
  } catch (error) {
    dispatch(sourceLoadFailed({ pathname: flow.pathname, error: error.message }));
  }
};

/**
 * §4.3: the file changed on disk, so the raw editor catches up with it.
 *
 * The editor's text lives in the store keyed by path, precisely so an unsaved edit survives a tab
 * switch — which also means nothing ever re-read the file once it had been read, and an edit made
 * outside Bruno stayed invisible for the life of the session even across closing and reopening the
 * tab.
 *
 * **A dirty editor is never overwritten.** Bruno's own save fires the same watcher event as an
 * external edit, and the two are indistinguishable here; taking the file's text unconditionally
 * would discard whatever was typed while a save was in flight. A clean editor has nothing to lose
 * and takes the file; a dirty one keeps what was typed and is marked as having diverged.
 *
 * No source at all means the flow's raw editor was never opened. Reading it here would put text in
 * the store for a tab nobody has, so the pane's own first read is left to do that.
 */
export const refreshFlowSource = (flow) => async (dispatch, getState) => {
  const { pathname } = flow;
  const source = getState().flows.sources[pathname];
  if (!source || source.loading) {
    return;
  }

  if (source.saving || source.content !== source.saved) {
    dispatch(sourceDivergedOnDisk({ pathname }));
    return;
  }

  const scope = { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot };

  try {
    const content = await ipc().invoke('renderer:flow-read-source', { entry: pathname, scope });
    // Re-checked after the read: the file is read asynchronously and a keystroke during it would
    // otherwise be overwritten by text that was already stale when it arrived.
    const current = getState().flows.sources[pathname];
    if (!current || current.saving || current.content !== current.saved) {
      dispatch(sourceDivergedOnDisk({ pathname }));
      return;
    }
    dispatch(sourceRefreshed({ pathname, content }));
  } catch (error) {
    dispatch(sourceLoadFailed({ pathname, error: error.message }));
  }
};

/**
 * §4.3: writing the editor's text back.
 *
 * The content is read from the store at the moment of the write rather than passed in, because the
 * two callers — the save key and the auto-save timer — both fire against text that may have moved on
 * since they were scheduled. Recording *what was written* is what makes the dirty comparison honest
 * for the keystrokes that landed during the write.
 */
export const saveFlowSource = (flow) => async (dispatch, getState) => {
  const { pathname } = flow;
  const source = getState().flows.sources[pathname];
  if (!source || source.content === source.saved) {
    return;
  }

  const content = source.content;
  const scope = { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot };
  dispatch(sourceSaving({ pathname }));

  try {
    await ipc().invoke('renderer:flow-write-source', { entry: pathname, scope, content });
    dispatch(sourceSaved({ pathname, content }));
  } catch (error) {
    dispatch(sourceSaveFailed({ pathname, error: error.message }));
    throw error;
  }
};

/**
 * 002 §4.1's flows directory for a scope — the location the Create Flow form defaults to.
 *
 * Asked of the main process rather than joined here: the renderer's `path` is a POSIX shim, and the
 * form shows this string to the author before sending it back to be written.
 */
export const flowsFolderFor = (scopeRoot) => async () => ipc().invoke('renderer:flow-folder', { scopeRoot });

/**
 * §4.1: writing a new flow. Nothing is dispatched on success — the watcher is watching the
 * directory, so the sidebar row arrives through `flowTreeUpdated` the same way it would for a flow
 * somebody created outside the app.
 *
 * The text comes from the form (`CreateFlow/flowDocument.js`) rather than being built here: this
 * module is reached eagerly from `fork/registry.js`, and the relative-path helper the document needs
 * is upstream.
 */
export const createFlow = ({ fileName, directory, content }) => async () =>
  ipc().invoke('renderer:flow-create', { directory, filename: `${fileName}.flow.yml`, content });

/**
 * 002 §4.7 — the same form, over a flow that already exists.
 *
 * The document is not sent: the host copies the source's own text and replaces its `meta:` with
 * these properties, so everything the form does not ask about — the steps, the `apis:`, the comments
 * — survives the duplicate exactly as written.
 */
export const duplicateFlow = ({ flow, fileName, directory, properties }) => async () =>
  ipc().invoke('renderer:flow-duplicate', {
    entry: flow.pathname,
    scope: { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot },
    directory,
    filename: `${fileName}.flow.yml`,
    properties
  });

/**
 * 002 §4.4 — the `meta:` block and the filename the properties dialog opens with.
 *
 * Read from the file rather than taken from the sidebar row: the watcher's tree entry carries only
 * the name and the library flag (002 §11.3), because those are what a row is drawn from and reading
 * more of every flow in a scope on every tree change would be paying for a dialog nobody opened.
 */
export const readFlowProperties = (flow) => async () =>
  ipc().invoke('renderer:flow-read-properties', {
    entry: flow.pathname,
    scope: { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot }
  });

/**
 * §4.4 — the edit, applied. Resolves the flow's pathname, which is a new one when it was renamed.
 *
 * Nothing is dispatched on success, for `createFlow`'s reason: the watcher reports the write and the
 * rename, so the sidebar and the descriptions follow from the disk rather than from here. What the
 * caller does with the returned path is retarget the tabs the rename left behind, which is the one
 * thing no watcher event can do.
 */
export const updateFlowProperties = ({ flow, filename, properties }) => async () =>
  ipc().invoke('renderer:flow-update-properties', {
    entry: flow.pathname,
    scope: { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot },
    filename,
    properties
  });

/**
 * §4.5 — renaming a script, in place. Resolves its new pathname.
 *
 * Nothing is dispatched on success, for `updateFlowProperties`' reason: the watcher reports the
 * rename, so the sidebar follows from disk. What the caller does is retarget the tab the rename left
 * behind, which no watcher event can do.
 */
export const renameFlowScript = ({ script, filename }) => async () =>
  ipc().invoke('renderer:flow-rename-script', {
    entry: script.pathname,
    scope: { workspaceRoot: script.workspaceRoot, collectionRoot: script.collectionRoot },
    filename
  });

/**
 * §7.2's param inputs, as the engine has to see them.
 *
 * A box that was typed into and then cleared holds `''`, and a box never touched has no key at all —
 * a distinction the author cannot see and did not make. The engine treats *absent* as missing (001
 * §12.5, the predicate `validate.ts` uses at a `uses:` call site), so blanks are dropped here and
 * the two agree: an empty box is a param that was not supplied, and a required one stops the run
 * instead of putting `{{params.x}}` on the wire.
 */
const suppliedParams = (params) =>
  Object.fromEntries(Object.entries(params || {}).filter(([, value]) => String(value ?? '').trim() !== ''));

export const runFlow = ({ flow, configuration }) => async (dispatch, getState) => {
  const state = getState();
  const collection = flow.collectionRoot
    ? find(state.collections.collections, (entry) => entry.pathname === flow.collectionRoot)
    : undefined;

  return ipc().invoke('renderer:flow-run', {
    entry: flow.pathname,
    scope: { workspaceRoot: flow.workspaceRoot, collectionRoot: flow.collectionRoot },
    tiers: tiersFor({
      collection,
      globalEnvironments: state.globalEnvironments,
      envVarOverrides: configuration.envVarOverrides
    }),
    params: suppliedParams(configuration.params),
    overrides: {
      concurrency: configuration.concurrency,
      dataset: configuration.dataset,
      capture: { enabled: configuration.capture !== false }
    }
  });
};

export const cancelFlowRun = (runId) => async () => ipc().invoke('renderer:flow-cancel', { runId });

export const readStepCapture = ({ dir, stepId, iteration, attempt }) => async () =>
  ipc().invoke('renderer:flow-read-capture', { dir, stepId, iteration, attempt });

/** §10: the runs under `.bruno-runs/` for the scope that owns this flow, newest first. */
export const listFlowRuns = (flow) => async () =>
  ipc().invoke('renderer:flow-list-runs', {
    scopeRoot: flow.collectionRoot || flow.workspaceRoot,
    flow: flow.pathname
  });

/**
 * §10: opening a stored run. `stepIds` comes from the graph because 001 §14.5's directory name is a
 * lossy encoding of a step id and cannot be inverted — the engine answers which of the ids we hold
 * have a capture (002 §11.2).
 *
 * A run that recorded a snapshot answers from *its own* ids instead, and this list is the fallback
 * for runs written before snapshots: the ids here are today's graph, so a step renamed since the run
 * is not among them and its captures would be unreachable.
 */
export const openPastRun = ({ flow, entry, stepIds }) => async (dispatch) => {
  const stored = await ipc().invoke('renderer:flow-read-run', { dir: entry.dir, stepIds });
  dispatch(pastRunLoaded({ pathname: flow.pathname, stored }));
};

/**
 * §10: the suites under `.bruno-runs/` for one scope, newest first — the roster a retry is selected
 * from.
 *
 * A suite's own `suite.json` is what this reads, so a flow whose validation failed is in the roster
 * with the rest: it never gets a run directory, and a list rebuilt from those alone would silently
 * drop exactly the flows a retry most wants to re-run. A suite written before the index exists is
 * rebuilt from its run directories and says so (`partial`) rather than implying it was complete.
 */
export const listFlowSuites = (scopeRoot) => async () => ipc().invoke('renderer:flow-list-suites', { scopeRoot });

/**
 * §10: the flows of a past suite that did not pass, run again in one sequential suite of their own.
 *
 * "Did not pass" is `failed`, `cancelled` and `invalid` together. An `invalid` flow usually fails
 * validation again immediately and cheaply, and excluding it would let a mistyped selection shrink
 * silently on every retry until there was nothing left to notice.
 *
 * The retry is a **new** suite recording the one it re-ran (`retryOf`), never an edit of the old
 * one — a run is a record of an invocation, and a second invocation is a second record.
 *
 * The suite id is minted here rather than taken from the resolved call: the host answers as soon as
 * the suite directory is open (002 §11.3), so `suite:start` can arrive first, and a stream the
 * renderer cannot yet name is one it would have to fold blind.
 */
export const rerunFailedFlows = ({ scopeRoot, suite }) => async (dispatch, getState) => {
  const state = getState();

  /**
   * A collection-scoped suite is one whose root *is* a loaded collection — the same pairing
   * `main:collection-opened` records when it watches the scope. The distinction is not cosmetic:
   * §7.2 resolves a collection's environment and its scripts' `require` against `collectionRoot`.
   */
  const collection = find(state.collections.collections, (entry) => entry.pathname === scopeRoot);

  const flows = suite.flows
    .filter((record) => record.outcome !== 'passed')
    .map((record) => ({
      entry: record.file,
      // §12.5: a library flow's params are typed by hand before each run and live in the run panel's
      // configuration, so a retry runs each flow with what its own panel is holding.
      params: suppliedParams(get(state.flows.configurations, [record.file, 'params']))
    }));

  return ipc().invoke('renderer:flow-run-suite', {
    suiteId: uuid(),
    scope: { workspaceRoot: scopeRoot, collectionRoot: collection ? scopeRoot : undefined },
    flows,
    tiers: tiersFor({ collection, globalEnvironments: state.globalEnvironments }),
    // The manifest names the suite this one re-ran by its directory's own name, so a record stays
    // readable after the capture root has been moved or checked out somewhere else.
    retryOf: brunoPath.basename(suite.dir)
  });
};

/**
 * The suite is stopped, and the flow in flight with it — 001 §11.3's cleanup steps still run.
 *
 * The mark is dispatched here rather than folded from `suite:end`, which reports a stopped suite and
 * an exhausted one identically; this side asked for it, so this side is the one that knows.
 */
export const cancelSuiteRun = (suiteId) => async (dispatch) => {
  await ipc().invoke('renderer:flow-cancel-suite', { suiteId });
  dispatch(suiteRunCancelled({ suiteId }));
};
