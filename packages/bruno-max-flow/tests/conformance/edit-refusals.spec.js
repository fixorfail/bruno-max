/**
 * B1.12–B1.16 — refuse rather than corrupt, and refuse only what the edit caused (005 §9.1).
 *
 * Two failure modes sit on either side of this, and both are worse than a refusal. A writer that
 * rebuilds a document it could not parse silently discards whatever the author was midway through
 * typing; a gate that refuses any schema error locks the builder out of every flow the app itself
 * creates, since 002 §4.1c's create form writes a file with no `steps:` and the schema requires one.
 * The gate therefore runs before and after and compares, and every refusal leaves the text alone.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits, readFlowEditModel } = require('../../src/edit');
const { changedLines } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, `builder/${file}`), 'utf8');

const refusal = (file, edits) => {
  const result = applyFlowEdits(read(file), edits);
  expect(result.ok).toBe(false);
  // A refusal carries no text at all, which is the strongest form of "the text that stands is the
  // one that came in": there is nothing for a caller to write back by mistake.
  expect(result).not.toHaveProperty('text');
  return result;
};

describe('B1.12 — unparseable text is refused, not rebuilt', () => {
  const broken = 'version: [\n';

  it.each([
    ['an insert', [{ kind: 'step.insert', step: { operation: 'api#createThing' } }]],
    ['a patch', [{ kind: 'step.patch', id: 'a', patch: { set: { timeout: 5 } } }]],
    ['a binding', [{ kind: 'api.add', binding: { alias: 'api', source: './x.yml' } }]],
    ['no edit at all', []]
  ])('refuses %s', (unused, edits) => {
    expect(applyFlowEdits(broken, edits)).toEqual({
      ok: false,
      reason: 'unparseable',
      message: expect.any(String)
    });
  });

  /** The same answer the read gives, for `readFlowProperties`' reason: there is no document. */
  it('has no edit model either', () => {
    expect(readFlowEditModel(broken)).toBeUndefined();
  });
});

describe('B1.13 — a refused edit leaves the text unchanged', () => {
  it.each([
    ['no-such-step', 'linear.flow.yml', [{ kind: 'step.remove', id: 'nobody' }]],
    ['no-such-step', 'linear.flow.yml', [{ kind: 'step.insert', step: { operation: 'api#x' }, after: 'nobody' }]],
    ['no-such-api', 'linear.flow.yml', [{ kind: 'api.remove', alias: 'nobody' }]],
    ['duplicate-step-id', 'linear.flow.yml', [{ kind: 'step.insert', step: { id: 'a', operation: 'api#x' } }]],
    ['duplicate-step-id', 'linear.flow.yml', [{ kind: 'step.rename', id: 'b', to: 'a' }]],
    ['duplicate-alias', 'linear.flow.yml', [
      { kind: 'api.add', binding: { alias: 'regress-api', source: './other.yml' } }
    ]],
    ['invalid-step-id', 'linear.flow.yml', [{ kind: 'step.rename', id: 'b', to: 'my-step' }]],
    ['invalid-step-id', 'linear.flow.yml', [{ kind: 'step.rename', id: 'b', to: '1st' }]],
    ['invalid-step-id', 'linear.flow.yml', [{ kind: 'step.rename', id: 'b', to: 'a.b' }]],
    ['unknown-field', 'linear.flow.yml', [{ kind: 'step.patch', id: 'a', patch: { set: { colour: 'red' } } }]]
  ])('refuses with %s', (reason, file, edits) => {
    expect(refusal(file, edits).reason).toBe(reason);
  });

  /**
   * §5.5: unlike a dangling `depends`, a removed binding leaves no diagnostic anchored where the
   * author is looking — every step through the alias goes red at once and the legend row that caused
   * it is gone. So the refusal names them, and the dialog reads them back.
   */
  it('names the steps that hold a binding in use', () => {
    expect(refusal('linear.flow.yml', [{ kind: 'api.remove', alias: 'regress-api' }])).toEqual({
      ok: false,
      reason: 'api-in-use',
      message: expect.stringContaining('a, b, c'),
      steps: ['a', 'b', 'c']
    });
  });
});

