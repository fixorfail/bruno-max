/**
 * B1.1–B1.3 — the round-trip guarantee the rest of the builder stands on (005 §9.1).
 *
 * Every other scenario in 005-C assumes this one: a structured edit changes the lines it names and
 * no others. The cheap wrong implementation reads the normalized model and serializes it back — it
 * produces a correct flow, passes every test that parses its output, and fails the first review of
 * a committed `.flow.yml`. So these assert on bytes, and the corpus is the whole fixture tree
 * rather than a file written for the purpose: a shape the writer has never seen is exactly the one
 * it will reformat.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits } = require('../../src/edit');
const { normalizeFlow, parseDocument } = require('../../src/document');
const { changedLines, lineOf } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');

const flowFilesUnder = (dir) =>
  fs.readdirSync(path.join(FLOWS, dir), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) return flowFilesUnder(name);
    return entry.name.endsWith('.flow.yml') ? [name] : [];
  });

const flowFiles = flowFilesUnder('.').map((file) => path.normalize(file)).sort();
const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

describe('B1.1 — the empty edit is the identity', () => {
  /** The corpus is the assertion (005-C §3): sixty-odd files nobody wrote for this test. */
  it('covers every committed flow, including the shapes builder/ adds', () => {
    expect(flowFiles.length).toBeGreaterThan(60);
    expect(flowFiles).toContain(path.normalize('builder/commented.flow.yml'));
    expect(flowFiles).toContain(path.normalize('builder/anchored.flow.yml'));
  });

  it.each(flowFiles)('%s is returned byte for byte', (file) => {
    const text = read(file);

    expect(applyFlowEdits(text, [])).toEqual({ ok: true, text, changed: false });
  });
});

describe('B1.2 — a one-key patch changes one line', () => {
  const file = path.normalize('builder/commented.flow.yml');
  const edit = { kind: 'step.patch', id: 'create', patch: { set: { timeout: 5000 } } };

  it('adds the key at its schema position and touches nothing else', () => {
    const text = read(file);
    const written = applyFlowEdits(text, [edit]);

    expect(written.ok).toBe(true);
    expect(written.changed).toBe(true);
    expect(changedLines(text, written.text)).toEqual({
      // §5.3 reads `timeout` after `assert` and before `maxDuration`, whatever order the file's own
      // keys arrived in — so the one line lands between them rather than at the end of the block.
      at: lineOf(text, '    maxDuration: 120000                   # §11.1\'s whole-step budget'),
      removed: [],
      added: ['    timeout: 5000']
    });
  });

  /**
   * 002 §4.4 records the library re-spacing a trailing comment as this mechanism's one exception,
   * and 005 §9.1 confines it to the line that was edited. The confinement is the assertion: a
   * writer that emitted the document would collapse the column on all eleven of these lines.
   */
  it('leaves the aligned comment column on every line it did not write', () => {
    const written = applyFlowEdits(read(file), [edit]);
    const aligned = written.text.split('\n').filter((line) => /\S {2,}#/.test(line));

    expect(aligned).toHaveLength(12);
    expect(written.text).toContain('  - id: create                            # the second step');
    expect(written.text).toContain('      - res.status eq 201                 # the documented status');
  });
});

describe('B1.3 — an anchor, a merge key and a flow-style collection survive', () => {
  const file = path.normalize('builder/anchored.flow.yml');

  /**
   * Each of these is a spelling the normalized model does not distinguish — `retry: *poll` and the
   * mapping it points at are one object by the time anything downstream sees them — so a writer
   * that rebuilt the document from the model would rewrite all four and no test of what a flow
   * *means* would notice.
   */
  it('leaves all four spellings as written when an unrelated step is patched', () => {
    const text = read(file);
    const written = applyFlowEdits(text, [{ kind: 'step.patch', id: 'settle', patch: { set: { timeout: 1000 } } }]);

    expect(written.ok).toBe(true);
    expect(written.text).toContain('    retry: &poll { maxAttempts: 10, delay: 500 }');
    expect(written.text).toContain('    retry: *poll');
    expect(written.text).toContain('    <<: *defaults');
    expect(written.text).toContain('    depends: [sign_in, create]');
    expect(written.text).toContain('  step_defaults: &defaults');
    expect(changedLines(text, written.text)).toEqual({
      at: lineOf(text, '    operation: regress-api#getState') + 1,
      removed: [],
      added: ['    timeout: 1000']
    });
  });
});

/**
 * B1.22 — §8.2's scripts are written the same way wherever this writer puts one.
 *
 * Nothing requires a block: every script position reads its value as a string. But the library
 * chooses a spelling per string — plain, double-quoted the moment a script holds `: `, `|-` the
 * moment it holds a newline — so one flow ends up with three spellings of the same kind of value.
 * Which one a script got is not information about the flow.
 */
describe('B1.22 — a script is written as a block', () => {
  const STEP = 'version: 1\nsteps:\n  - id: create\n    operation: api#createThing\n';

  const written = (patch) => {
    const result = applyFlowEdits(STEP, [{ kind: 'step.patch', id: 'create', patch: { set: patch } }]);
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    return result.text;
  };

  it('writes a one-line script as a block in each of the three positions', () => {
    const text = written({
      pre: { token: '(ctx) => ctx.vars.token' },
      outputs: { thingId: { script: '(res) => ({ id: res.body.id })' } },
      retry: { maxAttempts: 3, shouldRetry: '(res) => res.status === 429' }
    });

    expect(text).toContain('    pre:\n      token: |-\n        (ctx) => ctx.vars.token\n');
    expect(text).toContain('        script: |-\n          (res) => ({ id: res.body.id })\n');
    expect(text).toContain('      shouldRetry: |-\n        (res) => res.status === 429\n');
  });

  /** A path is not a script — the value beside it in the same block stays the scalar it is. */
  it('leaves an output that is a path alone', () => {
    expect(written({ outputs: { name: 'data.name' } })).toContain('      name: data.name\n');
  });

  it('round-trips every one of them through the reader', () => {
    const text = written({
      pre: { token: '(ctx) => ctx.vars.token' },
      outputs: { thingId: { script: '(res) => ({ id: res.body.id })' } },
      retry: { shouldRetry: '(res) => res.status === 429' }
    });
    const step = normalizeFlow(parseDocument(text), '/w/f.flow.yml').steps[0];

    expect(step.pre[0].script).toBe('(ctx) => ctx.vars.token');
    expect(step.outputs[0].script).toBe('(res) => ({ id: res.body.id })');
    expect(step.retry.shouldRetry).toBe('(res) => res.status === 429');
  });

  /** §5.2's `config.retry:` is the same block one level up, and reaches the writer the same way. */
  it('writes the flow-wide predicate as a block too', () => {
    const result = applyFlowEdits(STEP, [
      { kind: 'config.patch', patch: { set: { retry: { shouldRetry: '(res) => res.status === 429' } } } }
    ]);

    expect(result.text).toContain('config:\n  retry:\n    shouldRetry: |-\n      (res) => res.status === 429\n');
  });
});
