jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), on: jest.fn() } }));
// The engine's own reader and writer are real here: they are the format's only serializer (001
// §5.1), and a properties handler tested against a stub of them would assert its own plumbing.
jest.mock('@bruno-max/flow', () => ({
  ...jest.requireActual('@bruno-max/flow'),
  runFlow: jest.fn(),
  describeFlow: jest.fn(),
  listRuns: jest.fn(),
  readCapture: jest.fn()
}));
// The real port is covered by `ports.spec.js`; here it only has to hand back the reporter so a
// scenario can drive `onRequest` the way a dispatched request would, and a `readFile` that names
// what it read so §4.3's draft overlay can be told apart from a read of the disk.
jest.mock('./ports', () => ({
  createPorts: ({ onRequest }) => ({
    onRequest,
    readFile: async (target) => Buffer.from(`on disk: ${target}`),
    readSpec: async () => ({ text: '', from: 'file' })
  })
}));

const { ipcMain } = require('electron');
const { runFlow } = require('@bruno-max/flow');
const registerFlowIpc = require('./index');
const { startRun, cancelRun, shutdown } = require('./index');

const makeWindow = () => ({ isDestroyed: () => false, webContents: { send: jest.fn() } });

const runRequest = (entry) => ({ entry, scope: { workspaceRoot: '/workspace' }, tiers: {} });

/**
 * A run that announces itself, emits what the test asks for, and then waits to be cancelled — the
 * shape every scenario below needs from the engine.
 */
const scriptedRun = (runId, events = []) => (options) => {
  options.onEvent({ type: 'run:start', runId, flow: options.entry, iterationCount: 1 });
  for (const event of events) {
    options.onEvent(event);
  }
  return new Promise((resolve) => {
    options.signal.addEventListener('abort', () => resolve({ runId, status: 'cancelled' }));
  });
};

