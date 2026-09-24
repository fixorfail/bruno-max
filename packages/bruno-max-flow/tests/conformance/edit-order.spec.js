/**
 * B1.10–B1.11 — a new key, and a new block, land where the format reads them.
 *
 * `setIn` appends, which is right for a data structure and wrong for a file people read top to
 * bottom: a `steps:` above `meta:` is 001 §5.2 inverted by the first click, and a `name:` written
 * below `assert:` makes every form in the editor a source of key-order churn. One rule for both, and
 * the rule is the schema's own declaration order, so the writer cannot drift from what ajv accepts.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits } = require('../../src/edit');
const { ROOT_KEY_ORDER, STEP_KEY_ORDER, V1 } = require('../../src/schema/v1');
const { changedLines, lineOf } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

const written = (file, edits) => {
  const result = applyFlowEdits(read(file), edits);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.text;
};

describe('B1.10 — a new key lands in schema order', () => {
  const patch = (set) => ({ kind: 'step.patch', id: 'a', patch: { set } });

  it('reads back in the schema\'s order, whatever order the edits arrived in', () => {
    const text = written('builder/linear.flow.yml', [
      patch({ assert: ['res.status eq 200'] }),
      patch({ headers: { 'X-Trace': '{{flow.runId}}' } }),
      patch({ name: 'Sign in' })
    ]);

    expect(changedLines(read('builder/linear.flow.yml'), text)).toEqual({
      at: lineOf(read('builder/linear.flow.yml'), '    operation: regress-api#signIn'),
      removed: ['    operation: regress-api#signIn'],
      added: [
        '    name: Sign in',
        '    operation: regress-api#signIn',
        '    headers:',
        '      X-Trace: "{{flow.runId}}"',
        '    assert:',
        '      - res.status eq 200'
      ]
    });
  });

  /**
   * The order the writer splices into and the set ajv accepts are one declaration, so a key added to
   * the schema is a key the builder can write, in the position the format reads it, with no second
   * list to remember.
   */
  it('is the schema\'s own property order, not a list beside it', () => {
    expect(STEP_KEY_ORDER).toEqual(Object.keys(V1.properties.steps.items.properties));
    expect(STEP_KEY_ORDER.slice(0, 4)).toEqual(['id', 'name', 'meta', 'operation']);
    expect(ROOT_KEY_ORDER).toEqual(Object.keys(V1.properties));
  });
});

