jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), on: jest.fn() } }));
jest.mock('../network', () => ({ configureRequest: jest.fn() }));
jest.mock('../network/prepare-request', () => ({ setAuthHeaders: jest.fn() }));
jest.mock('../swagger-fetch', () => ({ proxySwaggerFetch: jest.fn() }));
jest.mock('../../utils/cookies', () => {
  const { CookieJar } = require('tough-cookie');
  return { cookieJar: new CookieJar() };
});
jest.mock('../../store/preferences', () => ({
  preferencesUtil: {
    shouldStoreCookies: jest.fn(() => false),
    shouldSendCookies: jest.fn(() => false),
    // What the real `getCertsAndProxyConfig` reads — U5.15 runs it rather than stubbing it.
    // TLS verification off keeps the CA bundle out of a unit test; nothing below turns on TLS.
    shouldVerifyTls: jest.fn(() => false),
    shouldUseCustomCaCertificate: jest.fn(() => false),
    getCustomCaCertificateFilePath: jest.fn(() => null),
    shouldKeepDefaultCaCertificates: jest.fn(() => true),
    getGlobalClientCertificates: jest.fn(() => []),
    getGlobalProxyConfig: jest.fn(() => ({ disabled: true })),
    isSslSessionCachingEnabled: jest.fn(() => false)
  }
}));
let mockSecurityConfig = { jsSandboxMode: 'developer' };
jest.mock('../../store/collection-security', () =>
  jest.fn().mockImplementation(() => ({ getSecurityConfigForCollection: () => mockSecurityConfig }))
);
/**
 * Both script runtimes stay real — a stub would let this file assert that a function was called
 * rather than that a script ran — and are only wrapped so a scenario can say *which* sandbox took a
 * script. `(value) => value + 1` answers 2 either way, which is exactly why the branch needs naming.
 */
