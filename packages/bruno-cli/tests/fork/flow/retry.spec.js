/**
 * `--retry-failed`'s selection — 001 §14.2 over §14.5's roster.
 *
 * Two things are pinned here. Which flows a retry re-runs: everything that did not pass, which is
 * `failed`, `cancelled` **and** `invalid`, because a retry that quietly narrowed its own selection
 * would go on shrinking every time it ran. And that every way the invocation can be refused is
 * refused from the roster alone, before a request is sent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { retrySelection } = require('../../../src/fork/flow');
const { createPorts } = require('../../../src/fork/flow/ports');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

describe('--retry-failed', () => {
  let root;
  let scope;
  let ports;

  /** One roster line, as `suite.json` spells it — identity, outcome, and where the run landed. */
  const flow = (name, outcome) => ({
    file: path.join(root, 'flows', `${name}.flow.yml`),
    id: `flows/${name}`,
    name,
    tags: [],
    outcome
  });

  const suite = (root, dir, startedAt, flows) =>
    write(root, path.join(dir, 'suite.json'), `${JSON.stringify({
      suiteId: dir.slice(-4),
      startedAt,
      finishedAt: startedAt,
      exitCode: 1,
      flows
    }, null, 2)}\n`);

  const select = (named, over = {}) =>
    retrySelection({ named, scope, captureRoot: path.join(root, '.bruno-runs'), ports, ...over });

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retry-')));
    write(root, 'workspace.yml', 'name: retry\n');
    for (const name of ['a', 'b', 'c']) write(root, `flows/${name}.flow.yml`, 'version: 1\n');
    // `gone` is deliberately never written: the roster names a flow that is no longer on disk.

    suite(root, '.bruno-runs/suite-2026-09-01T10-00-00Z-cccc', '2026-09-01T10:00:00.000Z', [flow('a', 'passed')]);
    suite(root, '.bruno-runs/suite-2026-09-02T10-00-00Z-aaaa', '2026-09-02T10:00:00.000Z', [
      flow('a', 'passed'),
      flow('b', 'failed')
    ]);
    suite(root, '.bruno-runs/suite-2026-09-03T10-00-00Z-bbbb', '2026-09-03T10:00:00.000Z', [
      flow('c', 'invalid'),
      flow('b', 'cancelled'),
      flow('a', 'passed'),
      flow('gone', 'failed')
    ]);

    scope = { workspaceRoot: root };
    ports = createPorts({ collectionPath: root });
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /**
   * The bare flag: the newest suite, and every flow in it that did not pass. `invalid` is in there
   * because it fails validation again immediately and cheaply — dropping it would let a mis-typed
   * selection silently shrink on every retry.
   */
  it('re-runs the flows of the newest suite that did not pass, in path order', async () => {
    const selection = await select('');

    expect(selection.flows).toEqual([path.join(root, 'flows', 'b.flow.yml'), path.join(root, 'flows', 'c.flow.yml')]);
    expect(selection.retryOf).toBe('suite-2026-09-03T10-00-00Z-bbbb');
  });

  // A retry is a new invocation and a new record, so the suite it re-ran is the only thing tying it
  // back — by basename, which is what a person reads off the filesystem and out of a report.
  it('names the suite it re-ran, not the one before it', async () => {
    expect((await select('suite-2026-09-02T10-00-00Z-aaaa')).retryOf).toBe('suite-2026-09-02T10-00-00Z-aaaa');
  });

  it('takes a named suite as a bare name inside the capture root, or as a path', async () => {
    const b = path.join(root, 'flows', 'b.flow.yml');
    expect((await select('suite-2026-09-02T10-00-00Z-aaaa')).flows).toEqual([b]);
    expect((await select(path.join(root, '.bruno-runs', 'suite-2026-09-02T10-00-00Z-aaaa'))).flows).toEqual([b]);
  });

  /**
   * A flow the roster names that has since been renamed or deleted is skipped and said out loud —
   * the rest of the retry is still worth running, and re-running a file that is gone is not.
   */
  it('skips a flow the roster names that is no longer on disk, and counts it as retried', async () => {
    const selection = await select('');

    expect(selection.missing).toEqual([path.join(root, 'flows', 'gone.flow.yml')]);
    expect(selection.flows).not.toContain(path.join(root, 'flows', 'gone.flow.yml'));
    // Three flows did not pass; two of them can be run.
    expect(selection.retried).toBe(3);
  });

  // Nothing is wrong here, so this is not a usage error: the caller says so and exits 0.
  it('reports an empty selection for a suite that passed entirely', async () => {
    const selection = await select('suite-2026-09-01T10-00-00Z-cccc');

    expect(selection.retried).toBe(0);
    expect(selection.flows).toEqual([]);
  });

  // Refused from the roster alone, before a request is sent — the handler turns each into exit 3.
  it('refuses a scope with no suite in it', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retry-empty-')));
    await expect(
      retrySelection({
        named: '',
        scope: { workspaceRoot: empty },
        captureRoot: path.join(empty, '.bruno-runs'),
        ports
      })
    ).rejects.toThrow(`no suite to retry in ${path.join(empty, '.bruno-runs')}`);

    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('refuses a named directory that is not a suite', async () => {
    await expect(select('suite-2026-09-09T10-00-00Z-dddd')).rejects.toThrow(/is not a suite directory/);
    await expect(select(path.join(root, 'flows'))).rejects.toThrow(/is not a suite directory/);
  });

  // `--capture-dir` moves the whole capture root, and the retry reads the suites where the run that
  // wrote them put them.
  it('reads a relocated capture root', async () => {
    suite(root, path.join('artifacts', 'suite-2026-09-04T10-00-00Z-eeee'), '2026-09-04T10:00:00.000Z', [
      flow('c', 'failed')
    ]);

    const selection = await select('', { captureRoot: path.join(root, 'artifacts') });

    expect(selection.retryOf).toBe('suite-2026-09-04T10-00-00Z-eeee');
    expect(selection.flows).toEqual([path.join(root, 'flows', 'c.flow.yml')]);
  });
});
