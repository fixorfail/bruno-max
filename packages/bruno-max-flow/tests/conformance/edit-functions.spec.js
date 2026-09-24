/**
 * B1.19 — a shared script joins the flow's `functions.use:`, and leaves it.
 *
 * 001 §8.6 makes `use:` the one place a flow says which files its scripts may call into, and makes
 * it explicit on purpose. The writer keeps that block in the shape the file gave it — a string for
 * one path, a list for more — and takes the block away with its last path rather than leaving an
 * empty `functions:` that declares nothing.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits, readFlowEditModel } = require('../../src/edit');
const { lineOf } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

const written = (text, edits) => {
  const result = applyFlowEdits(text, edits);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
};

const use = (source) => ({ kind: 'functions.use', source });
const unuse = (source) => ({ kind: 'functions.unuse', source });

describe('B1.19 — a shared script joins functions.use, and leaves it', () => {
  it('creates the block, in schema order, for a flow that declares none', () => {
    const { text } = written(read('builder/linear.flow.yml'), [use('./scripts/helpers.js')]);

    expect(text).toContain('\nfunctions:\n  use: [ ./scripts/helpers.js ]\n');
    expect(lineOf(text, 'functions:')).toBeGreaterThan(lineOf(text, 'apis:'));
    expect(lineOf(text, 'functions:')).toBeLessThan(lineOf(text, 'steps:'));
    expect(readFlowEditModel(text).functions).toEqual(['./scripts/helpers.js']);
  });

  it('turns the one-path string form into a list, and appends to a list', () => {
    const one = 'version: 1\nfunctions:\n  use: ./a.js\nsteps:\n  - id: a\n    operation: api#x\n';
    const { text } = written(one, [use('./b.js')]);
    expect(text).toContain('  use: [ ./a.js, ./b.js ]\n');

    const more = written(text, [use('./c.js')]).text;
    expect(more).toContain('  use: [ ./a.js, ./b.js, ./c.js ]\n');
    expect(readFlowEditModel(more).functions).toEqual(['./a.js', './b.js', './c.js']);
  });

  it('lists a path once, however often it is used', () => {
    const one = 'version: 1\nfunctions:\n  use: [./a.js]\nsteps:\n  - id: a\n    operation: api#x\n';
    const result = written(one, [use('./a.js')]);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(one);
  });

  it('appends to a block-style list in its own style, and touches nothing else in the block', () => {
    const before = read('regressions/r4t-functions.flow.yml');
    const { text } = written(before, [use('./scripts/helpers.js')]);
    const added = text.split('\n').filter((line) => !before.split('\n').includes(line));

    expect(added).toEqual(['    - ./scripts/helpers.js']);
    expect(text).toContain('  use:\n    - ./lib/shared-functions.yml\n    - ./scripts/helpers.js\n');
    expect(readFlowEditModel(text).functions).toEqual(['./lib/shared-functions.yml', './scripts/helpers.js']);
  });

  it('removes a path, and the block with the last one', () => {
    const two = 'version: 1\nfunctions:\n  use: [./a.js, ./b.js]\nsteps:\n  - id: a\n    operation: api#x\n';
    const one = written(two, [unuse('./a.js')]).text;
    expect(one).toContain('use: [ ./b.js ]');

    const none = written(one, [unuse('./b.js')]).text;
    expect(none).not.toContain('functions');
    expect(none).toContain('version: 1\nsteps:\n');
    expect(written(none, [unuse('./b.js')]).changed).toBe(false);
  });

  it('keeps a block that still defines something when its last path goes', () => {
    const defined = 'version: 1\nfunctions:\n  use: ./a.js\n  upper: (v) => v\nsteps:\n  - id: a\n    operation: api#x\n';
    const { text } = written(defined, [unuse('./a.js')]);

    expect(text).toContain('functions:\n  upper: (v) => v\n');
    expect(text).not.toContain('use:');
  });
});

/**
 * B4.19 — §8.6's other half: the functions a flow defines inline, written as a block.
 *
 * `use:` and the definitions are different statements in one key — the first names files, every
 * other key defines a function — so a write to one leaves the other exactly as it was.
 */
describe('B4.19 — the functions a flow defines', () => {
  const written = (text, edits) => {
    const result = applyFlowEdits(text, edits);
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    return result.text;
  };

  const WITH_USE = 'version: 1\nfunctions:\n  use: [ ./scripts/helpers.js ]\nsteps: []\n';

  it('writes a definition as a block scalar, beside the files it reads', () => {
    const text = written(WITH_USE, [{ kind: 'functions.define', define: { lastFour: '(v) => v.slice(-4)' } }]);

    expect(text).toContain('functions:\n  use: [ ./scripts/helpers.js ]\n  lastFour: |-\n    (v) => v.slice(-4)\n');
  });

  it('creates the block for a flow that has none', () => {
    const text = written('version: 1\nsteps: []\n', [{ kind: 'functions.define', define: { tail: '(v) => v' } }]);

    expect(text).toContain('functions:\n  tail: |-\n    (v) => v\n');
  });

  /** A rename is one write, so the entry keeps its place rather than moving to the end. */
  it('replaces the definitions whole, in the order it is given them', () => {
    const text = written(
      'version: 1\nfunctions:\n  a: (v) => v\n  b: (v) => v\nsteps: []\n',
      [{ kind: 'functions.define', define: { renamed: '(v) => v', b: '(v) => v' } }]
    );

    expect(text).toContain('functions:\n  renamed: |-');
    expect(text).not.toContain('\n  a:');
  });

  it('removes the block when neither half has anything left', () => {
    const text = written('version: 1\nfunctions:\n  a: (v) => v\nsteps: []\n', [{ kind: 'functions.define', define: {} }]);

    expect(text).not.toContain('functions:');
  });

  it('keeps a block that still reads files', () => {
    const text = written(WITH_USE, [{ kind: 'functions.define', define: {} }]);

    expect(text).toContain('functions:\n  use: [ ./scripts/helpers.js ]\n');
  });

  /** `use:` names the scripts a flow reads; it is not a function the flow defines. */
  it('refuses a definition called use', () => {
    const result = applyFlowEdits(WITH_USE, [{ kind: 'functions.define', define: { use: '(v) => v' } }]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-field');
  });
});
