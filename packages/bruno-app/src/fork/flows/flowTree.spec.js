import { buildFlowTree, folderKeysOf, folderSegmentsOf, relativePathOf } from './flowTree';

/**
 * 002 §4.1a. The watcher has always walked `flows/` recursively, so these entries are the shape the
 * sidebar already receives — what is under test is the folder the app now reads out of one.
 */

const flow = (pathname, extra = {}) => ({
  pathname,
  filename: pathname.split(/[\\/]/).pop(),
  workspaceRoot: '/w',
  ...extra
});

describe('folderSegmentsOf', () => {
  it('reads the directories between the scope flows folder and the file', () => {
    expect(folderSegmentsOf(flow('/w/flows/company/billing/create.flow.yml'))).toEqual(['company', 'billing']);
  });

  it('gives a flow sitting directly in flows/ no folders', () => {
    expect(folderSegmentsOf(flow('/w/flows/create.flow.yml'))).toEqual([]);
  });

  it('counts a collection flow from its collection rather than the workspace', () => {
    const entry = flow('/w/payments/flows/refunds/settle.flow.yml', { collectionRoot: '/w/payments' });
    expect(folderSegmentsOf(entry)).toEqual(['refunds']);
  });

  // §4.5 and §4.6: each is measured from its own directory, so neither label is restated as a
  // folder row directly under it.
  it('counts a script from the scripts directory', () => {
    expect(folderSegmentsOf(flow('/w/flows/scripts/auth/sign.js', { script: true }))).toEqual(['auth']);
    expect(folderSegmentsOf(flow('/w/flows/scripts/sign.js', { script: true }))).toEqual([]);
  });

  it('counts a fixture from the fixtures directory', () => {
    expect(folderSegmentsOf(flow('/w/flows/fixtures/orders/large.json', { fixture: true }))).toEqual(['orders']);
    expect(folderSegmentsOf(flow('/w/flows/fixtures/catalog.json', { fixture: true }))).toEqual([]);
  });

  /**
   * A pathname arrives with the separators of the platform that reported it, and browserify's `path`
   * in the renderer is the POSIX build — so a Windows path is only split correctly by treating both
   * separators as one. Stated here rather than left to a Windows CI run, which is where the failure
   * would otherwise first appear.
   */
  it('splits a Windows path the same way', () => {
    const entry = {
      pathname: 'C:\\repo\\w\\flows\\company\\create.flow.yml',
      filename: 'create.flow.yml',
      workspaceRoot: 'C:\\repo\\w'
    };
    expect(folderSegmentsOf(entry)).toEqual(['company']);
    expect(relativePathOf(entry)).toBe('company/create.flow.yml');
  });

  // Not reachable through the watcher, which builds both from one scope — but a flow disappearing
  // from the sidebar is the one outcome a grouping rule must never produce by itself.
  it('lists an entry outside its own scope at the top rather than dropping it', () => {
    expect(folderSegmentsOf(flow('/elsewhere/create.flow.yml'))).toEqual([]);
  });
});

describe('relativePathOf', () => {
  it('is the filename for a flow with no folders, so ids that predate folders are unchanged', () => {
    expect(relativePathOf(flow('/w/flows/create.flow.yml'))).toBe('create.flow.yml');
  });

  it('distinguishes the same filename in two folders', () => {
    expect(relativePathOf(flow('/w/flows/company/create.flow.yml'))).toBe('company/create.flow.yml');
    expect(relativePathOf(flow('/w/flows/user/create.flow.yml'))).toBe('user/create.flow.yml');
  });
});

describe('buildFlowTree', () => {
  it('nests a flow under each directory it sits in', () => {
    const tree = buildFlowTree([flow('/w/flows/company/billing/create.flow.yml')], 'flows');

    expect(tree.flows).toEqual([]);
    expect(tree.folders.map((folder) => folder.name)).toEqual(['company']);

    const [company] = tree.folders;
    expect(company.path).toBe('company');
    expect(company.key).toBe('flows:/w/flows/company');

    const [billing] = company.folders;
    expect(billing.path).toBe('company/billing');
    expect(billing.flows.map((entry) => entry.filename)).toEqual(['create.flow.yml']);
  });

  it('puts folders above the flows beside them, each in name order', () => {
    const tree = buildFlowTree([
      flow('/w/flows/zebra.flow.yml'),
      flow('/w/flows/user/create.flow.yml'),
      flow('/w/flows/alpha.flow.yml'),
      flow('/w/flows/company/create.flow.yml')
    ], 'flows');

    expect(tree.folders.map((folder) => folder.name)).toEqual(['company', 'user']);
    expect(tree.flows.map((entry) => entry.filename)).toEqual(['alpha.flow.yml', 'zebra.flow.yml']);
  });

  // §4.1: a flow reads by the name it declares, so that is what it is ordered by too — ordering by
  // filename would sort a list nobody is reading.
  it('orders flows by their declared name where they have one', () => {
    const tree = buildFlowTree([
      flow('/w/flows/a.flow.yml', { name: 'Zebra' }),
      flow('/w/flows/z.flow.yml', { name: 'Alpha' })
    ], 'flows');

    expect(tree.flows.map((entry) => entry.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('keys a folder by its absolute path, so two scopes naming a folder alike stay distinct', () => {
    const tree = buildFlowTree([
      flow('/w/flows/company/create.flow.yml'),
      flow('/w/payments/flows/company/refund.flow.yml', { collectionRoot: '/w/payments' })
    ], 'flows');

    expect(folderKeysOf(tree)).toEqual(['flows:/w/flows/company', 'flows:/w/payments/flows/company']);
  });

  /**
   * One directory holding both an ordinary flow and a library is drawn as two rows, either side of
   * the `Libraries` label — so they must open independently, whatever they share on disk.
   */
  it('keys a folder by its bucket as well, so two buckets sharing a directory stay distinct', () => {
    const nested = '/w/flows/company/create.flow.yml';

    expect(folderKeysOf(buildFlowTree([flow(nested)], 'flows'))).toEqual(['flows:/w/flows/company']);
    expect(folderKeysOf(buildFlowTree([flow(nested)], 'libraries'))).toEqual(['libraries:/w/flows/company']);
  });

  it('reports every folder key, at every depth', () => {
    const tree = buildFlowTree([
      flow('/w/flows/company/billing/create.flow.yml'),
      flow('/w/flows/user/create.flow.yml')
    ], 'flows');

    expect(folderKeysOf(tree)).toEqual([
      'flows:/w/flows/company',
      'flows:/w/flows/company/billing',
      'flows:/w/flows/user'
    ]);
  });
});
