const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { runScriptInNodeVm } = require('@usebruno/js');
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
 * 001 §7.6's per-run and per-iteration jar scoping is not honoured yet: `utils/cookies` is a single
 * process-wide jar, so `ctx.cookieJar` has nowhere to map to. Iterations of a dataset flow therefore
 * share cookies in the app, which 001 §7.6 says they must not.
 */
const executeRequest = ({ collectionRoot }) => async (request, ctx) => {
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
  const response = await axiosInstance(axiosRequest);
  const headersReceived = plainHeaders(response.headers);
  const duration = headersReceived['request-duration'];
  delete headersReceived['request-duration'];

  saveCookies(axiosRequest.url, headersReceived);

  const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersReceived,
    body: parseBody(bytes, headersReceived['content-type']),
    bytes,
    responseTimeMs: Number(duration) || Date.now() - startedAt,
    size: { body: bytes.length, headers: 0 }
  };
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
const runScript = (collectionRoot) => async (source, args) => {
  const { jsSandboxMode } = collectionRoot ? collectionSecurityStore.getSecurityConfigForCollection(collectionRoot) : {};
  if (collectionRoot && jsSandboxMode !== 'developer') {
    throw new Error('flows cannot run scripts in a safe-mode collection: the quickjs sandbox discards the value');
  }

  const box = { args, result: undefined };
  await runScriptInNodeVm({
    script: '__flow.result = await (' + source + ')(...__flow.args);',
    context: { __flow: box, console },
    collectionPath: collectionRoot,
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

const createPorts = ({ collectionRoot }) => ({
  executeRequest: executeRequest({ collectionRoot }),
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
  runScript: runScript(collectionRoot)
});

module.exports = { createPorts, bodyForRequest, parseBody };
