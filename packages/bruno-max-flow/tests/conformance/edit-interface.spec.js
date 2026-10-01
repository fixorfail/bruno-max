/**
 * B1.23, B1.24 — the interface of a flow, `params:` and `exports:` (001 §12.1), written whole.
 *
 * Each draft contains all entries of its block. Thus a renamed entry keeps its position. The file
 * keeps each unchanged entry byte for byte, with its comments and style. An entry with a local tag
 * is opaque (§6.4): when the draft names it, the writer keeps it unchanged.
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

const params = (entries) => ({ kind: 'params.define', params: entries });
const exports = (entries) => ({ kind: 'exports.define', exports: entries });

const LIBRARY = [
  'version: 1',
  'meta:',
  '  name: Login',
  '  library: true',
  'params:',
  '  email: { required: true }    # the account under test',
  '  password:',
  '    required: false',
  '    default: "{{testUserPassword}}"',
  'exports:',
  '  token: steps.login.token     # what every caller needs',
  '  userId: "steps.login.userId"',
  'steps:',
  '  - id: login',
  '    operation: auth-api#login',
  '    outputs:',
  '      token: data.access_token',
  '      userId: data.user.id',
  ''
].join('\n');

describe('B1.23 — params: is written whole, and keeps what did not change', () => {
  it('creates the block, in §5.2\'s position, as one line per param', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [params({ email: { required: true } })]);

    expect(text).toContain('\nparams:\n  email: { required: true }\n');
    expect(lineOf(text, 'params:')).toBeGreaterThan(lineOf(text, 'apis:'));
    expect(lineOf(text, 'params:')).toBeLessThan(lineOf(text, 'steps:'));
  });

  it('reads each param as written, in order, with nothing filled in', () => {
    expect(readFlowEditModel(LIBRARY).params).toEqual([
      { name: 'email', required: true },
      { name: 'password', required: false, default: '{{testUserPassword}}' }
    ]);
  });

  it('writes the draft the model gave it as the identity', () => {
    const drafted = Object.fromEntries(readFlowEditModel(LIBRARY).params.map(({ name, ...param }) => [name, param]));
    const result = written(LIBRARY, [params(drafted)]);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(LIBRARY);
  });

  it('changes one key of one param, and keeps the style and the comment it has', () => {
    const { text } = written(LIBRARY, [
      params({ email: { required: true, secret: true }, password: { required: false, default: '{{testUserPassword}}' } })
    ]);

    expect(changedLines(LIBRARY, text)).toEqual({
      at: lineOf(LIBRARY, '  email: { required: true }    # the account under test'),
      removed: ['  email: { required: true }    # the account under test'],
      added: ['  email: { required: true, secret: true } # the account under test']
    });
  });

  it('deletes a key the draft leaves out rather than writing its default', () => {
    const { text } = written(LIBRARY, [
      params({ email: { required: true }, password: { default: '{{testUserPassword}}' } })
    ]);

    expect(changedLines(LIBRARY, text).removed).toEqual(['    required: false']);
    expect(changedLines(LIBRARY, text).added).toEqual([]);
  });

  it('renames a param in its place', () => {
    const { text } = written(LIBRARY, [
      params({ login: { required: true }, password: { required: false, default: '{{testUserPassword}}' } })
    ]);

    expect(readFlowEditModel(text).params.map((param) => param.name)).toEqual(['login', 'password']);
    expect(text).toContain('  login: { required: true }\n  password:\n    required: false\n');
  });

  it('removes a param, and the block with its last one', () => {
    const one = written(LIBRARY, [params({ email: { required: true } })]).text;
    expect(one).not.toContain('password');

    const none = written(one, [params({})]).text;
    expect(none).not.toContain('params:');
    expect(none).toContain('exports:');
  });

  it('replaces a params: key that holds nothing, rather than declaring a second one', () => {
    const empty = 'version: 1\nparams:\nsteps: []\n';
    const { text } = written(empty, [params({ email: {} })]);

    expect(text).toBe('version: 1\nparams:\n  email: {}\nsteps: []\n');
  });

  it('refuses a key 001 §12.1 does not give a param, and leaves the text alone', () => {
    const result = applyFlowEdits(LIBRARY, [params({ email: { requird: true } })]);

    expect(result).toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('shows a tagged param as opaque, and keeps it byte for byte when the draft names it', () => {
    const tagged = LIBRARY.replace('  email: { required: true }    # the account under test', '  email: { default: !file ./email.txt }');
    const model = readFlowEditModel(tagged);
    expect(model.params[0]).toEqual({ name: 'email', opaque: true });

    const { text } = written(tagged, [params({ email: {}, password: { required: true, default: '{{testUserPassword}}' } })]);
    expect(changedLines(tagged, text)).toEqual({
      at: lineOf(tagged, '    required: false'),
      removed: ['    required: false'],
      added: ['    required: true']
    });
  });
  it('keeps a param with a key the schema does not know, when the draft names it', () => {
    const unknown = LIBRARY.replace('  email: { required: true }    # the account under test', '  email: { required: true, x-note: qa }');
    expect(readFlowEditModel(unknown).params[0]).toEqual({ name: 'email', opaque: true });

    const result = written(unknown, [params({ email: {}, password: { required: false, default: '{{testUserPassword}}' } })]);
    expect(result.changed).toBe(false);
  });
});

describe('B1.24 — exports: is written whole, and keeps what did not change', () => {
  it('creates the block after params:, where §5.2 reads it', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [params({ id: {} }), exports({ thingId: 'steps.b.thingId' })]);

    expect(text).toContain('\nparams:\n  id: {}\nexports:\n  thingId: steps.b.thingId\n');
    expect(lineOf(text, 'exports:')).toBeLessThan(lineOf(text, 'steps:'));
  });

  it('reads each export as written, in order', () => {
    expect(readFlowEditModel(LIBRARY).exports).toEqual([
      { name: 'token', source: 'steps.login.token' },
      { name: 'userId', source: 'steps.login.userId' }
    ]);
  });

  it('changes one reference in place, with its quoting and its comment', () => {
    const { text } = written(LIBRARY, [exports({ token: 'steps.login.refresh', userId: 'steps.login.id' })]);

    expect(changedLines(LIBRARY, text)).toEqual({
      at: lineOf(LIBRARY, '  token: steps.login.token     # what every caller needs'),
      removed: ['  token: steps.login.token     # what every caller needs', '  userId: "steps.login.userId"'],
      added: ['  token: steps.login.refresh # what every caller needs', '  userId: "steps.login.id"']
    });
  });

  it('adds an export at the end, and removes the block with its last one', () => {
    const more = written(LIBRARY, [
      exports({ token: 'steps.login.token', userId: 'steps.login.userId', role: 'shared.role' })
    ]).text;
    expect(changedLines(LIBRARY, more).added).toEqual(['  role: shared.role']);

    const none = written(LIBRARY, [exports({})]).text;
    expect(none).not.toContain('exports:');
    expect(none).toContain('params:');
  });

  it('writes nothing for a draft equal to the block', () => {
    const result = written(LIBRARY, [exports({ token: 'steps.login.token', userId: 'steps.login.userId' })]);

    expect(result.changed).toBe(false);
  });

  it('shows an export that is not a reference as opaque, and keeps it when the draft names it', () => {
    const odd = LIBRARY.replace('  userId: "steps.login.userId"', '  userId: [steps.login.userId]');

    expect(readFlowEditModel(odd).exports[1]).toEqual({ name: 'userId', source: '', opaque: true });
    expect(written(odd, [exports({ token: 'steps.login.token', userId: '' })]).changed).toBe(false);
  });
});