describe('B1.11 — api.add lands after the last root key that precedes it', () => {
  const binding = { alias: 'regress-api', source: '../../specs/regressions-v1.yml' };

  it('creates the block after meta:, above the config that reads it', () => {
    const before = read('builder/no-apis.flow.yml');
    const text = written('builder/no-apis.flow.yml', [{ kind: 'api.add', binding }]);

    expect(changedLines(before, text)).toEqual({
      // Before the blank line that `config:` carries with it, which is the line the author would
      // have typed the block on.
      at: lineOf(before, '  name: Builder — a flow with no bindings') + 1,
      removed: [],
      added: ['apis:', '  regress-api: ../../specs/regressions-v1.yml']
    });
  });

  it('creates it after version: on a flow that declares nothing else', () => {
    const before = read('builder/version-only.flow.yml');
    const text = written('builder/version-only.flow.yml', [{ kind: 'api.add', binding }]);

    expect(changedLines(before, text)).toEqual({
      at: lineOf(before, 'version: 1') + 1,
      removed: [],
      added: ['apis:', '  regress-api: ../../specs/regressions-v1.yml']
    });
  });

  /**
   * §5.2's shorthand where a binding says only what it binds, and the mapping form the moment it says
   * more — which is how `writeNewFlowDocument` already writes one, so a legend-added binding reads
   * like a create-form one.
   */
  it('writes the mapping form only for a binding that declares more than its source', () => {
    const text = written('builder/version-only.flow.yml', [
      { kind: 'api.add', binding: { ...binding, auth: 'user-token', baseUrl: '', color: '#ff8800' } }
    ]);

    expect(text).toContain([
      'apis:',
      '  regress-api:',
      '    source: ../../specs/regressions-v1.yml',
      '    auth: user-token',
      '    color: "#ff8800"'
    ].join('\n'));
  });

  /**
   * The rest of §6.2's binding — the fields a flow declares once for every step through it. They are
   * here rather than in a test of their own because the shape they are written in is the same one
   * `auth:` and `color:` proved: what the binding says nothing about, the file does not carry.
   *
   * `strictNulls: false` is the case the filter has to be right about — `false` is the *meaningful*
   * value of that key (001 §10.1), and a writer dropping falsy values would write the binding
   * without the one field the author set.
   */
  it('writes the rest of a binding, including a strictNulls: false', () => {
    const text = written('builder/no-apis.flow.yml', [
      {
        kind: 'api.add',
        binding: {
          ...binding,
          baseUrl: 'https://qa.example.com',
          rateLimit: { requests: 100, per: 'minute' },
          defaultHeaders: { 'X-Tenant': 'acme' },
          strictNulls: false
        }
      }
    ]);

    expect(text).toContain([
      'apis:',
      '  regress-api:',
      '    source: ../../specs/regressions-v1.yml',
      '    baseUrl: https://qa.example.com',
      '    rateLimit:',
      '      requests: 100',
      '      per: minute',
      '    defaultHeaders:',
      '      X-Tenant: acme',
      '    strictNulls: false'
    ].join('\n'));
  });

  /**
   * B1.21 — `api.update` is a merge, not a replacement.
   *
   * `ApiBindingDraft` models eight keys and a binding may carry more: one a later format version
   * adds, one a hand-written file has. Written as a replacement, saving an edit to the *colour*
   * deleted every one of them — silently, from a form that never showed them.
   */
  describe('B1.21 — a binding updated keeps what the draft does not model', () => {
    const edited = (text, over = {}) => {
      const result = applyFlowEdits(text, [
        { kind: 'api.update', alias: 'api', binding: { alias: 'api', source: './api.yml', ...over } }
      ]);
      if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
      return result.text;
    };

    const withUnknown = [
      'version: 1',
      'apis:',
      '  api:',
      '    source: ./api.yml',
      '    color: "#123456"',
      '    x-owner: payments-team',
      'steps: []',
      ''
    ].join('\n');

    it('leaves a key this build does not know where the author put it', () => {
      const text = edited(withUnknown, { color: '#abcdef' });

      expect(text).toContain('    color: "#abcdef"');
      expect(text).toContain('    x-owner: payments-team');
    });

    it('keeps it even when the edit clears every key the draft models', () => {
      const text = edited(withUnknown);

      expect(text).not.toContain('color');
      expect(text).toContain('    x-owner: payments-team');
      // Still a mapping, because the unknown key is holding it open.
      expect(text).toContain('  api:\n    source: ./api.yml\n    x-owner: payments-team');
    });

    /** The form clears a field by omitting it, so a merge that kept everything would clear nothing. */
    it('still removes a modelled key the draft leaves out', () => {
      const text = edited('version: 1\napis:\n  api:\n    source: ./api.yml\n    color: "#123456"\n    auth: service\nsteps: []\n', { auth: 'service' });

      expect(text).not.toContain('color');
      expect(text).toContain('auth: service');
    });

    /**
     * §6.4's opaque keys are modelled keys the file wrote under a tag. The model reports them as
     * opaque and the dialog never receives them, so their absence from a draft says nothing — and
     * treating it as *cleared* would be the same deletion one level subtler.
     */
    it('keeps a modelled key the file wrote under a tag', () => {
      const text = edited('version: 1\napis:\n  api:\n    source: ./api.yml\n    defaultHeaders: !...\nsteps: []\n', { color: '#abcdef' });

      expect(text).toContain('defaultHeaders: !...');
      expect(text).toContain('color: "#abcdef"');
    });

    it('collapses to the shorthand when nothing but the source is left', () => {
      const text = edited('version: 1\napis:\n  api:\n    source: ./api.yml\n    color: "#123456"\nsteps: []\n');

      expect(text).toContain('  api: ./api.yml\n');
    });

    /** §9.1's promise: an existing scalar is mutated, so what was written around it survives. */
    it('keeps a comment and the flow style the binding was written in', () => {
      const commented = 'version: 1\napis:\n  api:\n    source: ./api.yml\n    color: "#123456" # the brand blue\n    x-owner: payments\nsteps: []\n';
      const text = edited(commented, { color: '#abcdef' });

      expect(text).toContain('color: "#abcdef" # the brand blue');

      const flowStyle = 'version: 1\napis:\n  api: { source: ./api.yml, color: "#123456", x-owner: payments }\nsteps: []\n';

      expect(edited(flowStyle, { color: '#abcdef' })).toContain('api: { source: ./api.yml, color: "#abcdef", x-owner: payments }');
    });

    it('writes a key the binding did not have in BINDING_KEYS order', () => {
      const text = edited(withUnknown, { color: '#123456', baseUrl: 'https://qa.example.com' });

      expect(text).toContain('    source: ./api.yml\n    baseUrl: https://qa.example.com\n    color: "#123456"\n    x-owner: payments-team');
    });
  });

  it('B1.6 creates the steps: block after the last root key that precedes it', () => {
    const before = read('builder/root-keys.flow.yml');
    const text = written('builder/root-keys.flow.yml', [
      { kind: 'step.insert', step: { operation: 'regress-api#createThing' } }
    ]);

    expect(changedLines(before, text)).toEqual({
      at: before.split('\n').length,
      removed: [],
      added: ['steps:', '  - id: create_thing', '    operation: regress-api#createThing']
    });
    const lines = text.split('\n');
    expect(lines.indexOf('steps:')).toBeGreaterThan(lines.indexOf('  currency: USD'));
  });
});
