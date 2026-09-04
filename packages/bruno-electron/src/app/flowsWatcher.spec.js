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
      workspaceRoot,
      // `flowIdentity` names an undeclared flow by its file, so a flow with no `meta:` is still
      // findable by what it is called.
      terms: ['flows/checkout', 'checkout']
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

  /**
   * What the sidebar's search box filters on. The terms are the engine's extraction rather than the
   * fields a row draws, because the box and `bru flow run --grep` have to agree about what a flow
   * contains — a flow findable in one and not the other is a bug with no explanation.
   */
  describe('search terms', () => {
    it('carries the id, the name, the tags and each step\'s name and meta', async () => {
      fs.writeFileSync(
        path.join(flowsDir, 'checkout.flow.yml'),
        [
          'version: 1',
          'meta:',
          '  name: Checkout',
          '  tags:',
          '    - smoke',
          'steps:',
          '  - id: pay',
          '    name: Pay the invoice',
          '    meta:',
          '      jira:',
          '        key: PAY-41',
          ''
        ].join('\n')
      );

      const [flow] = await watcher.listFlows({ workspaceRoot });

      expect(flow.terms).toEqual(['flows/checkout', 'Checkout', 'smoke', 'pay', 'Pay the invoice', 'PAY-41']);
    });

    /** The id is the flow's identity (001 §5.2), so it is relative to the scope the flow belongs to. */
    it('names a collection-scoped flow relative to its collection', async () => {
      const collectionRoot = path.join(workspaceRoot, 'payments');
      fs.mkdirSync(path.join(collectionRoot, 'flows'), { recursive: true });
      fs.writeFileSync(path.join(collectionRoot, 'flows', 'settle.flow.yml'), 'version: 1\n');

      const [flow] = await watcher.listFlows({ workspaceRoot, collectionRoot });

      expect(flow.terms).toEqual(['flows/settle', 'settle']);
    });

    /** 002 §6: an unparseable flow is ordinary, and is still findable by the path it already has. */
    it('indexes a flow that does not parse by its path alone', async () => {
      fs.writeFileSync(path.join(flowsDir, 'broken.flow.yml'), 'steps: [ unterminated');

      const [flow] = await watcher.listFlows({ workspaceRoot });

      expect(flow.terms).toEqual(['flows/broken', 'broken']);
    });

    it('re-indexes a flow whose metadata changed', async () => {
      const flowFile = path.join(flowsDir, 'checkout.flow.yml');
      fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Checkout\n');
      watcher.addWatcher(win, { workspaceRoot });
      await until(() => sent('addFile').length === 1);

      fs.writeFileSync(flowFile, 'version: 1\nmeta:\n  name: Checkout\n  tags:\n    - slow\n');
      await until(() => sent('changeFile').length === 1);

      expect(sent('changeFile')[0][2].terms).toEqual(['flows/checkout', 'Checkout', 'slow']);
    });

    /** §4.5 and §4.6 are source and data: they have no `meta:`, and the app filters them by filename. */
    it('gives a script and a fixture none', async () => {
      fs.mkdirSync(path.join(flowsDir, 'scripts'));
      fs.mkdirSync(path.join(flowsDir, 'fixtures'));
      fs.writeFileSync(path.join(flowsDir, 'scripts', 'text.js'), '\n');
      fs.writeFileSync(path.join(flowsDir, 'fixtures', 'catalog.json'), '{}\n');

      const flows = await watcher.listFlows({ workspaceRoot });

      expect(flows.map((flow) => flow.terms)).toEqual([undefined, undefined]);
    });
  });

  /**
   * 002 §4.5 — `.js` helpers under `flows/scripts/`, listed so the files `use:` names are visible
   * without opening a flow. Only under that directory: a `.js` beside a flow is an ordinary `use:`
   * target and always was, and listing every one would make the section a file browser.
   */
  describe('scripts (§4.5)', () => {
    const scriptsDir = () => path.join(flowsDir, 'scripts');

    beforeEach(() => {
      fs.mkdirSync(path.join(flowsDir, 'scripts'), { recursive: true });
    });

    it('lists a script, flagged, with no name read from it', async () => {
      fs.writeFileSync(path.join(scriptsDir(), 'text.js'), 'const lastFour = () => 4;\n');

      const [entry] = await watcher.listFlows({ workspaceRoot });

      expect(entry).toEqual({
        pathname: path.join(scriptsDir(), 'text.js'),
        filename: 'text.js',
        workspaceRoot,
        script: true
      });
    });

    it('lists one nested inside the scripts directory', async () => {
      fs.mkdirSync(path.join(scriptsDir(), 'money'));
      fs.writeFileSync(path.join(scriptsDir(), 'money', 'format.js'), '\n');

      const flows = await watcher.listFlows({ workspaceRoot });

      expect(flows.map((flow) => flow.filename)).toEqual(['format.js']);
    });

    /** The convention is what gives the section a meaning to state. */
    it('ignores a .js anywhere else under flows/', async () => {
      fs.mkdirSync(path.join(flowsDir, 'lib'));
      fs.writeFileSync(path.join(flowsDir, 'lib', 'text.js'), '\n');
      fs.writeFileSync(path.join(flowsDir, 'helper.js'), '\n');

      expect(await watcher.listFlows({ workspaceRoot })).toEqual([]);
    });

    it('ignores a non-.js file inside the scripts directory', async () => {
      fs.writeFileSync(path.join(scriptsDir(), 'notes.md'), '\n');
      fs.writeFileSync(path.join(scriptsDir(), 'shared.yml'), 'functions:\n');

      expect(await watcher.listFlows({ workspaceRoot })).toEqual([]);
    });

    it('reports a script added, changed and deleted', async () => {
      watcher.addWatcher(win, { workspaceRoot });
      const target = path.join(scriptsDir(), 'text.js');

      fs.writeFileSync(target, 'const a = 1;\n');
      await until(() => sent('addFile').some(([, , entry]) => entry.filename === 'text.js'));
      expect(sent('addFile').at(-1)[2]).toMatchObject({ filename: 'text.js', script: true });

      fs.writeFileSync(target, 'const a = 2;\n');
      await until(() => sent('changeFile').length > 0);

      fs.rmSync(target);
      await until(() => sent('unlinkFile').length > 0);
      expect(sent('unlinkFile').at(-1)[2]).toMatchObject({ filename: 'text.js', script: true });
    });

    it('lists flows and scripts together, and flags only the scripts', async () => {
      fs.writeFileSync(path.join(flowsDir, 'checkout.flow.yml'), 'version: 1\n');
      fs.writeFileSync(path.join(scriptsDir(), 'text.js'), '\n');

      const flows = await watcher.listFlows({ workspaceRoot });

      expect(flows.map((flow) => [flow.filename, Boolean(flow.script)])).toEqual([
        ['checkout.flow.yml', false],
        ['text.js', true]
      ]);
    });
  });

  /**
   * 002 §4.6. The directory is the convention, not the extension — 001 §7.4 reads JSON, YAML and CSV
   * through `!file` and attaches documents of whatever type the operation takes.
   */
  describe('fixtures (§4.6)', () => {
    const fixturesDir = () => path.join(flowsDir, 'fixtures');

    beforeEach(() => {
      fs.mkdirSync(fixturesDir(), { recursive: true });
    });

    it('lists a fixture, flagged, with no name read from it', async () => {
      fs.writeFileSync(path.join(fixturesDir(), 'catalog.json'), '{}\n');

      const [entry] = await watcher.listFlows({ workspaceRoot });

      expect(entry).toEqual({
        pathname: path.join(fixturesDir(), 'catalog.json'),
        filename: 'catalog.json',
        workspaceRoot,
        fixture: true
      });
    });

    it('lists one whatever its extension, including a binary document', async () => {
      fs.writeFileSync(path.join(fixturesDir(), 'customers.csv'), 'id,name\n');
      fs.writeFileSync(path.join(fixturesDir(), 'contract.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));
      fs.writeFileSync(path.join(fixturesDir(), 'notes'), 'no extension at all\n');

      const flows = await watcher.listFlows({ workspaceRoot });

      expect(flows.map((flow) => flow.filename).sort()).toEqual(['contract.pdf', 'customers.csv', 'notes']);
      expect(flows.every((flow) => flow.fixture)).toBe(true);
    });

    it('lists one nested inside the fixtures directory', async () => {
      fs.mkdirSync(path.join(fixturesDir(), 'orders'));
      fs.writeFileSync(path.join(fixturesDir(), 'orders', 'large.json'), '{}\n');

      const flows = await watcher.listFlows({ workspaceRoot });

      expect(flows.map((flow) => flow.filename)).toEqual(['large.json']);
    });

    /** The convention is what keeps the section from being a file browser. */
    it('ignores a data file anywhere else under flows/', async () => {
      fs.mkdirSync(path.join(flowsDir, 'data'));
      fs.writeFileSync(path.join(flowsDir, 'data', 'catalog.json'), '{}\n');
      fs.writeFileSync(path.join(flowsDir, 'catalog.json'), '{}\n');

      expect(await watcher.listFlows({ workspaceRoot })).toEqual([]);
    });

    /** A flow is a flow wherever it is filed, rather than becoming opaque data. */
    it('lists a .flow.yml under fixtures as a flow', async () => {
      fs.writeFileSync(path.join(fixturesDir(), 'seed.flow.yml'), 'meta:\n  name: Seed\n');

      const [entry] = await watcher.listFlows({ workspaceRoot });

      expect(entry).toMatchObject({ filename: 'seed.flow.yml', name: 'Seed' });
      expect(entry.fixture).toBeUndefined();
    });

    it('reports a fixture added, changed and deleted', async () => {
      watcher.addWatcher(win, { workspaceRoot });
      const target = path.join(fixturesDir(), 'catalog.json');

      fs.writeFileSync(target, '{ "a": 1 }\n');
      await until(() => sent('addFile').some(([, , entry]) => entry.filename === 'catalog.json'));
      expect(sent('addFile').at(-1)[2]).toMatchObject({ filename: 'catalog.json', fixture: true });

      fs.writeFileSync(target, '{ "a": 2 }\n');
      await until(() => sent('changeFile').length > 0);

      fs.rmSync(target);
      await until(() => sent('unlinkFile').length > 0);
      expect(sent('unlinkFile').at(-1)[2]).toMatchObject({ filename: 'catalog.json', fixture: true });
    });
  });
});