describe('the flow IPC host', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    runFlow.mockReset();
    ipcMain.on.mockClear();
    ipcMain.handle.mockClear();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  /** 002-C U5.4 */
  it('cancels the run it was given and no other', async () => {
    runFlow.mockImplementation((options) => scriptedRun(options.entry === 'a.flow.yml' ? 'run-a' : 'run-b')(options));

    const win = makeWindow();
    const { runId: a } = await startRun(win, runRequest('a.flow.yml'));
    const { runId: b } = await startRun(win, runRequest('b.flow.yml'));

    expect(cancelRun({ runId: a })).toBe(true);
    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(true);
    expect(runFlow.mock.calls[1][0].signal.aborted).toBe(false);

    cancelRun({ runId: b });
  });

  /** 002-C U5.4 */
  it('resolves false for a run this process is not executing', () => {
    expect(cancelRun({ runId: 'a-run-the-cli-started' })).toBe(false);
  });

  /** 002-C U5.5 */
  it('batches events per run, never mixing two', async () => {
    const stepEvent = (id) => ({ type: 'step:start', id, index: 0 });
    runFlow.mockImplementationOnce(scriptedRun('run-a', [stepEvent('one'), stepEvent('two')]));
    runFlow.mockImplementationOnce(scriptedRun('run-b', [stepEvent('three')]));

    const win = makeWindow();
    await startRun(win, runRequest('a.flow.yml'));
    await startRun(win, runRequest('b.flow.yml'));
    jest.advanceTimersByTime(20);

    const batches = win.webContents.send.mock.calls.filter(([channel]) => channel === 'main:flow-run-event');
    expect(batches).toHaveLength(2);

    const [{ runId: firstRun, events: firstEvents }] = batches.find(([, payload]) => payload.runId === 'run-a').slice(1);
    expect(firstRun).toBe('run-a');
    expect(firstEvents.map((event) => event.type)).toEqual(['run:start', 'step:start', 'step:start']);
    expect(firstEvents.slice(1).map((event) => event.id)).toEqual(['one', 'two']);

    const [{ events: secondEvents }] = batches.find(([, payload]) => payload.runId === 'run-b').slice(1);
    expect(secondEvents.every((event) => event.id === undefined || event.id === 'three')).toBe(true);

    cancelRun({ runId: 'run-a' });
    cancelRun({ runId: 'run-b' });
  });

  /** 002-C U5.9 */
  it('batches request logs, and across runs rather than per run', async () => {
    const sendRequests = (runId) => (options) => {
      options.onEvent({ type: 'run:start', runId, flow: options.entry, iterationCount: 1 });
      options.ports.onRequest({ runId, stepId: 'create', iteration: 0, attempt: 1 });
      options.ports.onRequest({ runId, stepId: 'create', iteration: 0, attempt: 2 });
      return new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ runId, status: 'cancelled' }));
      });
    };
    runFlow.mockImplementationOnce(sendRequests('run-a'));
    runFlow.mockImplementationOnce(sendRequests('run-b'));

    const win = makeWindow();
    await startRun(win, runRequest('a.flow.yml'));
    await startRun(win, runRequest('b.flow.yml'));
    jest.advanceTimersByTime(20);

    const batches = win.webContents.send.mock.calls.filter(([channel]) => channel === 'main:flow-request-log-batch');
    expect(batches).toHaveLength(1);
    expect(batches[0][1].requests.map((log) => `${log.runId}:${log.attempt}`)).toEqual([
      'run-a:1',
      'run-a:2',
      'run-b:1',
      'run-b:2'
    ]);

    cancelRun({ runId: 'run-a' });
    cancelRun({ runId: 'run-b' });
  });

  it('drops a queued batch rather than sending to a window that is gone', async () => {
    runFlow.mockImplementationOnce((options) => {
      options.onEvent({ type: 'run:start', runId: 'run-a', flow: options.entry, iterationCount: 1 });
      options.ports.onRequest({ runId: 'run-a', stepId: 'create', iteration: 0, attempt: 1 });
      return new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ runId: 'run-a', status: 'cancelled' }));
      });
    });

    const win = makeWindow();
    win.isDestroyed = () => true;
    await startRun(win, runRequest('a.flow.yml'));
    jest.advanceTimersByTime(20);

    expect(win.webContents.send).not.toHaveBeenCalled();
    cancelRun({ runId: 'run-a' });
  });

  /** 002-C U5.8 */
  it('leaves a run alone when quit is only initiated', async () => {
    runFlow.mockImplementation(scriptedRun('run-a'));
    // Registering for real is the point: the defect was a `main:start-quit-flow` listener that
    // aborted every run, and `ConfirmAppClose` lets the user dismiss that dialog and stay.
    registerFlowIpc(makeWindow());

    const { runId } = await startRun(makeWindow(), runRequest('a.flow.yml'));
    for (const [channel, handler] of ipcMain.on.mock.calls) {
      if (channel === 'main:start-quit-flow') handler();
    }

    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(false);
    cancelRun({ runId });
  });

  /** 002-C U5.8 */
  it('aborts every run at shutdown and waits for its cleanup to finish', async () => {
    let cleanupFinished = false;
    runFlow.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onEvent({ type: 'run:start', runId: 'run-a', flow: options.entry, iterationCount: 1 });
          options.signal.addEventListener('abort', () => {
            // 001 §11.3 keeps `status: [cancelled]` steps running after the abort; the run resolves
            // only once that cleanup is done, and shutdown has to wait for it.
            setTimeout(() => {
              cleanupFinished = true;
              resolve({ runId: 'run-a', status: 'cancelled' });
            }, 50);
          });
        })
    );

    await startRun(makeWindow(), runRequest('a.flow.yml'));
    const shuttingDown = shutdown();
    jest.advanceTimersByTime(50);
    await shuttingDown;

    expect(runFlow.mock.calls[0][0].signal.aborted).toBe(true);
    expect(cleanupFinished).toBe(true);
  });

  it('rejects a flow that fails before it has a run identity', async () => {
    runFlow.mockRejectedValue(new Error('flows/broken.flow.yml: could not be parsed'));

    await expect(startRun(makeWindow(), runRequest('broken.flow.yml'))).rejects.toThrow('could not be parsed');
  });

  it('refuses a request with no workspace root', async () => {
    await expect(startRun(makeWindow(), { entry: 'a.flow.yml', scope: {}, tiers: {} })).rejects.toThrow(
      'workspaceRoot'
    );
  });
});

