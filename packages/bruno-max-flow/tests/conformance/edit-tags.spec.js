/**
 * B3.1–B3.3 — the engine half of opaque fields (005 §6.4, §9.2, §12).
 *
 * A tag is structure a form cannot show without inventing a widget for it, and re-emitting one
 * wrong destroys a fixture: `document.ts`'s tag table resolves `!file` to a `FileRef` and `!...` to
 * a symbol, neither of which has a serializer, so a writer built on it writes
 * `body: !file "[object Object]"` and the flow now uploads nothing. `meta.spec.js` holds that case
 * for `meta:`; this is the same case one level down, where the tags actually live.
 *
 * §12 believes it has listed every position a tag can appear in. One fixture per position is how a
 * missing one shows up as a red test rather than as a destroyed file.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits, readFlowEditModel } = require('../../src/edit');
const { changedLines } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, `builder/${file}`), 'utf8');

const patched = (file, id, set) => {
  const text = read(file);
  const result = applyFlowEdits(text, [{ kind: 'step.patch', id, patch: { set } }]);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return { text, written: result.text, diff: changedLines(text, result.text) };
};

const stepNamed = (file, id) => readFlowEditModel(read(file)).steps.find((step) => step.id === id);

describe('B3.1 — a tagged value is opaque, in the model and in the editor', () => {
  it('names the tag rather than the value, and keeps the key out of fields', () => {
    const body = stepNamed('tag-body.flow.yml', 'create');
    const outputs = stepNamed('tag-outputs.flow.yml', 'create');

    expect(body.opaque).toEqual([{ key: 'body', tag: '!file' }]);
    expect(body.fields).not.toHaveProperty('body');
    expect(outputs.opaque).toEqual([{ key: 'outputs', tag: '!...' }]);
    expect(outputs.fields).not.toHaveProperty('outputs');
  });

  /** *Open in YAML* opens at the key, not at the step — so the line is the key's own. */
  it('carries the line each opaque key sits on', () => {
    const step = stepNamed('tag-body.flow.yml', 'create');
    const lines = read('tag-body.flow.yml').split('\n');

    expect(lines[step.keyPositions.body.line - 1]).toBe('    body: !file ./fixtures/thing.json');
    expect(step.position).toEqual(step.keyPositions.id);
  });

  /**
   * The tag makes the *key* opaque even where it is buried in the value: `outputs:` is an ordinary
   * mapping whose one entry is a suppression, and an editor that rewrote the mapping around it would
   * drop the entry it could not see.
   */
  it('is the subtree that decides, not the node the key points at', () => {
    expect(stepNamed('tag-suppressed-keys.flow.yml', 'create').opaque).toEqual([
      { key: 'body', tag: '!...' },
      { key: 'query', tag: '!...' },
      { key: 'headers', tag: '!...' }
    ]);
  });
});

describe('B3.2 — a patch beside a tagged value leaves it byte-identical', () => {
  it('writes the one line the patch names', () => {
    const { text, written, diff } = patched('tag-body.flow.yml', 'create', { timeout: 5000 });

    expect(written).toContain('    body: !file ./fixtures/thing.json');
    expect(diff).toEqual({
      at: text.split('\n').indexOf('    body: !file ./fixtures/thing.json') + 2,
      removed: [],
      added: ['    timeout: 5000']
    });
  });

  it('leaves a suppression as written', () => {
    const { written, diff } = patched('tag-outputs.flow.yml', 'create', { timeout: 5000 });

    expect(written).toContain('      ref: !...\n');
    expect(diff.added).toEqual(['    timeout: 5000']);
    expect(diff.removed).toEqual([]);
  });
});

describe('B3.3 — every position the format allows a tag is covered', () => {
  /** §12's list, each with the step a patch is aimed at and the line that has to survive it. */
  const positions = [
    ['body', 'tag-body.flow.yml', 'create', '    body: !file ./fixtures/thing.json'],
    ['vars.*', 'tag-vars.flow.yml', 'create', '  catalog: !file ./fixtures/catalog.json'],
    ['vars.* in its mapping form', 'tag-vars.flow.yml', 'create', '  invoice: !file'],
    ['dataset.source', 'tag-dataset.flow.yml', 'create', '  source: !file ../../datasets/roles.csv'],
    ['outputs.<name>', 'tag-outputs.flow.yml', 'create', '      ref: !...'],
    ['a key of body', 'tag-suppressed-keys.flow.yml', 'create', '      legacy_field: !...'],
    ['a key of query', 'tag-suppressed-keys.flow.yml', 'create', '      expand: !...'],
    ['a key of headers', 'tag-suppressed-keys.flow.yml', 'create', '      X-Legacy-Key: !...'],
    ['with.*', 'tag-with.flow.yml', 'read_back', '      payload: !file ./fixtures/payload.json']
  ];

  it.each(positions)('%s survives a patch to an unrelated key', (unused, file, id, line) => {
    const { written } = patched(file, id, { timeout: 5000 });

    expect(written.split('\n')).toContain(line);
  });

  /**
   * A root-level tag has no step to be opaque on; what it has is a writer that must leave it alone.
   * The step-level ones are listed to their own step, which is what the editor's *Not editable here*
   * renders from.
   */
  it.each([
    ['tag-body.flow.yml', 'create', [{ key: 'body', tag: '!file' }]],
    ['tag-outputs.flow.yml', 'create', [{ key: 'outputs', tag: '!...' }]],
    ['tag-with.flow.yml', 'call_sub', [{ key: 'with', tag: '!file' }]],
    ['tag-vars.flow.yml', 'create', []],
    ['tag-dataset.flow.yml', 'create', []]
  ])('%s reports %s\'s opaque keys', (file, id, expected) => {
    expect(stepNamed(file, id).opaque).toEqual(expected);
  });
});
