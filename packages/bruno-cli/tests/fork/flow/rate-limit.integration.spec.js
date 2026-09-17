/**
 * `bru flow run` against a declared `rateLimit:` — 004.
 *
 * Pacing is only observable from outside, the same way `--flows` concurrency is: the CLI reports
 * the same steps with the same verdicts whether or not the limiter did anything, and the one place
 * the difference exists is the times a server saw the requests arrive.
 *
 * Every timing assertion is a lower bound with slack. This is the real clock, and a machine under
 * load will always be slower than the schedule — never faster, which is the whole guarantee.
 *
 * That guarantee covers the times the limiter *releases* requests, which is not quite what the
 * server below sees. The first request of a run also pays connection setup, and that cost lands on
 * its arrival rather than its release: arrival 0 is late, so the gap behind it reads short — by ~7ms
 * on an idle machine and ~70ms on a contended CI runner, which is enough to cross the slack. Pacing
 * is therefore asserted on the warm gaps only; see `pacedGaps`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

/** The declared rate for these fixtures: 4 per second, so 250ms apart. */
const INTERVAL = 250;
/** Timer jitter and process scheduling; a gap this much under the interval still counts as paced. */
const SLACK = 60;

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

/** The gaps between consecutive arrivals at one route, in order. */
const gaps = (times) => times.slice(1).map((at, index) => at - times[index]);

/**
 * The gaps pacing is measured on: every one but the first.
 *
 * Only the first request of a run pays connection setup, so that cost skews arrival 0 alone and
 * shortens gap 0 alone. Every later request reuses the socket and arrives a near-constant hop after
 * it was released, which is the spacing worth asserting. Dropping gap 0 costs no coverage: a run
 * that paced nothing leaves every remaining gap at roughly zero.
 */
const pacedGaps = (times) => gaps(times).slice(1);

jest.setTimeout(60000);

describe('bru flow run with a declared rateLimit', () => {
  let server;
  let port;
  const staged = [];

  /** When each request arrived, per route — the only evidence pacing happened. */
  let arrivals = { paced: [], open: [] };

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const route = request.url.startsWith('/open') ? 'open' : 'paced';
      arrivals[route].push(Date.now());
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
    arrivals = { paced: [], open: [] };
  });

  const spec = (title, route, operations) =>
    [
      'openapi: 3.0.0',
      `info: { title: ${title}, version: 1.0.0 }`,
      `servers: [{ url: 'http://127.0.0.1:${port}' }]`,
      'paths:',
      ...operations.map((name) =>
        [
          `  ${route}/${name}:`,
          '    get:',
          `      operationId: ${name}`,
          '      responses:',
          '        \'200\':',
          '          description: OK',
          '          content:',
          '            application/json:',
          '              schema: { type: object }'
        ].join('\n')
      )
    ].join('\n');

  /** One workspace per case, so nothing a previous invocation wrote is in the count. */
  const stage = (flow) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ratelimit-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: paced\n');
    write(root, 'apispec/paced-v1.yml', spec('paced', '/paced', ['pingA', 'pingB', 'pingC', 'pingD']));
    write(root, 'apispec/open-v1.yml', spec('open', '/open', ['echoA', 'echoB', 'echoC', 'echoD']));
    write(root, 'flows/paced.flow.yml', flow);

    return root;
  };

  const steps = (alias, operations) =>
    operations.flatMap((name, index) => [`  - id: s${index}`, `    operation: ${alias}#${name}`]);

  const PACED = [
    'version: 1',
    '',
    'apis:',
    '  paced:',
    '    source: ../apispec/paced-v1.yml',
    '    rateLimit:',
    '      requests: 4',
    '      per: second',
    '',
    'config:',
    '  concurrency: 4',
    '',
    'steps:',
    ...steps('paced', ['pingA', 'pingB', 'pingC', 'pingD']),
    ''
  ].join('\n');

  it('spaces the requests it sends to the limited API', async () => {
    const root = stage(PACED);

    const { status } = await run(['flow', 'run', 'flows/paced.flow.yml', '--no-capture'], root);

    expect(status).toBe(0);
    expect(arrivals.paced).toHaveLength(4);
    for (const gap of pacedGaps(arrivals.paced)) expect(gap).toBeGreaterThanOrEqual(INTERVAL - SLACK);
  });

  it('sends them as fast as it can under --no-rate-limit', async () => {
    const root = stage(PACED);

    const { status } = await run(['flow', 'run', 'flows/paced.flow.yml', '--no-capture', '--no-rate-limit'], root);

    expect(status).toBe(0);
    expect(arrivals.paced).toHaveLength(4);
    // Three intervals is what the limit would have cost; unpaced, the whole flow is well inside one.
    const span = arrivals.paced[arrivals.paced.length - 1] - arrivals.paced[0];
    expect(span).toBeLessThan(INTERVAL);
  });

  it('leaves a second API in the same flow unpaced', async () => {
    const root = stage(
      [
        'version: 1',
        '',
        'apis:',
        '  paced:',
        '    source: ../apispec/paced-v1.yml',
        '    rateLimit:',
        '      requests: 4',
        '      per: second',
        '  open: ../apispec/open-v1.yml',
        '',
        'config:',
        '  concurrency: 8',
        '',
        'steps:',
        ...steps('paced', ['pingA', 'pingB', 'pingC', 'pingD']),
        ...['echoA', 'echoB', 'echoC', 'echoD'].flatMap((name, index) => [
          `  - id: o${index}`,
          `    operation: open#${name}`
        ]),
        ''
      ].join('\n')
    );

    const { status } = await run(['flow', 'run', 'flows/paced.flow.yml', '--no-capture'], root);

    expect(status).toBe(0);
    expect(arrivals.paced).toHaveLength(4);
    expect(arrivals.open).toHaveLength(4);
    for (const gap of pacedGaps(arrivals.paced)) expect(gap).toBeGreaterThanOrEqual(INTERVAL - SLACK);
    // A bucket shared across documents would have paced these too.
    expect(arrivals.open[arrivals.open.length - 1] - arrivals.open[0]).toBeLessThan(INTERVAL);
  });
});