/**
 * 002 §4.3 — the raw editor's host. It reads and writes one file and describes text that is not on
 * disk yet, and the preload forwards any channel to it, so what it refuses matters as much as what
 * it does.
 */
describe('the raw YAML editor host', () => {
  const fs = require('fs');
  const { describeFlow } = require('@bruno-max/flow');
  const { describeFlowHandler, readFlowSourceHandler, writeFlowSourceHandler } = require('./index');

  const scope = { workspaceRoot: '/workspace' };
  const entry = '/workspace/flows/checkout.flow.yml';

  beforeEach(() => {
    describeFlow.mockReset();
  });

  it('describes the file on disk when there is no draft', async () => {
    describeFlow.mockImplementation(async ({ ports }) => (await ports.readFile(entry)).toString('utf8'));

    await expect(describeFlowHandler({ entry, scope })).resolves.toBe(`on disk: ${entry}`);
  });

  /** Only the entry is answered from memory: sub-flows and specs still come off the disk (§4.3). */
  it('answers the entry from the draft and everything else from disk', async () => {
    describeFlow.mockImplementation(async ({ ports }) => ({
      entry: (await ports.readFile(entry)).toString('utf8'),
      subflow: (await ports.readFile('/workspace/flows/login.flow.yml')).toString('utf8')
    }));

    await expect(describeFlowHandler({ entry, scope, content: 'steps: []' })).resolves.toEqual({
      entry: 'steps: []',
      subflow: 'on disk: /workspace/flows/login.flow.yml'
    });
  });

  it('reads and writes the flow as text', async () => {
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue('steps: []');
    jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);

    await expect(readFlowSourceHandler({ entry, scope })).resolves.toBe('steps: []');
    await writeFlowSourceHandler({ entry, scope, content: 'steps: []' });

    expect(fs.promises.writeFile).toHaveBeenCalledWith(entry, 'steps: []', 'utf8');
    fs.promises.readFile.mockRestore();
    fs.promises.writeFile.mockRestore();
  });

  it('refuses a path that is not a flow', async () => {
    await expect(writeFlowSourceHandler({ entry: '/workspace/notes.txt', scope, content: '' })).rejects.toThrow(
      'not a flow file'
    );
  });

  /** The scope root is not a string prefix: `/workspace-two` starts with `/workspace`. */
  it('refuses a flow outside the scope it named', async () => {
    const outside = '/workspace/../elsewhere/x.flow.yml';

    await expect(readFlowSourceHandler({ entry: outside, scope })).rejects.toThrow('outside its scope');
    await expect(readFlowSourceHandler({ entry: '/workspace-two/x.flow.yml', scope })).rejects.toThrow(
      'outside its scope'
    );
  });

  it('refuses a write with no text', async () => {
    await expect(writeFlowSourceHandler({ entry, scope })).rejects.toThrow('needs text');
  });
});

