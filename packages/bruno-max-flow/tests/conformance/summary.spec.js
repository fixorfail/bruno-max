/**
 * A flow as a listing shows it — 001 §14.7's `bru flow list`, read from the file's text alone.
 *
 * These run against `meta.ts` directly, for `search.spec.js`' reason: they are properties of reading
 * the file, and nothing about a run would make them more true.
 *
 * The extraction is the engine's because §5.1 buys one parser, so the assertions worth their weight
 * are the ones the CLI could not restate for itself: that §12.5's flag is read the way the run reads
 * it, that the count is of declared steps rather than of anything resolved, and that a file which
 * does not parse is still a row.
 */
const path = require('path');

const { readFlowSummary } = require('../../src/meta');

describe('a flow as a listing shows it', () => {
  const ROOT = path.resolve('/workspace');
  const FILE = path.join(ROOT, 'flows', 'checkout.flow.yml');

  it('carries §5.2\'s identity beside the step count and the library flag', () => {
    const text = [
      'version: 1',
      'meta:',
      '  name: Checkout happy path',
      '  testId: C1000',
      '  tags: [checkout, smoke]',
      'steps:',
      '  - id: pay',
      '  - id: verify',
      ''
    ].join('\n');

    expect(readFlowSummary(ROOT, FILE, text)).toEqual({
      file: FILE,
      id: 'flows/checkout',
      name: 'Checkout happy path',
      testId: 'C1000',
      tags: ['checkout', 'smoke'],
      library: false,
      steps: 2
    });
  });

  /** §12.5's flag as `document.ts` reads it, so a listing cannot disagree with the run about it. */
  it('marks a library flow, and only one that declares the flag true', () => {
    const library = 'version: 1\nmeta:\n  library: true\nsteps:\n  - id: post\n';

    expect(readFlowSummary(ROOT, FILE, library).library).toBe(true);
    expect(readFlowSummary(ROOT, FILE, 'version: 1\nmeta:\n  library: yes please\n').library).toBe(false);
  });

  it('reads a flow carrying §5.4\'s local tags, which a plain parser calls an error', () => {
    const text = 'version: 1\nvars:\n  catalog: !file ./catalog.json\nsteps:\n  - id: pay\n';

    expect(readFlowSummary(ROOT, FILE, text).steps).toBe(1);
  });

  /**
   * Being unreadable is `validateFlow`'s finding to report, not a listing's to settle by omission —
   * so text that does not parse is a row carrying the identity its path gives it (002 §6).
   */
  it('lists a flow whose text does not parse, and one it has no text for at all', () => {
    const broken = 'version: 1\nsteps:\n  - id: a\n   bad indent\n';
    const fromPathAlone = { file: FILE, id: 'flows/checkout', name: 'checkout', tags: [], library: false, steps: 0 };

    expect(readFlowSummary(ROOT, FILE, broken)).toEqual(fromPathAlone);
    expect(readFlowSummary(ROOT, FILE)).toEqual(fromPathAlone);
  });

  /** No steps at all and a `steps:` that is not a list are the same answer: nothing to count. */
  it('counts no steps for a flow that declares none', () => {
    expect(readFlowSummary(ROOT, FILE, 'version: 1\n').steps).toBe(0);
    expect(readFlowSummary(ROOT, FILE, 'version: 1\nsteps: pay\n').steps).toBe(0);
  });
});
