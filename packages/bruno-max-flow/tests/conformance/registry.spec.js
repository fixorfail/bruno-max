const fs = require('fs');
const path = require('path');

/**
 * The conformance document and this suite name the same requirements.
 *
 * 001-C is a registry: every `### R4x — …` heading is a contract, and the `describe` that pins it
 * carries the same id. Nothing enforced that, and it drifted in both directions — three requirements
 * were written as tests and never registered, after which two *new* requirements were written
 * against ids already taken, because the document said they were free.
 *
 * An id collision is the expensive half. Two `describe`s sharing an id read as one requirement, so
 * the traceability the document exists to provide silently reports the wrong scenario.
 *
 * The exceptions are listed here and in 001-C §2, and the two lists agreeing is itself asserted —
 * an exception that stops being true should fail rather than sit in a table nobody reads.
 */

const SPEC = path.join(__dirname, '../../../../docs/specs/001-api-flows-conformance.md');
const SUITE = __dirname;

/** Registered in 001-C, deliberately not a `describe` here — see §2's table for each reason. */
const TESTED_ELSEWHERE = ['R4i', 'R4k', 'R4l'];

/** Registered in 001-C with no test anywhere. Removing one from this list is the point of it. */
const NOT_YET_PINNED = ['R4d2', 'R4m'];

const specIds = () => {
  const text = fs.readFileSync(SPEC, 'utf8');
  return [...text.matchAll(/^### ((?:R|F)[\w.]*?)[ ]/gm)].map((match) => match[1]);
};

const testIds = () => {
  const found = [];
  for (const entry of fs.readdirSync(SUITE)) {
    if (!entry.endsWith('.spec.js')) continue;
    const text = fs.readFileSync(path.join(SUITE, entry), 'utf8');
    for (const match of text.matchAll(/describe\('((?:R|F)[\w.]*?)[ ]/g)) {
      found.push({ id: match[1], file: entry });
    }
  }
  return found;
};

describe('the conformance registry', () => {
  it('has a test for every requirement it registers', () => {
    const covered = new Set([...testIds().map((entry) => entry.id), ...TESTED_ELSEWHERE, ...NOT_YET_PINNED]);
    const orphans = specIds().filter((id) => !covered.has(id));

    expect(orphans).toEqual([]);
  });

  it('registers every requirement this suite tests', () => {
    const registered = new Set(specIds());
    const unregistered = [...new Set(testIds().map((entry) => entry.id))].filter((id) => !registered.has(id));

    expect(unregistered).toEqual([]);
  });

  /**
   * The failure that cost the most: an id already in use reads as one requirement with two sets of
   * cases, and every later reader is told the wrong scenario pins it.
   *
   * **Across files, not within one.** A large requirement split into topic-named `describe`s in its
   * own file — R4q's control edges, data edges, slots and nodes — is one requirement organised for
   * reading. The same id in two *files* is the drift this catches: R4g2 named the capture's run
   * identity in one file and two unrelated things in another, and the document registered only the
   * first.
   */
  it('registers each id once, and keeps it to a single file', () => {
    const headings = specIds();
    expect(headings.filter((id, index) => headings.indexOf(id) !== index)).toEqual([]);

    const files = new Map();
    for (const { id, file } of testIds()) files.set(id, new Set([...(files.get(id) || []), file]));
    expect([...files].filter(([, where]) => where.size > 1).map(([id]) => id)).toEqual([]);
  });

  /** An exception that stopped being true is worse than no list at all. */
  it('keeps its exception lists honest', () => {
    const tested = new Set(testIds().map((entry) => entry.id));
    const registered = new Set(specIds());

    expect(TESTED_ELSEWHERE.filter((id) => tested.has(id))).toEqual([]);
    expect(NOT_YET_PINNED.filter((id) => tested.has(id))).toEqual([]);
    expect([...TESTED_ELSEWHERE, ...NOT_YET_PINNED].filter((id) => !registered.has(id))).toEqual([]);
  });
});
