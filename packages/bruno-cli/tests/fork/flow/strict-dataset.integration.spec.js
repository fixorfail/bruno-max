/**
 * `bru flow run --strict` and `--dataset` end to end — 001 §14.1, §14.2 and §9.4.
 *
 * Both flags are wiring rather than logic, and wiring is only observable from outside: `--strict`
 * turns a diagnostic the run already produced into an exit code, and `--dataset` changes how many
 * times a flow is dispatched. So each case runs the CLI as a process and asserts the exit code and
 * what actually reached the server, rather than a decision taken along the way.
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
    const child = spawn(process.execPath, [BRU, 'flow', ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });

/** Each case spawns `bin/bru.js` — a Node start plus a real filesystem walk, well past Jest's 5s. */
jest.setTimeout(30000);

describe('bru flow run --strict and --dataset', () => {
  let server;
  let port;
  let seen;
  const staged = [];

  beforeAll(async () => {
    seen = [];
    server = http.createServer((request, response) => {
      seen.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, id: 'abc' }));
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  const spec = [
    'openapi: 3.0.3',
    'info: { title: Rows API, version: 1.0.0 }',
    'servers:',
    '  - url: http://127.0.0.1:PORT',
    'paths:',
    '  /ping:',
    '    get:',
    '      operationId: ping',
    '      parameters:',
    '        - { name: tier, in: query, schema: { type: string } }',
    '      responses:',
    '        \'200\': { description: OK }',
    ''
  ];

  /** A workspace per case, so what one invocation sent is what is being counted. */
  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-strict-')));
    staged.push(root);
    seen.length = 0;

    write(root, 'workspace.yml', 'name: strict\n');
    write(root, 'apispec/rows-v1.yml', spec.join('\n').replace('PORT', String(port)));
    write(root, 'rows/eu.csv', 'tier\nsilver\ngold\nbronze\n');
    write(root, 'rows/one.csv', 'tier\nplatinum\n');

    // Clean: one step, no raw reference, no dataset, nothing to warn about.
    write(
      root,
      'flows/clean.flow.yml',
      [
        'version: 1',
        'apis: { rows: ../apispec/rows-v1.yml }',
        'steps:',
        '  - id: ping',
        '    operation: rows#ping',
        '    assert: [res.status eq 200]',
        ''
      ].join('\n')
    );

    // Reads a row, declares no dataset — the flow `--dataset` is for.
    write(
      root,
      'flows/rows.flow.yml',
      [
        'version: 1',
        'apis: { rows: ../apispec/rows-v1.yml }',
        'steps:',
        '  - id: ping',
        '    operation: rows#ping',
        '    query: { tier: "{{row.tier}}" }',
        '    assert: [res.status eq 200]',
        ''
      ].join('\n')
    );

    // Warns: §8.3's escape hatch, which validates as `undeclared-dependency` and nothing worse.
    write(
      root,
      'flows/warns.flow.yml',
      [
        'version: 1',
        'apis: { rows: ../apispec/rows-v1.yml }',
        'steps:',
        '  - id: first',
        '    operation: rows#ping',
        '  - id: second',
        '    operation: rows#ping',
        '    depends: [first]',
        '    query: { tier: "{{steps.first.body.id}}" }',
        ''
      ].join('\n')
    );

    // Declares a dataset of its own, for the replacement case.
    write(
      root,
      'flows/declared.flow.yml',
      [
        'version: 1',
        'dataset: ../rows/one.csv',
        'apis: { rows: ../apispec/rows-v1.yml }',
        'steps:',
        '  - id: ping',
        '    operation: rows#ping',
        '    query: { tier: "{{row.tier}}" }',
        ''
      ].join('\n')
    );

    return root;
  };

  const tiers = () => seen.map((url) => new URL(url, 'http://x').searchParams.get('tier')).filter(Boolean);

  // --- --strict ------------------------------------------------------------

  /**
   * The pair that gives `--strict` its meaning: the same file, the same diagnostic, two exit codes.
   * Without the flag the warning is printed and the flow runs, which is §8.3's whole position.
   */
  it('runs a warning flow by default and refuses it under --strict', async () => {
    const root = stage();

    const lenient = await run(['run', 'flows/warns.flow.yml', '--no-capture'], root);
    const strict = await run(['run', 'flows/warns.flow.yml', '--no-capture', '--strict'], root);

    expect(lenient.status).toBe(0);
    expect(lenient.output).toContain('undeclared-dependency');
    expect(strict.status).toBe(2);
    expect(strict.output).toContain('undeclared-dependency');
  });

  /** §14.2's code for a flow that did not run — so `--strict` refuses it *before* dispatching. */
  it('sends nothing for a flow it refused under --strict', async () => {
    const root = stage();

    await run(['run', 'flows/warns.flow.yml', '--no-capture', '--strict'], root);

    expect(seen).toEqual([]);
  });

  /**
   * `validate` and `run` share the gate, so a file that fails one under `--strict` fails the other.
   * A CI job that validates before it runs would otherwise disagree with itself.
   */
  it('gives bru flow validate --strict the same verdict', async () => {
    const root = stage();

    const lenient = await run(['validate', 'flows/warns.flow.yml'], root);
    const strict = await run(['validate', 'flows/warns.flow.yml', '--strict'], root);

    expect(lenient.status).toBe(0);
    expect(strict.status).toBe(2);
  });

  /** The flag promotes warnings; it does not invent them. */
  it('leaves a flow with no warnings passing under --strict', async () => {
    const root = stage();

    const result = await run(['run', 'flows/clean.flow.yml', '--no-capture', '--strict'], root);

    expect(result.status).toBe(0);
  });

  // --- --dataset -----------------------------------------------------------

  /**
   * The case the flag exists for: a flow written against no rows at all, pointed at a row set by
   * CI. Three rows, three dispatches, each carrying its own `{{row.tier}}`.
   */
  it('gives a dataset to a flow that declares none', async () => {
    const root = stage();

    const result = await run(['run', 'flows/rows.flow.yml', '--no-capture', '--dataset', 'rows/eu.csv'], root);

    expect(result.status).toBe(0);
    expect(tiers().sort()).toEqual(['bronze', 'gold', 'silver']);
  });

  /** …and replaces one that is declared, rather than running both. */
  it('replaces a declared dataset', async () => {
    const root = stage();

    const result = await run(['run', 'flows/declared.flow.yml', '--no-capture', '--dataset', 'rows/eu.csv'], root);

    expect(result.status).toBe(0);
    expect(tiers().sort()).toEqual(['bronze', 'gold', 'silver']);
    expect(tiers()).not.toContain('platinum');
  });

  /** Relative to where the command was typed, not to the flow file — §13.2's no-cwd rule. */
  it('resolves the path from the current directory', async () => {
    const root = stage();

    const result = await run(['run', 'rows.flow.yml', '--no-capture', '--dataset', '../rows/eu.csv'], path.join(root, 'flows'));

    expect(result.status).toBe(0);
    expect(tiers()).toHaveLength(3);
  });

  /**
   * §7.4 holds a dataset the way it holds a `!file`, and an override arrives from a command line
   * where `../` costs nothing to type. Exit 2: the flow did not run.
   */
  it('refuses a dataset outside the scope root', async () => {
    const root = stage();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-outside-')));
    fs.writeFileSync(path.join(outside, 'rows.csv'), 'tier\nsecret\n');

    const result = await run(['run', 'flows/rows.flow.yml', '--no-capture', '--dataset', path.join(outside, 'rows.csv')], root);

    expect(result.status).toBe(2);
    expect(result.output).toContain('outside the scope root');
    expect(seen).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /** A dataset that is not there names itself, rather than failing as an unexplained refusal. */
  it('names a dataset it could not read', async () => {
    const root = stage();

    const result = await run(['run', 'flows/rows.flow.yml', '--no-capture', '--dataset', 'rows/nope.csv'], root);

    expect(result.status).toBe(2);
    expect(result.output).toContain('nope.csv');
  });
});
