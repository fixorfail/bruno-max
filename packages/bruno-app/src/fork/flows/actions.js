import get from 'lodash/get';
import find from 'lodash/find';
import { describeStarted, describeSucceeded, describeFailed, flowsLoaded, pastRunLoaded } from './slice';

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
    params: configuration.params,
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
 */
export const openPastRun = ({ flow, entry, stepIds }) => async (dispatch) => {
  const stored = await ipc().invoke('renderer:flow-read-run', { dir: entry.dir, stepIds });
  dispatch(pastRunLoaded({ pathname: flow.pathname, stored }));
};