/** 002 §4.1 — the Create Flow form's two handlers. */
describe('creating a flow', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { flowsFolderHandler, createFlowHandler } = require('./index');

  let scopeRoot;

  beforeEach(() => {
    scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-create-'));
  });

  afterEach(() => {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
  });

  it('names the scope flows folder without creating it', () => {
    expect(flowsFolderHandler({ scopeRoot })).toBe(path.join(scopeRoot, 'flows'));
    expect(fs.existsSync(path.join(scopeRoot, 'flows'))).toBe(false);
  });

  it('refuses to name a folder for no scope', () => {
    expect(() => flowsFolderHandler({})).toThrow('needs a scope root');
  });

  /** The first flow of a workspace lands in a directory nothing has made yet. */
  it('creates the directory the flow is written into', async () => {
    const directory = path.join(scopeRoot, 'flows');

    const pathname = await createFlowHandler({ directory, filename: 'checkout.flow.yml', content: 'version: 1\n' });

    expect(pathname).toBe(path.join(directory, 'checkout.flow.yml'));
    expect(fs.readFileSync(pathname, 'utf8')).toBe('version: 1\n');
  });

  /** The only thing the form knows about a file already there is that the author did not mean it. */
  it('refuses to overwrite a flow that already exists', async () => {
    const directory = path.join(scopeRoot, 'flows');
    await createFlowHandler({ directory, filename: 'checkout.flow.yml', content: 'version: 1\n' });

    await expect(
      createFlowHandler({ directory, filename: 'checkout.flow.yml', content: 'version: 2\n' })
    ).rejects.toThrow('a flow already exists at');
    expect(fs.readFileSync(path.join(directory, 'checkout.flow.yml'), 'utf8')).toBe('version: 1\n');
  });

  /** `scanFlows` matches on the extension, so a file written without it is created and then unseen. */
  it('refuses a filename the watcher would never report', async () => {
    await expect(createFlowHandler({ directory: scopeRoot, filename: 'checkout.yml', content: '' })).rejects.toThrow(
      'not a valid flow filename'
    );
  });

  it('refuses a filename that is a path', async () => {
    await expect(
      createFlowHandler({ directory: scopeRoot, filename: '../escaped.flow.yml', content: '' })
    ).rejects.toThrow('not a valid flow filename');
  });

  it('refuses a create with no directory and one with no text', async () => {
    await expect(createFlowHandler({ filename: 'a.flow.yml', content: '' })).rejects.toThrow('needs a directory');
    await expect(createFlowHandler({ directory: scopeRoot, filename: 'a.flow.yml' })).rejects.toThrow('needs text');
  });
});

