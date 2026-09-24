/**
 * §7's stages 2 through 5, asserted on one step at a time.
 *
 * Materialization is deterministic and has no side effects, so it is the part of the engine a unit
 * test can pin exactly — and the part where a flow-shaped test is least able to. A run shows the
 * request that came out; it does not show *which layer* put a field there, and the layering is the
 * whole of §7.2. A seed that stopped omitting optional properties and a step body that started
 * losing to the spec's example produce the same passing scenario and different requests.
 *
 * §7.5's media-type decision is here for the same reason: the errors it raises are the only place
 * the engine refuses to guess, and each of them is a request never sent.
 */
const { DROP, FileRef } = require('../../src/document');
const { MaterializationError, collectionAuthProfile, materialize, merge } = require('../../src/materialize');

const CONFIG = { concurrency: 1, cleanupGrace: 0, redactHeaders: [], capturePreviewBytes: 8192 };

const step = (over = {}) => ({
  id: 'create',
  query: {},
  headers: {},
  pathParams: {},
  ...over
});

const resolved = (over = {}) => ({
  operationId: 'createThing',
  method: 'POST',
  template: '/things',
  operation: {},
  parameters: [],
  servers: ['https://api.test'],
  definitions: {},
  ...over
});

/** An operation declaring one media type with the schema given. */
const withSchema = (schema, mediaType = 'application/json', extra = {}) =>
  resolved({ operation: { requestBody: { content: { [mediaType]: { schema, ...extra } } } } });

const refuse = () => {
  throw new Error('no file should have been read');
};

const run = (over = {}) => {
  const { stepOver = {}, binding, profiles = {}, config = {}, scope = { vars: {}, namespaces: {} }, read = refuse, operation }
    = over;
  return materialize(step(stepOver), binding, operation || resolved(), profiles, { ...CONFIG, ...config }, scope, read);
};

describe('§7.1 seeding from the spec', () => {
  it('seeds a required property by its type', async () => {
    const operation = withSchema({ type: 'object', required: ['name', 'count', 'live'], properties: { name: { type: 'string' }, count: { type: 'integer' }, live: { type: 'boolean' } } });

    expect((await run({ operation })).request.body.value).toEqual({ name: '', count: 0, live: false });
  });

  it('omits an optional property, which would otherwise be sent on every request', async () => {
    const operation = withSchema({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, note: { type: 'string' } } });

    expect((await run({ operation })).request.body.value).toEqual({ name: '' });
  });

  it('seeds an optional property that carries an example or a default', async () => {
    const operation = withSchema({ type: 'object', properties: { note: { type: 'string', example: 'hi' }, size: { type: 'integer', default: 3 } } });

    expect((await run({ operation })).request.body.value).toEqual({ note: 'hi', size: 3 });
  });

  it('never seeds a binary property, an empty string uploading zero bytes while looking intentional', async () => {
    const operation = withSchema({ type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } });

    expect((await run({ operation })).request.body.value).toEqual({});
  });

  it('takes the first member of an enum', async () => {
    const operation = withSchema({ type: 'object', required: ['role'], properties: { role: { enum: ['admin', 'viewer'] } } });

    expect((await run({ operation })).request.body.value).toEqual({ role: 'admin' });
  });

  it('seeds an array as empty rather than inventing a member', async () => {
    const operation = withSchema({ type: 'object', required: ['tags'], properties: { tags: { type: 'array', items: { type: 'string' } } } });

    expect((await run({ operation })).request.body.value).toEqual({ tags: [] });
  });

  it('lets the operation example override what the schema would seed', async () => {
    const operation = withSchema(
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      'application/json',
      { example: { name: 'from the example' } }
    );

    expect((await run({ operation })).request.body.value).toEqual({ name: 'from the example' });
  });
});

