/**
 * R10 — §8.5's reusable connectors (001-C §7).
 *
 * The fixture tree under `fixtures/flows/connectors/` is a workspace with a collection inside it:
 *
 *   connectors/                                  # WORKSPACE root
 *     flows/connectors.yml                       #   signIn: token, role · getThing: thingId, title
 *     flows/shared/login.flow.yml                #   a library flow whose exports are connector-supplied
 *     collections/payments/                      # COLLECTION root
 *       flows/connectors.yml                     #   getThing: title (overridden), thingName · signIn: role !...
 *       flows/*.flow.yml                         #   the flows under test
 *
 * Every file binds the one document under a different alias — `regress-api`, `things`, `svc` — which
 * is the whole of §8.5's matching rule: by the document an alias resolves to, never by the alias.
 * The broken files `bru flow validate` has to name are served from memory over the collection file's
 * own path, so what a check reports is the edit and not the fixture.
 */
const fs = require('fs');
const path = require('path');

const engine = require('../../src');
const { describeFlow, runFlow, validate, variant, FLOWS } = require('./harness');

const WORKSPACE_ROOT = path.join(FLOWS, 'connectors');
const COLLECTION_ROOT = path.join(WORKSPACE_ROOT, 'collections', 'payments');
const SCOPE = { workspaceRoot: WORKSPACE_ROOT, collectionRoot: COLLECTION_ROOT };

const WORKSPACE_FILE = path.join(WORKSPACE_ROOT, 'flows', 'connectors.yml');
const COLLECTION_FILE = path.join(COLLECTION_ROOT, 'flows', 'connectors.yml');

const flow = (name) => `connectors/collections/payments/flows/${name}`;
const flowFile = (name) => path.join(COLLECTION_ROOT, 'flows', name);

const SIGNED_IN = { status: 200, body: { data: { token: 'tok-1', role: 'admin' } } };
const THING = { status: 200, body: { data: { id: 'thing-1', name: 'Widget' } } };
const CREATED = { status: 201, body: { data: { id: 'thing-2' } } };
const RESPONSES = { signIn: SIGNED_IN, getThing: THING, createThing: CREATED };

const outputsOf = (run, id) => run.result.iterations[0].steps.find((step) => step.id === id).outputs;
const node = (description, id) => description.nodes.find((entry) => entry.id === id);
const of = (diagnostics, code) => diagnostics.filter((entry) => entry.code === code);

/** The collection connector file replaced, in memory, with `text`. */
const collectionFile = (text) => ({ [COLLECTION_FILE]: text });

/**
 * `variant()` over the text rather than the model, for the one fixture that carries `!...`: the
 * harness deliberately refuses to re-serialize a tag, so the edit is made where the tag survives.
 */
const textVariant = (name, edit) => {
  const source = flowFile(name);
  const entry = source.replace(/\.flow\.yml$/, '.variant.flow.yml');
  return { entry, files: { [entry]: edit(fs.readFileSync(source, 'utf8')) } };
};

/** §8.5's listing, over the same two ports `validate()` uses — the harness has no wrapper for it. */
const resolveOutputs = (entry, options = {}) =>
  engine.resolveOutputs({
    entry,
    scope: SCOPE,
    ports: {
      readFile: async (target) => {
        if (options.files && options.files[target] !== undefined) return Buffer.from(options.files[target]);
        return fs.promises.readFile(target);
      },
      readSpec: async (source) => ({ text: await fs.promises.readFile(source, 'utf8'), from: 'file' })
    }
  });

