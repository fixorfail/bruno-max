/**
 * R9.15 — §9.1's `skipReason:` outside a run: what normalization keeps, what the described graph
 * carries, and what an edit leaves in the file. R9.14 pins what a run does with it.
 *
 * A key the engine reads at run time and drops anywhere else is a key the app removes on the first
 * edit, after which the join runs past a closed gate again with nothing in the diff to say why.
 */
const fs = require('fs');
const path = require('path');

const { normalizeFlow, parseDocument } = require('../../src/document');
const { applyFlowEdits } = require('../../src/edit');
const { describeFlow, FLOWS } = require('./harness');
const { changedLines } = require('./lines');

const FIXTURE = 'regressions/r9-skip-reason.flow.yml';
const read = () => fs.readFileSync(path.join(FLOWS, FIXTURE), 'utf8');
const join = (flow) => flow.steps.find((step) => step.id === 'create_payable');

describe('R9.15 — skipReason: survives normalization, description and an edit', () => {
  it('normalizes to skipReasons on the entry, and leaves an entry without one unnarrowed', () => {
    const flow = normalizeFlow(parseDocument(read()), path.join(FLOWS, FIXTURE));

    expect(join(flow).depends.entries).toEqual([
      { on: 'get_vendor', status: ['success', 'skipped'], skipReasons: ['condition-false'] }
    ]);
    expect(flow.steps.find((step) => step.id === 'get_vendor').depends.entries).toEqual([
      { on: 'probe_cutoff', status: ['success'] }
    ]);
  });

  it('normalizes one value to a list', () => {
    const text = read().replace('skipReason: [condition-false]', 'skipReason: condition-false');
    const flow = normalizeFlow(parseDocument(text), path.join(FLOWS, FIXTURE));

    expect(join(flow).depends.entries[0].skipReasons).toEqual(['condition-false']);
  });

  it('carries skipReason on the described edge', async () => {
    const description = await describeFlow(FIXTURE);
    const edge = description.edges.find((entry) => entry.kind === 'depends' && entry.to === 'create_payable');

    expect(edge).toEqual(expect.objectContaining({
      from: 'get_vendor',
      status: ['success', 'skipped'],
      skipReason: ['condition-false']
    }));
    expect(description.edges.find((entry) => entry.to === 'get_vendor').skipReason).toBeUndefined();
  });

  it('keeps skipReason when a step edit names another field', () => {
    const text = read();
    const result = applyFlowEdits(text, [{ kind: 'step.patch', id: 'create_payable', patch: { set: { timeout: 5000 } } }]);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('skipReason: [condition-false]');
    expect(changedLines(text, result.text).removed).toEqual([]);
  });

  it('writes skipReason when a step edit rewrites depends:', () => {
    const depends = [{ on: 'get_vendor', status: ['success', 'skipped'], skipReason: ['condition-false', 'unresolved-dependency'] }];
    const result = applyFlowEdits(read(), [{ kind: 'step.patch', id: 'create_payable', patch: { set: { depends } } }]);

    expect(result.ok).toBe(true);
    const flow = normalizeFlow(parseDocument(result.text), path.join(FLOWS, FIXTURE));
    expect(join(flow).depends.entries[0].skipReasons).toEqual(['condition-false', 'unresolved-dependency']);
  });

  it('keeps skipReason on a duplicated step', () => {
    const result = applyFlowEdits(read(), [{ kind: 'step.duplicate', id: 'create_payable', to: 'create_payable_again' }]);

    expect(result.ok).toBe(true);
    const flow = normalizeFlow(parseDocument(result.text), path.join(FLOWS, FIXTURE));
    expect(flow.steps.find((step) => step.id === 'create_payable_again').depends.entries[0].skipReasons)
      .toEqual(['condition-false']);
  });
});
