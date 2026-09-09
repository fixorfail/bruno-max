/**
 * `ExecuteRequest` for the CLI — 001 §13.2.
 *
 * The engine sends no HTTP: it materializes a request (§7) and decides which cookie jar carries it
 * (§7.6), and this dispatches it. Everything a request picks up on the way out — the resolved auth
 * profile, the collection's proxy and certificates, the jar's cookies — is the host's, and each half
 * here is the one `bru run` already uses, so a flow and a request cannot reach the same API
 * differently.
 */
const axios = require('axios');
const { getSentHeaders } = require('@usebruno/requests');
const { applyAuth, needsChallenge } = require('./auth');
const { bodyForAxios, multipartHeaders, isFormData } = require('./body');
const { createJars, applyJar } = require('./cookies');
const { collectionConfig, agentsFor } = require('./network');

const headerNamed = (headers, name) => Object.keys(headers).find((header) => header.toLowerCase() === name);

const queryString = (query) => new URLSearchParams(query.map((entry) => [entry.name, entry.value])).toString();

const createExecuteRequest = ({ collectionPath }) => {
  // One registry per flow run: the engine's ids distinguish a run, its iterations and its sub-flows
  // (§7.6), and nothing outside this run can name one of them.
  const jarFor = createJars();
  /** Read on the first request rather than up front — `validate` and `list` dispatch nothing. */
  let config;

  return async (request, ctx) => {
    config = config || collectionConfig(collectionPath);

    const headers = { ...request.headers };
    const { data, contentType } = bodyForAxios(request.body);
    const declared = headerNamed(headers, 'content-type');

    if (isFormData(data)) Object.assign(headers, multipartHeaders(data, declared && headers[declared]));
    else if (contentType && !declared) headers['content-type'] = contentType;

    const query = queryString(request.query);
    const axiosRequest = {
      method: request.method,
      // The query goes onto the URL rather than into axios `params`, because §6.4's signing modes
      // sign the URL and a signature covering a query the server did receive is the point.
      url: query ? `${request.url}?${query}` : request.url,
      headers,
      data,
      signal: ctx.signal,
      timeout: ctx.timeoutMs,
      // The engine judges the status (§10.1); axios treating a 4xx as a rejection would turn a
      // negative test into a transport error. A challenge mode is the one exception — see `auth.js`.
      validateStatus: needsChallenge(request.auth) ? (status) => status !== 401 : () => true,
      transformResponse: (raw) => raw
    };

    const configureInstance = await applyAuth(axiosRequest, request.auth, { collectionPath, config });
    const { httpAgent, httpsAgent } = await agentsFor(axiosRequest.url, collectionPath, config, ctx.variables);
    axiosRequest.httpAgent = httpAgent;
    axiosRequest.httpsAgent = httpsAgent;

    // `proxy: false` for the reason every other Bruno instance sets it: the agents above already
    // carry the collection's proxy decision, and axios' own environment handling would be a second.
    const instance = axios.create({ proxy: false });
    applyJar(instance, jarFor(ctx.cookieJar.id));
    await configureInstance(instance);

    const startedAt = Date.now();
    let response;
    try {
      response = await instance(axiosRequest);
    } catch (error) {
      // A challenge that was never answered ends as a 401, which is a response the engine judges
      // rather than a transport failure.
      if (!error.response) throw error;
      response = error.response;
    }

    const text = typeof response.data === 'string' ? response.data : '';
    let parsed = response.data;
    if (text && String(response.headers['content-type'] || '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    // What went out on the wire, rather than what was assembled above: §13.2 keeps auth, the body's
    // content type and the jar's cookies with the host, so a capture reporting only the declared
    // headers would not be the request that was sent.
    const sentHeaders = getSentHeaders(response.request);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: parsed,
      bytes: text ? Buffer.from(text) : undefined,
      responseTimeMs: Date.now() - startedAt,
      size: { body: text.length, headers: 0 },
      requestHeaders: Object.keys(sentHeaders).length ? sentHeaders : undefined
    };
  };
};

module.exports = { createExecuteRequest };
