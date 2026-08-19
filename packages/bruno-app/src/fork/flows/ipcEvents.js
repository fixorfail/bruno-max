import { flowTreeUpdated, runEventsReceived, requestLogsReceived } from './slice';
import { watchScope } from './actions';

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
  });

  const removeRunEventListener = ipcRenderer.on('main:flow-run-event', (batch) => {
    dispatch(runEventsReceived(batch));
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
    removeRequestLogListener();
    removeWorkspaceOpenedListener();
    removeCollectionOpenedListener();
  };
};
