jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() }, shell: { showItemInFolder: jest.fn() } }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { createFlowFolderHandler, moveFlowEntryHandler, revealFlowPathHandler } = require('./files');

/** 002 §4.1d (002-C U5.6e) — the sidebar's new folder and move, against a real directory. */
describe('flow file management', () => {
  let workspaceRoot;
  let flowsDir;
  let scope;

  const write = (relative, content = 'version: 1\n') => {
    const target = path.join(flowsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-files-'));
    flowsDir = path.join(workspaceRoot, 'flows');
    fs.mkdirSync(flowsDir);
    scope = { workspaceRoot };
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe('creating a folder', () => {
    it('creates one inside flows/ and returns its path', async () => {
      const pathname = await createFlowFolderHandler({ scope, parent: flowsDir, name: ' payments ' });

      expect(pathname).toBe(path.join(flowsDir, 'payments'));
      expect(fs.statSync(pathname).isDirectory()).toBe(true);
    });

    it('creates one inside another folder', async () => {
      fs.mkdirSync(path.join(flowsDir, 'payments'));

      const pathname = await createFlowFolderHandler({ scope, parent: path.join(flowsDir, 'payments'), name: 'refunds' });

      expect(pathname).toBe(path.join(flowsDir, 'payments', 'refunds'));
    });

    it('refuses a name that is already taken', async () => {
      fs.mkdirSync(path.join(flowsDir, 'payments'));

      await expect(createFlowFolderHandler({ scope, parent: flowsDir, name: 'payments' })).rejects.toThrow(
        'already exists'
      );
    });

    it.each(['', '../escape', 'a/b', '.hidden', 'node_modules'])('refuses the name %p', async (name) => {
      await expect(createFlowFolderHandler({ scope, parent: flowsDir, name })).rejects.toThrow();
      expect(fs.readdirSync(flowsDir)).toEqual([]);
    });

    /** Those are §4.5's and §4.6's bucket directories, which the sidebar never draws as folders. */
    it('refuses scripts and fixtures at the top of flows/, and allows them further down', async () => {
      await expect(createFlowFolderHandler({ scope, parent: flowsDir, name: 'scripts' })).rejects.toThrow('scripts');
      await expect(createFlowFolderHandler({ scope, parent: flowsDir, name: 'fixtures' })).rejects.toThrow('fixtures');

      fs.mkdirSync(path.join(flowsDir, 'payments'));
      await expect(
        createFlowFolderHandler({ scope, parent: path.join(flowsDir, 'payments'), name: 'fixtures' })
      ).resolves.toBe(path.join(flowsDir, 'payments', 'fixtures'));
    });

    it('refuses a parent outside the scope flows directory', async () => {
      await expect(createFlowFolderHandler({ scope, parent: workspaceRoot, name: 'elsewhere' })).rejects.toThrow(
        'inside the scope flows directory'
      );
    });
  });

  describe('moving a file', () => {
    it('moves a flow into a folder and rewrites the paths it writes', async () => {
      const flow = write('checkout.flow.yml', 'version: 1\napis:\n  payments: ../apispec/payments.yml\n');
      fs.mkdirSync(path.join(flowsDir, 'payments'));

      const target = await moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'payments') });

      expect(target).toBe(path.join(flowsDir, 'payments', 'checkout.flow.yml'));
      expect(fs.existsSync(flow)).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('version: 1\napis:\n  payments: ../../apispec/payments.yml\n');
    });

    it('moves a flow out of a folder', async () => {
      const flow = write('payments/checkout.flow.yml', 'version: 1\ndataset: ../fixtures/cases.csv\n');

      const target = await moveFlowEntryHandler({ entry: flow, scope, directory: flowsDir });

      expect(target).toBe(path.join(flowsDir, 'checkout.flow.yml'));
      expect(fs.readFileSync(target, 'utf8')).toBe('version: 1\ndataset: fixtures/cases.csv\n');
    });

    it('leaves the file untouched when it names no relative path', async () => {
      const text = 'version: 1   # spacing kept\n';
      const flow = write('checkout.flow.yml', text);
      fs.mkdirSync(path.join(flowsDir, 'payments'));

      const target = await moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'payments') });

      expect(fs.readFileSync(target, 'utf8')).toBe(text);
    });

    it('returns the same path for a move into the folder the file is already in', async () => {
      const flow = write('checkout.flow.yml');

      await expect(moveFlowEntryHandler({ entry: flow, scope, directory: flowsDir })).resolves.toBe(flow);
    });

    it('refuses to replace a file already at the destination', async () => {
      const flow = write('checkout.flow.yml', 'version: 1\n# mine\n');
      const other = write('payments/checkout.flow.yml', 'version: 1\n# theirs\n');

      await expect(
        moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'payments') })
      ).rejects.toThrow('already exists');
      expect(fs.readFileSync(other, 'utf8')).toBe('version: 1\n# theirs\n');
      expect(fs.existsSync(flow)).toBe(true);
    });

    it('refuses a flow whose text does not parse, and leaves it where it was', async () => {
      const flow = write('broken.flow.yml', 'steps: [\n');
      fs.mkdirSync(path.join(flowsDir, 'payments'));

      await expect(
        moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'payments') })
      ).rejects.toThrow('not a YAML document');
      expect(fs.existsSync(flow)).toBe(true);
    });

    /** A move never changes what a file is (§4.5, §4.6). */
    describe('staying in its bucket', () => {
      it('moves a script only within flows/scripts/', async () => {
        const script = write('scripts/auth.js', 'module.exports = {};\n');
        fs.mkdirSync(path.join(flowsDir, 'scripts', 'shared'));

        await expect(
          moveFlowEntryHandler({ entry: script, scope, directory: path.join(flowsDir, 'scripts', 'shared') })
        ).resolves.toBe(path.join(flowsDir, 'scripts', 'shared', 'auth.js'));
        await expect(
          moveFlowEntryHandler({ entry: path.join(flowsDir, 'scripts', 'shared', 'auth.js'), scope, directory: flowsDir })
        ).rejects.toThrow('cannot be moved');
      });

      it('moves a fixture only within flows/fixtures/', async () => {
        const fixture = write('fixtures/cases.csv', 'a,b\n');

        await expect(moveFlowEntryHandler({ entry: fixture, scope, directory: flowsDir })).rejects.toThrow(
          'cannot be moved'
        );
      });

      it('keeps a flow out of flows/scripts/ and flows/fixtures/', async () => {
        const flow = write('checkout.flow.yml');
        fs.mkdirSync(path.join(flowsDir, 'scripts'));

        await expect(
          moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'scripts') })
        ).rejects.toThrow('cannot be moved');
      });

      it('never moves the connector file', async () => {
        const connectors = write('connectors.yml', 'apis: {}\n');
        fs.mkdirSync(path.join(flowsDir, 'payments'));

        await expect(
          moveFlowEntryHandler({ entry: connectors, scope, directory: path.join(flowsDir, 'payments') })
        ).rejects.toThrow('cannot be moved');
      });

      it('refuses a file outside the scope flows directory', async () => {
        const outside = path.join(workspaceRoot, 'outside.flow.yml');
        fs.writeFileSync(outside, 'version: 1\n');

        await expect(moveFlowEntryHandler({ entry: outside, scope, directory: flowsDir })).rejects.toThrow(
          'outside the scope flows directory'
        );
      });

      it('refuses a destination that is not a folder', async () => {
        const flow = write('checkout.flow.yml');

        await expect(
          moveFlowEntryHandler({ entry: flow, scope, directory: path.join(flowsDir, 'missing') })
        ).rejects.toThrow('is not a folder');
      });
    });
  });

  describe('revealing a path', () => {
    it('reveals a file or folder inside flows/, resolved to the platform form', () => {
      revealFlowPathHandler({ scope, pathname: `${flowsDir}/payments/../payments` });

      expect(shell.showItemInFolder).toHaveBeenCalledWith(path.join(flowsDir, 'payments'));
    });

    it('refuses a path outside the scope flows directory', () => {
      expect(() => revealFlowPathHandler({ scope, pathname: workspaceRoot })).toThrow('inside the scope flows directory');
    });
  });
});
