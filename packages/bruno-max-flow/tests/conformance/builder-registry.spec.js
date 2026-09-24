/**
 * 005-C's registry, beside 002-C's — the same two-way assertion over the builder's scenarios.
 *
 * 005-C's scenarios are spread across three suites: the engine's own (`edit-*.spec.js`,
 * `operations.spec.js`), the hosts' (`bruno-app/src/fork`, `bruno-electron/src/ipc/flow`), and the
 * e2e (`tests/flows/designer.spec.ts`). Most cite their `B…` id; the ones that cite a section instead
 * are listed here as traceability gaps, and the list can only shrink.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SPEC = path.join(ROOT, 'docs', 'specs', '005-api-flow-builder-conformance.md');

/** Where a `B…` id can be cited. */
const SEARCHED = [
  __dirname,
  path.join(ROOT, 'tests', 'flows'),
  path.join(ROOT, 'packages', 'bruno-app', 'src', 'fork'),
  path.join(ROOT, 'packages', 'bruno-electron', 'src', 'ipc', 'flow')
];

/**
 * Scenarios covered by a test that cites its spec section rather than its id. An entry leaves by a
 * test citing the id, not by being deleted here.
 */
const UNCITED = [];

const specIds = () => [...fs.readFileSync(SPEC, 'utf8').matchAll(/^### (B[\w.]*?)[ —]/gm)].map((match) => match[1]);

const corpus = () => {
  const collected = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && entry.name !== 'builder-registry.spec.js') {
        collected.push(fs.readFileSync(target, 'utf8'));
      }
    }
  };
  for (const root of SEARCHED) walk(root);
  return collected.join('\n');
};

describe('the 005-C registry', () => {
  const cites = (text, id) => new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`).test(text);

  it('finds the scenarios it expects to find, so a moved suite fails loudly', () => {
    expect(specIds().length).toBeGreaterThan(40);
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

  it('holds no scenario in UNCITED that 005-C no longer registers', () => {
    const registered = new Set(specIds());
    const stale = UNCITED.filter((id) => !registered.has(id));

    expect(stale).toEqual([]);
  });
});
