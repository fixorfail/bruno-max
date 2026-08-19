const fs = require('fs');
const os = require('os');
const path = require('path');
const FlowsWatcher = require('./flowsWatcher');

/** 002-C U5.6 — the watcher reports, and reads only `meta.name`. */
describe('FlowsWatcher', () => {
  let workspaceRoot;
  let flowsDir;
  let watcher;
  let win;

  const sent = (event) =>
    win.webContents.send.mock.calls.filter(([channel, name]) => channel === 'main:flow-tree-updated' && name === event);

  const until = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the watcher never reported');
  };

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-watcher-'));
    flowsDir = path.join(workspaceRoot, 'flows');
    fs.mkdirSync(flowsDir);
    watcher = new FlowsWatcher();
    win = { isDestroyed: () => false, webContents: { send: jest.fn() } };
  });

  afterEach(async () => {
    await watcher.closeAllWatchers();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('lists the flows already on disk, in path order, and ignores everything else', async () => {
    fs.writeFileSync(path.join(flowsDir, 'checkout.flow.yml'), 'version: 1\n');
    fs.mkdirSync(path.join(flowsDir, 'shared'));
    fs.writeFileSync(path.join(flowsDir, 'shared', 'login.flow.yml'), 'version: 1\n');
    fs.writeFileSync(path.join(flowsDir, 'notes.md'), 'not a flow');

    const flows = await watcher.listFlows({ workspaceRoot });

    expect(flows.map((flow) => flow.filename)).toEqual(['checkout.flow.yml', 'login.flow.yml']);
    expect(flows[0]).toEqual({
      pathname: path.join(flowsDir, 'checkout.flow.yml'),
      filename: 'checkout.flow.yml',
      workspaceRoot
    });
  });

  it('returns nothing for a scope with no flows directory', async () => {
    expect(await watcher.listFlows({ workspaceRoot: path.join(workspaceRoot, 'nowhere') })).toEqual([]);
  });

  it('reports a flow that does not parse, unnamed', async () => {
    fs.writeFileSync(path.join(flowsDir, 'broken.flow.yml'), 'steps: [ unterminated');
    watcher.addWatcher(win, { workspaceRoot });

    await until(() => sent('addFile').length === 1);
    expect(sent('addFile')[0][2].filename).toBe('broken.flow.yml');
    expect(sent('addFile')[0][2].name).toBeUndefined();
  });

  /**
   * §5.4's local tags are part of the format. A watcher parsing YAML on its own rejects `!file` as
   * an unknown tag, and the flow — a perfectly good one, which `bru flow validate` passes — loses
   * its name silently and reads in the sidebar as its filename.
   */
  it('names a flow that uses a local tag', async () => {
    fs.writeFileSync(
      path.join(flowsDir, 'seed.flow.yml'),
      'version: 1\nmeta:\n  name: Seed a verified company\nvars:\n  documents: !file ../fixtures/documents.json\n'
    );

    const [flow] = await watcher.listFlows({ workspaceRoot });

    expect(flow.name).toBe('Seed a verified company');
  });

  /** §4.1: the sidebar names a flow by `meta.name`, which it has to know before the flow is opened. */
  it('carries the declared name, and reports it again when it changes', async () => {
    const flowFile = path.join(flowsDir, 'checkout.flow.yml');
    fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Checkout\n');

    expect((await watcher.listFlows({ workspaceRoot }))[0].name).toBe('Checkout');

    watcher.addWatcher(win, { workspaceRoot });
    await until(() => sent('addFile').length === 1);

    fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Checkout with discounts\n');
    await until(() => sent('changeFile').length === 1);

    expect(sent('changeFile')[0][2].name).toBe('Checkout with discounts');
  });

  /**
   * §4.1 groups the sidebar by it, and 001 §12.5 makes it the difference between a flow a glob run
   * executes and one it skips — so it has to be known for a flow nobody has opened.
   */
  it('carries the library flag, and drops it when the file stops declaring one', async () => {
    const flowFile = path.join(flowsDir, 'login.flow.yml');
    fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Login\n  library: true\n');

    expect((await watcher.listFlows({ workspaceRoot }))[0].library).toBe(true);

    watcher.addWatcher(win, { workspaceRoot });
    await until(() => sent('addFile').length === 1);

    fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Login\n');
    await until(() => sent('changeFile').length === 1);

    expect(sent('changeFile')[0][2].library).toBeUndefined();
  });

  it('reports an add, a change and a delete, and stops once unwatched', async () => {
    watcher.addWatcher(win, { workspaceRoot });
    const flowFile = path.join(flowsDir, 'refund.flow.yml');

    fs.writeFileSync(flowFile, 'version: 1\n');
    await until(() => sent('addFile').length === 1);

    fs.writeFileSync(flowFile, 'version: 1\nsteps: []\n');
    await until(() => sent('changeFile').length === 1);

    fs.rmSync(flowFile);
    await until(() => sent('unlinkFile').length === 1);

    watcher.removeWatcher({ workspaceRoot });
    win.webContents.send.mockClear();
    fs.writeFileSync(path.join(flowsDir, 'later.flow.yml'), 'version: 1\n');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('carries the collection root when the scope has one', async () => {
    const collectionRoot = path.join(workspaceRoot, 'payments');
    fs.mkdirSync(path.join(collectionRoot, 'flows'), { recursive: true });
    fs.writeFileSync(path.join(collectionRoot, 'flows', 'settle.flow.yml'), 'version: 1\n');

    const [flow] = await watcher.listFlows({ workspaceRoot, collectionRoot });

    expect(flow.collectionRoot).toBe(collectionRoot);
    expect(flow.workspaceRoot).toBe(workspaceRoot);
  });
});
