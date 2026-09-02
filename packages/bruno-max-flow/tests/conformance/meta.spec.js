/**
 * R4z — reading and rewriting `meta:` (001 §5.2, 002 §4.4).
 *
 * These run against `meta.ts` directly, for `parse.spec.js`' reason: they are properties of reading
 * and writing the file, and nothing about a run would make them more true.
 *
 * The round-trip assertions carry most of the weight. A `.flow.yml` is committed and hand-edited
 * (§5.1), so the guarantee that matters is not that `meta:` ends up right — it is that *nothing else
 * moved*, and the ways a YAML serializer quietly rewrites a document it re-emits are exactly what a
 * property dialog would otherwise ship.
 */
const { readFlowProperties, writeFlowProperties } = require('../../src/meta');

const NONE = { tags: [], library: false };

describe('R4z — reading a flow\'s properties', () => {
  it('reads every key §5.2 declares, trimmed', () => {
    const text = [
      'version: 1',
      'meta:',
      '  name: "  Checkout happy path  "',
      '  description: Creates a payment.',
      '  testId: "  C1000  "',
      '  tags: [checkout, smoke]',
      '  library: true',
      ''
    ].join('\n');

    expect(readFlowProperties(text)).toEqual({
      name: 'Checkout happy path',
      description: 'Creates a payment.',
      testId: 'C1000',
      tags: ['checkout', 'smoke'],
      library: true
    });
  });

  /**
   * The dialog opens on a flow that may declare nothing, and the defaults it shows have to be the
   * ones the engine runs on — `document.ts` reads the flag as `Boolean(meta.library)`, so `false`
   * and an absent key are one state rather than two.
   */
  it('reports the defaults for a flow that declares no meta, and for one that declares them false', () => {
    expect(readFlowProperties('version: 1\nsteps:\n  - id: a\n')).toEqual(NONE);
    expect(readFlowProperties('version: 1\nmeta:\n  library: false\n  tags: []\n')).toEqual(NONE);
  });

  /**
   * `document.ts` coerces this key, so the dialog has to read back the string the engine would
   * normalize to — otherwise the field shows `1000` as a number the moment it is edited.
   */
  it('reads a case id the author wrote as a bare number, and omits a blank one', () => {
    expect(readFlowProperties('version: 1\nmeta:\n  testId: 1000\n')).toEqual({ ...NONE, testId: '1000' });
    expect(readFlowProperties('version: 1\nmeta:\n  testId: "   "\n')).toEqual(NONE);
    expect(readFlowProperties('version: 1\nmeta:\n  testId:\n')).toEqual(NONE);
  });

  it('reads a flow carrying §5.4\'s local tags, which a plain parser calls an error', () => {
    const text = 'version: 1\nmeta:\n  name: probe\nvars:\n  catalog: !file ./catalog.json\n';

    expect(readFlowProperties(text)).toEqual({ ...NONE, name: 'probe' });
  });

  /** No document to edit. The dialog reports the file rather than offering to rewrite it. */
  it('has no properties for text that does not parse', () => {
    expect(readFlowProperties('version: 1\nsteps:\n  - id: a\n   bad indent\n')).toBeUndefined();
  });
});

