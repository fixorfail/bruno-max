/**
 * What a flow's request carries besides its own fields — 001-C R7.2, R7.3 and R7.4.
 *
 * §7.5's multipart and binary bodies, §7.6's cookie jars and the collection's proxy are all the
 * host's half of §13.2, so none of them can be asserted from the engine: each case runs
 * `bru flow run` against a server that records the bytes and headers that arrived.
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

const collect = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });

/**
 * Each case spawns `bin/bru.js`, which costs a Node start plus a real filesystem walk. Jest's 5s
 * default is inside that margin, so these specs fail on load rather than on behaviour without this.
 */
jest.setTimeout(30000);

describe('the CLI transport for flows', () => {
  let server;
  let port;
  /** Every request the flow sent, in arrival order. */
  let received;
  /** Incremented per `/login`, so two sessions are distinguishable on the wire. */
  let sessions;
  const staged = [];

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      const [route] = request.url.split('?');
      received.push({ route, headers: request.headers, body: await collect(request) });

      if (route === '/login') {
        sessions += 1;
        response.writeHead(200, {
          'set-cookie': [`sid=session-${sessions}; Path=/`, 'flavour=chocolate; Path=/'],
          'content-type': 'application/json'
        });
        response.end(JSON.stringify({ ok: true }));
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
    sessions = 0;
  });

  const sent = (route) => received.filter((entry) => entry.route === `/${route}`);

  const spec = (paths) =>
    [
      'openapi: 3.0.3',
      'info: { title: Transport API, version: 1.0.0 }',
      'servers:',
      `  - url: http://127.0.0.1:${port}`,
      'paths:',
      ...paths
    ].join('\n');

  const get = (route, name) =>
    [
      `  /${route}:`,
      '    get:',
      `      operationId: ${name}`,
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: object }',
      ''
    ].join('\n');

  const stage = (prefix) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `flow-${prefix}-`)));
    staged.push(root);
    return root;
  };

  describe('R7.2 §7.5 bodies', () => {
    // Built when a case runs, not when the file is read: the server has no port until `beforeAll`.
    const uploadSpec = () => spec([
      '  /upload:',
      '    post:',
      '      operationId: uploadInvoice',
      '      requestBody:',
      '        content:',
      '          multipart/form-data:',
      '            schema:',
      '              type: object',
      '              required: [document]',
      '              properties:',
      '                document: { type: string, format: binary }',
      '                description: { type: string }',
      '                amount: { type: integer }',
      '',
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: object }',
      '  /scan:',
      '    post:',
      '      operationId: uploadScan',
      '      requestBody:',
      '        content:',
      '          application/octet-stream:',
      '            schema: { type: string, format: binary }',
      '',
      '      responses:',
      '        \'200\':',
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: object }',
      ''
    ]);

    const bodiesRoot = () => {
      const root = stage('bodies');
      write(root, 'workspace.yml', 'name: bodies\n');
      write(root, 'apispec/transport-v1.yml', uploadSpec());
      write(root, 'flows/fixtures/invoice.csv', 'sku,qty\nwidget,2\n');
      // Bytes no text encoding round-trips, so a corrupted upload cannot pass as an equal string.
      fs.writeFileSync(path.join(root, 'flows/fixtures/scan.bin'), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f]));
      return root;
    };

    /**
     * §7.5's filename is not cosmetic — servers key validation and storage on it — and it is the one
     * thing `utils/form-data`'s `createFormData` could not carry, since it derives the name from the
     * path it reads.
     */
    it('sends one part per key, with the engine\'s filename and content type', async () => {
      const root = bodiesRoot();
      write(
        root,
        'flows/upload.flow.yml',
        [
          'version: 1',
          '',
          'apis:',
          '  files-api: ../apispec/transport-v1.yml',
          '',
          'steps:',
          '  - id: upload',
          '    operation: files-api#uploadInvoice',
          '    body:',
          '      document: !file',
          '        path: ./fixtures/invoice.csv',
          '        filename: september-invoice.csv',
          '      description: Q3 invoice',
          '      amount: 9900',
          '    assert:',
          '      - res.status eq 200',
          ''
        ].join('\n')
      );

      const result = await run(['flow', 'run', 'flows/upload.flow.yml', '--no-capture'], root);
      expect(result.status).toBe(0);

      const [request] = sent('upload');
      expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=.+/);

      const body = request.body.toString();
      expect(body).toContain('name="document"; filename="september-invoice.csv"');
      expect(body).toContain('Content-Type: text/csv');
      expect(body).toContain('sku,qty');
      expect(body).toContain('name="description"');
      expect(body).toContain('Q3 invoice');
      expect(body).toContain('name="amount"');
      expect(body).toContain('9900');
    }, 60000);

    /** §7.5: for a single-payload media type the body *is* the file, byte for byte. */
    it('sends a binary body as the file\'s bytes', async () => {
      const root = bodiesRoot();
      write(
        root,
        'flows/scan.flow.yml',
        [
          'version: 1',
          '',
          'apis:',
          '  files-api: ../apispec/transport-v1.yml',
          '',
          'steps:',
          '  - id: scan',
          '    operation: files-api#uploadScan',
          '    bodyFile: ./fixtures/scan.bin',
          '    assert:',
          '      - res.status eq 200',
          ''
        ].join('\n')
      );

      const result = await run(['flow', 'run', 'flows/scan.flow.yml', '--no-capture'], root);
      expect(result.status).toBe(0);

      const [request] = sent('scan');
      expect(request.headers['content-type']).toBe('application/octet-stream');
      expect([...request.body]).toEqual([0x00, 0x01, 0xfe, 0xff, 0x7f]);
    }, 60000);
  });

  describe('R7.3 §7.6 cookie jars', () => {
    const sessionSpec = () => spec([get('login', 'login'), get('whoami', 'whoami')]);

    const cookiesRoot = () => {
      const root = stage('cookies');
      write(root, 'workspace.yml', 'name: cookies\n');
      write(root, 'apispec/transport-v1.yml', sessionSpec());
      return root;
    };

    const sessionFlow = (dataset) =>
      [
        'version: 1',
        '',
        'apis:',
        '  session-api: ../apispec/transport-v1.yml',
        '',
        ...(dataset ? ['dataset: ./rows.csv', ''] : []),
        'steps:',
        '  - id: login',
        '    operation: session-api#login',
        '    assert:',
        '      - res.status eq 200',
        '',
        '  - id: whoami',
        '    operation: session-api#whoami',
        '    assert:',
        '      - res.status eq 200',
        ''
      ].join('\n');

    it('carries what a step\'s response set into the steps after it', async () => {
      const root = cookiesRoot();
      write(root, 'flows/session.flow.yml', sessionFlow(false));

      const result = await run(['flow', 'run', 'flows/session.flow.yml', '--no-capture'], root);
      expect(result.status).toBe(0);

      expect(sent('login')[0].headers.cookie).toBeUndefined();
      expect(sent('whoami')[0].headers.cookie).toContain('sid=session-1');
      expect(sent('whoami')[0].headers.cookie).toContain('flavour=chocolate');
    }, 60000);

    /**
     * §7.6's load-bearing rule. Under one run-wide jar the second row sends the first row's cookie
     * and the server answers as the wrong identity, which passes while having tested one session
     * twice.
     */
    it('gives each dataset iteration a jar of its own', async () => {
      const root = cookiesRoot();
      write(root, 'flows/session.flow.yml', sessionFlow(true));
      write(root, 'flows/rows.csv', 'label\nfirst\nsecond\n');

      const result = await run(['flow', 'run', 'flows/session.flow.yml', '--no-capture'], root);
      expect(result.status).toBe(0);

      expect(sent('login')).toHaveLength(2);
      const carried = sent('whoami').map((request) => request.headers.cookie).sort();
      expect(carried).toEqual(['sid=session-1; flavour=chocolate', 'sid=session-2; flavour=chocolate']);
    }, 60000);
  });

  describe('R7.4 the collection\'s proxy', () => {
    let proxy;
    let proxyPort;
    let proxied;

    beforeAll(async () => {
      // A proxied request arrives with an absolute URI on the request line, which is how this knows
      // it was reached as a proxy rather than as an origin server.
      proxy = http.createServer((request, response) => {
        proxied.push(request.url);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
      proxyPort = await listen(proxy);
    });

    afterAll(() => {
      if (proxy) proxy.close();
    });

    beforeEach(() => {
      proxied = [];
    });

    /** §7.6 calls a proxy ambient configuration of the transport: the collection's, as `bru run`. */
    it('routes a flow\'s request through the proxy bruno.json configures', async () => {
      const root = stage('proxy');
      write(
        root,
        'bruno.json',
        JSON.stringify({
          version: '1',
          name: 'proxied',
          type: 'collection',
          proxy: {
            inherit: false,
            config: { protocol: 'http', hostname: '127.0.0.1', port: proxyPort, auth: { disabled: true }, bypassProxy: '' }
          }
        })
      );
      write(root, 'apispec/transport-v1.yml', spec([get('whoami', 'whoami')]));
      write(
        root,
        'flows/proxied.flow.yml',
        [
          'version: 1',
          '',
          'apis:',
          '  session-api: ../apispec/transport-v1.yml',
          '',
          'steps:',
          '  - id: whoami',
          '    operation: session-api#whoami',
          '    assert:',
          '      - res.status eq 200',
          ''
        ].join('\n')
      );

      const result = await run(['flow', 'run', 'flows/proxied.flow.yml', '--no-capture'], root);

      expect(result.status).toBe(0);
      expect(proxied).toEqual([`http://127.0.0.1:${port}/whoami`]);
      // Nothing reached the API directly.
      expect(received).toEqual([]);
    }, 60000);

    /**
     * §7.4: one collection config, read per environment. A proxy that differs between staging and
     * production is written as a `{{variable}}` and resolved against the run's own variables — and
     * the failure it prevents is the silent one, since an unexpanded `{{proxyHost}}` is a hostname
     * that resolves nowhere rather than a config error anything reports.
     */
    it('resolves a {{variable}} in that proxy against the run\'s environment', async () => {
      const root = stage('proxy-vars');
      write(
        root,
        'bruno.json',
        JSON.stringify({
          version: '1',
          name: 'proxied',
          type: 'collection',
          proxy: {
            inherit: false,
            config: {
              protocol: 'http',
              hostname: '{{proxyHost}}',
              port: proxyPort,
              auth: { disabled: true },
              bypassProxy: ''
            }
          }
        })
      );
      write(
        root,
        'environments/ci.yml',
        ['name: ci', 'variables:', '  - name: proxyHost', '    value: 127.0.0.1', '    enabled: true', ''].join('\n')
      );
      write(root, 'apispec/transport-v1.yml', spec([get('whoami', 'whoami')]));
      write(
        root,
        'flows/proxied.flow.yml',
        [
          'version: 1',
          '',
          'apis:',
          '  session-api: ../apispec/transport-v1.yml',
          '',
          'steps:',
          '  - id: whoami',
          '    operation: session-api#whoami',
          '    assert:',
          '      - res.status eq 200',
          ''
        ].join('\n')
      );

      const result = await run(
        ['flow', 'run', 'flows/proxied.flow.yml', '--global-env', 'ci', '--no-capture'],
        root
      );

      expect(result.status).toBe(0);
      expect(proxied).toEqual([`http://127.0.0.1:${port}/whoami`]);
      expect(received).toEqual([]);
    }, 60000);
  });
});
