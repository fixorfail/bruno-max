/**
 * R4n's host half — what `bru flow run` actually masks in a capture (001 §14.4, §14.5).
 *
 * The engine's own tests supply `RunOptions.secrets` and assert the walk. This asserts the thing
 * only the host can show: **which values reach the tracker at all under `bru`**, which is a
 * different set from the app's and is a decision rather than a shortfall.
 *
 * The CLI passes no `secrets`, because it holds no value it *knows* to be secret — a `secret: true`
 * variable's value lives in the app's encrypted store and `parseEnvironment` zeroes it, and an
 * `--env-var` was typed on a command line the user's shell already recorded. Masking every
 * `--env-var` would blank ordinary values out of every report.
 *
 * Two sources still reach it, both derived by the engine rather than declared by the host: a param
 * the *flow* marked `secret: true`, and the credentials an auth profile resolves to. The third case
 * below is the same `--env-var` value in both roles at once — masked where it is a bearer token,
 * untouched where it is an ordinary body field — which is the rule stated as sharply as a test can.
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

/** Every `attempt-*.json` under the capture root, as one string — what a CI job would archive. */
const capturedText = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/^attempt-\d+\.json$/.test(entry.name)) found.push(fs.readFileSync(target, 'utf8'));
    }
  };
  walk(path.join(root, '.bruno-runs'));
  expect(found.length).toBeGreaterThan(0);
  return found.join('\n');
};

jest.setTimeout(30000);

describe('bru flow run — what reaches §14.4 provenance redaction', () => {
  let server;
  let port;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        // Echoed back, so a value that was not masked is in the response half of the capture too.
        response.end(JSON.stringify({ ok: true, echo: body }));
      });
    });
    port = await listen(server);
  });

  afterAll(() => {
    if (server) server.close();
    for (const root of staged) fs.rmSync(root, { recursive: true, force: true });
  });

  const stage = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-redaction-')));
    staged.push(root);

    write(root, 'workspace.yml', 'name: redaction\n');
    write(
      root,
      'apispec/redact-v1.yml',
      [
        'openapi: 3.0.0',
        'info: { title: redact, version: 1.0.0 }',
        `servers: [{ url: 'http://127.0.0.1:${port}' }]`,
        'paths:',
        '  /send:',
        '    post:',
        '      operationId: send',
        '      requestBody:',
        '        content:',
        '          application/json:',
        '            schema: { type: object }',
        '      responses:',
        '        \'200\':',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema: { type: object }',
        ''
      ].join('\n')
    );
    write(
      root,
      'flows/send.flow.yml',
      [
        'version: 1',
        '',
        'meta:',
        '  name: redaction',
        '  library: true',
        '',
        'apis:',
        '  redact-api: ../apispec/redact-v1.yml',
        '',
        'params:',
        '  apiKey: { required: true, secret: true }',
        '',
        'authProfiles:',
        '  user: { mode: bearer, token: "{{authToken}}" }',
        '',
        'steps:',
        '  - id: call',
        '    operation: redact-api#send',
        '    auth: user',
        '    body:',
        '      key: "{{params.apiKey}}"',
        '      note: "{{plain}}"',
        '      alsoTheToken: "{{authToken}}"',
        ''
      ].join('\n')
    );

    return root;
  };

  it('masks a secret param and an auth credential, and leaves an ordinary --env-var alone', async () => {
    const root = stage();

    const { status } = await run(
      [
        'flow',
        'run',
        'flows/send.flow.yml',
        '--param',
        'apiKey=PARAM-SECRET-VALUE',
        '--env-var',
        'authToken=TOKEN-SECRET-VALUE',
        '--env-var',
        'plain=ORDINARY-VALUE'
      ],
      root
    );

    expect(status).toBe(0);

    const captured = capturedText(root);

    // Declared `secret: true` by the flow — the engine adds it whatever the host passed.
    expect(captured).not.toContain('PARAM-SECRET-VALUE');
    // Resolved as a bearer credential, so the engine knows it is one — and it is masked *everywhere*
    // it surfaced, including the ordinary body field that happens to carry the same value.
    expect(captured).not.toContain('TOKEN-SECRET-VALUE');
    // The decision, asserted rather than assumed: an `--env-var` is not treated as secret.
    expect(captured).toContain('ORDINARY-VALUE');
  });
});