describe('R4z — writing a flow\'s properties', () => {
  /**
   * The one that would be silently wrong. `document.ts`'s tags resolve `!file` to a `FileRef`, which
   * has no `stringify` — re-emitting a document parsed with them writes `!file "[object Object]"`
   * and destroys a flow's fixtures on an edit to its name.
   */
  it('leaves everything outside meta exactly as it was written', () => {
    const text = [
      '# The checkout path, end to end.',
      'version: 1',
      '',
      'meta:',
      '  name: Checkout',
      '',
      'vars:',
      '  catalog: !file ./fixtures/catalog.json',
      '  invoice: !file',
      '    path: ./invoice.pdf',
      '    filename: signed.pdf',
      '  defaults: &defaults { retries: 2 }',
      '',
      'steps:',
      '  - id: charge # the one that matters',
      '    <<: *defaults',
      '    operation: payments-api#createPayment',
      ''
    ].join('\n');

    const written = writeFlowProperties(text, { ...NONE, name: 'Renamed' });

    expect(written).toBe(text.replace('  name: Checkout', '  name: Renamed'));
  });

  /**
   * The one thing that does not survive. `yaml` re-emits a trailing comment one space after the
   * value, so padding an author used to align a column of them collapses — everything the format
   * carries meaning in is preserved, and this is the cosmetic edge of that guarantee. Asserted
   * rather than left to be discovered in a diff.
   */
  it('collapses padding before a trailing comment, and changes nothing else about the line', () => {
    const text = 'version: 1\nmeta:\n  name: Checkout\nsteps:\n  - id: charge      # aligned\n';

    expect(writeFlowProperties(text, { ...NONE, name: 'Renamed' })).toBe(
      'version: 1\nmeta:\n  name: Renamed\nsteps:\n  - id: charge # aligned\n'
    );
  });

  it('adds the keys a flow did not declare, and keeps the block\'s comments', () => {
    const text = 'version: 1\nmeta:\n  name: Checkout # the prose name\n';

    expect(writeFlowProperties(text, { name: 'Checkout', description: 'Does things.', tags: ['smoke'], library: true }))
      .toBe(
        [
          'version: 1',
          'meta:',
          '  name: Checkout # the prose name',
          '  description: Does things.',
          '  tags:',
          '    - smoke',
          '  library: true',
          ''
        ].join('\n')
      );
  });

  /**
   * §5.2 makes `description: ''`, `tags: []` and `library: false` mean what the missing key means,
   * and `CreateFlow`'s `buildFlowDocument` writes a new flow that way — so clearing a field has to
   * delete it. Spelling out a default would make edit-and-undo leave a different file behind.
   */
  it('deletes a key that was cleared rather than writing its default', () => {
    const text = 'version: 1\nmeta:\n  name: Checkout\n  description: Does things.\n  tags: [smoke]\n  library: true\n';

    expect(writeFlowProperties(text, { ...NONE, name: 'Checkout' })).toBe('version: 1\nmeta:\n  name: Checkout\n');
  });

  /**
   * `setIn` on a document with no `meta:` appends the block, which puts a flow's name below its
   * steps — §5.2's structure inverted by an edit that only meant to name the thing.
   */
  it('creates a missing meta block directly after version', () => {
    const text = 'version: 1\n\napis:\n  payments-api: ./payments.yml\n\nsteps:\n  - id: a\n';

    expect(writeFlowProperties(text, { ...NONE, name: 'Checkout' })).toBe(
      'version: 1\nmeta:\n  name: Checkout\n\napis:\n  payments-api: ./payments.yml\n\nsteps:\n  - id: a\n'
    );
  });

  it('writes nothing at all when a flow with no meta is given none', () => {
    const text = 'version: 1\nsteps:\n  - id: a\n';

    expect(writeFlowProperties(text, NONE)).toBe(text);
  });

  it('refuses text that does not parse, rather than replacing it with a document it built', () => {
    expect(writeFlowProperties('version: 1\nsteps:\n  - id: a\n   bad indent\n', { ...NONE, name: 'x' }))
      .toBeUndefined();
  });

  /** §5.2's order: the case id sits with the prose it describes, above the tags. */
  it('writes a case id after description and before tags', () => {
    const text = 'version: 1\nmeta:\n  name: Checkout\n';

    expect(writeFlowProperties(text, { name: 'Checkout', description: 'Does things.', testId: 'C1000', tags: ['smoke'], library: false }))
      .toBe(
        [
          'version: 1',
          'meta:',
          '  name: Checkout',
          '  description: Does things.',
          '  testId: C1000',
          '  tags:',
          '    - smoke',
          ''
        ].join('\n')
      );
  });

  it('deletes a case id that was cleared, like every other default', () => {
    const text = 'version: 1\nmeta:\n  name: Checkout\n  testId: C1000\n';

    expect(writeFlowProperties(text, { ...NONE, name: 'Checkout' })).toBe('version: 1\nmeta:\n  name: Checkout\n');
    expect(writeFlowProperties(text, { ...NONE, name: 'Checkout', testId: '   ' }))
      .toBe('version: 1\nmeta:\n  name: Checkout\n');
  });

  /**
   * The guarantee the whole module exists for, applied to the new key: setting it must move nothing
   * else, comments and steps included.
   */
  it('leaves the rest of the document byte-identical when only the case id changes', () => {
    const text = [
      'version: 1',
      '',
      'meta:',
      '  name: Checkout # the prose name',
      '',
      'apis:',
      // One space before the comment on purpose: aligned padding collapses, which is this
      // module's one documented exception and has a test of its own above.
      '  payments-api: ./payments.yml # the binding',
      '',
      'vars:',
      '  catalog: !file ./catalog.json',
      '',
      'steps:',
      '  - id: a',
      '    operation: payments-api#createPayment',
      ''
    ].join('\n');
    const written = writeFlowProperties(text, { ...NONE, name: 'Checkout', testId: 'C1000' });

    expect(written).toBe(text.replace('  name: Checkout # the prose name', '  name: Checkout # the prose name\n  testId: C1000'));
    // And removing it puts the file back exactly as it was.
    expect(writeFlowProperties(written, { ...NONE, name: 'Checkout' })).toBe(text);
  });

  /** What is written has to read back as what was asked for, for every field at once. */
  it('round-trips through the reader', () => {
    const properties = {
      name: 'Checkout',
      description: 'Does things.',
      testId: 'C1000',
      tags: ['checkout', 'smoke'],
      library: true
    };

    expect(readFlowProperties(writeFlowProperties('version: 1\nsteps:\n  - id: a\n', properties))).toEqual(properties);
  });
});
