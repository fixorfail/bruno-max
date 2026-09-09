/**
 * 001 §6.4's auth profiles, applied to a flow's request.
 *
 * §6.4's claim is that flows introduce no new auth mechanics: the engine resolves a profile and
 * hands over Bruno's own `Auth`, and the host applies it the way it already applies a request's. So
 * the mapping from `Auth` onto an axios request is `runner/prepare-request`'s — the same function
 * `bru run` maps it with, called with the resolved profile — and everything below is the wiring
 * `runner/run-single-request` does with what it produced.
 */
const axios = require('axios');
const { NtlmClient } = require('axios-ntlm');
const { addDigestInterceptor, addEdgeGridInterceptor, applyOAuth1ToRequest, makeAxiosInstance } = require('@usebruno/requests');
const prepareRequest = require('../../../runner/prepare-request');
const { addAwsV4Interceptor, resolveAwsV4Credentials } = require('../../../runner/awsv4auth-helper');
const { getOAuth2Token } = require('../../../utils/oauth2');
const { agentsFor } = require('./network');

/**
 * Digest and NTLM authenticate against a challenge, and both read it off a *rejected* 401 — the
 * interceptor in `@usebruno/requests` and the adapter in `axios-ntlm` alike. A flow's request
 * otherwise resolves on every status, because the engine judges it (§10.1), so these two modes are
 * the exception the dispatch reverses afterwards: the final 401 comes back as a response.
 */
const CHALLENGE_MODES = ['digest', 'ntlm'];

const needsChallenge = (auth) => Boolean(auth) && CHALLENGE_MODES.includes(auth.mode);

/**
 * §6.4: a header the step declared wins over the profile for that field alone. It is the only place
 * that rule can be honoured — the engine hands over the two separately precisely so a host does not
 * have to guess which of them a value came from.
 */
const withoutDeclared = (declared, fromAuth) => {
  const present = new Set(Object.keys(declared).map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(fromAuth).filter(([name]) => !present.has(name.toLowerCase())));
};

/** `bru run` carries basic auth as far as `interpolate-vars`, which is where it becomes a header. */
const basicHeader = ({ username, password }) =>
  `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;

/**
 * The token request is its own request to its own host, so it gets its own agents — the collection's
 * certificates and proxy apply to it as they do to the step's.
 *
 * A failure rejects rather than sending the step unauthenticated: `bru run` logs and carries on,
 * which for a flow would report a 401 the run cannot explain, where a transport error (§14.6) names
 * what actually went wrong.
 */
const oauth2Token = async (oauth2, { collectionPath, config }) => {
  const tokenUrl = oauth2.accessTokenUrl || oauth2.refreshTokenUrl;
  if (!tokenUrl) return null;

  const { httpAgent, httpsAgent } = await agentsFor(tokenUrl, collectionPath, config);
  try {
    return await getOAuth2Token(oauth2, makeAxiosInstance({ httpAgent, httpsAgent }));
  } catch (error) {
    throw new Error(`OAuth2 token request failed: ${error.message}`);
  }
};

/** §6.4 keeps OAuth2's placement rules; these are `run-single-request`'s, on a flow's request. */
const applyOauth2Token = (axiosRequest, oauth2, token) => {
  const { tokenPlacement = 'header', tokenHeaderPrefix = '', tokenQueryKey = 'access_token' } = oauth2;

  if (tokenPlacement === 'url') {
    const url = new URL(axiosRequest.url);
    url.searchParams.set(tokenQueryKey, token);
    axiosRequest.url = url.toString();
    return;
  }
  const header = { Authorization: `${tokenHeaderPrefix} ${token}`.trim() };
  Object.assign(axiosRequest.headers, withoutDeclared(axiosRequest.headers, header));
};

/**
 * Applies the resolved profile to `axiosRequest` and returns what the axios *instance* still needs —
 * the signing interceptors and NTLM's adapter, which attach to the instance rather than the request.
 */
const applyAuth = async (axiosRequest, auth, { collectionPath, config }) => {
  if (!auth || auth.mode === 'none') return () => {};

  const prepared = await prepareRequest(
    {
      request: {
        method: axiosRequest.method,
        url: axiosRequest.url,
        headers: [],
        params: [],
        auth,
        body: {}
      }
    },
    { pathname: collectionPath }
  );

  // An apikey placed in `queryparams` reaches the request through the URL, so this is not the same
  // string that went in.
  axiosRequest.url = prepared.url;
  const fromProfile = prepared.basicAuth
    ? { ...prepared.headers, Authorization: basicHeader(prepared.basicAuth) }
    : prepared.headers;
  Object.assign(axiosRequest.headers, withoutDeclared(axiosRequest.headers, fromProfile));

  if (prepared.oauth2) {
    const token = await oauth2Token(prepared.oauth2, { collectionPath, config });
    if (token) applyOauth2Token(axiosRequest, prepared.oauth2, token);
  }

  if (prepared.oauth1config) {
    // Signs the URL, the method and the body, and may rewrite any of the three, so it is given the
    // request itself; the query string is already on the URL, which is what the signature covers.
    axiosRequest.oauth1config = prepared.oauth1config;
    applyOAuth1ToRequest(axiosRequest, collectionPath);
  }

  return async (instance) => {
    if (prepared.ntlmConfig) {
      const client = NtlmClient(prepared.ntlmConfig, {});
      instance.defaults.adapter = (requestConfig) => client.request({ ...requestConfig, adapter: axios.getAdapter('http') });
    }
    if (prepared.awsv4config) {
      axiosRequest.awsv4config = await resolveAwsV4Credentials({ awsv4config: prepared.awsv4config });
      addAwsV4Interceptor(instance, axiosRequest);
      delete axiosRequest.awsv4config;
    }
    if (prepared.digestConfig) {
      addDigestInterceptor(instance, { ...axiosRequest, digestConfig: prepared.digestConfig });
    }
    if (prepared.edgeGridConfig) {
      addEdgeGridInterceptor(instance, { edgeGridConfig: prepared.edgeGridConfig });
    }
  };
};

module.exports = { applyAuth, needsChallenge };
