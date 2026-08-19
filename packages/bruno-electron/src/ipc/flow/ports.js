const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { runScriptInNodeVm } = require('@usebruno/js');
const { createRedactor } = require('@bruno-max/flow');
const { configureRequest } = require('../network');
const { setAuthHeaders } = require('../network/prepare-request');
const { proxySwaggerFetch } = require('../swagger-fetch');
const { addCookieToJar } = require('../../utils/cookies');
const { preferencesUtil } = require('../../store/preferences');
const CollectionSecurityStore = require('../../store/collection-security');

/**
 * The app's half of the engine boundary — 001 §13.2.
 *
 * `@bruno-max/flow` sends no HTTP, touches no `fs` and selects no script runtime. What makes the app
 * worth running a flow in rather than shelling out to `bru` is that its dispatch port is the app's
 * own request path (002 §7.3): `configureRequest` is what applies proxy settings, client
 * certificates, the cookie jar and the OAuth2 token cache, so a flow step inherits all four without
 * flows implementing any of them.
 */

const collectionSecurityStore = new CollectionSecurityStore();

/**
 * `configureRequest` reads only `promptVariables` and the bruno config off the collection, and a
 * flow has neither — it resolves its own operations from OpenAPI (001 §6). `proxySwaggerFetch`
 * passes the same empty shape for the same reason.
 */
const flowCollection = { promptVariables: {} };

const bodyForRequest = (body) => {
  switch (body.kind) {
    case 'none':
      return {};
    case 'json':
      return { data: JSON.stringify(body.value), contentType: 'application/json' };
    case 'text':
      return { data: body.value, contentType: body.contentType };
    case 'urlencoded':
      return {
        data: new URLSearchParams(body.fields.map((field) => [field.name, field.value])).toString(),
        contentType: 'application/x-www-form-urlencoded'
      };
    case 'binary':
      return { data: body.file.bytes, contentType: body.file.contentType };
    case 'multipart': {
      const form = new FormData();
      for (const part of body.parts) {
        if (part.kind === 'file') {
          form.append(part.name, part.file.bytes, { filename: part.file.filename, contentType: part.file.contentType });
        } else {
          form.append(part.name, part.value, part.contentType ? { contentType: part.contentType } : undefined);
        }
      }
      return { data: form.getBuffer(), contentType: form.getHeaders()['content-type'] };
    }
    default:
      throw new Error(`unsupported body kind: ${body.kind}`);
  }
};

const parseBody = (bytes, contentType) => {
  const text = bytes.toString('utf8');
  if (!text || !String(contentType || '').includes('json')) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    // A response that claims JSON and is not one is the server's problem to report, not a reason
    // for the step to fail before its assertions run (001 §13.2 — parsed where parsing succeeded).
    return text;
  }
};

const plainHeaders = (headers) =>
  typeof headers?.toJSON === 'function' ? headers.toJSON() : { ...(headers || {}) };

const saveCookies = (url, headers) => {
  if (!preferencesUtil.shouldStoreCookies()) {
    return;
  }

  const setCookie = headers['set-cookie'];
  for (const header of [].concat(setCookie || [])) {
    if (typeof header === 'string' && header.length) {
      addCookieToJar(header, url);
    }
  }
};

/**
 * A body larger than this is reported as absent to the network log (002 §8.5). Unlike the single
 * response of an ordinary request, a run's bodies accumulate — one per attempt, and a poll makes
 * twenty of those — so the whole run would otherwise sit base64-encoded in the renderer's store.
 * The capture keeps the real bytes either way, which is where a large body is meant to be read.
 */
const MAX_LOGGED_BODY_BYTES = 1024 * 1024;

