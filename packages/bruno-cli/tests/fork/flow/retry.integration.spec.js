/**
 * `bru flow run --retry-failed` and `--retries` end to end — 001 §14.2, §14.5 and §14.8.
 *
 * The unit specs assert the selection and the accumulator from values handed to them; this is the
 * only place the loop itself runs — that a retry re-runs the flows the roster names and nothing
 * else, that a flow which passes on a second attempt turns the invocation green, and that every
 * invocation leaves the `suite.json` the next retry reads. It runs the CLI as a process because the
 * exit code is half the contract, and a handler calling `process.exit` cannot be asserted in-process.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { SUITE_DIRECTORY } = require('@bruno-max/flow');

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

const suitesOf = (root) => {
  const captureRoot = path.join(root, '.bruno-runs');
  return fs
    .readdirSync(captureRoot)
    .filter((entry) => SUITE_DIRECTORY.test(entry))
    .sort()
    .map((entry) => ({
      dir: entry,
      manifest: JSON.parse(fs.readFileSync(path.join(captureRoot, entry, 'suite.json'), 'utf8'))
    }));
};

/**
 * Each case spawns `bin/bru.js`, which costs a Node start plus a real filesystem walk — several run
 * to 3.5s alone and longer when the workspace's suites share the machine. Jest's 5s default is
 * inside that margin, so these specs fail on load rather than on behaviour without this.
 */
jest.setTimeout(30000);

