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
  /**
   * §8.5 reads a connector entry by §8.1's rule, so every form an `outputs:` block takes is
   * available — the short path, `from:`, and `script:`. Written down because the entry looks like a
   * path map, and an author who assumed it was one would declare the computed half inline in every
   * flow, which is the duplication §8.5 exists to remove.
   */
  it('takes a script: output as readily as a path', async () => {
    const files = collectionFile(
      [
        'version: 1',
        'apis:',
        '  things: ../../../../../specs/regressions-v1.yml',
        'connectors:',
        '  things#getThing:',
        '    shouty:',
        '      script: |',
        '        (res) => res.body.data.name.toUpperCase()'
      ].join('\n')
    );
    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, files, responses: RESPONSES });

    expect(run.result.status).toBe('passed');
    expect(outputsOf(run, 'get_thing')).toEqual(expect.objectContaining({ shouty: 'WIDGET' }));
  });

  /**
   * §8.6's library belongs to the flow the script runs in, and a connector file supplies none — so a
   * connector script calling a shared helper is a run-time failure in any flow that does not declare
   * it, not a validation one. Pinned because it is the sharp edge of the case above.
   */
  it('runs a connector script in the using flow\'s library, and says so when it is not there', async () => {
    const files = collectionFile(
      [
        'version: 1',
        'apis:',
        '  things: ../../../../../specs/regressions-v1.yml',
        'connectors:',
        '  things#getThing:',
        '    short:',
        '      script: |',
        '        (res) => lastFour(res.body.data.id)'
      ].join('\n')
    );

    expect(await validate(flow('inherit.flow.yml'), { scope: SCOPE, files })).toEqual([]);

    const run = await runFlow(flow('inherit.flow.yml'), { scope: SCOPE, files, responses: RESPONSES });
    expect(run.outcome('get_thing')).toBe('failed:script-error');
    expect(run.step('get_thing').message).toContain('lastFour is not defined');
  });

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

/**
 * §8.5's binding defaults — everything about an API that is true of the *service* rather than of one
 * flow, declared once in the connector file and inherited by every flow that binds the document.
 *
 * The same identity rule the outputs above are matched on: by the document a `source:` resolves to,
 * never by the alias, so a flow that named it something else still gets them.
 */
describe('R10.6 — a connector file supplies the binding, not only its outputs', () => {
  const ECHO = { status: 200, body: { ok: true } };

  it('inherits the host, the auth profile, the defaults and the colour', async () => {
    const run = await runFlow(flow('binding-inherit.flow.yml'), { scope: SCOPE, responses: { echoA: ECHO } });

    expect(run.status).toBe('passed');
    const call = run.call('echoA');
    expect(call.url).toContain('https://shared.example.com');
    expect(call.auth).toEqual(expect.objectContaining({ mode: 'bearer', bearer: { token: 'tok-shared' } }));
    expect(call.headers).toEqual(expect.objectContaining({ 'X-Tenant-Id': 'acme', 'X-Client': 'shared' }));
    expect(call.query).toEqual(expect.arrayContaining([{ name: 'api_version', value: '2026-01' }]));
  });

  it('carries the inherited colour into the description a viewer draws', async () => {
    const description = await describeFlow(flow('binding-inherit.flow.yml'), { scope: SCOPE });

    expect(description.apis).toEqual(
      expect.arrayContaining([expect.objectContaining({ alias: 'svc', color: '#8ab4f8' })])
    );
  });

  it('lets the flow override field by field, and keeps what it did not mention', async () => {
    const run = await runFlow(flow('binding-override.flow.yml'), { scope: SCOPE, responses: { echoA: ECHO } });

    expect(run.status).toBe('passed');
    const call = run.call('echoA');
    expect(call.url).toContain('https://own.example.com');
    expect(call.auth).toEqual(expect.objectContaining({ mode: 'bearer', bearer: { token: 'tok-own' } }));
    // The flow's own X-Client wins; the X-Tenant-Id it never mentioned still arrives.
    expect(call.headers).toEqual(expect.objectContaining({ 'X-Tenant-Id': 'acme', 'X-Client': 'own' }));
    // `!...` drops an inherited default exactly as it drops an inherited output.
    expect(call.query).toEqual([]);
  });

  it('gives the flow\'s own config.baseUrl the rank above the inherited host', async () => {
    const run = await runFlow(flow('binding-config-baseurl.flow.yml'), { scope: SCOPE, responses: { echoA: ECHO } });

    expect(run.status).toBe('passed');
    const call = run.call('echoA');
    // §6.3: a scope file's host is a default for a flow that named none, and this flow named one.
    expect(call.url).toContain('https://flow-config.example.com');
    // Everything else the connector file supplied still applies.
    expect(call.headers).toEqual(expect.objectContaining({ 'X-Tenant-Id': 'acme' }));
  });

  it('validates clean', async () => {
    for (const name of ['binding-inherit', 'binding-override', 'binding-config-baseurl']) {
      expect(await validate(flow(`${name}.flow.yml`), { scope: SCOPE })).toEqual([]);
    }
  });

  it('reports a connector file\'s own bad colour against the connector file', async () => {
    const diagnostics = await validate(flow('binding-inherit.flow.yml'), {
      scope: SCOPE,
      files: collectionFile(
        ['version: 1', 'apis:', '  shared-svc:', '    source: ../../../../../specs/paced-other-v1.yml', '    color: blue', 'connectors: {}'].join('\n')
      )
    });

    expect(of(diagnostics, 'invalid-api-color')).toEqual([
      expect.objectContaining({ severity: 'warning', file: COLLECTION_FILE })
    ]);
  });
});