/** The query is on the axios config, and a row keyed by a URL without it names the wrong request. */
const loggedUrl = (url, params) => {
  const query = params.toString();
  if (!query) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

/**
 * 002 §8.5. Only a string body is reported: a `binary` or `multipart` body is a Buffer here, and
 * either rendering its bytes or restating the capture's structural summary would put a second,
 * weaker description of a body in the app. The step pane reads the capture for those.
 */
const loggedRequestBody = (data) => (typeof data === 'string' && data.length <= MAX_LOGGED_BODY_BYTES ? data : null);

/**
 * 002 §8.5 — what the dispatch port tells the app about a request it just sent.
 *
 * Headers go through 001 §14.4's denylist with the run's own `config.redactHeaders`, taken from
 * `ctx` so the panel and the capture mask the same set. The shape is the one the DevTools network
 * tab already reads for an ordinary request, so nothing downstream learns that flows exist.
 */
const requestLog = ({ request, axiosRequest, ctx, startedAt, response, bytes, error }) => {
  const redactor = createRedactor(ctx.redactHeaders);

  return {
    runId: ctx.runId,
    stepId: ctx.stepId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    // Both halves of the scope: the renderer resolves a collection from the first and falls back to
    // the second's scratch collection, the way a workspace-scoped flow's own tab already does.
    collectionRoot: ctx.scope.collectionRoot,
    workspaceRoot: ctx.scope.workspaceRoot,
    timestamp: startedAt,
    request: {
      url: loggedUrl(axiosRequest.url, axiosRequest.params),
      method: request.method,
      headers: redactor.headers(axiosRequest.headers),
      data: loggedRequestBody(axiosRequest.data)
    },
    response: error
      ? { error: error.message }
      : {
          status: response.status,
          statusText: response.statusText,
          headers: redactor.headers(response.headers),
          data: bytes.length <= MAX_LOGGED_BODY_BYTES ? response.body : null,
          dataBuffer: bytes.length <= MAX_LOGGED_BODY_BYTES ? bytes.toString('base64') : null,
          size: bytes.length,
          duration: response.responseTimeMs
        }
  };
};

/**
 * 001 §7.6's per-run and per-iteration jar scoping is not honoured yet: `utils/cookies` is a single
 * process-wide jar, so `ctx.cookieJar` has nowhere to map to. Iterations of a dataset flow therefore
 * share cookies in the app, which 001 §7.6 says they must not.
 */
const executeRequest = ({ collectionRoot, onRequest }) => async (request, ctx) => {
  const { data, contentType } = bodyForRequest(request.body);
  const headers = { ...request.headers };
  if (contentType && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = contentType;
  }

  const axiosRequest = {
    method: request.method,
    url: request.url,
    params: new URLSearchParams(request.query.map((entry) => [entry.name, entry.value])),
    headers,
    data,
    responseType: 'arraybuffer',
    signal: ctx.signal,
    // The engine judges the status (001 §10.1); axios rejecting a 4xx would turn a negative test
    // into a transport error.
    validateStatus: () => true
  };

  setAuthHeaders(axiosRequest, request, undefined);
  const axiosInstance = await configureRequest(
    undefined,
    flowCollection,
    axiosRequest,
    {},
    {},
    {},
    collectionRoot || '',
    {}
  );

  // After `configureRequest`, which overwrites `timeout` with the global preference. A step's
  // per-attempt timeout (001 §11.1) is the engine's decision and outranks it.
  if (ctx.timeoutMs) {
    axiosRequest.timeout = ctx.timeoutMs;
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await axiosInstance(axiosRequest);
  } catch (error) {
    // The engine maps this rejection to `transport-error` (001 §13.2), and a request that never got
    // a response is the case the network log is most needed for — so it is reported before the
    // rejection travels on.
    onRequest?.(requestLog({ request, axiosRequest, ctx, startedAt, error }));
    throw error;
  }

  const headersReceived = plainHeaders(response.headers);
  const duration = headersReceived['request-duration'];
  delete headersReceived['request-duration'];

  saveCookies(axiosRequest.url, headersReceived);

  const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');
  const executed = {
    status: response.status,
    statusText: response.statusText,
    headers: headersReceived,
    body: parseBody(bytes, headersReceived['content-type']),
    bytes,
    responseTimeMs: Number(duration) || Date.now() - startedAt,
    size: { body: bytes.length, headers: 0 },
    // Read after `setAuthHeaders` and `configureRequest`, so the capture (001 §14.5) records the
    // request that went out rather than the one the step declared — the difference is the auth
    // header, the content type, and anything the proxy or cookie jar added.
    requestHeaders: plainHeaders(axiosRequest.headers)
  };

  onRequest?.(requestLog({ request, axiosRequest, ctx, startedAt, response: executed, bytes }));
  return executed;
};

/**
 * The script's value comes back through a host object on the context, because the sandbox wraps a
 * script in an async closure and discards what it evaluates to — the same mechanism the CLI uses.
 *
 * **A safe-mode collection refuses rather than silently escalating.** `getJsSandboxRuntime` gives
 * quickjs by default, and quickjs discards the evaluated value entirely
 * (`bruno-js/src/sandbox/quickjs/index.js` returns nothing), so there is no way to serve a flow's
 * `script:` form from it without changing bruno-js. Running it in the node VM instead would hand a
 * user who chose the sandbox an unsandboxed script.
 */
const runScript = ({ collectionRoot, workspaceRoot }) => async (source, args) => {
  const { jsSandboxMode } = collectionRoot ? collectionSecurityStore.getSecurityConfigForCollection(collectionRoot) : {};
  if (collectionRoot && jsSandboxMode !== 'developer') {
    throw new Error('flows cannot run scripts in a safe-mode collection: the quickjs sandbox discards the value');
  }

  const box = { args, result: undefined };
  await runScriptInNodeVm({
    script: '__flow.result = await (' + source + ')(...__flow.args);',
    context: { __flow: box, console },
    /**
     * The VM resolves `require` against this, so it is a *path* and not optional: without one it
     * throws `The "path" argument must be of type string`, and 001 §8.2's script positions are
     * `outputs`, `when:` and `shouldRetry` — so the failure lands as a `script-error` on the step,
     * blaming the author's script for a host that handed the VM nothing.
     *
     * A workspace-scoped flow has no collection (002 §7.2), and its scope root is the workspace —
     * the same fallback `bru` makes, so a script behaves identically in both hosts.
     */
    collectionPath: collectionRoot || workspaceRoot,
    scriptingConfig: {}
  });
  return box.result;
};

const readSpec = async (source) => {
  if (!/^https?:\/\//.test(source)) {
    return { text: await fs.promises.readFile(source, 'utf8'), from: 'file' };
  }

  const response = await proxySwaggerFetch({ url: source, method: 'GET' });
  if (response.error) {
    throw new Error(`could not fetch ${source}: ${response.message}`);
  }
  return { text: Buffer.from(response.bodyBase64, 'base64').toString('utf8'), from: 'network' };
};

const createPorts = ({ collectionRoot, workspaceRoot, onRequest }) => ({
  executeRequest: executeRequest({ collectionRoot, onRequest }),
  readFile: async (target) => fs.promises.readFile(target),
  writeFile: async (target, data) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  },
  listDirectory: async (target) => fs.promises.readdir(target),
  // force only suppresses ENOENT; Windows locks aggressively enough that a retry is not optional.
  removeDirectory: async (target) =>
    fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  readSpec,
  runScript: runScript({ collectionRoot, workspaceRoot })
});

module.exports = { createPorts, bodyForRequest, parseBody, MAX_LOGGED_BODY_BYTES };