describe('R10.1 — A connector file supplies an operation\'s outputs', () => {
  it('publishes connector-supplied outputs from a step with no outputs: block', async () => {
    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.result.status).toBe('passed');
    expect(outputsOf(run, 'sign_in')).toEqual({ token: 'tok-1' });
    expect(outputsOf(run, 'get_thing')).toEqual({ thingId: 'thing-1', title: 'Widget', thingName: 'Widget' });
  });

  it('lets a later step read them exactly as it reads a declared output', async () => {
    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.call('createThing').json).toEqual({ name: 'Widget', ref: 'thing-1' });
    // The auth profile reads `{{steps.sign_in.token}}`, which only a connector file declared.
    expect(run.call('getThing').auth).toEqual(expect.objectContaining({ mode: 'bearer' }));
  });

  it('validates clean: the references are declared, and nothing is unused or undeclared', async () => {
    expect(await validate(flow('inherit.flow.yml'), { scope: SCOPE })).toEqual([]);
  });

  it('lists them on the node and draws a declared data edge for each one read', async () => {
    const description = await describeFlow(flow('inherit.flow.yml'), { scope: SCOPE });

    expect(node(description, 'sign_in').outputs).toEqual(['token']);
    expect(node(description, 'get_thing').outputs).toEqual(['thingId', 'title', 'thingName']);
    expect(description.edges.filter((edge) => edge.kind === 'data')).toEqual(
      expect.arrayContaining([
        { from: 'get_thing', to: 'create', kind: 'data', output: 'title', declared: true },
        { from: 'get_thing', to: 'create', kind: 'data', output: 'thingId', declared: true }
      ])
    );
    expect(description.edges.filter((edge) => edge.kind === 'data' && edge.declared === false)).toEqual([]);
  });

  it('still refuses a name no layer supplies', async () => {
    const { entry, files } = variant(flow('inherit.flow.yml'), (document) => {
      document.steps[2].body.ref = '{{steps.get_thing.thingy}}';
    });
    const diagnostics = await validate(entry, { scope: SCOPE, files });

    expect(of(diagnostics, 'unknown-output-reference')).toEqual([
      expect.objectContaining({ severity: 'error', stepId: 'create', message: expect.stringContaining('thingId') })
    ]);
  });
});

describe('R10.2 — Matching is by resolved spec identity', () => {
  it('applies whatever alias the flow uses for the document', async () => {
    const { entry, files } = variant(flow('inherit.flow.yml'), (document) => {
      document.apis = { anything: document.apis.svc };
      for (const step of document.steps) step.operation = step.operation.replace('svc#', 'anything#');
    });

    expect(await validate(entry, { scope: SCOPE, files })).toEqual([]);
    const run = await runFlow(entry, { scope: SCOPE, files, responses: RESPONSES });
    expect(outputsOf(run, 'get_thing')).toEqual({ thingId: 'thing-1', title: 'Widget', thingName: 'Widget' });
  });

  it('applies to a step addressing the operation by method and path (§6.1)', async () => {
    const { entry, files } = variant(flow('inherit.flow.yml'), (document) => {
      document.steps[1].operation = 'svc#GET /things/{id}';
    });

    expect(await validate(entry, { scope: SCOPE, files })).toEqual([]);
    const description = await describeFlow(entry, { scope: SCOPE, files });
    expect(node(description, 'get_thing').outputs).toEqual(['thingId', 'title', 'thingName']);
  });

  it('does not apply to the same operationId in a different document', async () => {
    // A second document declaring `getThing` — same id, different spec, so no entry names it.
    const other = path.join(COLLECTION_ROOT, 'flows', 'other-v1.yml');
    const { entry, files } = variant(flow('inherit.flow.yml'), (document) => {
      document.apis.svc = './other-v1.yml';
    });
    const overlay = {
      ...files,
      [other]: fs.readFileSync(path.join(FLOWS, '..', 'specs', 'regressions-v1.yml'), 'utf8')
        .replace('title: Regression API', 'title: Other API')
    };
    const diagnostics = await validate(entry, { scope: SCOPE, files: overlay });

    // Nothing is supplied for either operation: `create` reads two of `get_thing`'s, and the auth
    // profile reads `sign_in.token` from both steps that use it.
    expect(of(diagnostics, 'unknown-output-reference').map((entry) => entry.stepId).sort()).toEqual([
      'create',
      'create',
      'create',
      'get_thing'
    ]);
    const description = await describeFlow(entry, { scope: SCOPE, files: overlay });
    expect(node(description, 'sign_in').outputs).toEqual([]);
    expect(node(description, 'get_thing').outputs).toEqual([]);
  });
});