describe('B1.14 — the schema gate refuses only what the edit introduced', () => {
  /** 001 §5.3's xor: a step targets an operation or invokes a sub-flow, never both. */
  it('refuses an operation written onto a uses: step', () => {
    expect(refusal('tag-with.flow.yml', [
      { kind: 'step.patch', id: 'call_sub', patch: { set: { operation: 'regress-api#createThing' } } }
    ]).reason).toBe('schema-refused');
  });

  /**
   * The case a stricter gate gets wrong. `empty.flow.yml` is what the create form writes, and it is
   * schema-invalid for lacking `steps:` before the builder has touched it — so a gate reading the
   * after-state alone would refuse the very first insert on every new flow.
   */
  it('inserts into a flow that is already schema-invalid for having no steps', () => {
    const result = applyFlowEdits(read('empty.flow.yml'), [
      { kind: 'step.insert', step: { operation: 'regress-api#createThing' } }
    ]);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('steps:\n  - id: create_thing\n');
  });

  it('patches a step on a flow carrying a pre-existing schema error', () => {
    const broken = read('linear.flow.yml').replace('    when: steps.b.status eq 200', '    when: 42');
    const result = applyFlowEdits(broken, [{ kind: 'step.patch', id: 'a', patch: { set: { timeout: 5000 } } }]);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('    when: 42');
  });
});

describe('B1.15 — an unknown key is preserved through an edit to its own step', () => {
  const file = 'unknown-key.flow.yml';

  it('leaves the key this build does not model exactly as written', () => {
    const text = read(file);
    const result = applyFlowEdits(text, [{ kind: 'step.patch', id: 'create', patch: { set: { timeout: 5000 } } }]);

    expect(result.ok).toBe(true);
    expect(changedLines(text, result.text)).toEqual({
      // After the last key the schema reads before `timeout`, which is `operation`. The key this
      // build does not model is stepped over rather than ordered against, so it keeps its place
      // relative to the `maxDuration` below it.
      at: text.split('\n').indexOf('    retryPolicy: aggressive') + 1,
      removed: [],
      added: ['    timeout: 5000']
    });
    expect(result.text).toContain('    retryPolicy: aggressive');
  });

  /**
   * 001 §15's "never drops unrecognized fields" is only true if the surface that would drop them can
   * see them — so the key is named rather than omitted, with no tag, which is what tells the editor
   * to list it under *Not editable here* rather than to render a control for it.
   */
  it('lists it as opaque, with no tag', () => {
    const step = readFlowEditModel(read(file)).steps[0];

    expect(step.opaque).toEqual([{ key: 'retryPolicy' }]);
    expect(step.fields).toEqual({
      id: 'create',
      operation: 'regress-api#createThing',
      maxDuration: 120000
    });
  });
});

describe('B1.13 — an edit kind this build does not know is refused', () => {
  /** An older engine under a newer renderer: the one failure that would otherwise change nothing and say nothing. */
  it('names the kind rather than applying it as nothing', () => {
    const result = applyFlowEdits('version: 1\nsteps:\n  - id: a\n    operation: api#x\n', [{ kind: 'step.teleport', id: 'a' }]);

    expect(result).toEqual({ ok: false, reason: 'unknown-edit', message: 'this engine has no step.teleport edit' });
  });
});

describe('B1.16 — a compound edit is one parse', () => {
  const edits = [
    { kind: 'step.insert', step: { operation: 'regress-api#getState' }, after: 'sign_in' },
    { kind: 'step.patch', id: 'get_state', patch: { set: { timeout: 5000 } } },
    { kind: 'step.rename', id: 'get_state', to: 'poll' }
  ];

  /**
   * The reason §9.1 is one entry point over a list rather than a function per edit. Applying them
   * one call at a time is parse → emit → parse → emit, and the second parse re-derives every node
   * from text the first pass rewrote — so the preservation holds across a compound edit only if
   * there is one parse and one emission.
   */
  it('lands the same text as applying the three in sequence', () => {
    const text = read('commented.flow.yml');
    const compound = applyFlowEdits(text, edits);
    const sequential = edits.reduce((carried, edit) => {
      const step = applyFlowEdits(carried, [edit]);
      if (!step.ok) throw new Error(`${step.reason}: ${step.message}`);
      return step.text;
    }, text);

    expect(compound.ok).toBe(true);
    expect(compound.text).toBe(sequential);
  });

  it('leaves the comments around the step it touched as they were', () => {
    const text = read('commented.flow.yml');
    const compound = applyFlowEdits(text, edits);

    expect(changedLines(text, compound.text)).toEqual({
      at: text.split('\n').indexOf('    operation: regress-api#signIn         # §6.1\'s reference') + 2,
      removed: [],
      added: ['  - id: poll', '    operation: regress-api#getState', '    timeout: 5000']
    });
    expect(compound.text).toContain('  # The one under edit.');
    expect(compound.text).toContain('  - id: create                            # the second step');
  });
});
