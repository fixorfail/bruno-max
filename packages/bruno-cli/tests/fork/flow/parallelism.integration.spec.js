/**
 * `bru flow run --flows` end to end — 003 §2 and §3.
 *
 * Concurrency is only observable from outside: whether two flows overlap is a fact about the server
 * they both call, not about anything the CLI reports. So this spawns the real command against a real
 * server that counts how many requests are in flight at once, which is the only place the difference
 * between `--flows 1` and `--flows 3` exists.
 *
 * The ordering case is here for the same reason. Report order and completion order are the same
 * thing at `--flows 1`, so a report that sorts itself by whichever flow finished first passes every
 * sequential test ever written — it can only be caught by making the two disagree.
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

jest.setTimeout(60000);

describe('bru flow run --flows', () => {
  let server;
  let port;
  const staged = [];

  /** What the server saw: how many requests overlapped, and which flows got as far as calling it. */
  let inFlight = 0;
  let peak = 0;
  let called = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const name = url.searchParams.get('name') || '';
      const delay = Number(url.searchParams.get('ms') || 0);

      called.push(name);
      inFlight += 1;
      peak = Math.max(peak, inFlight);

      setTimeout(() => {
        inFlight -= 1;
        const failing = url.pathname.startsWith('/bad');
        response.writeHead(failing ? 500 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: !failing }));
      }, delay);
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    inFlight = 0;
    peak = 0;
    called = [];
  });

  const operation = (name, route) =>
    [
      `  ${route}:`,
      '    get:',
      `      operationId: ${name}`,
      '      parameters:',
      '        - { name: name, in: query, required: false, schema: { type: string } }',
      '        - { name: ms, in: query, required: false, schema: { type: integer } }',
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: object }',
      ''
    ].join('\n');

  const flowFor = (name, { ms, bad }) =>
    [
      'version: 1',
      '',
      'apis:',
      '  pace: ../apispec/pace-v1.yml',
      '',
      'steps:',
      '  - id: call',
      `    operation: pace#${bad ? 'bad' : 'slow'}`,
      '    query:',
      `      name: ${name}`,
      `      ms: ${ms}`,
      '    assert:',
      '      - res.status eq 200',
      ''
    ].join('\n');

  /** One workspace per case, so what a previous invocation left behind is never in the count. */
  const stage = (flows) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-parallel-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: pace\n');
    write(
      root,
      'apispec/pace-v1.yml',
      [
        'openapi: 3.0.0',
        'info: { title: pace, version: 1.0.0 }',
        `servers: [{ url: 'http://127.0.0.1:${port}' }]`,
        'paths:',
        operation('slow', '/slow'),
        operation('bad', '/bad')
      ].join('\n')
    );
    for (const [name, options] of Object.entries(flows)) write(root, `flows/${name}.flow.yml`, flowFor(name, options));

    return root;
  };

  it('runs the selection one at a time by default, so nothing overlaps', async () => {
    const root = stage({ a: { ms: 150 }, b: { ms: 150 }, c: { ms: 150 } });

    const { status } = await run(['flow', 'run', 'flows', '--no-capture'], root);

    expect(status).toBe(0);
    expect(called.sort()).toEqual(['a', 'b', 'c']);
    // 003 §5.1: every invocation that exists today behaves exactly as it did.
    expect(peak).toBe(1);
  });

  it('overlaps flows when asked to', async () => {
    const root = stage({ a: { ms: 300 }, b: { ms: 300 }, c: { ms: 300 } });

    const { status } = await run(['flow', 'run', 'flows', '--flows', '3', '--no-capture'], root);

    expect(status).toBe(0);
    expect(called.sort()).toEqual(['a', 'b', 'c']);
    expect(peak).toBeGreaterThan(1);
  });

  it('reports flows in roster order even when they finish in another', async () => {
    // `a` is slowest and `b` fastest, so completion order is b, c, a — and roster order is a, b, c.
    const root = stage({ a: { ms: 400 }, b: { ms: 50 }, c: { ms: 200 } });

    const { status } = await run(
      ['flow', 'run', 'flows', '--flows', '3', '--reporter-json', 'out.json', '--no-capture'],
      root
    );

    expect(status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));

    expect(report.flows.map((flow) => flow.id)).toEqual(['flows/a', 'flows/b', 'flows/c']);
  });

  it('drains under --bail: nothing new starts, and what is in flight finishes', async () => {
    // Two slots. `a` fails immediately; `b` is already in flight beside it and must still finish,
    // while `c` and `d` are never taken off the roster (003 §3).
    const root = stage({ a: { ms: 0, bad: true }, b: { ms: 300 }, c: { ms: 0 }, d: { ms: 0 } });

    const { status } = await run(
      ['flow', 'run', 'flows', '--flows', '2', '--bail', '--reporter-json', 'out.json', '--no-capture'],
      root
    );

    expect(status).toBe(1);
    expect(called.sort()).toEqual(['a', 'b']);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    const outcomes = Object.fromEntries(report.flows.map((flow) => [flow.id, flow.outcome]));

    // `b` reports a real verdict rather than `cancelled` — the whole of what draining buys.
    expect(outcomes).toEqual({ 'flows/a': 'failed', 'flows/b': 'passed' });
  });
});