describe('R10.3 — Resolution order, and what removes an inherited entry', () => {
  it('lets the collection file override and extend the workspace file', async () => {
    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    // `title` is `data.id` in the workspace file and `data.name` in the collection's.
    expect(outputsOf(run, 'get_thing').title).toBe('Widget');
    expect(outputsOf(run, 'get_thing').thingName).toBe('Widget');
  });

  it('lets the collection file suppress a workspace entry with !...', async () => {
    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });
    expect(outputsOf(run, 'sign_in')).not.toHaveProperty('role');

    const { entry, files } = variant(flow('inherit.flow.yml'), (document) => {
      document.steps[2].body.name = '{{steps.sign_in.role}}';
    });
    const diagnostics = await validate(entry, { scope: SCOPE, files });
    expect(of(diagnostics, 'unknown-output-reference')).toHaveLength(1);
  });

  it('lets the step\'s own block override, extend and suppress what it inherits', async () => {
    const run = await runFlow(flow('override.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.result.status).toBe('passed');
    expect(outputsOf(run, 'get_thing')).toEqual({ title: 'thing-1', own: 'Widget', thingName: 'Widget' });
    expect(run.call('createThing').json).toEqual({ name: 'Widget', ref: 'thing-1' });
    expect(await validate(flow('override.flow.yml'), { scope: SCOPE })).toEqual([]);
  });

  it('refuses a read of the entry the step suppressed', async () => {
    const { entry, files } = textVariant('override.flow.yml', (text) =>
      text.replace('ref: "{{steps.get_thing.title}}"', 'ref: "{{steps.get_thing.thingId}}"'));
    const diagnostics = await validate(entry, { scope: SCOPE, files });

    expect(of(diagnostics, 'unknown-output-reference')).toEqual([
      expect.objectContaining({ severity: 'error', stepId: 'create' })
    ]);
  });

  it('refuses null as a removal token, in a step and in a connector file alike', async () => {
    const { entry, files } = textVariant('override.flow.yml', (text) =>
      text.replace('own: data.name', 'own: data.name\n      thingName: null'));
    const inStep = await validate(entry, { scope: SCOPE, files });
    expect(of(inStep, 'null-output')).toEqual([
      expect.objectContaining({ severity: 'error', stepId: 'get_thing', file: entry, line: expect.any(Number) })
    ]);

    const inFile = await validate(flow('inherit.flow.yml'), {
      scope: SCOPE,
      files: collectionFile(`
version: 1
apis:
  things: ../../../../../specs/regressions-v1.yml
connectors:
  things#signIn:
    role: null
`)
    });
    expect(of(inFile, 'null-output')).toEqual([
      expect.objectContaining({ severity: 'error', file: COLLECTION_FILE, line: 7, message: expect.stringContaining('!...') })
    ]);
  });

  it('resolves a sub-flow\'s connectors from its own scope, not its caller\'s (§12.3)', async () => {
    // The collection file suppresses `role`; the shared flow sits under the workspace's `flows/`, so
    // only the workspace file applies to it and the export it names still resolves.
    const run = await runFlow(flow('uses-shared.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.result.status).toBe('passed');
    expect(outputsOf(run, 'auth')).toEqual({ token: 'tok-1', role: 'admin' });
    expect(await validate(flow('uses-shared.flow.yml'), { scope: SCOPE })).toEqual([]);
    expect(await validate(path.join(WORKSPACE_ROOT, 'flows', 'shared', 'login.flow.yml'), {
      scope: { workspaceRoot: WORKSPACE_ROOT }
    })).toEqual([]);
  });

  it('treats a scope with no connector file as one that supplies nothing', async () => {
    // The fixtures root has no `flows/connectors.yml`: the steps inherit nothing, and no diagnostic
    // says a file is missing — its absence is the ordinary case.
    const diagnostics = await validate(flow('inherit.flow.yml'));

    // Two reads of `get_thing`, and the auth profile's read of `sign_in.token` from two steps.
    expect(diagnostics.map((entry) => entry.code)).toEqual(Array(4).fill('unknown-output-reference'));
  });
});

describe('R10.4 — A connector file is checked against the documents it binds', () => {
  const connectors = (body) => collectionFile(`
version: 1
apis:
  things: ../../../../../specs/regressions-v1.yml
  dup: ../../../../../specs/validation-duplicates-v1.yml
connectors:
${body}`);

  const check = (body) => validate(flow('inherit.flow.yml'), { scope: SCOPE, files: connectors(body) });

  // A diagnostic anchors to the node it is about — the entry's value — so `body`'s first line is the
  // file's line 8, and a mapping value begins on the line under its key.
  it('reports an entry whose alias the file does not bind, against the file', async () => {
    const diagnostics = await check(`
  nope#getThing:
    thingId: data.id
`);

    expect(of(diagnostics, 'unresolved-alias')).toEqual([
      expect.objectContaining({ severity: 'error', file: COLLECTION_FILE, line: 9 })
    ]);
    // The thing to fix is in the file the diagnostic names, not in any step of the flow.
    expect(of(diagnostics, 'unresolved-alias')[0]).not.toHaveProperty('stepId');
  });

  it('reports an entry naming an operation the document does not have', async () => {
    const diagnostics = await check(`
  things#getWidget:
    thingId: data.id
`);

    expect(of(diagnostics, 'unknown-operation')).toEqual([
      expect.objectContaining({ file: COLLECTION_FILE, message: expect.stringContaining('getWidget') })
    ]);
  });

  it('reports an entry naming an operationId the document declares twice (§6.5)', async () => {
    const diagnostics = await check(`
  dup#createTicket:
    ticketId: data.id
`);

    expect(of(diagnostics, 'ambiguous-operation')).toEqual([expect.objectContaining({ file: COLLECTION_FILE })]);
  });

  it('reports an entry that is not a mapping of outputs', async () => {
    const diagnostics = await check(`
  things#getThing: data.id
`);

    expect(of(diagnostics, 'invalid-connector-entry')).toEqual([
      expect.objectContaining({ severity: 'error', file: COLLECTION_FILE, line: 8 })
    ]);
  });

  it('checks each path against the operation\'s response schema, with a did-you-mean', async () => {
    const diagnostics = await check(`
  things#getThing:
    thingName: data.nmae
    thingId: data.id
`);

    expect(of(diagnostics, 'unknown-output-path')).toEqual([
      expect.objectContaining({
        severity: 'error',
        file: COLLECTION_FILE,
        line: 9,
        message: expect.stringMatching(/nmae.*did you mean name\?/)
      })
    ]);
  });

  it('does not check a path bruno-query selects by value, or one a schema is silent on', async () => {
    const diagnostics = await check(`
  things#getThing:
    first: data.items[?(@.active)].id
    picked: data[*]
`);

    expect(of(diagnostics, 'unknown-output-path')).toEqual([]);
  });

  it('reports a connector file that does not parse, and checks nothing in it', async () => {
    const diagnostics = await validate(flow('inherit.flow.yml'), {
      scope: SCOPE,
      files: collectionFile('version: 1\nconnectors: [\n')
    });

    expect(of(diagnostics, 'parse-error')).toEqual([
      expect.objectContaining({ file: COLLECTION_FILE, line: expect.any(Number) })
    ]);
    expect(diagnostics.filter((entry) => entry.file === COLLECTION_FILE)).toHaveLength(1);
  });

  it('has the run ignore exactly the entries validate names', async () => {
    const run = await runFlow(flow('inherit.flow.yml'), {
      scope: SCOPE,
      responses: RESPONSES,
      files: connectors(`
  nope#getThing:
    thingName: data.name
`)
    });

    // Only the workspace file applied: `title` is still `data.id`, and `thingName` never arrived.
    expect(outputsOf(run, 'get_thing')).toEqual({ thingId: 'thing-1', title: 'thing-1' });
    expect(outputsOf(run, 'sign_in')).toEqual({ token: 'tok-1', role: 'admin' });
  });
});

describe('R10.5 — Where each output was declared', () => {
  it('lists a step\'s resolved outputs with the file and layer each came from', async () => {
    const listing = await resolveOutputs(flowFile('override.flow.yml'));
    const getThing = listing.find((step) => step.id === 'get_thing');

    // In the order first declared, whichever layer had the last say: the workspace's `title` slot is
    // kept where it stood, `thingId` is gone, and `own` is new.
    expect(getThing.outputs.map(({ name, origin, file }) => ({ name, origin, file }))).toEqual([
      { name: 'title', origin: 'inline', file: flowFile('override.flow.yml') },
      { name: 'thingName', origin: 'collection', file: COLLECTION_FILE },
      { name: 'own', origin: 'inline', file: flowFile('override.flow.yml') }
    ]);
    expect(getThing.outputs.map((output) => output.path)).toEqual(['data.id', 'data.name', 'data.name']);
  });

  it('names the workspace file for an output nothing nearer redeclared', async () => {
    const listing = await resolveOutputs(flowFile('inherit.flow.yml'));

    expect(listing.map((step) => step.id)).toEqual(['sign_in', 'get_thing', 'create']);
    expect(listing[0].outputs.map(({ name, origin, file }) => ({ name, origin, file }))).toEqual([
      { name: 'token', origin: 'workspace', file: WORKSPACE_FILE }
    ]);
    expect(listing[1].outputs.map(({ name, origin }) => `${name}:${origin}`)).toEqual([
      'thingId:workspace',
      'title:collection',
      'thingName:collection'
    ]);
    expect(listing[2].outputs).toEqual([]);
  });
});
