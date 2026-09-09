/**
 * R9.13 — the mapping from a collection's stored auth block to §6.4's implicit `collection` profile.
 *
 * Bruno stores auth nested under a key named for its mode; a profile's fields are authored flat.
 * The mapping is the engine's (§13.1) because both hosts read a collection root off disk and a copy
 * each is a copy that can drift — a mode one host flattens and the other does not is a collection
 * that authenticates under `bru flow run` and silently does not in the app.
 *
 * This runs against `materialize.ts` directly: it is a pure function of the parsed block, and the
 * hosts' own specs cover reading the file that produced it.
 */
const { collectionAuthProfile } = require('../../src/materialize');

describe('R9.13 — One mapping from a collection\'s stored auth to its profile', () => {
  /** Every mode `AuthMode` names, as the app's auth editor stores it. */
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
    // The one key that is not the mode string.
    ['akamai-edgegrid', 'akamaiEdgegrid', { accessToken: 'at_1', clientToken: 'ct_1', clientSecret: 'cs_1' }]
  ];

  it.each(MODES)('flattens %s into the fields the engine resolves', (mode, key, fields) => {
    const profile = collectionAuthProfile({ mode, [key]: fields });

    expect(profile.fields).toEqual({ mode, ...fields });
    // The nesting is undone, not merely accompanied: a `bearer` key left beside `mode` would reach
    // the wire as a field of the mode rather than as its token.
    expect(profile.fields[key]).toBeUndefined();
  });

  /**
   * No `scope`: §6.4 resolves a *declared* profile lexically, and nothing declared this one, so the
   * engine resolves it in the using step's scope. A scope here would change what `{{authToken}}` in
   * a collection's bearer token reads.
   */
  it('attaches no lexical scope', () => {
    expect(collectionAuthProfile({ mode: 'bearer', bearer: { token: '{{authToken}}' } }).scope).toBeUndefined();
  });

  /**
   * §6.4 promises a collection flow "authenticates exactly as the collection does" — a collection
   * that authenticates with nothing included — so the empty answer is a profile rather than the
   * absence of one, and `auth: collection` resolves for every collection.
   */
  it.each([
    ['a collection whose auth is none', { mode: 'none' }],
    // `inherit` at the collection root has nothing above it to inherit from.
    ['a collection whose auth is inherit', { mode: 'inherit' }],
    ['a collection with no auth block at all', {}],
    ['a collection with no auth at all', undefined],
    ['an auth block that is not one', 'bearer']
  ])('answers a none profile for %s', (_label, auth) => {
    expect(collectionAuthProfile(auth)).toEqual({ fields: { mode: 'none' } });
  });

  /** A mode whose own block is missing or malformed is still that mode, with no fields invented. */
  it.each([
    ['missing', { mode: 'bearer' }],
    ['not a mapping', { mode: 'bearer', bearer: 'tok-collection' }]
  ])('carries the mode alone when its fields are %s', (_label, auth) => {
    expect(collectionAuthProfile(auth)).toEqual({ fields: { mode: 'bearer' } });
  });
});
