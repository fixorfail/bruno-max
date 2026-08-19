import { createSelector } from '@reduxjs/toolkit';
import { collectionUidForScope } from './collectionScope';

/**
 * What the DevTools network tab lists — 002 §8.5.
 *
 * A flow's requests leave the app through the dispatch port (002 §7.3) rather than through
 * `send-http-request`, so they never reach a collection's `timeline` and the panel could not see
 * them at all. Merging happens here, in one place, because the panel builds this list twice
 * (`Console/index.js` for the method counts, `NetworkTab/index.js` for the rows) and two merges
 * would drift.
 *
 * A flow request is mapped into the timeline entry the panel already reads rather than the panel
 * being taught a second shape: nothing downstream of this selector needs to know flows exist.
 */

const collectionEntries = (collections) =>
  collections.flatMap((collection) =>
    (collection.timeline || [])
      .filter((entry) => entry.type === 'request')
      .map((entry) => ({ ...entry, collectionName: collection.name, collectionUid: collection.uid }))
  );

/**
 * Every row carries a collection, including a workspace-scoped flow's — see `collectionScope`. The
 * details panel resolves the collection from it and hands it to the response viewer, which reaches
 * for `collection.uid`; a row without one crashes that viewer rather than merely reading as
 * unattributed.
 */
const flowEntries = (requestLogs, collections, workspaces) =>
  requestLogs.map((log) => {
    const collectionUid = collectionUidForScope({
      collectionRoot: log.collectionRoot,
      workspaceRoot: log.workspaceRoot,
      collections,
      workspaces
    });

    return {
      type: 'request',
      collectionUid,
      collectionName: collections.find((entry) => entry.uid === collectionUid)?.name,
      folderUid: null,
      // The panel keys a row and its selection on this; an attempt is the finest thing that can be
      // selected, so it is what makes the id unique — a poll's twenty attempts are twenty rows.
      itemUid: `${log.runId}:${log.stepId}:${log.iteration}:${log.attempt}`,
      timestamp: log.timestamp,
      data: {
        request: log.request,
        response: log.response,
        timestamp: log.timestamp
      }
    };
  });

/**
 * The flow reducer is read through a fallback so that a store assembled without `forkReducers` —
 * which is how upstream's own panel specs build one — renders the collection half rather than
 * throwing. Keeping that tolerance here is what stops the fork from having to edit those specs.
 */
export const selectDevtoolsRequests = createSelector(
  [
    (state) => state.collections.collections,
    (state) => state.flows?.requestLogs || [],
    (state) => state.workspaces?.workspaces || []
  ],
  (collections, requestLogs, workspaces) =>
    [...collectionEntries(collections), ...flowEntries(requestLogs, collections, workspaces)].sort(
      (left, right) => left.timestamp - right.timestamp
    )
);
