/**
 * The registry of 006-C, beside 005-C's — the same assertion over the scenarios of the loops.
 *
 * The scenarios are in seven files: two of the engine (`loops.spec.js`, `loops-validation.spec.js`),
 * one of the console (`bruno-cli/tests/fork/flow/output.spec.js`), one of the host
 * (`bruno-electron/src/ipc/flow/index.spec.js`) and three of the app. Each test cites its `L…` id.
 * A scenario that no test cites is a scenario that nothing pins. An id that 006-C does not register
 * is a test that pins nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SPEC = path.join(ROOT, 'docs', 'specs', '006-step-loops-conformance.md');

/** Where an `L…` id can be cited. */
const SEARCHED = [
  path.join(__dirname, 'loops.spec.js'),
  path.join(__dirname, 'loops-validation.spec.js'),
  path.join(ROOT, 'packages', 'bruno-cli', 'tests', 'fork', 'flow', 'output.spec.js'),
  path.join(ROOT, 'packages', 'bruno-electron', 'src', 'ipc', 'flow', 'index.spec.js'),
  path.join(ROOT, 'packages', 'bruno-app', 'src', 'fork', 'flows', 'slice.spec.js'),
  path.join(ROOT, 'packages', 'bruno-app', 'src', 'fork', 'flows', 'FlowTabPane', 'StepDetail', 'index.spec.js'),
  path.join(ROOT, 'packages', 'bruno-app', 'src', 'fork', 'flows', 'FlowTabPane', 'FlowGraph', 'index.spec.js')
];

const specIds = () => [...fs.readFileSync(SPEC, 'utf8').matchAll(/^### (L[\w.]*?)[ —]/gm)].map((match) => match[1]);

const corpus = () => SEARCHED.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

/** The ids that a test declares, as `describe('L1.1 — …')`. */
const testIds = () => [...corpus().matchAll(/describe\('(L[\w.]*?)[ —]/g)].map((match) => match[1]);

describe('the 006-C registry', () => {
  it('finds the scenarios it expects to find, so a moved suite fails loudly', () => {
    expect(specIds().length).toBeGreaterThan(40);
    expect(corpus().length).toBeGreaterThan(10000);
  });

  it('has a test for every scenario', () => {
    const declared = new Set(testIds());

    expect(specIds().filter((id) => !declared.has(id))).toEqual([]);
  });

  it('has a scenario for every test', () => {
    const registered = new Set(specIds());

    expect([...new Set(testIds())].filter((id) => !registered.has(id))).toEqual([]);
  });

  it('registers each scenario once', () => {
    const ids = specIds();

    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});
