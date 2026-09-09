import { addTab } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import { readFlowsSnapshot } from 'fork/snapshot';
import { collectionUidForScope } from './collectionScope';
import { configurationsRestored, flowTabsRestored } from './slice';

/**
 * 002 §7.2 and §4.2 — what the last session left, read back out of the snapshot.
 *
 * **This module imports upstream and `actions.js` therefore reaches it dynamically.** `actions.js`
 * is in `fork/registry.js`'s eager graph, which `registry.spec.js` pins clear of upstream modules:
 * an upstream import there closes a loop with the Redux store and builds an app whose store has no
 * `flows` reducer. `retargetTabs.js` has the same shape for the same reason and is reached only from
 * lazily-loaded components; this one is reached from a thunk, so the deferral is the import itself.
 */

/**
 * §7.2's configuration, restored once for every flow the snapshot holds one for.
 *
 * Not scoped to the workspace being opened: a configuration is keyed by the flow's absolute path and
 * needs nothing else resolved, so there is nothing to wait for and nothing to match against.
 */
export const restoreFlowConfiguration = (snapshot) => (dispatch) => {
  const { configurations } = readFlowsSnapshot(snapshot);
  if (Object.keys(configurations).length) {
    dispatch(configurationsRestored({ configurations }));
  }
};

/**
 * §4.2's workspace-scoped flow tabs, reopened into the workspace's scratch collection.
 *
 * **Only the workspace-scoped ones.** A collection-scoped flow tab is in upstream's per-collection
 * tab list and is restored by `hydrateTabs` like any other tab; reopening it here would open it
 * twice. The workspace-scoped ones are the ones upstream cannot carry: they belong to the scratch
 * collection, which `serializeSnapshot` skips and the workspace's own hydration excludes by uid.
 *
 * **Every workspace the snapshot holds tabs for is attempted, and one that resolves is marked.** The
 * scratch collection is mounted by the workspace-switch path, which runs alongside this rather than
 * before it, so the uid can genuinely not be there yet — an unresolved workspace is left unmarked and
 * the next scope watched tries it again. Reopening a tab the reader has since closed is the failure
 * worth avoiding, which is what the mark is for.
 */
export const restoreFlowTabs = (snapshot) => (dispatch, getState) => {
  const { tabs } = readFlowsSnapshot(snapshot);
  const state = getState();
  const roots = [...new Set(tabs.map((tab) => tab.workspaceRoot).filter(Boolean))];

  for (const workspaceRoot of roots) {
    if (state.flows.restoredTabScopes.includes(workspaceRoot)) {
      continue;
    }

    const collectionUid = collectionUidForScope({
      workspaceRoot,
      collections: state.collections.collections,
      workspaces: state.workspaces.workspaces
    });
    if (!collectionUid) {
      continue;
    }

    dispatch(flowTabsRestored({ workspaceRoot }));

    for (const tab of tabs.filter((entry) => entry.workspaceRoot === workspaceRoot)) {
      // `addTab` dedupes on pathname and type, so a tab already open is focused rather than doubled —
      // which is what makes a later attempt at a scope that had not resolved yet safe.
      dispatch(
        addTab({
          uid: uuid(),
          type: tab.type,
          pathname: tab.pathname,
          collectionUid,
          // Permanent, the way §4.1's own open is: a restored tab is one somebody kept.
          preview: false
        })
      );
    }
  }
};