/** 002 §4.4 — the properties dialog: the `meta:` block, and the file's own name. */
describe('a flow\'s properties', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readFlowPropertiesHandler, updateFlowPropertiesHandler } = require('./index');

  const NONE = { tags: [], library: false };

  let scopeRoot;
  let scope;
  let entry;

  const FLOW = 'version: 1\nmeta:\n  name: Checkout\n\nsteps:\n  - id: charge # the one that matters\n';

  beforeEach(() => {
    scopeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-props-')));
    scope = { workspaceRoot: scopeRoot };
    entry = path.join(scopeRoot, 'checkout.flow.yml');
    fs.writeFileSync(entry, FLOW, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
  });

  it('reads the meta block and the filename the dialog opens with', async () => {
    expect(await readFlowPropertiesHandler({ entry, scope })).toEqual({
      filename: 'checkout.flow.yml',
      name: 'Checkout',
      ...NONE
    });
  });

  /** The raw editor is where text that does not parse gets fixed; a form cannot offer to. */
  it('refuses to read a flow that is not a YAML document', async () => {
    fs.writeFileSync(entry, 'version: 1\nsteps:\n  - id: a\n   bad indent\n', 'utf8');

    await expect(readFlowPropertiesHandler({ entry, scope })).rejects.toThrow('is not a YAML document');
  });

  it('writes the meta block and leaves the rest of the file alone', async () => {
    const pathname = await updateFlowPropertiesHandler({
      entry,
      scope,
      filename: 'checkout.flow.yml',
      properties: { name: 'Checkout v2', description: 'Settles it.', tags: ['smoke'], library: false }
    });

    expect(pathname).toBe(entry);
    expect(fs.readFileSync(entry, 'utf8')).toBe(
      'version: 1\nmeta:\n  name: Checkout v2\n  description: Settles it.\n  tags:\n    - smoke\n\nsteps:\n  - id: charge # the one that matters\n'
    );
  });

  it('renames the file, in place, and reports where it went', async () => {
    const pathname = await updateFlowPropertiesHandler({
      entry,
      scope,
      filename: 'settlement.flow.yml',
      properties: { ...NONE, name: 'Settlement' }
    });

    expect(pathname).toBe(path.join(scopeRoot, 'settlement.flow.yml'));
    expect(fs.existsSync(entry)).toBe(false);
    expect(fs.readFileSync(pathname, 'utf8')).toContain('name: Settlement');
  });

  /** `rename` overwrites its target silently, and the target is somebody else's flow. */
  it('refuses to rename over a flow that already exists', async () => {
    fs.writeFileSync(path.join(scopeRoot, 'settlement.flow.yml'), 'version: 1\n', 'utf8');

    await expect(
      updateFlowPropertiesHandler({ entry, scope, filename: 'settlement.flow.yml', properties: NONE })
    ).rejects.toThrow('a flow already exists at');
    expect(fs.readFileSync(path.join(scopeRoot, 'settlement.flow.yml'), 'utf8')).toBe('version: 1\n');
  });

  it('refuses a filename that is a path, and one the watcher would never report', async () => {
    await expect(
      updateFlowPropertiesHandler({ entry, scope, filename: '../escaped.flow.yml', properties: NONE })
    ).rejects.toThrow('not a valid flow filename');
    await expect(
      updateFlowPropertiesHandler({ entry, scope, filename: 'checkout.yml', properties: NONE })
    ).rejects.toThrow('not a valid flow filename');
  });

  /** The same two rules §4.3's editor depends on: it is a flow, and it is inside the named scope. */
  it('refuses a flow outside its scope, and a file that is not a flow', async () => {
    await expect(
      readFlowPropertiesHandler({ entry: path.join(scopeRoot, '..', 'elsewhere.flow.yml'), scope })
    ).rejects.toThrow('outside its scope');
    await expect(readFlowPropertiesHandler({ entry: path.join(scopeRoot, 'notes.txt'), scope })).rejects.toThrow(
      'not a flow file'
    );
  });
});

/**
 * 002 §4.5 — a script is editable as text through the same two channels a flow is.
 *
 * The guard is the point of these. The preload forwards any channel with no allowlist, so "a `.js`
 * inside the scope" would make every helper the user has ever npm-installed writable from the
 * renderer; the rule is `.js` **and** under `flows/scripts/`.
 */