jest.mock('@usebruno/js', () => {
  const actual = jest.requireActual('@usebruno/js');
  return { ...actual, runScriptInNodeVm: jest.fn(actual.runScriptInNodeVm) };
});
jest.mock('@usebruno/js/src/fork/quickjs-value-runner', () => {
  const actual = jest.requireActual('@usebruno/js/src/fork/quickjs-value-runner');
  return { ...actual, runScriptInQuickJsForValue: jest.fn(actual.runScriptInQuickJsForValue) };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { configureRequest } = require('../network');
const { runScriptInNodeVm } = require('@usebruno/js');
const { runScriptInQuickJsForValue } = require('@usebruno/js/src/fork/quickjs-value-runner');
const { cookieJar: globalCookieJar } = require('../../utils/cookies');
const { preferencesUtil } = require('../../store/preferences');
const { createPorts, MAX_LOGGED_BODY_BYTES } = require('./ports');

/**
 * The dispatch port's half of 002 §8.5 — what the app learns about a request a flow sent.
 *
 * Redaction is not mocked: the point of the port taking `ctx.redactHeaders` is that the panel and
 * the capture mask the same set, and a stubbed redactor would assert that a function was called
 * rather than that a token stayed out of the renderer.
 */

const request = (overrides = {}) => ({
  method: 'POST',
  url: 'https://api.example.com/things',
  query: [{ name: 'page', value: '2' }],
  headers: { 'Authorization': 'Bearer sk_live_secret', 'X-Legacy-Key': 'legacy', 'X-Trace-Id': 'trace-1' },
  body: { kind: 'json', value: { name: 'widget' } },
  ...overrides
});

const context = (overrides = {}) => ({
  runId: 'run-a',
  stepId: 'create',
  iteration: 0,
  attempt: 1,
  scope: { workspaceRoot: '/workspace', collectionRoot: '/workspace/collections/payments' },
  redactHeaders: ['X-Legacy-Key'],
  cookieJar: { id: 'jar-a' },
  signal: new AbortController().signal,
  ...overrides
});

const respondWith = (response) => {
  configureRequest.mockResolvedValue(async () => response);
};

const rejectWith = (error) => {
  configureRequest.mockResolvedValue(async () => {
    throw error;
  });
};

const ok = (body = '{"id":"thing-1"}') => ({
  status: 201,
  statusText: 'Created',
  headers: { 'content-type': 'application/json', 'set-cookie': ['session=abc'], 'request-duration': '42' },
  data: Buffer.from(body)
});

const dispatch = async ({ onRequest, ...overrides }) => {
  const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments', onRequest });
  return executeRequest(request(overrides.request), context(overrides.ctx));
};

beforeEach(() => {
  globalCookieJar.removeAllCookiesSync();
  preferencesUtil.shouldStoreCookies.mockReturnValue(false);
  preferencesUtil.shouldSendCookies.mockReturnValue(false);
  mockSecurityConfig = { jsSandboxMode: 'developer' };
  runScriptInNodeVm.mockClear();
  runScriptInQuickJsForValue.mockClear();
});

/**
 * 001 §8.2's script positions — `outputs`, `when:` and `shouldRetry` — through the app's host.
 *
 * The node:vm path resolves `require` against a path, so handing it nothing throws `The "path"
 * argument must be of type string` and the engine reports it as `script-error` on the step: the
 * author's script blamed for a host that supplied no path. A workspace-scoped flow has no collection
 * (002 §7.2), which is exactly when that happened — it now takes the safe sandbox instead (U5.16
 * below), which needs no path at all, and the scope-root fallback covers a collection that opted
 * into node:vm.
 */
describe('the flow script port', () => {
  it('runs a script for a flow with no collection', async () => {
    const { runScript } = createPorts({ workspaceRoot: '/workspace' });

    await expect(runScript('(value) => value + 1', [1])).resolves.toBe(2);
  });

  it('runs one for a collection-scoped flow as before', async () => {
    const { runScript } = createPorts({
      collectionRoot: '/workspace/collections/payments',
      workspaceRoot: '/workspace'
    });

    await expect(runScript('(value) => value * 2', [21])).resolves.toBe(42);
  });

  /**
   * 002-C U5.11 — 001 §8.2's "no new security posture": a safe-mode collection's flow scripts run
   * in the QuickJS sandbox rather than being refused or escalated to node:vm.
   */
  describe('in a safe-mode collection (002-C U5.11)', () => {
    beforeEach(() => {
      mockSecurityConfig = { jsSandboxMode: 'safe' };
    });

    it('runs the script in QuickJS and returns its value', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await expect(runScript('(value) => value * 2', [21])).resolves.toBe(42);
    });

    it('awaits an async script before returning its value', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await expect(runScript('async (value) => { await null; return value + 1; }', [1])).resolves.toBe(2);
    });

    it('resolves an object value, not just a primitive', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await expect(runScript('(a, b) => ({ sum: a + b })', [1, 2])).resolves.toEqual({ sum: 3 });
    });

    /** 001 §8.2: a throwing script fails the position rather than being read as an answer. */
    it('rejects when the script throws', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await expect(runScript('() => { throw new Error("boom"); }', [])).rejects.toThrow('boom');
    });

    it('takes the QuickJS runner rather than node:vm', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await runScript('(value) => value * 2', [21]);

      expect(runScriptInQuickJsForValue).toHaveBeenCalledTimes(1);
      expect(runScriptInNodeVm).not.toHaveBeenCalled();
    });
  });

  /**
   * 002-C U5.16 — a workspace-scoped flow has no collection to have chosen a sandbox, and the absent
   * answer is `safe`.
   *
   * `mockSecurityConfig` is left at `developer` throughout: the point is that a flow with no
   * collection never reads it at all, rather than reading some other collection's.
   */
  describe('for a flow with no collection (002-C U5.16)', () => {
    it('runs the script in the safe sandbox by default, never node:vm', async () => {
      const { runScript } = createPorts({ workspaceRoot: '/workspace' });

      await expect(runScript('(value) => value + 1', [1])).resolves.toBe(2);
      expect(runScriptInQuickJsForValue).toHaveBeenCalledTimes(1);
      expect(runScriptInNodeVm).not.toHaveBeenCalled();
    });

    it('still fails the position when the script throws', async () => {
      const { runScript } = createPorts({ workspaceRoot: '/workspace' });

      await expect(runScript('() => { throw new Error("boom"); }', [])).rejects.toThrow('boom');
    });

    /** The escalation is a collection's to make, so a collection-scoped flow still gets node:vm. */
    it('leaves a developer-mode collection on node:vm', async () => {
      const { runScript } = createPorts({
        collectionRoot: '/workspace/collections/payments',
        workspaceRoot: '/workspace'
      });

      await expect(runScript('(value) => value + 1', [1])).resolves.toBe(2);
      expect(runScriptInNodeVm).toHaveBeenCalledTimes(1);
      expect(runScriptInQuickJsForValue).not.toHaveBeenCalled();
    });
  });
});

