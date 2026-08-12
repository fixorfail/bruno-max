/**
 * A guard on the fixture corpus, not one of 001-C's scenario specs.
 *
 * The corpus is the artifact (001-C §2), and it has to stay resolvable while the engine that will
 * run it does not exist yet. These checks are the subset of §14.3 that needs no execution: aliases
 * resolve, operations exist in the bound document, `uses:` targets and their params line up, step
 * ids satisfy §5.3.
 *
 * F1.4 lives here too, because it is specified as a static assertion with no execution.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const FIXTURES = path.join(__dirname, 'fixtures');
const FLOWS = path.join(FIXTURES, 'flows');
const SPECS = path.join(FIXTURES, 'specs');

/**
 * §5.4's resolved form: the local tags become values with identity, never marker objects — a body
 * may legitimately contain any key, so shape cannot be what distinguishes a tag from data.
 */
const DROP = Symbol('bruno.flow.drop');

class FileRef {
  constructor(data) {
    Object.assign(this, typeof data === 'string' ? { path: data } : data);
  }
}

const SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!file', { kind: 'scalar', construct: (data) => new FileRef(data) }),
  new yaml.Type('!file', { kind: 'mapping', construct: (data) => new FileRef(data) }),
  new yaml.Type('!...', { kind: 'scalar', construct: () => DROP })
]);

const load = (file) => yaml.load(fs.readFileSync(file, 'utf8'), { schema: SCHEMA });

const operationIds = (spec) => {
  const ids = new Set();
  for (const item of Object.values(spec.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (method !== 'parameters' && op && op.operationId) {
        ids.add(op.operationId);
      }
    }
  }
  return ids;
};

const flowFiles = fs.readdirSync(FLOWS).filter((f) => f.endsWith('.flow.yml'));
const specFiles = fs.readdirSync(SPECS).filter((f) => f.endsWith('.yml'));

describe('fixture corpus', () => {
  it('has the flows 001-C names', () => {
    expect(flowFiles.sort()).toEqual([
      'f1-role-matrix.flow.yml',
      'f2-login.flow.yml',
      'f2-order-fulfillment.flow.yml',
      'f3-batch-settlement.flow.yml',
      'f4-partner-acceptance.flow.yml',
      'f4-tenant-parent.flow.yml',
      'f4-workspace-session.flow.yml'
    ]);
  });

  describe.each(specFiles)('%s', (file) => {
    it('parses and declares an operationId for every operation', () => {
      const spec = load(path.join(SPECS, file));
      expect(spec.openapi).toMatch(/^3\./);
      for (const [route, item] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(item)) {
          if (method === 'parameters') continue;
          expect(`${method} ${route}: ${op.operationId}`).toEqual(expect.stringMatching(/: \w+$/));
        }
      }
    });
  });

  describe.each(flowFiles)('%s', (file) => {
    const flow = load(path.join(FLOWS, file));
    const dir = path.dirname(path.join(FLOWS, file));

    it('declares version 1', () => {
      expect(flow.version).toBe(1);
    });

    it('binds apis: that exist on disk', () => {
      for (const binding of Object.values(flow.apis || {})) {
        const source = typeof binding === 'string' ? binding : binding.source;
        expect(fs.existsSync(path.resolve(dir, source))).toBe(true);
      }
    });

    it('has unique step ids matching §5.3', () => {
      const ids = (flow.steps || []).map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
      }
    });

    it('resolves every operation: against its bound document', () => {
      const specs = {};
      for (const [alias, binding] of Object.entries(flow.apis || {})) {
        const source = typeof binding === 'string' ? binding : binding.source;
        specs[alias] = operationIds(load(path.resolve(dir, source)));
      }
      for (const step of flow.steps || []) {
        if (!step.operation) continue;
        const [alias, operationId] = String(step.operation).split('#');
        expect(Object.keys(specs)).toContain(alias);
        expect([...specs[alias]]).toContain(operationId);
      }
    });

    it('declares either operation: or uses:, never both', () => {
      for (const step of flow.steps || []) {
        expect(Boolean(step.operation && step.uses)).toBe(false);
        expect(Boolean(step.body && step.bodyFile)).toBe(false);
      }
    });

    it('passes only declared params at each uses: call site', () => {
      for (const step of flow.steps || []) {
        if (!step.uses) continue;
        const target = path.resolve(dir, step.uses);
        expect(fs.existsSync(target)).toBe(true);
        const sub = load(target);
        const declared = Object.keys(sub.params || {});
        for (const key of Object.keys(step.with || {})) {
          expect(declared).toContain(key);
        }
        for (const [name, def] of Object.entries(sub.params || {})) {
          if (def && def.required && def.default === undefined) {
            expect(Object.keys(step.with || {})).toContain(name);
          }
        }
      }
    });

    it('depends: only on steps in the same flow', () => {
      const ids = new Set((flow.steps || []).map((s) => s.id));
      for (const step of flow.steps || []) {
        const list = Array.isArray(step.depends)
          ? step.depends
          : step.depends
            ? step.depends.all || step.depends.any || []
            : [];
        for (const entry of list) {
          expect(ids).toContain(typeof entry === 'string' ? entry : entry.on);
        }
      }
    });

    it('writes only slots declared at flow level', () => {
      const slots = flow.shared || [];
      for (const step of flow.steps || []) {
        const written = Array.isArray(step.shared)
          ? step.shared
          : step.shared
            ? Object.keys(step.shared)
            : [];
        for (const slot of written) {
          expect(slots).toContain(slot);
        }
      }
    });

    it('names a real internal step in every exports: entry', () => {
      const ids = new Set((flow.steps || []).map((s) => s.id));
      for (const ref of Object.values(flow.exports || {})) {
        const match = String(ref).match(/^steps\.([^.]+)\./);
        if (match) {
          expect(ids).toContain(match[1]);
        }
      }
    });
  });
});

describe('F1.4 — an inserted branch does not rewire the sequence', () => {
  const flow = load(path.join(FLOWS, 'f1-role-matrix.flow.yml'));
  const step = (id) => flow.steps.find((s) => s.id === id);

  it('keeps get_product explicitly parented to add_product', () => {
    // Finding 2: `add_product_denied` sits between them in the file, so without this explicit
    // edge §9.1's implicit-sequence rule makes it the parent — a flow that is valid, runs, and
    // tests the inverse of what it says.
    expect(step('get_product').depends).toEqual(['add_product']);
  });

  it('keeps add_product_denied explicitly parented to me', () => {
    expect(step('add_product_denied').depends).toEqual(['me']);
  });

  it('keeps the two branches mutually exclusive on the row', () => {
    expect(step('add_product').when).toBe('row.canCreate eq true');
    expect(step('add_product_denied').when).toBe('row.canCreate eq false');
  });

  it('lets cleanup_leak accept every terminal outcome of the step it cleans up after', () => {
    expect(step('cleanup_leak').depends).toEqual([
      { on: 'add_product_denied', status: ['success', 'failed', 'skipped', 'cancelled'] }
    ]);
    // §11.2: nothing leaked on a passing run, so skipping is the intended outcome.
    expect(step('cleanup_leak').failOnUnresolved).toBe(false);
  });
});
