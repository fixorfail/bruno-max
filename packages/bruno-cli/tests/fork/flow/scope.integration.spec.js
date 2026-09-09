/**
 * §7.4's collection boundary end to end for a yml-format collection — 001-C R7.8.
 *
 * `bru run` finds a collection root by either on-disk format at the directory a request lives
 * under. `bru flow run` must find the same root for a flow, or `auth: collection` and §14.5's
 * capture root land on whatever ancestor workspace happens to exist instead of the collection
 * `scopeIn` missed. Mirrors the bearer case in `collection-auth.integration.spec.js`, staging an
 * `opencollection.yml` root instead of `bruno.json` + `collection.bru`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { stringifyCollection } = require('@usebruno/filestore');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Never `spawnSync`: the operation the flow calls is served from this process, and a synchronous
 * spawn holds its event loop until the child exits — the two would wait on each other forever.
 */
const run = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BRU, ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });

/** A spawned `bru` costs a Node start plus a filesystem walk, which is outside Jest's 5s default. */
jest.setTimeout(30000);

describe('R7.8 a yml-format collection scopes exactly like a bru one', () => {
  let server;
  let port;
  let received;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const [route] = request.url.split('?');
      received.push({ route, headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  const apispec = () =>
    [
      'openapi: 3.0.3',
      'info: { title: Ledger API, version: 1.0.0 }',
      'servers:',
      `  - url: http://127.0.0.1:${port}`,
      'paths:',
      '  /entries:',
      '    get:',
      '      operationId: list_entries',
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      ''
    ].join('\n');

  const stage = (name) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `flow-scope-${name}-`)));
    staged.push(root);
    write(root, 'apispec/ledger-v1.yml', apispec());
    return root;
  };

  const flowFile = () =>
    [
      'version: 1',
      '',
      'apis:',
      '  ledger-api: ../apispec/ledger-v1.yml',
      '',
      'steps:',
      '  - id: from_step',
      '    operation: ledger-api#list_entries',
      '    auth: collection',
      '    assert:',
      '      - res.status eq 200',
      ''
    ].join('\n');

  /** A yml collection keeps its config and its own auth in one root file — no `bruno.json` beside it. */
  const stageYmlCollection = (auth) => {
    const root = stage('yml');
    write(root, 'opencollection.yml', stringifyCollection({ name: 'ledger', request: { auth } }, {}, { format: 'yml' }));
    return root;
  };

  const sent = () => received.filter((entry) => entry.route === '/entries');

  it('sends the yml collection\'s own auth for a flow that names `auth: collection`', async () => {
    const root = stageYmlCollection({ mode: 'bearer', bearer: { token: 'tok-from-yml-collection' } });
    write(root, 'flows/inherit.flow.yml', flowFile());

    const result = await run(['flow', 'run', 'flows/inherit.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].headers.authorization).toBe('Bearer tok-from-yml-collection');
  }, 60000);

  /**
   * The counterpart the fix must not break: a flow with truly no collection above it — a bru root
   * fixes, this stages neither — still resolves `auth: collection` to nothing rather than to some
   * accidental ancestor.
   */
  it('still reports unknown-auth-profile when there is no collection at all', async () => {
    const root = stage('none');
    write(root, 'flows/inherit.flow.yml', flowFile());

    const result = await run(['flow', 'run', 'flows/inherit.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(2);
    expect(sent()).toHaveLength(0);
  }, 60000);
});
