import { flowTreeUpdated, runEventsReceived, suiteEventReceived, requestLogsReceived } from './slice';
import { refreshFlowSource, watchScope } from './actions';

/**
 * The push half of 002 §11.3, folded into the slice.
 *
 * **These are registered from `useIpcEvents` rather than from a flow component** (002 §12.1). Run
 * events must fold in whether or not any flow UI is mounted: 001 §11.3 keeps cleanup steps running
 * after a cancel and §4.2 keeps a run alive across a closed tab, so a listener whose lifetime was a
 * component's would drop events exactly when a run is still going and nothing is watching it.
 */
export const registerFlowIpcEvents = (dispatch) => {
  const { ipcRenderer } = window;

  const removeTreeListener = ipcRenderer.on('main:flow-tree-updated', (event, entry) => {
    dispatch(flowTreeUpdated({ event, entry }));
    /**
     * §4.3's raw editor holds the file's text in the store, so unlike the description — which the
     * reducer above simply drops — it has to be re-read to follow an edit made outside Bruno.
     *
     * `addFile` as well as `changeFile`: an editor that saves atomically writes a temporary file and
     * renames it over the original, which chokidar reports as an unlink followed by an add rather
     * than as a change. Ignoring it there would leave the whole class of editors that save that way
     * unable to refresh at all.
     */
    if (event === 'changeFile' || event === 'addFile') {
      dispatch(refreshFlowSource(entry));
    }
  });

  const removeRunEventListener = ipcRenderer.on('main:flow-run-event', (batch) => {
    dispatch(runEventsReceived(batch));
  });

  /**
   * §10's suite stream, beside the per-flow one rather than in place of it. The flows of a suite
   * report themselves through `main:flow-run-event` exactly as a single run does, so every flow tab
   * keeps following its own run and this carries only the roster and its progress.
   */
  const removeSuiteEventListener = ipcRenderer.on('main:flow-suite-event', (payload) => {
    dispatch(suiteEventReceived(payload));
  });

  const removeRequestLogListener = ipcRenderer.on('main:flow-request-log-batch', (batch) => {
    dispatch(requestLogsReceived(batch));
  });

  /**
   * §11.3: the renderer says which scopes to watch, because it is the side that knows what is open.
   * Subscribing to the *same* channels upstream already broadcasts costs no extra upstream line —
   * `ipcRenderer.on` is additive, so these listeners sit beside upstream's own.
   */
  const removeWorkspaceOpenedListener = ipcRenderer.on('main:workspace-opened', (workspacePath) => {
    dispatch(watchScope({ workspaceRoot: workspacePath }));
  });

  const removeCollectionOpenedListener = ipcRenderer.on('main:collection-opened', (pathname, uid, config, options) => {
    // A collection outside a workspace still owns its `flows/`; its own path is then the scope root.
    dispatch(watchScope({ workspaceRoot: options?.workspacePath || pathname, collectionRoot: pathname }));
  });

  return () => {
    removeTreeListener();
    removeRunEventListener();
    removeSuiteEventListener();
    removeRequestLogListener();
    removeWorkspaceOpenedListener();
    removeCollectionOpenedListener();
  };
};
