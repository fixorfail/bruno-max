/**
 * §7.4's collection/workspace boundary as `bru flow run` locates it on disk — 001-C R7.8.
 *
 * A collection root is `bruno.json` (the `.bru` format) or `opencollection.yml` (the `yml`
 * format); `scopeIn` must recognise either, the same way `getCollectionFormat` does for `bru run`
 * itself (`utils/collection.js`). Missing the `yml` half silently reclassifies a yml collection as
 * workspace-scoped: an empty `collectionRoot`, `auth: collection` left unresolved, and §14.5's
 * capture root landing on whatever ancestor workspace happens to exist instead.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scopeIn } = require('../../../src/fork/flow');

const staged = [];

const stage = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-scope-')));
  staged.push(root);
  return root;
};

const write = (root, file, body = '') => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
};

afterAll(() => {
  for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
});

describe('R7.8 scope detection recognises both collection formats', () => {
  it('finds a bru collection root by bruno.json', () => {
    const root = stage();
    write(root, 'bruno.json', '{}');
    fs.mkdirSync(path.join(root, 'flows'));

    const scope = scopeIn(path.join(root, 'flows'));
    expect(scope.collectionRoot).toBe(root);
    expect(scope.workspaceRoot).toBe(root);
  });

  it('finds a yml collection root by opencollection.yml', () => {
    const root = stage();
    write(root, 'opencollection.yml', 'name: probe\n');
    fs.mkdirSync(path.join(root, 'flows'));

    const scope = scopeIn(path.join(root, 'flows'));
    expect(scope.collectionRoot).toBe(root);
    expect(scope.workspaceRoot).toBe(root);
  });

  it('scopes a yml collection to itself rather than an ancestor workspace', () => {
    const workspace = stage();
    write(workspace, 'workspace.yml', 'name: ws\n');
    write(workspace, 'projects/api/opencollection.yml', 'name: probe\n');
    fs.mkdirSync(path.join(workspace, 'projects', 'api', 'flows'));

    const scope = scopeIn(path.join(workspace, 'projects', 'api', 'flows'));
    expect(scope.collectionRoot).toBe(path.join(workspace, 'projects', 'api'));
    expect(scope.workspaceRoot).toBe(workspace);
  });

  it('stops at the same directory whether it holds bruno.json, opencollection.yml, or both', () => {
    const root = stage();
    write(root, 'bruno.json', '{}');
    write(root, 'opencollection.yml', 'name: probe\n');
    fs.mkdirSync(path.join(root, 'flows'));

    expect(scopeIn(path.join(root, 'flows')).collectionRoot).toBe(root);
  });

  it('falls back to the workspace, and then the directory itself, when no collection root exists', () => {
    const workspace = stage();
    write(workspace, 'workspace.yml', 'name: ws\n');
    fs.mkdirSync(path.join(workspace, 'flows'));

    const scoped = scopeIn(path.join(workspace, 'flows'));
    expect(scoped.collectionRoot).toBeUndefined();
    expect(scoped.workspaceRoot).toBe(workspace);

    const bare = stage();
    const bareScope = scopeIn(bare);
    expect(bareScope.collectionRoot).toBeUndefined();
    expect(bareScope.workspaceRoot).toBe(bare);
  });
});
