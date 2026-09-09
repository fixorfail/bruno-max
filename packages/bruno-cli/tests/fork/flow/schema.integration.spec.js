/**
 * `bru flow schema`, end to end — 001-C R13.3.
 *
 * The unit spec drives `printSchema` directly; this is the only place the argv it reads is the one
 * yargs actually builds — that `schema` is an accepted action, that `--format-version` defaults to
 * the current version without being given, and that what lands on stdout survives a pipe as JSON.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { flowSchema, CURRENT_FLOW_VERSION } = require('@bruno-max/flow');

const BRU = path.join(__dirname, '..', '..', '..', 'bin', 'bru.js');

/**
 * stdout and stderr are collected apart, unlike the run specs': the whole point of this command is
 * that stdout is a machine format, and a spec that merged a warning into it could not tell.
 */
const run = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BRU, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

/** Each case spawns `bin/bru.js`, which costs a Node start — outside Jest's 5s default. */
jest.setTimeout(30000);

describe('R13.3 bru flow schema at the command line', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-cli-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints the current schema as JSON on stdout, with nothing else in it', async () => {
    const result = await run(['flow', 'schema'], root);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(flowSchema(CURRENT_FLOW_VERSION));
  });

  it('writes it to --out instead, and says where', async () => {
    const result = await run(['flow', 'schema', '--out', '.bruno/flow.schema.json'], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.bruno/flow.schema.json');

    const written = fs.readFileSync(path.join(root, '.bruno', 'flow.schema.json'), 'utf8');
    expect(JSON.parse(written)).toEqual(flowSchema(CURRENT_FLOW_VERSION));
  });

  it('exits 3 on a format version this build does not carry', async () => {
    const result = await run(['flow', 'schema', '--format-version', '99'], root);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('99');
  });
});
