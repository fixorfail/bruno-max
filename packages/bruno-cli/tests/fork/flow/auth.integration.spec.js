/**
 * Every §6.4 auth mode, end to end — 001-C R7.1.
 *
 * §6.4's claim is that a flow introduces no auth mechanics of its own: the engine resolves a profile
 * to Bruno's `Auth` and the CLI applies it the way it applies a request's. What that can only be
 * proven by is the wire, so each case runs `bru flow run` against a server that records what
 * arrived — a header the mode computes, or the challenge it answers.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Never `spawnSync`: the operation the flow calls is served from this process, and a synchronous
 * spawn holds its event loop until the child exits — the two would wait on each other forever.
 */
const run = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BRU, ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });

/**
 * Each case spawns `bin/bru.js`, which costs a Node start plus a real filesystem walk. Jest's 5s
 * default is inside that margin, so these specs fail on load rather than on behaviour without this.
 */
jest.setTimeout(30000);

const MODES = ['bearer', 'basic', 'apikey-header', 'apikey-query', 'wsse', 'awsv4', 'oauth1', 'oauth2', 'digest', 'ntlm', 'edgegrid'];

describe('R7.1 the CLI applies every §6.4 auth mode', () => {
  let server;
  let port;
  /** Every request the flow sent, in arrival order, so a challenge shows as two entries. */
  let received;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const [route] = request.url.split('?');
      received.push({ route, url: request.url, headers: request.headers });

      const authorization = request.headers.authorization || '';

      if (route === '/token') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'tok-from-token-endpoint', expires_in: 3600 }));
        return;
      }
      // A digest challenge only reaches the interceptor as a rejected 401 (§6.4).
      if (route === '/digest' && !authorization) {
        response.writeHead(401, {
          'www-authenticate': 'Digest realm="flows", nonce="dcd98b7102dd2f0e", qop="auth"',
          'content-type': 'application/json'
        });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      if (route === '/ntlm' && !authorization) {
        response.writeHead(401, { 'www-authenticate': 'NTLM', 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  const operation = (name) =>
    [
      `  /${name}:`,
      '    get:',
      `      operationId: ${name.replace(/-/g, '_')}`,
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      ''
    ].join('\n');

  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-auth-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: auth\n');
    write(
      root,
      'apispec/auth-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Auth API, version: 1.0.0 }',
        'servers:',
        `  - url: http://127.0.0.1:${port}`,
        'paths:',
        ...MODES.map(operation)
      ].join('\n')
    );

    write(
      root,
      'flows/auth.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  auth-api: ../apispec/auth-v1.yml',
        '',
        'authProfiles:',
        '  session: { mode: bearer, token: tok-bearer }',
        '  operator: { mode: basic, username: ops, password: hunter2 }',
        '  gateway: { mode: apikey, key: X-Api-Key, value: ak_1, placement: header }',
        '  gateway-query: { mode: apikey, key: api_key, value: ak_2, placement: queryparams }',
        '  soap: { mode: wsse, username: wsse-user, password: wsse-pass }',
        '  aws: { mode: awsv4, accessKeyId: AKIDEXAMPLE, secretAccessKey: secret, service: execute-api, region: us-east-1 }',
        '  legacy: { mode: oauth1, consumerKey: ck, consumerSecret: cs, signatureMethod: HMAC-SHA1 }',
        `  machine: { mode: oauth2, grantType: client_credentials, accessTokenUrl: "http://127.0.0.1:${port}/token", clientId: cid, clientSecret: sec, tokenHeaderPrefix: Bearer }`,
        '  challenge: { mode: digest, username: dig-user, password: dig-pass }',
        '  windows: { mode: ntlm, username: nt-user, password: nt-pass, domain: WORKGROUP }',
        '  akamai: { mode: akamai-edgegrid, accessToken: at_1, clientToken: ct_1, clientSecret: cs_1 }',
        '',
        'steps:',
        ...MODES.flatMap((mode, index) => [
          `  - id: step_${index}`,
          `    operation: auth-api#${mode.replace(/-/g, '_')}`,
          `    auth: ${['session', 'operator', 'gateway', 'gateway-query', 'soap', 'aws', 'legacy', 'machine', 'challenge', 'windows', 'akamai'][index]}`,
          '    assert:',
          '      - res.status eq 200'
        ]),
        ''
      ].join('\n')
    );

    return root;
  };

  const sent = (route) => received.filter((entry) => entry.route === `/${route}`);

  it('signs, encodes or answers a challenge for each mode, and the run passes', async () => {
    const root = stage();

    const result = await run(['flow', 'run', 'flows/auth.flow.yml', '--no-capture'], root);
    expect(result.status).toBe(0);

    expect(sent('bearer')[0].headers.authorization).toBe('Bearer tok-bearer');
    expect(sent('basic')[0].headers.authorization).toBe(`Basic ${Buffer.from('ops:hunter2').toString('base64')}`);
    expect(sent('apikey-header')[0].headers['x-api-key']).toBe('ak_1');
    expect(sent('apikey-query')[0].url).toContain('api_key=ak_2');
    expect(sent('wsse')[0].headers['x-wsse']).toMatch(/^UsernameToken Username="wsse-user", PasswordDigest=".+", Nonce=".+", Created=".+"$/);
    expect(sent('awsv4')[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/.*\/us-east-1\/execute-api\/aws4_request/);
    expect(sent('oauth1')[0].headers.authorization).toMatch(/^OAuth .*oauth_consumer_key="ck"/);

    // The token came from the token endpoint the profile named, not from the flow, and the
    // profile's own `tokenHeaderPrefix` placed it — `bru run`'s rule, unchanged (§6.4).
    expect(sent('token')).toHaveLength(1);
    expect(sent('oauth2')[0].headers.authorization).toBe('Bearer tok-from-token-endpoint');

    // Two legs each: the unauthenticated request that drew the challenge, then the answer.
    expect(sent('digest')).toHaveLength(2);
    expect(sent('digest')[0].headers.authorization).toBeUndefined();
    expect(sent('digest')[1].headers.authorization).toMatch(/^Digest username="dig-user", realm="flows", nonce="dcd98b7102dd2f0e"/);

    expect(sent('ntlm')).toHaveLength(2);
    expect(sent('ntlm')[1].headers.authorization).toMatch(/^NTLM /);

    expect(sent('edgegrid')[0].headers.authorization).toMatch(/^EG1-HMAC-SHA256 client_token=ct_1;/);
  }, 60000);

  /**
   * §6.4: a value the step declares wins for that field alone. Without it the profile would silently
   * replace a pre-signed token the step was written to send.
   */
  it('lets a header the step declared outrank the profile', async () => {
    const root = stage();
    write(
      root,
      'flows/override.flow.yml',
      [
        'version: 1',
        '',
        'apis:',
        '  auth-api: ../apispec/auth-v1.yml',
        '',
        'authProfiles:',
        '  session: { mode: bearer, token: tok-bearer }',
        '',
        'steps:',
        '  - id: overridden',
        '    operation: auth-api#bearer',
        '    auth: session',
        '    headers:',
        '      Authorization: "pre-signed"',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n')
    );

    const result = await run(['flow', 'run', 'flows/override.flow.yml', '--no-capture'], root);

    expect(result.status).toBe(0);
    expect(sent('bearer')[0].headers.authorization).toBe('pre-signed');
  }, 60000);
});
