const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { runScriptInNodeVm } = require('@usebruno/js');
const { runScriptInQuickJsForValue } = require('@usebruno/js/src/fork/quickjs-value-runner');
const { createRedactor } = require('@bruno-max/flow');
const { configureRequest } = require('../network');
const { setAuthHeaders } = require('../network/prepare-request');
const { proxySwaggerFetch } = require('../swagger-fetch');
const { cookieJar: globalCookieJar } = require('../../utils/cookies');
const { preferencesUtil } = require('../../store/preferences');
const CollectionSecurityStore = require('../../store/collection-security');
const { readBrunoConfig } = require('./collectionConfig');

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
 * The collection `configureRequest` is handed, which it reads exactly two things off: the prompt
 * variables — a flow has none, it resolves its own operations from OpenAPI (001 §6) — and the bruno
 * config, which is where §7.4's proxy and client-certificate configuration lives.
 *
 * **The config arrives through `draft`** because that is `getBrunoConfig`'s caller-supplied branch:
 * its other branch is a cache keyed by the `collectionUid` the renderer mints with `uuid()`, and the
 * flow host is handed a path (002 §7.2) rather than a uid, so there is nothing to look up with. Read
 * once per run and only when a step actually dispatches — `createPorts` is also called for a describe
 * or a validate, which never open a socket.
 */
const collectionReader = (collectionRoot) => {
  // The promise, not its value: at `concurrency: 5` five first steps ask at once, and memoizing the
  // answer would read the file five times before the first read had one to memoize.
  let collection;
  return () => {
    if (!collection) {
      collection = (collectionRoot ? readBrunoConfig(collectionRoot) : Promise.resolve({})).then(
        (brunoConfig) => ({ promptVariables: {}, draft: { brunoConfig } })
      );
    }
    return collection;
  };
};

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

/**
 * 001 §7.6: one jar per run, its own jar per dataset iteration, inherited by sub-flows — the engine
 * expresses exactly that scoping as `ctx.cookieJar.id` and never looks inside it. A jar is created
 * the moment its id is first seen in this run and lives for the rest of the run in `jars`, seeded
 * from the app's own process-wide jar the way a single request is today (001 §7.6's "cookies set
 * before a run"); from there it diverges, so two iterations that log in as different users each
 * carry only their own session, and a sub-flow reusing its caller's id shares that caller's cookies
 * without touching anyone else's.
 */
const jarFor = (jars, cookieJar) => {
  let jar = jars.get(cookieJar.id);
  if (!jar) {
    jar = CookieJar.deserializeSync(globalCookieJar.serializeSync());
    jars.set(cookieJar.id, jar);
  }
  return jar;
};

const cookieHeaderName = (headers) => Object.keys(headers).find((name) => name.toLowerCase() === 'cookie');

const parseCookiePairs = (value) =>
  (value || '').split(';').reduce((cookies, pair) => {
    const [name, ...rest] = pair.split('=');
    if (name && name.trim()) {
      cookies[name.trim()] = rest.join('=').trim();
    }
    return cookies;
  }, {});

/**
 * Mirrors `configureRequest`'s own cookie-header merge (`ipc/network/index.js`), against this run's
 * jar instead of the app's process-wide one. `configureRequest` already wrote a `Cookie` header from
 * the process-wide jar by the time this runs — §7.6 gives the run's jar the final say, so this
 * replaces it rather than merging with it, keeping only what the step itself declared plus what this
 * run's jar carries for the URL.
 */
const applyCookieJar = (axiosRequest, jar, declaredName, declaredCookie) => {
  if (!preferencesUtil.shouldSendCookies()) {
    return;
  }

  const jarCookieString = jar.getCookieStringSync(axiosRequest.url);
  const merged = { ...parseCookiePairs(declaredCookie), ...parseCookiePairs(jarCookieString) };
  const combined = Object.entries(merged)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

  if (combined) {
    axiosRequest.headers[declaredName || 'Cookie'] = combined;
  } else if (declaredName) {
    delete axiosRequest.headers[declaredName];
  }
};

