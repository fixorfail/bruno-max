import { collectionUidForScope } from './collectionScope';

/**
 * 002 §4.2 and §8.5 — everything a flow produces has to name a collection, because both surfaces it
 * reaches (the tab model, the devtools response viewer) assume there is always one.
 */

const collections = [
  { uid: 'collection-1', name: 'Payments', pathname: '/workspace/collections/payments' },
  { uid: 'scratch-1', name: 'Scratch', pathname: '/workspace/.scratch' }
];

const workspaces = [
  { uid: 'ws-1', pathname: '/workspace', scratchCollectionUid: 'scratch-1' },
  { uid: 'ws-2', pathname: '/other', scratchCollectionUid: 'scratch-2' }
];

const resolve = (scope) => collectionUidForScope({ ...scope, collections, workspaces });

describe('the collection a flow belongs to', () => {
  it('is the collection that owns it', () => {
    expect(resolve({ collectionRoot: '/workspace/collections/payments', workspaceRoot: '/workspace' }))
      .toBe('collection-1');
  });

  it('is the workspace scratch collection when the flow is scoped to the workspace', () => {
    expect(resolve({ workspaceRoot: '/workspace' })).toBe('scratch-1');
  });

  /** The section lists every watched scope, so the flow's own workspace decides, not the active one. */
  it('is the scratch collection of the flow own workspace, not of another', () => {
    expect(resolve({ workspaceRoot: '/other' })).toBe('scratch-2');
  });

  it('falls back to the scratch collection when the owning collection is closed', () => {
    expect(resolve({ collectionRoot: '/workspace/collections/gone', workspaceRoot: '/workspace' }))
      .toBe('scratch-1');
  });

  it('compares paths by separator and trailing slash, as every other path here is compared', () => {
    expect(resolve({ collectionRoot: '\\workspace\\collections\\payments\\', workspaceRoot: '/workspace' }))
      .toBe('collection-1');
  });

  /** A scope the app has nothing loaded for resolves to nothing rather than to an arbitrary uid. */
  it('resolves to nothing for a workspace that is not open', () => {
    expect(resolve({ workspaceRoot: '/elsewhere' })).toBeUndefined();
  });
});
