import find from 'lodash/find';
import { normalizePath } from 'utils/common/path';

/**
 * Which collection a flow's artifacts belong to — 002 §4.2 and §8.5.
 *
 * **Everything in this app belongs to a collection**, and a workspace-level thing belongs to the
 * workspace's *scratch* collection — which is how upstream's own `workspaceOverview` and
 * `workspaceEnvironments` tabs exist (`slices/workspaces/actions.js:668`). A flow scoped to the
 * workspace (§7.2) has no collection of its own, so it borrows that one, and so do the requests it
 * sends. Leaving it unresolved instead pushes a collection-less object into surfaces built on the
 * assumption that there is always one, where the failure is a crash rather than a missing name.
 *
 * A collection that is closed falls through to the same fallback: the flow ran, its rows are still
 * in the log, and the collection they named is simply no longer loaded.
 */

const samePath = (left, right) => Boolean(left) && Boolean(right) && normalizePath(left) === normalizePath(right);

export const collectionUidForScope = ({ collectionRoot, workspaceRoot, collections, workspaces }) => {
  // Paths reach the renderer by different routes — a collection's through `main:collection-opened`,
  // a flow's through its scope — so they are compared the way every other path here is.
  const collection = collectionRoot && find(collections, (entry) => samePath(entry.pathname, collectionRoot));
  if (collection) {
    return collection.uid;
  }

  return find(workspaces, (workspace) => samePath(workspace.pathname, workspaceRoot))?.scratchCollectionUid;
};
