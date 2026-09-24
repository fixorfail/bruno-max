/**
 * B1.20 — `config.patch`, the one edit that addresses the flow rather than something in it.
 *
 * 001 §5.2 writes a flow-wide default as an *absence*, which is what makes this a patch with an
 * `unset` beside its `set` rather than a whole-block write: clearing `concurrency` deletes the key,
 * it does not spell `5` out. The two rules that are this edit's own both follow from `config:` being
 * a block — it is created when the flow has none, and removed when its last key goes, so a flow back
 * at its defaults reads as one.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits, readFlowEditModel } = require('../../src/edit');
const { changedLines, lineOf } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

const written = (text, edits) => {
  const result = applyFlowEdits(text, edits);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
};

const patch = (patchOf) => ({ kind: 'config.patch', patch: patchOf });

describe('B1.20 — the flow\'s own config:', () => {
  it('creates the block, in §5.2\'s position, for a flow that declares none', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [patch({ set: { validateSchema: false } })]);

    expect(text).toContain('\nconfig:\n  validateSchema: false\n');
    expect(lineOf(text, 'config:')).toBeGreaterThan(lineOf(text, 'apis:'));
    expect(lineOf(text, 'config:')).toBeLessThan(lineOf(text, 'steps:'));
  });

  it('lands a new key in schema order beside the keys the block has', () => {
    const before = read('builder/root-keys.flow.yml');
    const { text } = written(before, [patch({ set: { baseUrl: 'https://qa.example.com', concurrency: 2 } })]);

    // `baseUrl` reads before the flags and `concurrency` after them, whichever order they arrived in.
    expect(text).toContain('config:\n  baseUrl: https://qa.example.com\n  failOnStatusCode: false\n  concurrency: 2\n');
  });

  it('overwrites a key in place, changing its line and no other', () => {
    const before = read('builder/root-keys.flow.yml');
    const { text } = written(before, [patch({ set: { failOnStatusCode: true } })]);

    expect(changedLines(before, text)).toEqual({
      at: lineOf(before, '  failOnStatusCode: false'),
      removed: ['  failOnStatusCode: false'],
      added: ['  failOnStatusCode: true']
    });
  });

  it('deletes a key rather than writing the default out, and removes the block with its last key', () => {
    const before = read('builder/root-keys.flow.yml');
    const { text } = written(before, [patch({ unset: ['failOnStatusCode'] })]);

    expect(text).not.toContain('failOnStatusCode');
    expect(text).not.toContain('config:');
    // The blocks around it are untouched — this is a removal, not a rewrite.
    expect(text).toContain('apis:\n  regress-api: ../../specs/regressions-v1.yml\n');
    expect(text).toContain('vars:\n  currency: USD\n');
  });

  it('leaves the block where a key remains', () => {
    const before = read('builder/root-keys.flow.yml');
    const { text } = written(before, [patch({ set: { concurrency: 3 }, unset: ['failOnStatusCode'] })]);

    expect(text).toContain('config:\n  concurrency: 3\n');
  });

  it('writes a nested map for the flow-wide retry defaults', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [patch({ set: { retry: { maxAttempts: 3, delay: 1000 } } })]);

    expect(text).toContain('config:\n  retry:\n    maxAttempts: 3\n    delay: 1000\n');
  });

  it('creates no block for an unset against a flow that has none', () => {
    const before = read('builder/linear.flow.yml');
    const result = applyFlowEdits(before, [patch({ unset: ['concurrency'] })]);

    expect(result.ok).toBe(true);
    expect(result.text).toBe(before);
    expect(result.changed).toBe(false);
  });

  it('refuses a key the block has no field for, and changes nothing', () => {
    const before = read('builder/root-keys.flow.yml');
    const result = applyFlowEdits(before, [patch({ set: { concurency: 2 } })]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-field');
    expect(result.message).toContain('concurency');
  });

  it('keeps the comment on a key it overwrites', () => {
    const before = 'version: 1\nconfig:\n  concurrency: 5 # as fast as staging likes\nsteps: []\n';
    const { text } = written(before, [patch({ set: { concurrency: 2 } })]);

    expect(text).toContain('concurrency: 2 # as fast as staging likes');
  });
});

/**
 * The read side of the same block (005 §9.2). The pane renders from the model and never from the
 * text, so what the file says about `config:` has to arrive in it — and what the file says *nothing*
 * about has to stay absent, because a default filled in here would be written back out the first
 * time a neighbouring key was committed.
 */
describe('B1.20 — config: in the edit model', () => {
  it('carries the block as the file declares it, and nothing it does not', () => {
    const model = readFlowEditModel(read('builder/root-keys.flow.yml'));

    expect(model.config).toEqual({ failOnStatusCode: false });
    expect(model.config).not.toHaveProperty('concurrency');
  });

  it('is an empty object for a flow that declares no config:', () => {
    expect(readFlowEditModel(read('builder/linear.flow.yml')).config).toEqual({});
  });

  it('offers the block\'s keys as a vocabulary, the way it offers a step\'s', () => {
    const { vocabulary } = readFlowEditModel(read('builder/linear.flow.yml'));

    expect(vocabulary.configKeys).toContain('validateSchema');
    expect(vocabulary.configKeys).toContain('capturePreviewBytes');
    expect(vocabulary.configKeys).not.toContain('steps');
  });

  it('reads a binding\'s strictNulls back as a boolean rather than as an opaque key', () => {
    const text = 'version: 1\napis:\n  api:\n    source: ./spec.yml\n    strictNulls: false\nsteps: []\n';
    const [binding] = readFlowEditModel(text).apis;

    expect(binding.strictNulls).toBe(false);
    expect(binding.opaque).toEqual([]);
  });
});
