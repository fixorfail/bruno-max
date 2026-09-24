/**
 * B7 — 005 §9.3's operations list, the engine's answer to "what can this step call".
 *
 * `listOperations` runs over a `SpecIndex` directly, the same one `resolveOperation` (`openapi.ts`)
 * answers a run's references against — building one here through `SpecLoader`, the way a run does,
 * is what keeps these scenarios from drifting from what the engine actually resolves. `fixtures/specs/operations/`
 * holds the documents written to exercise this file specifically; the corpus under `fixtures/specs/`
 * is 001-C's and `fixtures.spec.js` asserts every document there declares an `operationId` on every
 * operation, which the fallback and Swagger 2 cases here deliberately do not.
 *
 * `listFlowOperations` reads a flow's own text, so those scenarios build it in memory rather than
 * adding to the committed flow corpus — `fixtures.spec.js` asserts the exact set of top-level flow
 * fixtures, and a flow existing only to be read by this file has no place in that list.
 */
const fs = require('fs');
const path = require('path');

const {
  listOperations,
  listFlowOperations,
  stepRequestExample,
  resolveOperation,
  resolveSpecSource,
  SpecLoader
} = require('../../src/openapi');

const FIXTURES = path.join(__dirname, 'fixtures');
const SPECS = path.join(FIXTURES, 'specs', 'operations');

const readSpec = async (source) => ({ text: await fs.promises.readFile(source, 'utf8'), from: 'file' });

/** A `SpecIndex` for one fixture document, built the way a run builds one. */
const loadSpec = (file) => {
  const context = { runId: 'test', flow: SPECS, scope: { workspaceRoot: FIXTURES }, signal: new AbortController().signal };
  return new SpecLoader(readSpec, context).load(path.join(SPECS, file), SPECS);
};

describe('B7.1 — de-dup over the double-keyed index', () => {
  it('lists an id-bearing operation once, not once per index key', async () => {
    const spec = await loadSpec('duplicates-v1.yml');
    const listThings = listOperations(spec).filter((op) => op.operationId === 'listThings');

    expect(listThings).toHaveLength(1);
  });

  it('orders the list the way indexDocument walked paths and methods', async () => {
    const spec = await loadSpec('duplicates-v1.yml');

    expect(listOperations(spec).map((op) => op.reference)).toEqual([
      'listThings',
      'createThing',
      'POST /v1/tickets',
      'POST /v2/tickets'
    ]);
  });
});

describe('B7.2 — ambiguous from SpecIndex.duplicates', () => {
  it('marks both operations behind a twice-declared id, and neither reports it as their reference', async () => {
    const spec = await loadSpec('duplicates-v1.yml');
    const tickets = listOperations(spec).filter((op) => op.operationId === 'createTicket');

    expect(tickets).toHaveLength(2);
    expect(tickets.every((op) => op.ambiguous)).toBe(true);
    expect(tickets.map((op) => op.reference)).toEqual(['POST /v1/tickets', 'POST /v2/tickets']);
  });

  it('leaves an id declared once unmarked', async () => {
    const spec = await loadSpec('duplicates-v1.yml');
    const listThings = listOperations(spec).find((op) => op.operationId === 'listThings');

    expect(listThings.ambiguous).toBe(false);
    expect(listThings.reference).toBe('listThings');
  });
});

describe('B7.3 — summary, description, tags and deprecated read off the raw operation', () => {
  it('carries every field a fully-annotated operation declares', async () => {
    const spec = await loadSpec('duplicates-v1.yml');
    const listThings = listOperations(spec).find((op) => op.operationId === 'listThings');

    expect(listThings).toMatchObject({
      method: 'GET',
      path: '/things',
      summary: 'List things',
      description: 'Returns every thing in the account.',
      tags: ['things'],
      deprecated: false
    });
  });

  it('defaults an undeclared summary, description and tags list rather than throwing', async () => {
    const spec = await loadSpec('duplicates-v1.yml');
    const createThing = listOperations(spec).find((op) => op.operationId === 'createThing');

    expect(createThing.summary).toBeUndefined();
    expect(createThing.description).toBeUndefined();
    expect(createThing.tags).toEqual(['things', 'admin']);
    expect(createThing.deprecated).toBe(true);
  });
});

describe('B7.4 — the METHOD /template fallback for a document with no operationId', () => {
  it('offers the method-and-path form for every operation', async () => {
    const spec = await loadSpec('no-ids-v1.yml');
    const operations = listOperations(spec);

    expect(operations.map((op) => ({ reference: op.reference, operationId: op.operationId, ambiguous: op.ambiguous }))).toEqual([
      { reference: 'GET /legacy/widgets', operationId: undefined, ambiguous: false },
      { reference: 'POST /legacy/widgets', operationId: undefined, ambiguous: false }
    ]);
  });

  /**
   * §9.3's contract promise: the reference is exactly what `resolveOperation`'s `asEndpoint` will
   * accept back. Asserting the round trip, rather than the string shape alone, is what would catch
   * `listOperations` and `endpointKey`'s normalization disagreeing about what a reference means.
   */
  it('round-trips through resolveOperation to the same operation', async () => {
    const spec = await loadSpec('no-ids-v1.yml');

    for (const operation of listOperations(spec)) {
      const resolved = resolveOperation(spec, operation.reference);

      expect(resolved).not.toBe('ambiguous');
      expect(resolved).not.toBeUndefined();
      expect(resolved.method).toBe(operation.method);
      expect(resolved.template).toBe(operation.path);
    }
  });
});