/**
 * 002-C U5.15 — 001 §7.4's proxy and client-certificate configuration, interpolated with the run's
 * own variables.
 *
 * The assertion runs the **real** `getCertsAndProxyConfig` over the arguments the port handed
 * `configureRequest`, because those arguments are the whole of the behaviour: the request path owns
 * the interpolation, and a test that only inspected the call would pass just as well if the config
 * never reached the collection or the variables never reached a tier the interpolation reads.
 */
describe('a flow step\'s proxy and certificate configuration (002-C U5.15)', () => {
  let collectionPath;

  const brunoConfig = {
    version: '1',
    name: 'payments',
    type: 'collection',
    proxy: {
      inherit: false,
      config: {
        protocol: 'http',
        hostname: '{{proxyHost}}',
        port: '8080',
        auth: { username: '{{proxyUser}}', password: '{{proxyPassword}}' }
      }
    },
    clientCertificates: {
      certs: [
        {
          domain: 'api.example.com',
          type: 'cert',
          certFilePath: '{{certDir}}/client.pem',
          keyFilePath: '{{certDir}}/client.key'
        }
      ]
    }
  };

  const variables = {
    proxyHost: 'proxy.internal',
    proxyUser: 'flow-runner',
    proxyPassword: 'sk_proxy_secret',
    certDir: 'certs'
  };

  beforeEach(() => {
    configureRequest.mockReset();
    collectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-collection-'));
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify(brunoConfig));
    fs.mkdirSync(path.join(collectionPath, 'certs'));
    fs.writeFileSync(path.join(collectionPath, 'certs', 'client.pem'), 'the-client-cert');
    fs.writeFileSync(path.join(collectionPath, 'certs', 'client.key'), 'the-client-key');
  });

  afterEach(() => {
    fs.rmSync(collectionPath, { recursive: true, force: true });
  });

  /** What `configureRequest` does with its arguments, run for real over the ones the port passed. */
  const certsAndProxyFor = async (call) => {
    const [collectionUid, collection, request, envVars, runtimeVariables, processEnvVars, path_, globals]
      = call;
    const { getCertsAndProxyConfig } = jest.requireActual('../network/cert-utils');
    return getCertsAndProxyConfig({
      collectionUid,
      collection,
      request,
      envVars,
      runtimeVariables,
      processEnvVars,
      collectionPath: path_,
      globalEnvironmentVariables: globals
    });
  };

  const dispatchInCollection = async () => {
    respondWith(ok());
    const { executeRequest } = createPorts({ collectionRoot: collectionPath });
    await executeRequest(request(), context({ scope: { workspaceRoot: '/workspace', collectionRoot: collectionPath }, variables }));
    return configureRequest.mock.calls[0];
  };

  it('resolves {{proxyHost}} in the collection\'s proxy config from the run\'s variables', async () => {
    const { proxyMode, proxyConfig, interpolationOptions } = await certsAndProxyFor(await dispatchInCollection());
    const { interpolateString } = jest.requireActual('../network/interpolate-string');

    expect(proxyMode).toBe('on');
    expect(interpolateString(proxyConfig.hostname, interpolationOptions)).toBe('proxy.internal');
  });

  /** `setupProxyAgents` builds the proxy URI out of all four, from this same options object. */
  it('resolves the proxy\'s credentials the same way', async () => {
    const { proxyConfig, interpolationOptions } = await certsAndProxyFor(await dispatchInCollection());
    const { interpolateString } = jest.requireActual('../network/interpolate-string');

    expect(interpolateString(proxyConfig.auth.username, interpolationOptions)).toBe('flow-runner');
    expect(interpolateString(proxyConfig.auth.password, interpolationOptions)).toBe('sk_proxy_secret');
  });

  /** A cert path is interpolated inside `getCertsAndProxyConfig`, which then reads the file. */
  it('loads the client certificate {{certDir}} names, relative to the collection', async () => {
    const { httpsAgentRequestFields } = await certsAndProxyFor(await dispatchInCollection());

    expect(httpsAgentRequestFields.cert.toString()).toBe('the-client-cert');
    expect(httpsAgentRequestFields.key.toString()).toBe('the-client-key');
  });

  it('reads the collection config once for a run, however many steps dispatch', async () => {
    respondWith(ok());
    const { executeRequest } = createPorts({ collectionRoot: collectionPath });
    const ctx = context({ scope: { workspaceRoot: '/workspace', collectionRoot: collectionPath }, variables });

    await executeRequest(request(), ctx);
    fs.rmSync(path.join(collectionPath, 'bruno.json'));
    await executeRequest(request(), ctx);

    const [, first] = configureRequest.mock.calls[0];
    const [, second] = configureRequest.mock.calls[1];
    expect(second).toBe(first);
    expect(second.draft.brunoConfig.proxy.config.hostname).toBe('{{proxyHost}}');
  });

  /** A workspace-scoped flow has no collection to read a proxy or a certificate off (002 §7.2). */
  it('leaves a workspace-scoped flow with the empty config', async () => {
    respondWith(ok());
    const { executeRequest } = createPorts({ workspaceRoot: '/workspace' });
    await executeRequest(request(), context({ scope: { workspaceRoot: '/workspace' }, variables }));

    const [, collection] = configureRequest.mock.calls[0];
    expect(collection.draft.brunoConfig).toEqual({});
  });
});

