/**
 * Moving a flow — 002 §4.1d's rewrite of the paths the moved flow writes.
 *
 * These run against `relocate.ts` directly, for `meta.spec.js`' reason: they are properties of
 * rewriting the file, and nothing about a run would make them more true. The round-trip assertions
 * carry the weight — a committed, hand-edited file must come back with its paths changed and
 * nothing else moved.
 */
const path = require('path');

const { rebaseFlowPaths } = require('../../src/relocate');

const ROOT = path.resolve('/workspace/flows');
const FROM = path.join(ROOT, 'checkout.flow.yml');
const DEEPER = path.join(ROOT, 'payments', 'checkout.flow.yml');

const flow = (...lines) => [...lines, ''].join('\n');

describe('rebasing a moved flow\'s paths', () => {
  it('rewrites every position a path is written in', () => {
    const text = flow(
      'version: 1',
      'apis:',
      '  short: ../apispec/payments.yml',
      '  long:',
      '    source: ../apispec/ledger.yml',
      '    baseUrl: https://ledger.example.com',
      'functions:',
      '  use: [scripts/auth.js, ./scripts/money.js]',
      'dataset:',
      '  source: fixtures/cases.csv',
      '  parallel: 2',
      'steps:',
      '  - id: login',
      '    uses: auth/login.flow.yml',
      '  - id: upload',
      '    operation: short.upload',
      '    bodyFile: fixtures/invoice.pdf',
      '    body:',
      '      customer: !file fixtures/customer.json',
      '      document: !file { path: fixtures/terms.pdf, contentType: application/pdf }'
    );

    expect(rebaseFlowPaths(text, FROM, DEEPER)).toBe(flow(
      'version: 1',
      'apis:',
      '  short: ../../apispec/payments.yml',
      '  long:',
      '    source: ../../apispec/ledger.yml',
      '    baseUrl: https://ledger.example.com',
      'functions:',
      '  use: [ ../scripts/auth.js, ../scripts/money.js ]',
      'dataset:',
      '  source: ../fixtures/cases.csv',
      '  parallel: 2',
      'steps:',
      '  - id: login',
      '    uses: ../auth/login.flow.yml',
      '  - id: upload',
      '    operation: short.upload',
      '    bodyFile: ../fixtures/invoice.pdf',
      '    body:',
      '      customer: !file ../fixtures/customer.json',
      '      document: !file { path: ../fixtures/terms.pdf, contentType: application/pdf }'
    ));
  });

  it('shortens a path when the flow moves towards what it names', () => {
    const text = flow('version: 1', 'functions:', '  use: ../scripts/auth.js');

    expect(rebaseFlowPaths(text, DEEPER, FROM)).toBe(flow('version: 1', 'functions:', '  use: scripts/auth.js'));
  });

  it('keeps a `./` the author wrote while the path still needs no `../`', () => {
    const text = flow('version: 1', 'dataset: ./payments/cases.csv');

    expect(rebaseFlowPaths(text, FROM, DEEPER)).toBe(flow('version: 1', 'dataset: ./cases.csv'));
  });

  /** Each of these names the same file from any directory, or one only a run can resolve. */
  it('leaves URLs, workspace paths, absolute paths and interpolated paths as written', () => {
    const text = flow(
      'version: 1',
      'apis:',
      '  remote: https://api.example.com/openapi.yml',
      '  pinned: /srv/specs/payments.yml',
      'steps:',
      '  - id: shared',
      '    uses: workspace:flows/auth/login.flow.yml',
      '  - id: upload',
      '    operation: remote.upload',
      '    bodyFile: "{{vars.fixture}}"'
    );

    expect(rebaseFlowPaths(text, FROM, DEEPER)).toBe(text);
  });

  it('preserves comments, quoting and everything the move does not name', () => {
    const text = flow(
      'version: 1',
      '# the checkout suite',
      'meta:',
      '  name: Checkout # shown in the sidebar',
      'apis:',
      '  payments: "../apispec/payments.yml"',
      'steps:',
      '  - id: pay',
      '    operation: payments.create'
    );

    expect(rebaseFlowPaths(text, FROM, DEEPER)).toBe(flow(
      'version: 1',
      '# the checkout suite',
      'meta:',
      '  name: Checkout # shown in the sidebar',
      'apis:',
      '  payments: "../../apispec/payments.yml"',
      'steps:',
      '  - id: pay',
      '    operation: payments.create'
    ));
  });

  it('returns the text unchanged when the directory does not change', () => {
    const text = flow('version: 1', 'dataset:    cases.csv');

    expect(rebaseFlowPaths(text, FROM, path.join(ROOT, 'renamed.flow.yml'))).toBe(text);
  });

  it('refuses text that does not parse', () => {
    expect(rebaseFlowPaths('steps: [\n', FROM, DEEPER)).toBeUndefined();
  });
});
