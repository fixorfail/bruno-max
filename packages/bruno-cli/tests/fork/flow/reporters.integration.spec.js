/**
 * `bru flow run --reporter-*` end to end — 001 §14.8.
 *
 * The unit specs assert the mapping from a `SuiteResult` that was handed to them; this one is the
 * only place the wiring itself is exercised — that the options reach the loader, that the loader
 * runs before the flow, that a real run produces the record the reporters write, and that the files
 * land where the flags said. It runs the CLI as a process for the same reason: the exit code is
 * half the contract, and a handler calling `process.exit` cannot be asserted in-process.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { SUITE_DIRECTORY } = require('@bruno-max/flow');

/**
 * §14.5's run naming, spelled out because the engine does not export it. A suite directory that
 * matched this would be swept up by `listRuns` and by per-flow pruning, which is the whole reason
 * the suite one is prefixed.
 */
const RUN_DIRECTORY = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{4}$/;

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

describe('bru flow run --reporter-junit --reporter-json', () => {
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

  /** A workspace of its own per case, so what one invocation left behind is what is being counted. */
  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-report-run-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: reporters\n');
    write(
      root,
      'environments/staging.yml',
      ['name: staging', 'variables:', '  - name: tier', '    value: staging', '    enabled: true', ''].join('\n')
    );
    write(
      root,
      'apispec/smoke-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Smoke API, version: 1.0.0 }',
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
        '                properties:',
        '                  ok: { type: boolean }',
        ''
      ].join('\n')
    );
    write(
      root,
      'flows/smoke.flow.yml',
      [
        'version: 1',
        '',
        'meta:',
        '  name: Smoke',
        '  tags: [smoke, reporters]',
        '  testId: C9000',
        '',
        'apis:',
        '  smoke-api: ../apispec/smoke-v1.yml',
        '',
        'steps:',
        '  - id: ping',
        '    operation: smoke-api#ping',
        '    meta:',
        '      testId: C1001',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    return root;
  };

  it('writes both report files where the flags said, and exits 0', async () => {
    const root = stage();
    const result = await run(
      ['flow', 'run', 'flows/smoke.flow.yml', '--reporter-junit', 'out.xml', '--reporter-json', 'out.json', '--no-capture'],
      root
    );

    expect(result.output).toContain('Wrote junit report to out.xml');
    expect(result.status).toBe(0);

    const xml = fs.readFileSync(path.join(root, 'out.xml'), 'utf8');
    expect(xml).toContain('<testsuite name="flows/smoke"');
    expect(xml).toContain('<property name="flow" value="flows/smoke"/>');
    expect(xml).toContain('<property name="tags" value="smoke,reporters"/>');
    expect(xml).toContain('<testcase name="ping"');
    expect(xml).toContain('<property name="test_id" value="C1001"/>');

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    expect(report.flows).toHaveLength(1);
    expect(report.flows[0]).toMatchObject({ id: 'flows/smoke', name: 'Smoke', outcome: 'passed' });
    expect(report.exitCode).toBe(0);
  }, 60000);

  // Which environment a suite ran against is the first thing a CI reader asks of a red build.
  it('records the environment the invocation named as the suite\'s provenance', async () => {
    const root = stage();
    const result = await run(
      ['flow', 'run', 'flows/smoke.flow.yml', '--global-env', 'staging', '--reporter-junit', 'out.xml', '--no-capture'],
      root
    );

    expect(result.status).toBe(0);
    const xml = fs.readFileSync(path.join(root, 'out.xml'), 'utf8');
    expect(xml).toContain('<property name="host" value="cli"/>');
    expect(xml).toContain('<property name="globalEnvironment" value="staging"/>');
  }, 60000);

  it('records the host alone when the invocation named no environment', async () => {
    const root = stage();
    const result = await run(['flow', 'run', 'flows/smoke.flow.yml', '--reporter-junit', 'out.xml', '--no-capture'], root);

    expect(result.status).toBe(0);
    const xml = fs.readFileSync(path.join(root, 'out.xml'), 'utf8');
    expect(xml).toContain('<property name="host" value="cli"/>');
    expect(xml).not.toContain('globalEnvironment');
  }, 60000);

  /**
   * The bare form, which is what most invocations write. Every run lives in a suite directory
   * (§14.5), and this command opens one per invocation because it batches many flows: the report
   * and every flow's run directory sit in the one folder, which is what lets a person or CI collect
   * an invocation as a unit rather than reassembling it from directories interleaved with every
   * other invocation's.
   */
  it('puts the report and the run it describes in one suite directory', async () => {
    const root = stage();
    // The flag goes after the flow path: yargs would otherwise take the path as its value.
    const result = await run(['flow', 'run', 'flows/smoke.flow.yml', '--reporter-junit'], root);

    expect(result.status).toBe(0);

    const captureRoot = path.join(root, '.bruno-runs');
    const entries = fs.readdirSync(captureRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(SUITE_DIRECTORY);
    // Prefixed so `listRuns` and per-flow pruning pass over it (§14.5).
    expect(entries[0]).not.toMatch(RUN_DIRECTORY);

    const inside = fs.readdirSync(path.join(captureRoot, entries[0]));
    const runs = inside.filter((entry) => RUN_DIRECTORY.test(entry));
    expect(inside).toContain('report-junit.xml');
    expect(runs).toHaveLength(1);
    expect(fs.existsSync(path.join(captureRoot, entries[0], runs[0], 'run.json'))).toBe(true);

    const junit = fs.readFileSync(path.join(captureRoot, entries[0], 'report-junit.xml'), 'utf8');
    expect(junit).toContain('<testsuite name="flows/smoke"');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.bruno-runs/');
  }, 60000);

  // The second shape of the same report: one testcase per flow, for a reader that counts flows.
  // Both shapes carry the flow's own case id, since either may be the one a tracker imports.
  it('writes the flow-level JUnit report from its own bare flag', async () => {
    const root = stage();
    const result = await run(
      ['flow', 'run', 'flows/smoke.flow.yml', '--no-capture', '--reporter-junit', '--reporter-junit-flows'],
      root
    );

    expect(result.status).toBe(0);

    const captureRoot = path.join(root, '.bruno-runs');
    const [suite] = fs.readdirSync(captureRoot);
    const flowLevel = fs.readFileSync(path.join(captureRoot, suite, 'report-junit-flows.xml'), 'utf8');
    expect(flowLevel.match(/<testsuite /g)).toHaveLength(1);
    expect(flowLevel).toContain('<testcase name="flows/smoke"');
    expect(flowLevel).toContain('<property name="test_id" value="C9000"/>');

    const stepLevel = fs.readFileSync(path.join(captureRoot, suite, 'report-junit.xml'), 'utf8');
    expect(stepLevel).toContain('<testsuite name="flows/smoke"');
    expect(stepLevel).toContain('<property name="test_id" value="C9000"/>');
  }, 60000);

  // Under `--no-capture` the folder still has to exist: the report is the artefact CI collects, and
  // where it lands cannot depend on whether the run kept its captures.
  it('creates the suite directory for the report alone under --no-capture', async () => {
    const root = stage();
    const result = await run(['flow', 'run', 'flows/smoke.flow.yml', '--no-capture', '--reporter-junit'], root);

    expect(result.status).toBe(0);

    const captureRoot = path.join(root, '.bruno-runs');
    const entries = fs.readdirSync(captureRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(SUITE_DIRECTORY);
    // The roster is written even here: it names the invocation, which `--no-capture` did not turn off.
    expect(fs.readdirSync(path.join(captureRoot, entries[0])).sort()).toEqual(['report-junit.xml', 'suite.json']);
  }, 60000);
});