const saveCookiesToJar = (jar, url, headers) => {
  if (!preferencesUtil.shouldStoreCookies()) {
    return;
  }

  const setCookie = headers['set-cookie'];
  for (const header of [].concat(setCookie || [])) {
    if (typeof header === 'string' && header.length) {
      jar.setCookieSync(header, url, { ignoreError: true });
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

const executeRequest = ({ collectionRoot, readCollection, onRequest, jars }) => async (request, ctx) => {
  const { data, contentType } = bodyForRequest(request.body);
  const headers = { ...request.headers };
  if (contentType && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = contentType;
  }

  const jar = jarFor(jars, ctx.cookieJar);
  const declaredCookieName = cookieHeaderName(headers);
  const declaredCookie = declaredCookieName ? headers[declaredCookieName] : '';

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
  /**
   * 001 §7.4 — the run's variables, in the slot the request path interpolates proxy and certificate
   * configuration from.
   *
   * `getCertsAndProxyConfig` builds one `interpolationOptions` out of the maps it is handed and uses
   * it for a client certificate's `domain`, `certFilePath`, `keyFilePath`, `pfxFilePath` and
   * `passphrase`; `setupProxyAgents` uses the same object later for the proxy's `protocol`,
   * `hostname`, `port` and `auth`. Handing the run's variables in as `runtimeVariables` is therefore
   * the whole of it — every field the request path interpolates, interpolated from the flow's own
   * scope, with no second implementation of the interpolation here to drift from that one.
   *
   * `runtimeVariables` rather than one of the other four tiers because `ctx.variables` is already
   * §7.3's chain resolved: the engine merged the tiers, and re-splitting a resolved map across slots
   * whose only purpose is precedence would invent a precedence the flow does not have.
   */
  const axiosInstance = await configureRequest(
    undefined,
    await readCollection(),
    axiosRequest,
    {},
    ctx.variables || {},
    {},
    collectionRoot || '',
    {}
  );

  // After `configureRequest`, which overwrites `timeout` with the global preference. A step's
  // per-attempt timeout (001 §11.1) is the engine's decision and outranks it.
  if (ctx.timeoutMs) {
    axiosRequest.timeout = ctx.timeoutMs;
  }

  // After `configureRequest`, which wrote a `Cookie` header from the app's process-wide jar —
  // §7.6 gives this run's own jar the final say over what actually goes out.
  applyCookieJar(axiosRequest, jar, declaredCookieName, declaredCookie);

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

  saveCookiesToJar(jar, axiosRequest.url, headersReceived);

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
 * 001 §8.2: flow scripts run in the collection's own sandbox mode, never a stronger one than the
 * collection chose — and, where there is no collection to have chosen, in the safe one.
 * `getJsSandboxRuntime`'s node:vm path returns its value through a host object on
 * the context, because that sandbox wraps a script in an async closure and discards what it
 * evaluates to; QuickJS's own closure (`wrapScriptInClosure`, `bruno-js/src/sandbox/quickjs/index.js`)
 * does the same, always resolving to the fixed string `'done'`. `runScriptInQuickJsForValue`
 * (`bruno-js/src/fork/quickjs-value-runner.js`) is a second QuickJS entry point built for exactly
 * this: it dumps the value out of the VM instead of discarding it, so a safe-mode collection gets a
 * real sandbox rather than a refusal or an escalation to node:vm.
 */
const runScript = ({ collectionRoot, workspaceRoot }) => async (source, args) => {
  /**
   * **A flow with no collection has no `securityConfig` to read, and defaults to `safe`.**
   * `jsSandboxMode` is a collection's setting, and a workspace-scoped flow has no collection by
   * construction (002 §7.2) — so the absent answer has to mean something, and the only safe reading
   * is the one `bru run` already makes and the one a collection gets when nobody has chosen:
   * QuickJS. Keying the gate on `collectionRoot` made the absence mean `developer` instead, so the
   * flow the app can least attribute to a collection's own decision was the one that got node:vm.
   */
  const { jsSandboxMode } = collectionRoot ? collectionSecurityStore.getSecurityConfigForCollection(collectionRoot) : {};

  if (jsSandboxMode !== 'developer') {
    return runScriptInQuickJsForValue({ source, args, console });
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
     * The fallback is the scope-root rule (002 §7.3), not a live branch: since the safe default
     * above took the no-collection case, only a collection that chose `developer` reaches node:vm,
     * so `collectionRoot` is always the answer here. It stays stated because the path this VM gets
     * is the flow's scope root either way, and a gate that changes should not have to rediscover it.
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
  // One map per `createPorts` call, which is one per run (`ipc/flow/index.js`) — its lifetime is
  // the run's, exactly what §7.6's per-run and per-iteration jars need. The collection reader is
  // scoped the same way: one read of the bruno config per run, however many steps dispatch.
  executeRequest: executeRequest({
    collectionRoot,
    readCollection: collectionReader(collectionRoot),
    onRequest,
    jars: new Map()
  }),
  readFile: async (target) => fs.promises.readFile(target),
  writeFile: async (target, data) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  },
  listDirectory: async (target) => fs.promises.readdir(target),
  readSpec,
  runScript: runScript({ collectionRoot, workspaceRoot })
});

module.exports = { createPorts, bodyForRequest, parseBody, MAX_LOGGED_BODY_BYTES };
