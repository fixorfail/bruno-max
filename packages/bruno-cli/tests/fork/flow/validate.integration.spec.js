/**
 * `bru flow validate` end to end — 001 §8.5's listing and §14.3's pass.
 *
 * It runs the CLI as a process because the claim is about a whole pass: the connector file is found
 * by walking the scope roots, the operation it names is resolved against the bound document, and
 * only then is anything printed. A unit test over the reporter is given its rows; this is what
 * decides what those rows are.
 *
 * Wording is asserted by the pieces a reader would search a log for, never as a whole line: §14.7 is
 * deliberately not a stable format, and the listing's own drawing is pinned in `output.spec.js`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

const validate = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BRU, 'flow', 'validate', ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });

/** Each case spawns `bin/bru.js`, which costs a Node start plus a real filesystem walk. */
jest.setTimeout(30000);

describe('bru flow validate', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-validate-')));
    write(root, 'workspace.yml', 'name: validating\n');

    write(
      root,
      'apispec/things-v1.yml',
      [
        'openapi: 3.0.3',
        'info: { title: Things API, version: 1.0.0 }',
        'servers:',
        '  - url: http://127.0.0.1:1',
        'paths:',
        '  /things/{id}:',
        '    get:',
        '      operationId: getThing',
        '      parameters:',
        '        - { name: id, in: path, required: true, schema: { type: string } }',
        '      responses:',
        '        \'200\':',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema:',
        '                type: object',
        '                properties:',
        '                  data:',
        '                    type: object',
        '                    properties:',
        '                      id: { type: string }',
        '                      name: { type: string }',
        '                      slug: { type: string }',
        '  /ping:',
        '    get:',
        '      operationId: ping',
        '      responses:',
        '        \'200\': { description: OK }',
        ''
      ].join('\n')
    );

    // §8.5's workspace connector file: what every flow under this root inherits for `getThing`.
    write(
      root,
      'flows/connectors.yml',
      [
        'version: 1',
        'apis: { things: ../apispec/things-v1.yml }',
        'connectors:',
        '  things#getThing:',
        '    thingId: data.id',
        '    title: data.name',
        ''
      ].join('\n')
    );

    // Binds the document under an alias of its own and declares one output inline, so the listing
    // has both origins to tell apart. The second step reads the inline one, which is what keeps it
    // from being an unused output.
    write(
      root,
      'flows/inherit.flow.yml',
      [
        'version: 1',
        'apis: { svc: ../apispec/things-v1.yml }',
        'steps:',
        '  - id: get_thing',
        '    operation: svc#getThing',
        '    pathParams: { id: thing-1 }',
        '    outputs:',
        '      own: data.slug',
        '  - id: get_again',
        '    operation: svc#getThing',
        '    depends: [get_thing]',
        '    pathParams: { id: "{{steps.get_thing.own}}" }',
        ''
      ].join('\n')
    );

    // Targets the one operation no connector entry covers, and declares nothing of its own.
    write(
      root,
      'flows/bare.flow.yml',
      ['version: 1', 'apis: { svc: ../apispec/things-v1.yml }', 'steps:', '  - id: ping', '    operation: svc#ping', ''].join('\n')
    );
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * §8.5's answer to the locality a connector file costs. `thingId` and `title` are named nowhere in
   * the flow, so a reader who cannot see them here has to open every file the flow binds to find out
   * what the step publishes.
   */
  it('lists each step\'s resolved outputs and the file each was declared in', async () => {
    const result = await validate(['flows/inherit.flow.yml'], root);

    expect(result.status).toBe(0);
    expect(result.output).toContain('get_thing');
    expect(result.output).toContain('thingId');
    expect(result.output).toContain('title');
    expect(result.output).toContain('workspace');
    expect(result.output).toContain('flows/connectors.yml');
    expect(result.output).toContain('own');
    expect(result.output).toContain('inline');
  });

  /** A flow whose steps publish nothing has nothing to list, which is most of them. */
  it('lists nothing for a flow whose steps resolve no outputs', async () => {
    const result = await validate(['flows/bare.flow.yml'], root);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('inline');
    expect(result.output).not.toContain('thingId');
  });
});