describe('bru flow run --retry-failed and --retries', () => {
  let server;
  let port;
  /** The `/flaky` operation fails its first request and passes afterwards; a test resets the count. */
  let flakyHits = 0;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const failing = request.url.startsWith('/bad') || (request.url.startsWith('/flaky') && flakyHits++ === 0);
      response.writeHead(failing ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: !failing }));
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  const flow = (operation) =>
    [
      'version: 1',
      '',
      'apis:',
      '  retry-api: ../apispec/retry-v1.yml',
      '',
      'steps:',
      '  - id: call',
      `    operation: retry-api#${operation}`,
      '    assert:',
      '      - res.status eq 200',
      ''
    ].join('\n');

  const operation = (name, route) =>
    [
      `  ${route}:`,
      '    get:',
      `      operationId: ${name}`,
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      ''
    ].join('\n');

  /** A workspace of its own per case, so what one invocation left behind is what is being counted. */
  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retry-run-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: retry\n');
    write(
      root,
      'apispec/retry-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Retry API, version: 1.0.0 }',
        'servers:',
        `  - url: http://127.0.0.1:${port}`,
        'paths:',
        operation('ok', '/ok'),
        operation('bad', '/bad'),
        operation('flaky', '/flaky')
      ].join('\n')
    );

    write(root, 'flows/a-passes.flow.yml', flow('ok'));
    write(root, 'flows/b-fails.flow.yml', flow('bad'));
    // Never validates, so it never opens a run directory — the flow only the roster can name.
    write(root, 'flows/c-broken.flow.yml', flow('nope'));
    // Outside `flows/`, so a directory run never picks it up and its first-request failure is the
    // retry cases' alone.
    write(root, 'flaky/c-flaky.flow.yml', flow('flaky'));

    return root;
  };

  /**
   * The roster is what makes a retry possible at all: report files are optional, and a flow that
   * failed validation leaves no run directory for a reader to find it by.
   */
  it('writes the invocation\'s roster, including the flow that never ran', async () => {
    const root = stage();
    const result = await run(['flow', 'run', 'flows/'], root);

    // The worst outcome decides (§14.2): a broken flow file outranks a failing step.
    expect(result.status).toBe(2);

    const [{ manifest }] = suitesOf(root);
    expect(manifest.exitCode).toBe(2);
    expect(manifest.origin).toEqual({ host: 'cli' });
    expect(manifest.flows.map((entry) => [entry.id, entry.outcome])).toEqual([
      ['flows/a-passes', 'passed'],
      ['flows/b-fails', 'failed'],
      ['flows/c-broken', 'invalid']
    ]);
    expect(manifest.flows[1].runDir).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.flows[2]).not.toHaveProperty('runDir');
    expect(manifest.flows[2]).not.toHaveProperty('attempt');
  }, 60000);

  /**
   * The point of the whole feature: the second invocation re-runs what did not pass and nothing
   * else — `invalid` included, since a mis-typed flow left out of the retry is a selection that
   * shrinks every time it runs.
   */
  it('re-runs only the flows that did not pass, into a suite of its own', async () => {
    const root = stage();
    expect((await run(['flow', 'run', 'flows/'], root)).status).toBe(2);

    const retry = await run(['flow', 'run', '--retry-failed', '--reporter-json'], root);
    expect(retry.status).toBe(2);

    const [first, second] = suitesOf(root);
    expect(second.manifest.retryOf).toBe(first.dir);
    expect(second.manifest.flows.map((entry) => entry.id)).toEqual(['flows/b-fails', 'flows/c-broken']);

    // A retry writes its own report, never an edit of the one it re-ran.
    const report = JSON.parse(fs.readFileSync(path.join(root, '.bruno-runs', second.dir, 'report.json'), 'utf8'));
    expect(report.retryOf).toBe(first.dir);
    expect(report.summary.flows).toEqual({ total: 2, passed: 0, failed: 1, cancelled: 0, invalid: 1, flaky: 0 });
  }, 60000);

  // Nothing is wrong, so nothing is refused: there is simply nothing left to re-run.
  it('says so and exits 0 when the last suite passed entirely', async () => {
    const root = stage();
    expect((await run(['flow', 'run', 'flows/a-passes.flow.yml'], root)).status).toBe(0);

    const retry = await run(['flow', 'run', '--retry-failed'], root);

    expect(retry.status).toBe(0);
    expect(retry.output).toContain('nothing to retry');
    // No second suite: an invocation that ran nothing has nothing to record.
    expect(suitesOf(root)).toHaveLength(1);
  }, 60000);

  // Both are usage errors (§14.2), raised from the capture root before a request is sent.
  it('refuses a scope with no suite, and a name that is not a suite directory', async () => {
    const root = stage();

    const nothing = await run(['flow', 'run', '--retry-failed'], root);
    expect(nothing.status).toBe(3);
    expect(nothing.output).toContain('no suite to retry in');

    const wrong = await run(['flow', 'run', '--retry-failed', 'suite-2026-09-02T10-00-00Z-ffff'], root);
    expect(wrong.status).toBe(3);
    expect(wrong.output).toContain('is not a suite directory');
  }, 60000);

  /**
   * The regression the retry loop must not cause: with no `--retries` the exit code is the worst
   * outcome of the one attempt each flow got, exactly as it was before retries existed.
   */
  it('exits on the failing flow when nothing asked for a retry', async () => {
    const root = stage();
    flakyHits = 0;

    const result = await run(['flow', 'run', 'flaky/c-flaky.flow.yml', '--reporter-json'], root);

    expect(result.status).toBe(1);
    const [{ dir }] = suitesOf(root);
    const report = JSON.parse(fs.readFileSync(path.join(root, '.bruno-runs', dir, 'report.json'), 'utf8'));
    expect(report.flows).toHaveLength(1);
    expect(report.flows[0].outcome).toBe('failed');
    expect(report.flows[0]).not.toHaveProperty('attempt');
    expect(report.summary.flows.flaky).toBe(0);
  }, 60000);

  /**
   * §14.8's retry: the final attempt is the flow's outcome, so a flow that passes on the second one
   * turns the invocation green — that is what a retry is for — and is marked flaky so the pass
   * cannot hide that it took two goes.
   */
  it('turns a flow that passes on a second attempt green, and marks it flaky', async () => {
    const root = stage();
    flakyHits = 0;

    const result = await run(['flow', 'run', 'flaky/c-flaky.flow.yml', '--retries', '1', '--reporter-json'], root);

    expect(result.status).toBe(0);

    const [{ manifest, dir }] = suitesOf(root);
    expect(manifest.exitCode).toBe(0);
    expect(manifest.flows).toHaveLength(1);
    expect(manifest.flows[0]).toMatchObject({ id: 'flaky/c-flaky', outcome: 'passed', attempt: 2, flaky: true });

    const report = JSON.parse(fs.readFileSync(path.join(root, '.bruno-runs', dir, 'report.json'), 'utf8'));
    expect(report.flows).toHaveLength(1);
    expect(report.summary.flows).toEqual({ total: 1, passed: 1, failed: 0, cancelled: 0, invalid: 0, flaky: 1 });
  }, 60000);

  // A flow that never passes is run the whole way out, and the invocation still fails on it.
  it('gives up after the last retry and exits on the final outcome', async () => {
    const root = stage();

    const result = await run(['flow', 'run', 'flows/b-fails.flow.yml', '--retries', '2', '--reporter-json'], root);

    expect(result.status).toBe(1);
    const [{ manifest }] = suitesOf(root);
    expect(manifest.flows[0]).toMatchObject({ outcome: 'failed', attempt: 3 });
    expect(manifest.flows[0]).not.toHaveProperty('flaky');
  }, 60000);
});
