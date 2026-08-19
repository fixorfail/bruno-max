jest.mock('../network', () => ({ configureRequest: jest.fn() }));
jest.mock('../network/prepare-request', () => ({ setAuthHeaders: jest.fn() }));
jest.mock('../swagger-fetch', () => ({ proxySwaggerFetch: jest.fn() }));
jest.mock('../../utils/cookies', () => ({ addCookieToJar: jest.fn() }));
jest.mock('../../store/preferences', () => ({ preferencesUtil: { shouldStoreCookies: () => false } }));
jest.mock('../../store/collection-security', () =>
  jest.fn().mockImplementation(() => ({ getSecurityConfigForCollection: () => ({ jsSandboxMode: 'developer' }) }))
);

const { configureRequest } = require('../network');
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

/**
 * 001 §8.2's script positions — `outputs`, `when:` and `shouldRetry` — through the app's host.
 *
 * The VM resolves `require` against a path, so handing it nothing throws `The "path" argument must be
 * of type string` and the engine reports it as `script-error` on the step: the author's script blamed
 * for a host that supplied no path. A workspace-scoped flow has no collection (002 §7.2), which is
 * exactly when that happened.
 */
describe('the flow script port', () => {
  it('runs a script for a flow with no collection, against the workspace root', async () => {
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
