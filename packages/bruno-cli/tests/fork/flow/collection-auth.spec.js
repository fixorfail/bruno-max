/**
 * 001 §6.4's implicit `collection` profile, as the CLI reads it off a collection — 001-C R7.7.
 *
 * The mapping under test is one direction: Bruno stores a collection's auth nested under a key named
 * for its mode, and a profile's fields are authored flat. Every mode `bru run` supports that the
 * engine's `AuthMode` also names is covered, because a mode this drops is a collection that
 * authenticates in the app and silently does not in a flow.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stringifyCollection } = require('@usebruno/filestore');

const { collectionAuthProfile, authProfilesFor } = require('../../../src/fork/flow/collection-auth');

const staged = [];

const stage = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-collection-auth-')));
  staged.push(root);
  fs.writeFileSync(path.join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'probe', type: 'collection' }));
  return root;
};

/** A collection whose root file says what the app's auth editor would have written into it. */
const withAuth = (auth) => {
  const root = stage();
  fs.writeFileSync(
    path.join(root, 'collection.bru'),
    stringifyCollection({ request: { auth } }, {}, { format: 'bru' })
  );
  return root;
};

afterAll(() => {
  for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
});

describe('R7.7 the collection profile the CLI supplies', () => {
  /** Each mode's fields as an author would write them into the collection, nested as Bruno stores them. */
  const MODES = [
    ['bearer', 'bearer', { token: '{{authToken}}' }],
    ['basic', 'basic', { username: 'bruno', password: '{{pw}}' }],
    ['apikey', 'apikey', { key: 'X-Api-Key', value: 'ak_1', placement: 'header' }],
    ['awsv4', 'awsv4', { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', service: 'execute-api', region: 'us-east-1' }],
    ['digest', 'digest', { username: 'dig-user', password: 'dig-pass' }],
    ['ntlm', 'ntlm', { username: 'nt-user', password: 'nt-pass', domain: 'WORKGROUP' }],
    ['wsse', 'wsse', { username: 'wsse-user', password: 'wsse-pass' }],
    ['oauth2', 'oauth2', { grantType: 'client_credentials', accessTokenUrl: 'http://127.0.0.1/token', clientId: 'cid', clientSecret: 'sec' }],
    ['oauth1', 'oauth1', { consumerKey: 'ck', consumerSecret: 'cs', signatureMethod: 'HMAC-SHA1' }],
    ['akamai-edgegrid', 'akamaiEdgegrid', { accessToken: 'at_1', clientToken: 'ct_1', clientSecret: 'cs_1' }]
  ];

  it.each(MODES)('flattens %s into the profile the engine reads', async (mode, key, fields) => {
    const profile = await collectionAuthProfile(withAuth({ mode, [key]: fields }));

    expect(profile.fields.mode).toBe(mode);
    expect(profile.fields).toMatchObject(fields);
    // The nesting is undone, not merely accompanied: a `bearer` key left beside `mode` would reach
    // the wire as a field of the mode rather than as its token.
    expect(profile.fields[key]).toBeUndefined();
  });

  /**
   * The flat shape exactly, for a mode whose parser adds no defaults of its own — `toMatchObject`
   * above says every authored field survives, and this says nothing else was invented.
   */
  it('carries the mode beside that mode\'s own fields and nothing more', async () => {
    const profile = await collectionAuthProfile(withAuth({ mode: 'bearer', bearer: { token: 'tok-collection' } }));

    expect(profile.fields).toEqual({ mode: 'bearer', token: 'tok-collection' });
  });

  /**
   * No `scope`: §6.4 resolves a *declared* profile lexically, and a host-supplied one has no flow
   * that declared it, so the engine resolves it in the using step's scope. Attaching one here would
   * change what `{{authToken}}` in a collection's bearer token reads.
   */
  it('attaches no lexical scope', async () => {
    const profile = await collectionAuthProfile(withAuth({ mode: 'bearer', bearer: { token: '{{authToken}}' } }));

    expect(profile.scope).toBeUndefined();
  });

  /**
   * §6.4's promise is that a collection flow "authenticates exactly as the collection does" — a
   * collection that authenticates with nothing included. So the profile is always supplied and the
   * empty answer is `none`, rather than `auth: collection` erroring for some collections and not
   * others depending on whether anyone filled the auth in.
   */
  it.each([
    ['a collection whose auth is none', { mode: 'none' }],
    // `inherit` at the collection root has nothing above it to inherit from.
    ['a collection whose auth is inherit', { mode: 'inherit' }],
    ['a collection with no auth block at all', {}]
  ])('supplies a none profile for %s', async (_label, auth) => {
    expect(await collectionAuthProfile(withAuth(auth))).toEqual({ fields: { mode: 'none' } });
  });

  it('supplies a none profile for a collection with no root file', async () => {
    expect(await collectionAuthProfile(stage())).toEqual({ fields: { mode: 'none' } });
  });

  /** A malformed root file is a shrug, not a run that refuses to start. */
  it('supplies a none profile for a collection whose root file does not parse', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'collection.bru'), 'auth {\n  mode');

    expect(await collectionAuthProfile(root)).toEqual({ fields: { mode: 'none' } });
  });

  /** The same collection auth, in the format that keeps root and config in one file. */
  it('reads a yml collection root', async () => {
    const root = stage();
    fs.rmSync(path.join(root, 'bruno.json'));
    fs.writeFileSync(
      path.join(root, 'opencollection.yml'),
      stringifyCollection({ name: 'probe', request: { auth: { mode: 'bearer', bearer: { token: 'tok-yml' } } } }, {}, { format: 'yml' })
    );

    expect(await collectionAuthProfile(root)).toEqual({ fields: { mode: 'bearer', token: 'tok-yml' } });
  });

  describe('what runFlow is handed', () => {
    it('names the profile `collection` for a collection-scoped flow', async () => {
      const collectionRoot = withAuth({ mode: 'bearer', bearer: { token: 'tok-collection' } });

      expect(await authProfilesFor({ workspaceRoot: collectionRoot, collectionRoot })).toEqual({
        collection: { fields: { mode: 'bearer', token: 'tok-collection' } }
      });
    });

    /**
     * A workspace-scoped flow has no collection to inherit from (§6.2), so the host supplies
     * nothing and `auth: collection` stays `unknown-auth-profile` — the truthful answer rather than
     * an empty profile that would send the step out unauthenticated.
     */
    it('supplies nothing for a workspace-scoped flow', async () => {
      expect(await authProfilesFor({ workspaceRoot: stage() })).toBeUndefined();
    });
  });
});