describe('B7.5 — Swagger 2 and OpenAPI 3 index the same way', () => {
  it('reads a Swagger 2 document\'s operations exactly as it would an OpenAPI 3 one', async () => {
    const spec = await loadSpec('swagger2-v1.yml');

    expect(listOperations(spec)).toEqual([
      {
        reference: 'listInvoices',
        operationId: 'listInvoices',
        method: 'GET',
        path: '/invoices',
        summary: 'List invoices',
        description: undefined,
        tags: ['invoices'],
        deprecated: false,
        ambiguous: false
      },
      {
        reference: 'createInvoice',
        operationId: 'createInvoice',
        method: 'POST',
        path: '/invoices',
        summary: undefined,
        description: undefined,
        tags: ['invoices'],
        deprecated: true,
        ambiguous: false
      }
    ]);
  });
});

/**
 * `listFlowOperations` reads a flow's own text through `options.ports.readFile` rather than a
 * committed fixture, so the entry path only has to resolve `apis:` sources against its directory —
 * it never has to exist on disk itself, which is what lets these scenarios build the flow in memory.
 */
describe('B7.6 — listFlowOperations resolves with a per-binding error, not a rejected promise', () => {
  const entry = path.join(FIXTURES, 'flows', 'operations', 'synthetic.flow.yml');
  const flow = ['version: 1', 'apis:', '  ops: ../../specs/operations/no-ids-v1.yml', '  broken: ./missing-doc.yml', ''].join(
    '\n'
  );

  const ports = {
    readFile: async (target) => (target === entry ? Buffer.from(flow) : fs.promises.readFile(target)),
    readSpec
  };

  it('reports the readable binding\'s operations and the unreadable one\'s error side by side', async () => {
    const result = await listFlowOperations({ entry, scope: { workspaceRoot: FIXTURES }, ports });

    expect(result.apis).toHaveLength(2);

    const [ops, broken] = result.apis;
    expect(ops.alias).toBe('ops');
    expect(ops.source).toBe('../../specs/operations/no-ids-v1.yml');
    expect(ops.resolved).toBe(resolveSpecSource(ops.source, entry));
    expect(ops.error).toBeUndefined();
    expect(ops.operations.map((op) => op.reference)).toEqual(['GET /legacy/widgets', 'POST /legacy/widgets']);

    expect(broken.alias).toBe('broken');
    expect(broken.source).toBe('./missing-doc.yml');
    expect(broken.resolved).toBeUndefined();
    expect(typeof broken.error).toBe('string');
    expect(broken.operations).toEqual([]);
  });
});

describe('B7.7 — an unparseable flow yields no apis rather than throwing', () => {
  it('resolves to an empty list for a document that does not parse', async () => {
    const entry = path.join(FIXTURES, 'flows', 'operations', 'broken.flow.yml');
    const flow = ['version: 1', 'apis:', '  broken: [unclosed', ''].join('\n');
    const ports = { readFile: async () => Buffer.from(flow), readSpec };

    await expect(listFlowOperations({ entry, scope: { workspaceRoot: FIXTURES }, ports })).resolves.toEqual({ apis: [] });
  });
});

/**
 * B4.6 — 005 §6.7's *Seed from spec* control: the operation's own request example, resolved the
 * same way a run resolves it, and a reason rather than a schema-derived guess when there is none.
 *
 * A flow built in memory, for `listFlowOperations`'s reason above — `stepRequestExample` reads the
 * flow's text through the port, so the entry path only has to resolve `apis:` against its directory.
 */
describe('B4.6 — the request example the spec declares', () => {
  const entry = path.join(FIXTURES, 'flows', 'operations', 'seed-from-spec.flow.yml');
  const flow = [
    'version: 1',
    'apis:',
    '  payments: ../../specs/operations/request-example-v1.yml',
    'steps:',
    '  - id: charge',
    '    operation: payments#createCharge',
    '  - id: refund',
    '    operation: payments#createRefund',
    '  - id: login',
    '    uses: ./login.flow.yml',
    ''
  ].join('\n');

  const ports = {
    readFile: async (target) => (target === entry ? Buffer.from(flow) : fs.promises.readFile(target)),
    readSpec
  };

  const seed = (stepId) => stepRequestExample({ entry, scope: { workspaceRoot: FIXTURES }, ports, stepId });

  it('replaces the body with the example the operation declares', async () => {
    await expect(seed('charge')).resolves.toEqual({
      example: { amount: 900, currency: 'usd' },
      mediaType: 'application/json'
    });
  });

  it('says so, and returns no example, for an operation that declares none', async () => {
    await expect(seed('refund')).resolves.toEqual({ reason: 'no-example' });
  });

  it('refuses a uses: step, which sends nothing of its own', async () => {
    await expect(seed('login')).resolves.toEqual({ reason: 'not-an-operation' });
  });

  it('refuses a step id the flow does not have', async () => {
    await expect(seed('missing')).resolves.toEqual({ reason: 'no-such-step' });
  });
});
