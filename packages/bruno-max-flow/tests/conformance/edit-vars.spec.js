/**
 * B1.25 — `vars:` (001 §7.3), written whole.
 *
 * The rules are the same as for `params:` and `exports:` (B1.23, B1.24). Each draft contains all
 * entries of the block, and a renamed entry keeps its position. The file keeps each unchanged entry
 * byte for byte. A var with a local tag, for example a `!file` source (§7.4), is opaque: when the
 * draft names it, the writer keeps it unchanged.
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

const vars = (entries) => ({ kind: 'vars.define', vars: entries });

const FLOW = [
  'version: 1',
  'vars:',
  '  currency: USD                 # the ledger default',
  '  testEmail: "qa+{{$randomUUID}}@example.com"',
  '  catalog: !file ./fixtures/catalog.json',
  '  limits: { daily: 100 }',
  'steps:',
  '  - id: a',
  '    operation: api#x',
  ''
].join('\n');

const UNCHANGED = {
  currency: 'USD',
  testEmail: 'qa+{{$randomUUID}}@example.com',
  catalog: null,
  limits: { daily: 100 }
};

describe('B1.25 — vars: is written whole, and keeps what did not change', () => {
  it('creates the block, in §5.2\'s position, for a flow that declares none', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [vars({ currency: 'USD' })]);

    expect(text).toContain('\nvars:\n  currency: USD\n');
    expect(lineOf(text, 'vars:')).toBeGreaterThan(lineOf(text, 'apis:'));
    expect(lineOf(text, 'vars:')).toBeLessThan(lineOf(text, 'steps:'));
  });

  it('reads each var as written, in order, and a tagged one as opaque', () => {
    expect(readFlowEditModel(FLOW).vars).toEqual([
      { name: 'currency', value: 'USD' },
      { name: 'testEmail', value: 'qa+{{$randomUUID}}@example.com' },
      { name: 'catalog', opaque: true },
      { name: 'limits', value: { daily: 100 } }
    ]);
  });

  it('writes the block the file holds as no change, and keeps the tagged var', () => {
    const result = written(FLOW, [vars(UNCHANGED)]);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(FLOW);
  });

  it('changes one value in place, with its quotes and its comment', () => {
    const { text } = written(FLOW, [
      vars({ ...UNCHANGED, currency: 'EUR', testEmail: 'qa+{{flow.runId}}@example.com' })
    ]);

    expect(changedLines(FLOW, text)).toEqual({
      at: lineOf(FLOW, '  currency: USD                 # the ledger default'),
      removed: ['  currency: USD                 # the ledger default', '  testEmail: "qa+{{$randomUUID}}@example.com"'],
      added: ['  currency: EUR # the ledger default', '  testEmail: "qa+{{flow.runId}}@example.com"']
    });
  });

  it('renames a var in its place', () => {
    const { currency, ...rest } = UNCHANGED;
    const { text } = written(FLOW, [vars({ ledgerCurrency: currency, ...rest })]);

    expect(readFlowEditModel(text).vars.map((entry) => entry.name)).toEqual(['ledgerCurrency', 'testEmail', 'catalog', 'limits']);
    expect(text).toContain('  catalog: !file ./fixtures/catalog.json\n');
  });

  it('removes a var, and the block with its last one', () => {
    const { text } = written(FLOW, [vars({ currency: 'USD' })]);
    expect(text).toBe('version: 1\nvars:\n  currency: USD                 # the ledger default\nsteps:\n  - id: a\n    operation: api#x\n');

    const none = written(text, [vars({})]).text;
    expect(none).not.toContain('vars:');
  });
});
