/**
 * 001 §6.4's implicit `collection` profile, end to end — 001-C R7.7.
 *
 * The mapping's unit spec says what the CLI reads off `collection.bru`; only the wire says the
 * engine received it and the transport sent it. Each case spawns `bin/bru.js` against a server that
 * records what arrived, exactly as R7.1's does.
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

describe('R7.7 `bru flow run` supplies the collection profile', () => {
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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `flow-${name}-`)));
    staged.push(root);
    write(root, 'apispec/ledger-v1.yml', apispec());
    return root;
  };

  /** A collection is what `bruno.json` marks — the same boundary §7.4 draws for every other read. */
  const stageCollection = (auth) => {
    const root = stage('collection-auth');
    write(root, 'bruno.json', JSON.stringify({ version: '1', name: 'ledger', type: 'collection' }));
    write(root, 'collection.bru', stringifyCollection({ request: { auth } }, {}, { format: 'bru' }));
    return root;
  };

  const sent = () => received.filter((entry) => entry.route === '/entries');

  /**
   * §6.4's simple case: the flow declares no `authProfiles:` of its own and names `collection`, and
   * the credential that reaches the wire is the collection's — which is what "authenticates exactly
   * as the collection does" means for a host that has to hand the profile over.
   */
  it('sends the collection\'s own auth for a flow that declares no profiles', async () => {
    const root = stageCollection({ mode: 'bearer', bearer: { token: 'tok-from-collection' } });
    write(
      root,
      'flows/inherit.flow.yml',
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
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/inherit.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].headers.authorization).toBe('Bearer tok-from-collection');
  }, 60000);

  /**
   * The binding's `auth:` is §6.4's second rank and reaches the same profile, and `auth: none` on a
   * step is the first rank overruling it — the profile being host-supplied changes neither.
   */
  it('resolves the profile from a binding, and lets a step opt out', async () => {
    const root = stageCollection({ mode: 'basic', basic: { username: 'ops', password: 'hunter2' } });
    write(
      root,
      'flows/binding.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  ledger-api:',
        '    source: ../apispec/ledger-v1.yml',
        '    auth: collection',
        '',
        'steps:',
        '  - id: from_binding',
        '    operation: ledger-api#list_entries',
        '    assert:',
        '      - res.status eq 200',
        '  - id: opted_out',
        '    operation: ledger-api#list_entries',
        '    auth: none',
        '    depends: [from_binding]',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/binding.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent()).toHaveLength(2);
    expect(sent()[0].headers.authorization).toBe(`Basic ${Buffer.from('ops:hunter2').toString('base64')}`);
    expect(sent()[1].headers.authorization).toBeUndefined();
  }, 60000);

  /**
   * The host supplies no lexical scope with the profile, so the engine resolves it in the using
   * step's — which is what lets a collection whose token is `{{authToken}}` authenticate from the
   * run's variables rather than from nothing.
   */
  it('interpolates the collection\'s credential against the run\'s variables', async () => {
    const root = stageCollection({ mode: 'bearer', bearer: { token: '{{authToken}}' } });
    write(
      root,
      'flows/interpolated.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  ledger-api: ../apispec/ledger-v1.yml',
        '',
        'vars:',
        '  authToken: tok-from-vars',
        '',
        'steps:',
        '  - id: interpolated',
        '    operation: ledger-api#list_entries',
        '    auth: collection',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/interpolated.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent()[0].headers.authorization).toBe('Bearer tok-from-vars');
  }, 60000);

  /**
   * A collection with nothing configured still supplies a profile, so `auth: collection` resolves
   * rather than failing `unknown-auth-profile` depending on whether anyone filled the auth in — and
   * what it resolves to is `none`, not a credential invented for the occasion.
   */
  it('runs unauthenticated against a collection that configures no auth', async () => {
    const root = stageCollection({ mode: 'none' });
    write(
      root,
      'flows/none.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  ledger-api: ../apispec/ledger-v1.yml',
        '',
        'steps:',
        '  - id: unauthenticated',
        '    operation: ledger-api#list_entries',
        '    auth: collection',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/none.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent()[0].headers.authorization).toBeUndefined();
  }, 60000);

  /**
   * §6.4: "Workspace-scoped flows have no such profile and must declare what they use." The host
   * supplies nothing there, the flow does not validate, and nothing is sent — an empty profile
   * would have sent the step out unauthenticated instead.
   */
  it('refuses a workspace-scoped flow that names the collection profile', async () => {
    const root = stage('workspace-auth');
    write(root, 'workspace.yml', 'name: ledger\n');
    write(
      root,
      'flows/workspace.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  ledger-api: ../apispec/ledger-v1.yml',
        '',
        'steps:',
        '  - id: no_collection',
        '    operation: ledger-api#list_entries',
        '    auth: collection',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/workspace.flow.yml', '--no-capture'], root);

    // §14.2's `invalid`: the flow did not run.
    expect(result.status).toBe(2);
    expect(result.output).toContain('no_collection authenticates with collection');
    expect(result.output).toContain('this scope has no collection to inherit an auth profile from');
    expect(sent()).toHaveLength(0);
  }, 60000);
});
