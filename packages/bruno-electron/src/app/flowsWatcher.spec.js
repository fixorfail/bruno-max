const fs = require('fs');
const os = require('os');
const path = require('path');
const FlowsWatcher = require('./flowsWatcher');

/** 002-C U5.6 — the watcher reports, and parses nothing. */
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

  it('reports a flow that does not parse', async () => {
    fs.writeFileSync(path.join(flowsDir, 'broken.flow.yml'), 'steps: [ unterminated');
    watcher.addWatcher(win, { workspaceRoot });

    await until(() => sent('addFile').length === 1);
    expect(sent('addFile')[0][2].filename).toBe('broken.flow.yml');
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
