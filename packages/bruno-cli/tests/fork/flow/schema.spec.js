/**
 * `bru flow schema` — 001-C R13.3 (001 §5.4, §14).
 *
 * The command emits §5.4's JSON Schema so an editor can complete and check a format people write by
 * hand. What is pinned here is the CLI's half — which version is emitted, where it goes, and what an
 * unknown version does — never the schema's contents, which are the engine's and are pinned by its
 * own `schema.spec.js`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FLOW_VERSIONS, CURRENT_FLOW_VERSION, flowSchema } = require('@bruno-max/flow');

const { printSchema, EXIT } = require('../../../src/fork/flow');

/**
 * `printSchema` writes the schema straight to `process.stdout` rather than through `console.log`:
 * the output is a file an editor reads, and a formatter between it and the shell is one chance for
 * it to stop being valid JSON.
 */
const capture = () => {
  const written = [];
  const logged = [];
  const errors = [];
  const exits = [];

  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation((message) => logged.push(message));
  jest.spyOn(console, 'error').mockImplementation((message) => errors.push(message));
  jest.spyOn(process, 'exit').mockImplementation((code) => exits.push(code));

  return { stdout: () => written.join(''), logged, errors, exits };
};

describe('R13.3 bru flow schema', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prints the current version\'s schema, as JSON, to stdout', () => {
    const { stdout, exits } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION });

    expect(exits).toEqual([]);
    expect(JSON.parse(stdout())).toEqual(flowSchema(CURRENT_FLOW_VERSION));
  });

  // A file an editor watches is read whole; one with no trailing newline is still a shell here-doc
  // away from being concatenated onto whatever follows it.
  it('ends that output with a newline', () => {
    const { stdout } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION });

    expect(stdout().endsWith('}\n')).toBe(true);
  });

  it('emits the version asked for', () => {
    const { stdout } = capture();
    printSchema({ formatVersion: FLOW_VERSIONS[0] });

    expect(JSON.parse(stdout())).toEqual(flowSchema(FLOW_VERSIONS[0]));
  });

  /**
   * §14.2's usage error rather than an empty file: the schema is normally consumed by a tool that
   * will not read stderr, so a version this build does not carry has to stop the command before
   * anything downstream reads a truncated one.
   */
  it('refuses a format version this build does not carry, and names the ones it does', () => {
    const { stdout, errors, exits } = capture();
    printSchema({ formatVersion: 99 });

    expect(exits).toEqual([EXIT.usage]);
    expect(stdout()).toBe('');
    expect(errors[0]).toContain('99');
    expect(errors[0]).toContain(FLOW_VERSIONS.join(', '));
  });

  // yargs parses `--format-version` as a number, so a non-numeric value arrives as NaN rather than
  // as a string — and is no more emittable than 99 is.
  it('refuses a format version that is not a number', () => {
    const { errors, exits } = capture();
    printSchema({ formatVersion: Number('nope') });

    expect(exits).toEqual([EXIT.usage]);
    expect(errors[0]).toContain('NaN');
  });

  it('writes the schema to --out instead, creating the directory it names', () => {
    const target = path.join(root, 'nested', '.bruno', 'flow.schema.json');
    const { stdout, logged } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION, out: target });

    expect(stdout()).toBe('');
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(flowSchema(CURRENT_FLOW_VERSION));
    expect(logged.join('\n')).toContain(target);
  });

  it('reports a path it cannot write as a usage error', () => {
    // A file where the parent directory has to be: `mkdir -p` cannot make one, and neither can this.
    const blocked = path.join(root, 'occupied');
    fs.writeFileSync(blocked, 'not a directory\n');

    const { errors, exits } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION, out: path.join(blocked, 'flow.schema.json') });

    expect(exits).toEqual([EXIT.usage]);
    expect(errors).toHaveLength(1);
  });

  /**
   * §14.7's `--silent` is "nothing; the exit code is the whole result", and it covers a command's
   * own product exactly as it covers `bru flow list`'s table. `--out` still writes: the flag governs
   * stdout, and a file the invocation was told to produce is not stdout.
   */
  it('writes nothing to stdout under --silent', () => {
    const { stdout, exits } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION, silent: true });

    expect(stdout()).toBe('');
    expect(exits).toEqual([]);
  });

  it('still writes --out under --silent, and says nothing about it', () => {
    const target = path.join(root, 'silent.schema.json');
    const { stdout, logged } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION, out: target, silent: true });

    expect(fs.existsSync(target)).toBe(true);
    expect(stdout()).toBe('');
    expect(logged).toEqual([]);
  });

  // --quiet drops step lines and failure detail (§14.7); this command prints neither, so the schema
  // it was invoked to produce is not what --quiet takes away.
  it('is unaffected by --quiet', () => {
    const { stdout } = capture();
    printSchema({ formatVersion: CURRENT_FLOW_VERSION, quiet: true });

    expect(JSON.parse(stdout())).toEqual(flowSchema(CURRENT_FLOW_VERSION));
  });
});
