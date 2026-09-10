/**
 * 002-C's registry, the counterpart to `registry.spec.js`.
 *
 * 001-C's scenarios are top-level describe blocks in this suite, each titled with its own id, so
 * that registry matches ids to tests directly. 002-C's are not: its scenarios are Playwright specs
 * under `tests/flows/` and jest specs beside the components in `bruno-app` and `bruno-electron`,
 * and most of them cite the spec
 * *section* they implement rather than the `U…` id. That is not wrong — a component test naming
 * §4.1 is more useful to the next reader than one naming `U4.15` — but it leaves no mechanical
 * trace, and a scenario nobody implements looks exactly like one implemented under a section name.
 *
 * So this asserts the traceable set rather than the covered set, in two directions:
 *
 * - No id outside `UNCITED` may lose its citation. That is the regression guard.
 * - No id *inside* `UNCITED` may have gained one without leaving the list. That is what stops the
 *   list going stale, which is the failure mode every allowlist has.
 *
 * Shrinking `UNCITED` is the point of it. An entry leaves by a test citing its id, not by being
 * deleted here.
 *
 * This lives beside 001-C's registry rather than in the packages it scans, so the two registries are
 * read together. It only *reads* those trees — the engine imports neither host (001 §13.1).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SPEC = path.join(ROOT, 'docs', 'specs', '002-api-flows-ui-conformance.md');

/** Where a `U…` id can be cited: the e2e suite, and the two hosts' own specs. */
const SEARCHED = [
  path.join(ROOT, 'tests', 'flows'),
  path.join(ROOT, 'packages', 'bruno-app', 'src', 'fork'),
  path.join(ROOT, 'packages', 'bruno-electron', 'src', 'ipc', 'flow')
];

/**
 * Scenarios covered by a test that cites its spec section instead of its id. Every entry here is a
 * traceability gap and not a coverage gap — adding the id to the test that already implements it is
 * what removes the entry.
 */
const UNCITED = [
  'U1.2', 'U1.7a', 'U1.8a', 'U1.8b', 'U1.9a', 'U1.9c', 'U1.9d', 'U1.11',
  'U2.4d', 'U2.4e', 'U2.9', 'U2.12', 'U2.13', 'U2.14', 'U2.15',
  'U3.7',
  'U4.2', 'U4.3', 'U4.4a', 'U4.4b', 'U4.4c', 'U4.9', 'U4.9a', 'U4.10a', 'U4.10b',
  'U4.12', 'U4.13', 'U4.14', 'U4.15', 'U4.15a', 'U4.15b', 'U4.15c', 'U4.16', 'U4.16a',
  'U4.17', 'U4.18a', 'U4.19', 'U4.19a', 'U4.20', 'U4.21',
  'U5.2', 'U5.6', 'U5.6a', 'U5.6b', 'U5.6c', 'U5.7', 'U5.7a', 'U5.14',
  'U6.2', 'U6.3', 'U6.9', 'U6.10', 'U6.11'
];

const specIds = () => [...fs.readFileSync(SPEC, 'utf8').matchAll(/^### (U[\w.]*?)[ —]/gm)].map((match) => match[1]);

const corpus = () => {
  const collected = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) collected.push(fs.readFileSync(target, 'utf8'));
    }
  };
  for (const root of SEARCHED) walk(root);
  return collected.join('\n');
};

describe('the 002-C registry', () => {
  const cites = (text, id) => new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`).test(text);

  it('finds the scenarios it expects to find, so a moved suite fails loudly', () => {
    // Guards the whole file: a rename that emptied the search would otherwise make every
    // assertion below pass by finding nothing anywhere.
    expect(specIds().length).toBeGreaterThan(100);
    expect(corpus().length).toBeGreaterThan(10000);
  });

  it('keeps a citation for every scenario that has one', () => {
    const text = corpus();
    const lost = specIds().filter((id) => !UNCITED.includes(id) && !cites(text, id));

    expect(lost).toEqual([]);
  });

  it('holds no scenario in UNCITED that a test now cites', () => {
    const text = corpus();
    const arrived = UNCITED.filter((id) => cites(text, id));

    expect(arrived).toEqual([]);
  });

  it('holds no scenario in UNCITED that 002-C no longer registers', () => {
    const registered = new Set(specIds());
    const stale = UNCITED.filter((id) => !registered.has(id));

    expect(stale).toEqual([]);
  });
});