describe('§7.2 merge semantics', () => {
  const operation = withSchema({
    type: 'object',
    required: ['name', 'address'],
    properties: {
      name: { type: 'string' },
      address: { type: 'object', required: ['city', 'zip'], properties: { city: { type: 'string' }, zip: { type: 'string' } } }
    }
  });

  it('deep-merges an object, so a step overrides one field without restating its siblings', async () => {
    const body = (await run({ operation, stepOver: { body: { address: { city: 'Berlin' } } } })).request.body.value;

    expect(body).toEqual({ name: '', address: { city: 'Berlin', zip: '' } });
  });

  it('replaces an array wholesale rather than merging it member by member', async () => {
    const listed = withSchema({ type: 'object', properties: { tags: { type: 'array', default: ['a', 'b'] } } });

    const body = (await run({ operation: listed, stepOver: { body: { tags: ['c'] } } })).request.body.value;

    expect(body).toEqual({ tags: ['c'] });
  });

  it('removes a key the seed introduced when the step drops it with `!...`', async () => {
    const body = (await run({ operation, stepOver: { body: { name: DROP } } })).request.body.value;

    expect(body).toEqual({ address: { city: '', zip: '' } });
  });

  it('treats a `!...` under a key the seed never introduced as absent, not as a value', async () => {
    const body = (await run({ operation, stepOver: { body: { partner: { data: { id: 'p1', name: DROP } } } } }))
      .request.body.value;

    expect(body).toEqual({ name: '', address: { city: '', zip: '' }, partner: { data: { id: 'p1' } } });
  });

  it('treats a `!...` in a mapping inside an array as absent', async () => {
    const body = (await run({ operation, stepOver: { body: { tags: [{ id: 't1', note: DROP }] } } })).request.body.value;

    expect(body.tags).toEqual([{ id: 't1' }]);
  });

  it('removes an array item that is `!...`, rather than sending it as null', async () => {
    const body = (await run({ operation, stepOver: { body: { tags: ['a', DROP, 'c'] } } })).request.body.value;

    expect(body.tags).toEqual(['a', 'c']);
  });

  it('keeps a file reference as itself under a key the seed never introduced', () => {
    const file = new FileRef('./a.txt');

    expect(merge({}, { attachment: { file } }).attachment.file).toBe(file);
  });

  it('layers the step over the binding over the seed, for query and headers alike', async () => {
    const binding = { alias: 'api', defaultQuery: { tenant: 'acme', page: '1' }, defaultHeaders: { 'x-trace': 'on', 'x-src': 'binding' } };

    const { request } = await run({ binding, stepOver: { query: { page: '2' }, headers: { 'x-src': 'step' } } });

    expect(request.query).toEqual([
      { name: 'tenant', value: 'acme' },
      { name: 'page', value: '2' }
    ]);
    expect(request.headers).toEqual({ 'x-trace': 'on', 'x-src': 'step' });
  });

  it('expands a repeated query parameter into one entry per value', async () => {
    const { request } = await run({ stepOver: { query: { tag: ['a', 'b'] } } });

    expect(request.query).toEqual([
      { name: 'tag', value: 'a' },
      { name: 'tag', value: 'b' }
    ]);
  });
});

describe('§7.5 the media-type decision', () => {
  it('uses the sole media type the operation declares', async () => {
    const { mediaType } = await run({ operation: withSchema({ type: 'object' }) });

    expect(mediaType).toBe('application/json');
  });

  it('refuses to guess between two, naming both', async () => {
    const operation = resolved({
      operation: { requestBody: { content: { 'application/json': {}, 'application/xml': {} } } }
    });

    await expect(run({ operation })).rejects.toThrow(
      'create: the operation declares application/json, application/xml — set contentType: on the step'
    );
  });

  it('takes the step\'s `contentType:` where the operation declares more than one', async () => {
    const operation = resolved({
      operation: {
        requestBody: {
          content: { 'application/json': {}, 'application/x-www-form-urlencoded': { schema: { type: 'object' } } }
        }
      }
    });

    const { mediaType, request } = await run({
      operation,
      stepOver: { contentType: 'application/x-www-form-urlencoded', body: { n: 1 } }
    });

    expect(mediaType).toBe('application/x-www-form-urlencoded');
    expect(request.body).toEqual({ kind: 'urlencoded', fields: [{ name: 'n', value: '1' }] });
  });

  it('rejects a `contentType:` the operation does not declare', async () => {
    const operation = withSchema({ type: 'object' });

    await expect(run({ operation, stepOver: { contentType: 'application/xml' } })).rejects.toThrow(
      'create: the operation does not declare application/xml'
    );
  });

  it('sends no body where the operation declares no request body at all', async () => {
    const { mediaType, request } = await run({ stepOver: { body: { ignored: true } } });

    expect(mediaType).toBeUndefined();
    expect(request.body).toEqual({ kind: 'none' });
  });

  it('tags a JSON body as json and a form body as urlencoded fields', async () => {
    const json = await run({ operation: withSchema({ type: 'object', properties: { n: { type: 'integer', default: 1 } } }) });
    const form = await run({
      operation: withSchema({ type: 'object', properties: { n: { type: 'integer', default: 1 } } }, 'application/x-www-form-urlencoded')
    });

    expect(json.request.body).toEqual({ kind: 'json', value: { n: 1 } });
    expect(form.request.body).toEqual({ kind: 'urlencoded', fields: [{ name: 'n', value: '1' }] });
  });

  it('rejects a `!file` where the media type does not accept one', async () => {
    const operation = withSchema({ type: 'object' });

    await expect(run({ operation, stepOver: { body: { doc: new FileRef('a.pdf') } } })).rejects.toThrow(
      'create: !file is only a value where the operation accepts one — application/json does not'
    );
  });

  it('rejects a raw media type given a body that is not a file reference', async () => {
    const operation = withSchema(undefined, 'application/pdf');

    await expect(run({ operation, stepOver: { body: { not: 'bytes' } } })).rejects.toThrow(
      'create: application/pdf takes the raw bytes of a bodyFile: or a body: !file'
    );
  });

  it('raises each of these as a MaterializationError carrying §14.3\'s code', async () => {
    const operation = withSchema({ type: 'object' });

    await expect(run({ operation, stepOver: { contentType: 'application/xml' } })).rejects.toMatchObject({
      constructor: MaterializationError,
      code: 'unknown-media-type'
    });
  });
});