describe('the flow dispatch port', () => {
  beforeEach(() => {
    configureRequest.mockReset();
  });

  it('reports the request it sent, with the query on the URL', async () => {
    respondWith(ok());
    const onRequest = jest.fn();

    await dispatch({ onRequest });

    expect(onRequest).toHaveBeenCalledTimes(1);
    const [log] = onRequest.mock.calls[0];
    expect(log.request.url).toBe('https://api.example.com/things?page=2');
    expect(log.request.method).toBe('POST');
    expect(log.request.data).toBe('{"name":"widget"}');
    expect(log.response.status).toBe(201);
    expect(log.response.data).toEqual({ id: 'thing-1' });
    expect(log.response.duration).toBe(42);
  });

  /**
   * 001 §13.2 leaves auth, content type and cookies to the host, so the engine cannot derive them —
   * and a capture built from the declared headers alone records a request nobody sent. A step that
   * declares no headers at all showed none in the step pane, which is the defect this closes.
   */
  it('reports the headers it actually wrote, not the ones the step declared', async () => {
    respondWith(ok());
    const onRequest = jest.fn();

    const executed = await dispatch({ onRequest, request: { headers: {} } });

    expect(executed.requestHeaders).toEqual({ 'content-type': 'application/json' });
  });

  /** So the renderer can attribute a row to the run, step and attempt that produced it. */
  it('names the attempt that produced it', async () => {
    respondWith(ok());
    const onRequest = jest.fn();

    await dispatch({ onRequest, ctx: { attempt: 3 } });

    // Both halves of the scope travel: the renderer needs the workspace to fall back to its scratch
    // collection when the flow names no collection of its own.
    expect(onRequest.mock.calls[0][0]).toMatchObject({
      runId: 'run-a',
      stepId: 'create',
      iteration: 0,
      attempt: 3,
      collectionRoot: '/workspace/collections/payments',
      workspaceRoot: '/workspace'
    });
  });

  /** 001 §14.4, through 002-C R3: the panel is not a way around the mask. */
  it('masks the denylist and the run own redactHeaders, and nothing else', async () => {
    respondWith(ok());
    const onRequest = jest.fn();

    await dispatch({ onRequest });

    const [log] = onRequest.mock.calls[0];
    expect(log.request.headers.Authorization).toBe('••••');
    expect(log.request.headers['X-Legacy-Key']).toBe('••••');
    expect(log.request.headers['X-Trace-Id']).toBe('trace-1');
    expect(log.response.headers['set-cookie']).toEqual(['••••']);
    expect(log.response.headers['content-type']).toBe('application/json');
  });

  it('reports a request that never got a response, and still rejects', async () => {
    rejectWith(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    const onRequest = jest.fn();

    await expect(dispatch({ onRequest })).rejects.toThrow('ECONNREFUSED');

    const [log] = onRequest.mock.calls[0];
    expect(log.request.url).toBe('https://api.example.com/things?page=2');
    expect(log.response).toEqual({ error: 'connect ECONNREFUSED 127.0.0.1:443' });
  });

  it('reports the size of a body too large to carry, and not the body', async () => {
    const large = 'x'.repeat(MAX_LOGGED_BODY_BYTES + 1);
    respondWith({ ...ok(), data: Buffer.from(large) });
    const onRequest = jest.fn();

    const executed = await dispatch({ onRequest });

    const [log] = onRequest.mock.calls[0];
    expect(log.response.size).toBe(MAX_LOGGED_BODY_BYTES + 1);
    expect(log.response.data).toBeNull();
    expect(log.response.dataBuffer).toBeNull();
    // The step itself is unaffected — the cap is the panel's, not the run's.
    expect(executed.bytes.length).toBe(MAX_LOGGED_BODY_BYTES + 1);
  });

  it('reports no request body for one that is not text', async () => {
    respondWith(ok());
    const onRequest = jest.fn();

    await dispatch({
      onRequest,
      request: { body: { kind: 'binary', file: { bytes: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' } } }
    });

    expect(onRequest.mock.calls[0][0].request.data).toBeNull();
  });

  it('sends without a reporter when the host asked for none', async () => {
    respondWith(ok());

    await expect(dispatch({ onRequest: undefined })).resolves.toMatchObject({ status: 201 });
  });
});

/**
 * 002-C U5.10 — 001 §7.6's jar scoping, expressed on the app's own dispatch port. `ctx.cookieJar.id`
 * is the engine's only word on which jar a request uses; everything below is what the port does with
 * that id.
 */
describe('the flow dispatch port\'s cookie jar (002-C U5.10)', () => {
  beforeEach(() => {
    configureRequest.mockReset();
    preferencesUtil.shouldSendCookies.mockReturnValue(true);
    preferencesUtil.shouldStoreCookies.mockReturnValue(true);
  });

  it('carries a Set-Cookie from one request into a later one under the same run', async () => {
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    await executeRequest(request(), context());

    respondWith({ ...ok(), headers: { 'content-type': 'application/json' } });
    const second = await executeRequest(request({ headers: {} }), context());

    expect(second.requestHeaders.Cookie).toBe('session=abc');
  });

  /** The load-bearing rule (001 §7.6): a role matrix logging in as three users must not become one session. */
  it('never carries a cookie set under one jar id into a request under another', async () => {
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    await executeRequest(request(), context({ cookieJar: { id: 'jar-user-1' } }));

    respondWith({ ...ok(), headers: { 'content-type': 'application/json' } });
    const otherUser = await executeRequest(request({ headers: {} }), context({ cookieJar: { id: 'jar-user-2' } }));

    expect(otherUser.requestHeaders.Cookie).toBeUndefined();
  });

  /** 001 §7.6: "cookies set before a run ... seed the jar as they do for a single request today." */
  it('seeds a newly minted jar from the app process-wide jar', async () => {
    globalCookieJar.setCookieSync('logged_in=yes; Domain=api.example.com; Path=/', 'https://api.example.com');
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    const executed = await executeRequest(request({ headers: {} }), context());

    expect(executed.requestHeaders.Cookie).toBe('logged_in=yes');
  });

  it('never writes a response cookie back into the app process-wide jar', async () => {
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    await executeRequest(request(), context());

    expect(globalCookieJar.getCookieStringSync('https://api.example.com/things')).toBe('');
  });

  it('does not send a jar cookie when the host preference is off', async () => {
    preferencesUtil.shouldSendCookies.mockReturnValue(false);
    globalCookieJar.setCookieSync('logged_in=yes; Domain=api.example.com; Path=/', 'https://api.example.com');
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    const executed = await executeRequest(request({ headers: {} }), context());

    expect(executed.requestHeaders.Cookie).toBeUndefined();
  });

  it('does not store a response cookie when the host preference is off', async () => {
    preferencesUtil.shouldStoreCookies.mockReturnValue(false);
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    await executeRequest(request(), context());

    respondWith({ ...ok(), headers: { 'content-type': 'application/json' } });
    const second = await executeRequest(request({ headers: {} }), context());

    expect(second.requestHeaders.Cookie).toBeUndefined();
  });

  /** A step's own declared cookie header survives alongside whatever the jar carries. */
  it('merges the jar with a cookie the step declared itself', async () => {
    globalCookieJar.setCookieSync('logged_in=yes; Domain=api.example.com; Path=/', 'https://api.example.com');
    const { executeRequest } = createPorts({ collectionRoot: '/workspace/collections/payments' });

    respondWith(ok());
    const executed = await executeRequest(request({ headers: { Cookie: 'theme=dark' } }), context());

    expect(executed.requestHeaders.Cookie.split('; ').sort()).toEqual(['logged_in=yes', 'theme=dark']);
  });
});
