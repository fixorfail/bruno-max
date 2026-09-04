/**
 * `bru flow list` end to end — 001 §14.7's listing and §14.2's codes.
 *
 * It runs the CLI as a process because half the contract is what the process does: the exit code,
 * and the fact that a listing sends nothing and leaves no capture root behind. The other half is
 * that the rows are the flows a `run` with the same arguments would have executed, which is only
 * observable by giving both commands the same arguments — so the cases below are `grep.spec.js`'
 * selection cases asked of `list` instead.
 *
 * Wording is asserted by the pieces a reader would search a log for, never as a whole line: §14.7 is
 * deliberately not a stable format, and the table's own drawing is pinned in `output.spec.js`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

const list = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BRU, 'flow', 'list', ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });

/** The first cell of each row, which is §5.2's display name, in the order the listing printed them. */
const namesIn = (output) => {
  const lines = output.split('\n');
  const header = lines.findIndex((line) => line.startsWith('id '));
  if (header === -1) return [];

  return lines
    .slice(header + 1, lines.indexOf('', header + 1))
    .map((line) => line.trim().split(/\s+/)[0]);
};

describe('bru flow list', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-list-')));
    write(root, 'workspace.yml', 'name: listing\n');

    write(
      root,
      'flows/checkout.flow.yml',
      [
        'version: 1',
        'meta:',
        '  name: Checkout happy path',
        '  tags: [checkout, smoke]',
        'steps:',
        '  - id: pay',
        '  - id: verify',
        ''
      ].join('\n')
    );

    write(root, 'flows/nightly.flow.yml', 'version: 1\nmeta:\n  tags: [slow]\nsteps:\n  - id: fetch\n');
    write(root, 'ops/login.flow.yml', 'version: 1\nsteps:\n  - id: post\n');
    // Indented into nothing a parser accepts; §5.2's identity survives it, the steps do not.
    write(root, 'flows/broken.flow.yml', 'version: 1\nsteps:\n  - id: a\n   name: Sends nothing\n');
    write(root, 'flows/shared/login.flow.yml', 'version: 1\nmeta:\n  name: Log in\n  library: true\nsteps:\n  - id: post\n');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /**
   * The command's whole point: the rows are the run's selection, so §12.5's exclusion is visible
   * here as an absence rather than restated by a rule of the listing's own. A flow whose text does
   * not parse is a row all the same — being unreadable is `bru flow validate`'s answer to give.
   */
  it('lists a directory\'s flows in path order, without the library one a run would skip', async () => {
    const result = await list(['.'], root);

    expect(result.status).toBe(0);
    expect(namesIn(result.output)).toEqual(['broken', 'checkout', 'nightly', 'login']);
    expect(result.output).toContain('4 flows');
    expect(result.output).toContain('checkout, smoke');
  });

  /** Nothing was sent, so there is nothing to have recorded. */
  it('writes no capture root, because it ran nothing', async () => {
    await list(['.'], root);

    expect(fs.existsSync(path.join(root, '.bruno-runs'))).toBe(false);
  });

  /**
   * The two halves of §12.5 as one rule: a directory run skips a library, and naming it runs it. The
   * listing mirrors both, so the flow that was absent above appears here — and is marked, since a
   * reader has to be able to tell why it is not in the listing above.
   */
  it('lists a library flow that was named directly, and marks it', async () => {
    const result = await list(['.', 'flows/shared/login.flow.yml'], root);

    expect(result.status).toBe(0);
    expect(result.output).toContain('library');
    expect(result.output).toContain('1 library');
    expect(namesIn(result.output)).toContain('shared/login');
  });

  /** §5.2: the final segment, widened to as much of the path as tells two flows apart. */
  it('widens the ids that share a stem, and only those', async () => {
    const result = await list(['.', 'flows/shared/login.flow.yml'], root);

    expect(namesIn(result.output)).toEqual(['broken', 'checkout', 'nightly', 'shared/login', 'ops/login']);
  });

  it('takes several paths, spaced or comma-separated', async () => {
    const spaced = await list(['flows/checkout.flow.yml', 'ops/login.flow.yml'], root);
    const commas = await list(['flows/checkout.flow.yml,ops/login.flow.yml'], root);

    expect(namesIn(spaced.output)).toEqual(['checkout', 'login']);
    expect(commas.output).toBe(spaced.output);
  });

  it('narrows the listing with --grep and --grep-invert, exactly as a run would be narrowed', async () => {
    const kept = await list(['.', '--grep', 'smoke|slow'], root);
    const dropped = await list(['.', '--grep', 'smoke|slow', '--grep-invert', 'nightly'], root);

    expect(namesIn(kept.output)).toEqual(['checkout', 'nightly']);
    expect(namesIn(dropped.output)).toEqual(['checkout']);
  });

  /**
   * Nothing is wrong — the paths were valid and the pattern kept none of them — so this is the exit
   * code `bru flow run` uses for the same answer, with both counts said out loud.
   */
  it('says how many flows the paths chose and exits 0 when the pattern keeps none', async () => {
    const result = await list(['.', '--grep', 'no-such-flow'], root);

    expect(result.status).toBe(0);
    expect(result.output).toContain('the paths selected 4 flows, the pattern kept none');
  });

  it('writes nothing under --silent', async () => {
    const listed = await list(['.', '--silent'], root);
    const empty = await list(['.', '--grep', 'no-such-flow', '--silent'], root);

    expect(listed).toEqual({ status: 0, output: '' });
    expect(empty).toEqual({ status: 0, output: '' });
  });

  /** A colour code in an archived log is corruption; a piped stdout is not a TTY either way. */
  it('never emits an escape sequence when colour is off', async () => {
    const result = await list(['.', '--no-color'], root);

    expect(result.output).not.toMatch(/\[/);
  });

  /** §14.2's usage errors, both raised before a single flow is read. */
  it('exits 3 on a path that does not exist and on a pattern that will not compile', async () => {
    const missing = await list(['nowhere/'], root);
    const pattern = await list(['.', '--grep', 'checkout('], root);

    expect(missing.status).toBe(3);
    expect(missing.output).toContain('no such path: nowhere/');
    expect(pattern.status).toBe(3);
    expect(pattern.output).toContain('--grep is not a valid regular expression');
  });

  it('exits 3 when the paths name a directory holding no flows', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-list-empty-'));

    const result = await list([empty], root);

    expect(result.status).toBe(3);
    expect(result.output).toContain('no flows matched');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