describe('a flow script', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readFlowSourceHandler, writeFlowSourceHandler } = require('./index');

  let scopeRoot;
  let scope;
  let scriptsDir;
  let entry;

  beforeEach(() => {
    scopeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-script-')));
    scope = { workspaceRoot: scopeRoot };
    scriptsDir = path.join(scopeRoot, 'flows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    entry = path.join(scriptsDir, 'text.js');
    fs.writeFileSync(entry, 'const lastFour = (v) => String(v).slice(-4);\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
  });

  it('reads and writes it as text', async () => {
    expect(await readFlowSourceHandler({ entry, scope })).toContain('lastFour');

    await writeFlowSourceHandler({ entry, scope, content: 'const a = 1;\n' });

    expect(fs.readFileSync(entry, 'utf8')).toBe('const a = 1;\n');
  });

  it('reads one nested inside the scripts directory', async () => {
    const nested = path.join(scriptsDir, 'money', 'format.js');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'const cents = 1;\n', 'utf8');

    expect(await readFlowSourceHandler({ entry: nested, scope })).toContain('cents');
  });

  /** The whole reason the rule names a directory rather than an extension. */
  it('refuses a .js outside flows/scripts, inside the scope though it is', async () => {
    const loose = path.join(scopeRoot, 'flows', 'helper.js');
    fs.writeFileSync(loose, 'const a = 1;\n', 'utf8');

    await expect(readFlowSourceHandler({ entry: loose, scope })).rejects.toThrow('outside the scope flows/scripts');
    await expect(writeFlowSourceHandler({ entry: loose, scope, content: '' })).rejects.toThrow(
      'outside the scope flows/scripts'
    );
  });

  it('refuses a .js in another scope, and one reached by climbing out', async () => {
    await expect(
      readFlowSourceHandler({ entry: path.join(scopeRoot, '..', 'elsewhere.js'), scope })
    ).rejects.toThrow('outside the scope flows/scripts');
    await expect(
      readFlowSourceHandler({ entry: path.join(scriptsDir, '..', '..', '..', 'secrets.js'), scope })
    ).rejects.toThrow('outside the scope flows/scripts');
  });

  /** A sibling scope whose path starts with this one's is not inside it. */
  it('refuses a script in a scope whose path merely shares a prefix', async () => {
    const sibling = `${scopeRoot}-two`;
    await expect(
      readFlowSourceHandler({ entry: path.join(sibling, 'flows', 'scripts', 'text.js'), scope })
    ).rejects.toThrow('outside the scope flows/scripts');
  });

  it('still refuses a file that is neither a flow nor a script', async () => {
    await expect(readFlowSourceHandler({ entry: path.join(scriptsDir, 'notes.md'), scope })).rejects.toThrow(
      'not a flow file'
    );
  });

  it('needs a scope, like every other channel naming a file', async () => {
    await expect(readFlowSourceHandler({ entry, scope: {} })).rejects.toThrow('needs a workspaceRoot');
  });

  /** 002 §4.5's rename — the name, and nothing else a script does not have. */
  describe('renaming it', () => {
    const { renameFlowScriptHandler } = require('./index');

    it('renames it in place and reports where it went', async () => {
      const pathname = await renameFlowScriptHandler({ entry, scope, filename: 'digits.js' });

      expect(pathname).toBe(path.join(scriptsDir, 'digits.js'));
      expect(fs.existsSync(entry)).toBe(false);
      expect(fs.readFileSync(pathname, 'utf8')).toContain('lastFour');
    });

    /** The directory is what makes a `.js` a listed script, so a rename must not leave it. */
    it('keeps it in the directory it was in, including a nested one', async () => {
      const nested = path.join(scriptsDir, 'money', 'format.js');
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, 'const cents = 1;\n', 'utf8');

      const pathname = await renameFlowScriptHandler({ entry: nested, scope, filename: 'cents.js' });

      expect(pathname).toBe(path.join(scriptsDir, 'money', 'cents.js'));
    });

    it('refuses to rename over a script already there', async () => {
      fs.writeFileSync(path.join(scriptsDir, 'digits.js'), 'const a = 1;\n', 'utf8');

      await expect(renameFlowScriptHandler({ entry, scope, filename: 'digits.js' })).rejects.toThrow(
        'a script already exists at'
      );
      expect(fs.readFileSync(path.join(scriptsDir, 'digits.js'), 'utf8')).toBe('const a = 1;\n');
    });

    it('refuses a filename that is a path, and one that is not .js', async () => {
      await expect(renameFlowScriptHandler({ entry, scope, filename: '../escaped.js' })).rejects.toThrow(
        'not a valid script filename'
      );
      await expect(renameFlowScriptHandler({ entry, scope, filename: 'text.txt' })).rejects.toThrow(
        'not a valid script filename'
      );
    });

    it('refuses a source outside flows/scripts', async () => {
      const loose = path.join(scopeRoot, 'flows', 'helper.js');
      fs.writeFileSync(loose, 'const a = 1;\n', 'utf8');

      await expect(renameFlowScriptHandler({ entry: loose, scope, filename: 'other.js' })).rejects.toThrow(
        'outside the scope flows/scripts'
      );
    });

    it('renaming to the same name changes nothing', async () => {
      expect(await renameFlowScriptHandler({ entry, scope, filename: 'text.js' })).toBe(entry);
      expect(fs.existsSync(entry)).toBe(true);
    });
  });
});
