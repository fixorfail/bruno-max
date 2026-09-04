/**
 * `bru flow run --grep` end to end — 001 §14.1's selection and §14.2's codes.
 *
 * The unit spec asserts the narrowing from a list handed to it; what is only observable from the
 * outside is what the process does with the result — that an unusable pattern is refused before
 * anything runs, that a pattern keeping nothing is an exit 0 rather than a failure, and that the
 * suite which *is* written contains exactly the flows the pattern kept. It runs the CLI as a process
 * because the exit code is half the contract, and a handler calling `process.exit` cannot be
 * asserted in-process.
 *
 * Every flow here names an operation its API spec does not declare, so each one is `invalid` and
 * sends no request: which flows an invocation selected is visible in its roster either way, and a
 * selection spec has no business standing up a server to observe it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SUITE_DIRECTORY } = require('@bruno-max/flow');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

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
  if (!fs.existsSync(captureRoot)) return [];

  return fs
    .readdirSync(captureRoot)
    .filter((entry) => SUITE_DIRECTORY.test(entry))
    .sort()
    .map((entry) => ({
      dir: entry,
      manifest: JSON.parse(fs.readFileSync(path.join(captureRoot, entry, 'suite.json'), 'utf8'))
    }));
};

const idsOf = (suite) => suite.manifest.flows.map((entry) => entry.id);

describe('bru flow run --grep', () => {
  const staged = [];

  afterAll(() => {
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  const flow = (name, tags) =>
    [
      'version: 1',
      'meta:',
      `  name: ${name}`,
      `  tags: [${tags.join(', ')}]`,
      '',
      'apis:',
      '  grep-api: ../apispec/grep-v1.yml',
      '',
      'steps:',
      '  - id: call',
      '    operation: grep-api#nope',
      ''
    ].join('\n');

  /** A workspace of its own per case, so the suites counted are the ones that case wrote. */
  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-grep-run-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: grep\n');
    write(
      root,
      'apispec/grep-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Grep API, version: 1.0.0 }',
        'servers:',
        '  - url: http://127.0.0.1:1',
        'paths:',
        '  /ok:',
        '    get:',
        '      operationId: ok',
        '      responses:',
        '        \'200\':',
        '          description: OK',
        ''
      ].join('\n')
    );

    write(root, 'flows/checkout.flow.yml', flow('Checkout happy path', ['smoke', 'payments']));
    write(root, 'flows/nightly.flow.yml', flow('Ledger reconciliation', ['slow']));
    write(root, 'flows/search.flow.yml', flow('Catalogue search', ['smoke']));

    return root;
  };

  /** A usage error (§14.2), raised before the first flow is read rather than after ten minutes. */
  it('refuses a pattern that is not a regular expression, before anything runs', async () => {
    const root = stage();

    const result = await run(['flow', 'run', 'flows/', '--grep', 'checkout('], root);

    expect(result.status).toBe(3);
    expect(result.output).toContain('--grep is not a valid regular expression');
    expect(suitesOf(root)).toEqual([]);
  }, 60000);

  /**
   * Nothing is wrong — the paths were valid and the pattern simply kept none of them — so this is
   * the exit code an all-passed `--retry-failed` uses, with both counts said out loud because an
   * invocation that ran nothing and exited green is otherwise unexplainable.
   */
  it('says how many flows the paths chose and exits 0 when the pattern keeps none', async () => {
    const root = stage();

    const result = await run(['flow', 'run', 'flows/', '--grep', 'no-such-flow'], root);

    expect(result.status).toBe(0);
    expect(result.output).toContain('the paths selected 3 flows, the pattern kept none');
    // An invocation that ran nothing records nothing.
    expect(suitesOf(root)).toEqual([]);
  }, 60000);

  it('runs the flows the pattern kept, and nothing else the paths chose', async () => {
    const root = stage();

    const result = await run(['flow', 'run', 'flows/', '--grep', 'smoke', '--grep-invert', 'catalogue'], root);

    expect(result.status).toBe(2);
    expect(idsOf(suitesOf(root)[0])).toEqual(['flows/checkout']);
  }, 60000);

  /** One rule over whatever the selection turned out to be, rather than two that can disagree. */
  it('narrows a --retry-failed roster the same way', async () => {
    const root = stage();
    expect((await run(['flow', 'run', 'flows/'], root)).status).toBe(2);

    const retry = await run(['flow', 'run', '--retry-failed', '--grep', 'payments'], root);
    expect(retry.status).toBe(2);

    const [first, second] = suitesOf(root);
    expect(idsOf(first)).toEqual(['flows/checkout', 'flows/nightly', 'flows/search']);
    expect(second.manifest.retryOf).toBe(first.dir);
    expect(idsOf(second)).toEqual(['flows/checkout']);
  }, 60000);

  it('takes several flows in one comma-separated argument beside space-separated ones', async () => {
    const root = stage();

    const paths = ['flows/checkout.flow.yml,flows/search.flow.yml', 'flows/nightly.flow.yml'];
    const result = await run(['flow', 'run', ...paths], root);

    expect(result.status).toBe(2);
    expect(idsOf(suitesOf(root)[0])).toEqual(['flows/checkout', 'flows/nightly', 'flows/search']);
  }, 60000);
});
