/**
 * Selecting flows by pattern — the terms a flow is matchable on (001 §5.2, §5.3), and the rule a
 * host's pattern is applied with.
 *
 * These run against `search.ts` directly, for `meta.spec.js`' reason: they are properties of reading
 * the file, and nothing about a run would make them more true.
 *
 * The extraction is one implementation because `bru flow run --grep` and the app's search box must
 * agree on it, so the assertions worth their weight are the ones a host could not restate for
 * itself: that a key of `meta:` is not a term, that a document with errors still yields the terms
 * its path carries, and that a filter compiled once survives being applied down a list.
 */
const path = require('path');

const { flowSearchTerms, flowMatches } = require('../../src/search');

const ROOT = path.resolve('/workspace');
const FILE = path.join(ROOT, 'flows', 'checkout.flow.yml');

describe('the terms a flow can be matched on', () => {
  it('carries §5.2\'s identity — the path-derived id, the name, every tag and the case id', () => {
    const text = [
      'version: 1',
      'meta:',
      '  name: Checkout happy path',
      '  testId: C1000',
      '  tags: [checkout, smoke]',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text).sort()).toEqual(
      ['C1000', 'Checkout happy path', 'checkout', 'flows/checkout', 'smoke'].sort()
    );
  });

  /**
   * The absolute path is not among them on purpose: it carries the machine's directory layout, so a
   * pattern matching a segment of the user's home directory would select every flow in the
   * workspace. `id` is the path a flow is named by.
   */
  it('does not carry the flow\'s absolute path', () => {
    const terms = flowSearchTerms(ROOT, FILE, 'version: 1\n');

    expect(terms).not.toContain(FILE);
    expect(terms).toContain('flows/checkout');
  });

  /** A flow that will not parse is still findable by the name and path it already has (002 §6). */
  it('yields the path-derived terms alone for text that does not parse, and for no text at all', () => {
    const broken = 'version: 1\nmeta:\n  name: Checkout\nsteps:\n  - id: a\n   bad indent\n';

    expect(flowSearchTerms(ROOT, FILE, broken)).toEqual(['flows/checkout', 'checkout']);
    expect(flowSearchTerms(ROOT, FILE)).toEqual(['flows/checkout', 'checkout']);
  });

  it('reads a flow carrying §5.4\'s local tags, which a plain parser calls an error', () => {
    const text = [
      'version: 1',
      'vars:',
      '  catalog: !file ./catalog.json',
      'steps:',
      '  - id: charge',
      '    name: Charge the card',
      '    body:',
      '      note: !...',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text)).toContain('Charge the card');
  });

  it('carries each step\'s id and name', () => {
    const text = [
      'version: 1',
      'steps:',
      '  - id: login',
      '    name: Sign the buyer in',
      '  - id: charge',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text)).toEqual(
      expect.arrayContaining(['login', 'Sign the buyer in', 'charge'])
    );
  });

  /**
   * §5.3's `meta:` is open, so its keys are vocabulary rather than content — a pattern matching them
   * would select every flow written for the same tracker.
   */
  it('carries every scalar of a step\'s meta at any depth, and none of its keys', () => {
    const text = [
      'version: 1',
      'steps:',
      '  - id: charge',
      '    meta:',
      '      testId: C-42',
      '      priority: 1',
      '      owners: [payments, risk]',
      '      jira:',
      '        key: PAY-7',
      ''
    ].join('\n');

    const terms = flowSearchTerms(ROOT, FILE, text);

    expect(terms).toEqual(expect.arrayContaining(['C-42', '1', 'payments', 'risk', 'PAY-7']));
    expect(terms).not.toContain('testId');
    expect(terms).not.toContain('jira');
    expect(terms).not.toContain('owners');
  });

  /**
   * A sub-flow's steps live in another file, which is itself a flow with terms of its own — and
   * reaching them would mean reading a file, which a listing over a whole workspace cannot afford.
   */
  it('does not reach into a sub-flow the step uses', () => {
    const text = [
      'version: 1',
      'steps:',
      '  - id: session',
      '    uses: ./workspace-session.flow.yml',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text)).toEqual(['flows/checkout', 'checkout', 'session']);
  });

  /** The list ships over IPC once per flow and is scanned per keystroke; a tag on twenty steps is one term. */
  it('deduplicates, and drops blank terms', () => {
    const text = [
      'version: 1',
      'meta:',
      '  tags: [smoke]',
      'steps:',
      '  - id: a',
      '    name: "   "',
      '    meta:',
      '      suite: smoke',
      '      note: ""',
      '      absent:',
      '  - id: b',
      '    meta:',
      '      suite: smoke',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text)).toEqual(['flows/checkout', 'checkout', 'smoke', 'a', 'b']);
  });

  /** An anchor may point at one of its own ancestors, and a walk into that would hang the listing. */
  it('terminates on a document whose anchor refers to itself', () => {
    const text = [
      'version: 1',
      'steps:',
      '  - id: a',
      '    meta: &cycle',
      '      suite: smoke',
      '      self: *cycle',
      ''
    ].join('\n');

    expect(flowSearchTerms(ROOT, FILE, text)).toEqual(['flows/checkout', 'checkout', 'a', 'smoke']);
  });
});

describe('matching a flow against a host\'s pattern', () => {
  const TERMS = ['flows/checkout', 'Checkout happy path', 'smoke', 'slow'];

  it('selects a flow when grep matches any one of its terms', () => {
    expect(flowMatches(TERMS, { grep: /smoke/ })).toBe(true);
    expect(flowMatches(TERMS, { grep: /happy/ })).toBe(true);
    expect(flowMatches(TERMS, { grep: /settlement/ })).toBe(false);
  });

  it('excludes a flow when grepInvert matches any one of them', () => {
    expect(flowMatches(TERMS, { grepInvert: /slow/ })).toBe(false);
    expect(flowMatches(TERMS, { grepInvert: /settlement/ })).toBe(true);
  });

  /** The only reading under which adding an exclusion can never widen a selection. */
  it('excludes a flow that matches both patterns', () => {
    expect(flowMatches(TERMS, { grep: /checkout/i, grepInvert: /slow/ })).toBe(false);
  });

  it('matches everything when a filter is absent, and nothing when a flow has no terms', () => {
    expect(flowMatches(TERMS, {})).toBe(true);
    expect(flowMatches([], {})).toBe(true);
    expect(flowMatches([], { grep: /anything/ })).toBe(false);
    expect(flowMatches([], { grepInvert: /anything/ })).toBe(true);
  });

  /**
   * The case fold is the host's — the CLI compiles `--grep` with `i` — so this only has to leave the
   * flags it was handed alone.
   */
  it('applies the pattern exactly as the host compiled it', () => {
    expect(flowMatches(TERMS, { grep: /CHECKOUT/ })).toBe(false);
    expect(flowMatches(TERMS, { grep: /CHECKOUT/i })).toBe(true);
  });

  /**
   * A host compiles its pattern once and applies it to every flow in the listing. `.test()` on a
   * `/g` pattern resumes from the previous match, so the second flow would be matched from the
   * middle of its terms — an intermittently empty run, or a sidebar that hides a row that matches.
   */
  it('is unaffected by a pattern compiled with the global flag, and leaves it as it found it', () => {
    const grep = /smoke/g;

    expect(flowMatches(TERMS, { grep })).toBe(true);
    expect(flowMatches(TERMS, { grep })).toBe(true);
    expect(flowMatches(['smoke', 'smoke'], { grep })).toBe(true);
    expect(grep.lastIndex).toBe(0);
  });
});
