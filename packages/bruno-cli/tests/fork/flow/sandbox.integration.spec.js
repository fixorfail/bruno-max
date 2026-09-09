/**
 * `bru flow run`'s script sandbox, end to end — 001-C R7.5 and R7.6.
 *
 * The unit spec proves the port in isolation; this is the only place the whole path is exercised —
 * that a real `outputs:` script (001 §8.2) is dispatched through this port during a run, that a
 * script's own return value survives into the run's JSON report (§14.8.2) exactly as it would from
 * `bru run`'s `safe` sandbox, and that §14.1's `--sandbox developer` reaches the run rather than
 * being parsed and dropped.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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

/**
 * Each case spawns `bin/bru.js`, which costs a Node start plus a real filesystem walk. Jest's 5s
 * default is inside that margin, so this spec fails on load rather than on behaviour without this.
 */
jest.setTimeout(30000);

describe('R7.5/R7.6 bru flow run dispatches outputs: scripts through the sandbox --sandbox names', () => {
  let server;
  let port;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sandbox-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: sandbox\n');
    write(
      root,
      'apispec/sandbox-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Sandbox API, version: 1.0.0 }',
        'servers:',
        `  - url: http://127.0.0.1:${port}`,
        'paths:',
        '  /ping:',
        '    get:',
        '      operationId: ping',
        '      responses:',
        '        \'200\':',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema:',
        '                type: object',
        ''
      ].join('\n')
    );
    write(
      root,
      'flows/sandbox.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  sandbox-api: ../apispec/sandbox-v1.yml',
        '',
        'steps:',
        '  - id: ping',
        '    operation: sandbox-api#ping',
        '    assert:',
        '      - res.status eq 200',
        '    outputs:',
        '      hasRequire:',
        '        script: |',
        '          (res, ctx) => typeof require !== \'undefined\'',
        '      computed:',
        '        script: |',
        '          (res, ctx) => 40 + 2',
        '  - id: check',
        '    operation: sandbox-api#ping',
        '    depends: [ping]',
        '    assert:',
        '      - steps.ping.computed eq 42',
        ''
      ].join('\n')
    );

    return root;
  };

  /**
   * The outputs of the first step, from the JSON report — which is the only place a script's real
   * return value is observable from outside the process (§14.8.2), and the point of the port.
   */
  const outputsOf = async (extra) => {
    const root = stage();
    const result = await run(
      ['flow', 'run', 'flows/sandbox.flow.yml', '--reporter-json', 'out.json', '--no-capture', ...extra],
      root
    );

    expect(result.status).toBe(0);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    return report.flows[0].result.iterations[0].steps[0].outputs;
  };

  it('runs a step\'s outputs: scripts in QuickJS and reports their real values', async () => {
    const outputs = await outputsOf([]);

    expect(outputs.hasRequire).toBe(false);
    expect(outputs.computed).toBe(42);
  });

  it('runs them in node:vm under --sandbox developer', async () => {
    const outputs = await outputsOf(['--sandbox', 'developer']);

    expect(outputs.hasRequire).toBe(true);
    expect(outputs.computed).toBe(42);
  });

  /**
   * The one place this flag is stricter than `bru run`'s: there, `develper` is `developer`. A typo
   * that escalates a script to `node:vm` is the failure direction §8.2 exists to rule out, so here it
   * is §14.2's usage error — nothing read, nothing sent, exit 3, the two real values named.
   */
  it('refuses a value that is neither, as a usage error, before reading any flow', async () => {
    const root = stage();
    const result = await run(
      ['flow', 'run', 'flows/sandbox.flow.yml', '--reporter-json', 'out.json', '--no-capture', '--sandbox', 'develper'],
      root
    );

    expect(result.status).toBe(3);
    expect(result.output).toContain('develper');
    expect(result.output).toContain('"safe", "developer"');
    expect(fs.existsSync(path.join(root, 'out.json'))).toBe(false);
  });

  /** §14.2: yargs' own validation is a usage error too — it exited 1, a failed flow's code, before. */
  it('exits 3 on an action the command does not have', async () => {
    const result = await run(['flow', 'bogus'], stage());

    expect(result.status).toBe(3);
    expect(result.output).toContain('bogus');
  });
});