/**
 * §8.5's identity across directory depth — R10.7.
 *
 * The connector file and the flow it configures sit at different depths, so the same document is
 * `../../../specs/…` in one and `../../../../specs/…` in the other. Matching is on what each path
 * resolves to *against its own file*, never on the string, which is what makes a `flows/shared/`
 * library configurable from the scope's connector file at all.
 */
describe('R10.7 — a library one directory deeper than the connector file', () => {
  const ECHO = { status: 200, body: { ok: true } };

  it('inherits the binding through the differing relative paths', async () => {
    const run = await runFlow(flow('uses-shared-binding.flow.yml'), { scope: SCOPE, responses: { echoA: ECHO } });

    expect(run.status).toBe('passed');
    const call = run.call('echoA');
    // Neither the library nor its caller names a host; the workspace connector file does.
    expect(call.url).toContain('https://workspace-scope.example.com');
    expect(call.headers).toEqual(expect.objectContaining({ 'X-Scope': 'workspace' }));
  });

  it('resolves the library against its own scope, not its caller\'s', async () => {
    // §12.3: the library is under the workspace, so the collection file's bindings never reach it —
    // which is the same rule `uses-shared.flow.yml` pins for outputs, one field along.
    const run = await runFlow(flow('uses-shared-binding.flow.yml'), { scope: SCOPE, responses: { echoA: ECHO } });

    expect(run.call('echoA').headers['X-Tenant-Id']).toBeUndefined();
  });

  it('validates clean', async () => {
    expect(await validate(flow('uses-shared-binding.flow.yml'), { scope: SCOPE })).toEqual([]);
  });
});

/**
 * §8.5's auth profiles — R10.8.
 *
 * A credential is a property of the service, so it belongs beside the binding that takes it. The
 * profile reads a *slot* rather than a step: a connector file has no steps of its own, and the token
 * is produced by whichever step signed in — which is the case §9.1's slots exist for.
 *
 * The flow keeps the `shared:` declaration. That line says which of *this* flow's steps may write
 * the value, which is a fact about this graph and not about the service.
 */
describe('R10.8 — a connector file declares the credential beside the binding', () => {
  const SIGNED = { status: 200, body: { data: { token: 'tok-signed-in' } } };
  const RESPONSES = { sessionSignIn: SIGNED, sessionThing: SIGNED };

  it('authenticates from a profile no flow declares', async () => {
    const run = await runFlow(flow('profile-inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.status).toBe('passed');
    expect(run.call('sessionThing').auth).toEqual(
      expect.objectContaining({ mode: 'apikey', apikey: expect.objectContaining({ key: 'Authorization' }) })
    );
  });

  it('resolves the slot the profile reads in the using flow\'s scope', async () => {
    const run = await runFlow(flow('profile-inherit.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    // The value came from this flow's own sign_in step, through the slot — nothing the scope knows.
    expect(run.call('sessionThing').auth.apikey.value).toBe('Token tok-signed-in');
    // And the step that sent no credential sent none: `auth: none` still opts out.
    expect(run.call('sessionSignIn').auth).toEqual({ mode: 'none' });
  });

  it('lets a flow override an inherited profile by name', async () => {
    const run = await runFlow(flow('profile-override.flow.yml'), { scope: SCOPE, responses: RESPONSES });

    expect(run.status).toBe('passed');
    expect(run.call('sessionThing').auth).toEqual(
      expect.objectContaining({ mode: 'bearer', bearer: { token: 'tok-flow-local' } })
    );
  });

  it('validates clean, and counts the slot as read', async () => {
    // `unused-slot` would fire if the profile's reference were invisible to §14.3's sweep.
    expect(await validate(flow('profile-inherit.flow.yml'), { scope: SCOPE })).toEqual([]);
    expect(await validate(flow('profile-override.flow.yml'), { scope: SCOPE })).toEqual([]);
  });

  it('names the flow that forgot the slot, before anything is sent', async () => {
    const { entry, files } = variant(flow('profile-inherit.flow.yml'), (document) => {
      delete document.shared;
      document.steps[0].shared = undefined;
    });

    expect(of(await validate(entry, { scope: SCOPE, files }), 'undeclared-slot')).toEqual([
      expect.objectContaining({ severity: 'error', stepId: 'call' })
    ]);
  });

  /**
   * A step inheriting its binding's `auth:` names neither the profile nor the file it came from, so
   * a `{{shared.x}}` inside that profile surfaces as a step depending on a slot nothing in the flow
   * mentions. The diagnostic has to carry the missing half or it names a mystery.
   */
  it('names the connector file when an inherited profile reads a slot the flow lacks', async () => {
    const { entry, files } = variant(flow('profile-inherit.flow.yml'), (document) => {
      delete document.shared;
      document.steps[0].shared = undefined;
    });
    const [complaint] = of(await validate(entry, { scope: SCOPE, files }), 'undeclared-slot');

    expect(complaint.message).toContain('auth profile session');
    expect(complaint.message).toContain('connectors.yml');
  });

  it('reports a malformed profile against the connector file', async () => {
    const diagnostics = await validate(flow('profile-inherit.flow.yml'), {
      scope: SCOPE,
      files: collectionFile(
        ['version: 1', 'authProfiles:', '  session:', '    mode: apikeys', 'connectors: {}'].join('\n')
      )
    });

    expect(of(diagnostics, 'invalid-auth-profile')).toEqual([
      expect.objectContaining({ severity: 'error', file: COLLECTION_FILE, message: expect.stringContaining('apikey') })
    ]);
  });
});