describe('§6.3 the base URL, and the path', () => {
  it('prefers the binding, then `config.baseUrl`, then the first server', async () => {
    const binding = { alias: 'api', baseUrl: 'https://binding.test' };

    expect((await run({ binding, config: { baseUrl: 'https://config.test' } })).request.url).toBe('https://binding.test/things');
    expect((await run({ config: { baseUrl: 'https://config.test' } })).request.url).toBe('https://config.test/things');
    expect((await run({})).request.url).toBe('https://api.test/things');
  });

  it('drops a trailing slash rather than doubling it against the path', async () => {
    expect((await run({ config: { baseUrl: 'https://api.test/' } })).request.url).toBe('https://api.test/things');
  });

  it('substitutes a path parameter, encoded', async () => {
    const operation = resolved({ template: '/things/{id}' });

    expect((await run({ operation, stepOver: { pathParams: { id: 'a b' } } })).request.url).toBe(
      'https://api.test/things/a%20b'
    );
  });

  it('leaves a path parameter nothing supplied in the template, where it is visible', async () => {
    const operation = resolved({ template: '/things/{id}' });

    expect((await run({ operation })).request.url).toBe('https://api.test/things/{id}');
  });
});

describe('§7.3 interpolation, applied after the merge', () => {
  const scope = { vars: { tenant: 'acme' }, namespaces: { steps: { login: { id: '7' } } } };

  it('resolves references in every layer the merge produced', async () => {
    const operation = withSchema({ type: 'object', properties: { ref: { type: 'string', default: '{{tenant}}' } } });

    const { request } = await run({
      operation,
      scope,
      stepOver: { query: { who: '{{tenant}}' }, headers: { 'x-id': '{{steps.login.id}}' } }
    });

    expect(request.body.value).toEqual({ ref: 'acme' });
    expect(request.query).toEqual([{ name: 'who', value: 'acme' }]);
    expect(request.headers).toEqual({ 'x-id': '7' });
  });

  it('reports an unproduced `steps.*` reference rather than sending it', async () => {
    const { unresolved } = await run({ scope, stepOver: { headers: { 'x-id': '{{steps.missing.id}}' } } });

    expect(unresolved).toEqual(['steps.missing.id']);
  });
});

describe('§6.4 auth, and §14.4 the credentials it resolves', () => {
  const profiles = {
    admin: { fields: { mode: 'bearer', token: '{{secretToken}}' } },
    collection: { fields: { mode: 'basic', username: 'u', password: 'p' } }
  };
  const scope = { vars: { secretToken: 't0ken' }, namespaces: {} };

  it('prefers the step\'s profile, then the binding\'s, then the implicit collection one', async () => {
    const binding = { alias: 'api', auth: 'admin' };

    expect((await run({ profiles, scope, stepOver: { auth: 'admin' } })).request.auth.mode).toBe('bearer');
    expect((await run({ profiles, scope, binding })).request.auth.mode).toBe('bearer');
    expect((await run({ profiles, scope })).request.auth.mode).toBe('basic');
  });

  it('sends `none` where no host supplied a collection profile', async () => {
    expect((await run({ profiles: {} })).request.auth).toEqual({ mode: 'none' });
  });

  it('keeps `auth: none` as the opt-out from the collection\'s credentials', async () => {
    expect((await run({ profiles, scope, stepOver: { auth: 'none' } })).request.auth).toEqual({ mode: 'none' });
  });

  it('rejects a profile name nothing declared', async () => {
    await expect(run({ profiles, stepOver: { auth: 'ghost' } })).rejects.toThrow('create: no auth profile named ghost');
  });

  it('reports the credential as the value that went out, not as the reference it was written as', async () => {
    expect((await run({ profiles, scope, stepOver: { auth: 'admin' } })).secrets).toEqual(['t0ken']);
  });

  it('reports the authenticating field and not the identifying one', async () => {
    expect((await run({ profiles, scope })).secrets).toEqual(['p']);
  });
});

describe('collectionAuthProfile', () => {
  it('lifts the collection\'s mode and its own field block into a profile', () => {
    expect(collectionAuthProfile({ mode: 'bearer', bearer: { token: 't' } })).toEqual({
      fields: { mode: 'bearer', token: 't' }
    });
  });

  it('reads Akamai\'s block, whose key is not the mode string', () => {
    expect(collectionAuthProfile({ mode: 'akamai-edgegrid', akamaiEdgegrid: { clientSecret: 's' } })).toEqual({
      fields: { mode: 'akamai-edgegrid', clientSecret: 's' }
    });
  });

  it.each([[{ mode: 'none' }], [{ mode: 'inherit' }], [{}], [undefined]])(
    'gives `none` for %p, there being no credentials to inherit at a profile boundary',
    (auth) => {
      expect(collectionAuthProfile(auth)).toEqual({ fields: { mode: 'none' } });
    }
  );
});
