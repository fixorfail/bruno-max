import { selectDevtoolsRequests } from './networkRequests';

/**
 * 002 §8.5 — what the DevTools network tab lists once a flow is running.
 *
 * The assertions are about the *merge*: that a flow request arrives in the timeline shape the panel
 * already reads, in chronological order beside the collection's own, and attributed to a collection
 * only when the flow has one.
 */

const collectionRequest = (timestamp, method) => ({
  type: 'request',
  itemUid: `item-${timestamp}`,
  timestamp,
  data: { request: { method, url: 'https://api.example.com/ping' }, response: { status: 200 }, timestamp }
});

const requestLog = (timestamp, overrides = {}) => ({
  runId: 'run-a',
  stepId: 'create',
  iteration: 0,
  attempt: 1,
  collectionRoot: '/workspace/collections/payments',
  workspaceRoot: '/workspace',
  timestamp,
  request: { url: 'https://api.example.com/things?page=2', method: 'POST', headers: {}, data: null },
  response: { status: 201, headers: {}, data: {}, dataBuffer: null, size: 12, duration: 42 },
  ...overrides
});

const state = ({ timeline = [], requestLogs = [] } = {}) => ({
  collections: {
    collections: [
      { uid: 'collection-1', name: 'Payments', pathname: '/workspace/collections/payments', timeline },
      { uid: 'scratch-1', name: 'Scratch', pathname: '/workspace/.scratch' }
    ]
  },
  flows: { requestLogs },
  workspaces: { workspaces: [{ uid: 'ws-1', pathname: '/workspace', scratchCollectionUid: 'scratch-1' }] }
});

describe('the DevTools request list', () => {
  it('interleaves flow requests with the collection timeline, oldest first', () => {
    const requests = selectDevtoolsRequests(
      state({
        timeline: [collectionRequest(30, 'GET'), collectionRequest(10, 'GET')],
        requestLogs: [requestLog(20)]
      })
    );

    expect(requests.map((entry) => entry.timestamp)).toEqual([10, 20, 30]);
    expect(requests.map((entry) => entry.data.request.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('carries the flow request in the shape the panel already reads', () => {
    const [entry] = selectDevtoolsRequests(state({ requestLogs: [requestLog(20)] }));

    expect(entry.type).toBe('request');
    expect(entry.data.request.url).toBe('https://api.example.com/things?page=2');
    expect(entry.data.response.status).toBe(201);
    expect(entry.data.timestamp).toBe(20);
  });

  it('attributes a collection-scoped flow to its collection', () => {
    const [entry] = selectDevtoolsRequests(state({ requestLogs: [requestLog(20)] }));

    expect(entry.collectionUid).toBe('collection-1');
    expect(entry.collectionName).toBe('Payments');
  });

  it('matches a collection whose path differs only in separators or a trailing slash', () => {
    const [entry] = selectDevtoolsRequests(
      state({ requestLogs: [requestLog(20, { collectionRoot: '\\workspace\\collections\\payments\\' })] })
    );

    expect(entry.collectionUid).toBe('collection-1');
  });

  /**
   * A workspace-scoped flow has no collection of its own (002 §7.2), so its rows borrow the
   * workspace's scratch collection — the same one its tab does. A row without any collection reaches
   * the details panel's response viewer, which dereferences `collection.uid`.
   */
  it('gives a workspace-scoped flow request the workspace scratch collection', () => {
    const [entry] = selectDevtoolsRequests(state({ requestLogs: [requestLog(20, { collectionRoot: undefined })] }));

    expect(entry.collectionUid).toBe('scratch-1');
  });

  it('falls back to the scratch collection when the named collection is no longer open', () => {
    const [entry] = selectDevtoolsRequests(
      state({ requestLogs: [requestLog(20, { collectionRoot: '/workspace/collections/closed' })] })
    );

    expect(entry.collectionUid).toBe('scratch-1');
  });

  it('gives every attempt of a poll its own row', () => {
    const requests = selectDevtoolsRequests(
      state({ requestLogs: [requestLog(20), requestLog(30, { attempt: 2 })] })
    );

    expect(requests.map((entry) => entry.itemUid)).toEqual(['run-a:create:0:1', 'run-a:create:0:2']);
  });

  it('ignores timeline entries that are not requests', () => {
    const requests = selectDevtoolsRequests(
      state({ timeline: [{ type: 'oauth2', timestamp: 5, data: {} }, collectionRequest(10, 'GET')] })
    );

    expect(requests).toHaveLength(1);
  });
});
