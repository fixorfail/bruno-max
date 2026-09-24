/**
 * B1.17 — a slot a step publishes to is declared in the flow's `shared:` block.
 *
 * The engine reports nothing for a write to an undeclared slot, so without this the author who typed
 * a slot on a step would find the graph drawing no slot and every reader told it is undeclared. The
 * declaration takes the form the block already has, and is never taken back.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits } = require('../../src/edit');
const { changedLines, lineOf } = require('./lines');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

const written = (text, edits) => {
  const result = applyFlowEdits(text, edits);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
};

const publish = (shared) => ({ kind: 'step.patch', id: 'a', patch: { set: { shared } } });

describe('B1.17 — a slot a step publishes to is declared', () => {
  it('creates the block, in schema order, for a flow that declares none', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [publish(['chargeId'])]);

    expect(text).toContain('\nshared: [ chargeId ]\n');
    expect(lineOf(text, 'shared: [ chargeId ]')).toBeGreaterThan(lineOf(text, 'apis:'));
    expect(lineOf(text, 'shared: [ chargeId ]')).toBeLessThan(lineOf(text, 'steps:'));
  });

  it('appends a name to a list, once, and leaves the names it has', () => {
    const before = 'version: 1\nshared: [sessionToken]\nsteps:\n  - id: a\n    operation: api#signIn\n';
    const { text } = written(before, [publish(['chargeId', 'sessionToken'])]);

    expect(text).toContain('shared: [ sessionToken, chargeId ]\n');
    expect(text.match(/chargeId/g)).toHaveLength(2);
  });

  it('adds a `writers: all` entry to a mapping, and reads the slot off the mapping form of the step', () => {
    const before = 'version: 1\nshared:\n  sessionToken: { writers: any }\nsteps:\n  - id: a\n    operation: api#charge\n    outputs:\n      backupId: data.id\n';
    const { text } = written(before, [publish({ chargeId: 'backupId' })]);

    expect(text).toContain('shared:\n  sessionToken: { writers: any }\n  chargeId: { writers: all }\n');
  });

  it('changes nothing at the root when every slot is already declared', () => {
    const before = 'version: 1\nshared: [chargeId]\nsteps:\n  - id: a\n    operation: api#charge\n';
    const { text } = written(before, [publish(['chargeId'])]);

    expect(changedLines(before, text).added).toEqual(['    shared:', '      - chargeId']);
    expect(changedLines(before, text).removed).toEqual([]);
  });

  it('declares the slots of an inserted step too', () => {
    const before = read('builder/linear.flow.yml');
    const { text } = written(before, [{ kind: 'step.insert', step: { operation: 'regress-api#charge', shared: ['chargeId'] } }]);

    expect(text).toContain('\nshared: [ chargeId ]\n');
  });

  it('takes nothing back when a step stops publishing', () => {
    const before = 'version: 1\nshared: [chargeId]\nsteps:\n  - id: a\n    operation: api#charge\n    shared: [chargeId]\n';
    const { text } = written(before, [{ kind: 'step.patch', id: 'a', patch: { unset: ['shared'] } }]);

    expect(text).toContain('\nshared: [chargeId]\n');
    expect(text).not.toContain('    shared:');
  });
});
