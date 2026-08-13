/**
 * R6's exit codes and R4i's selection ordering (001-C §7, 001 §14.1 and §14.2).
 *
 * The exit codes are a CI contract and cannot change; the ordering is what makes a suite
 * reproducible across machines and filesystems.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { selectFlows, exitCodeFor, EXIT } = require('../../../src/fork/flow');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

describe('exit codes', () => {
  it('maps a run outcome to the code CI gates on', () => {
    expect(exitCodeFor('passed')).toBe(0);
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('cancelled')).toBe(4);
  });

  // A broken flow file is an authoring problem, not a failing API, and a usage error is neither.
  it('keeps an invalid file and a usage error distinct from a failing step', () => {
    expect(EXIT.invalid).toBe(2);
    expect(EXIT.usage).toBe(3);
    expect(new Set(Object.values(EXIT)).size).toBe(5);
  });
});

describe('selection', () => {
  let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-selection-'));
    write(root, 'b/second.flow.yml', 'version: 1\n');
    write(root, 'a/first.flow.yml', 'version: 1\n');
    write(root, 'a/shared/login.flow.yml', 'version: 1\nmeta:\n  library: true\n');
    write(root, 'a/notes.md', 'not a flow\n');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // Path order rather than directory-read order, so a suite runs the same way everywhere.
  it('returns a directory\'s flows in path order', () => {
    expect(selectFlows([root]).map((file) => path.relative(root, file))).toEqual([
      path.join('a', 'first.flow.yml'),
      path.join('b', 'second.flow.yml')
    ]);
  });

  // §12.5: a glob run never fires a library flow standalone and reports a spurious missing-param
  // failure — but naming it explicitly still runs it.
  it('skips library flows in a directory and runs one that is named', () => {
    const named = path.join(root, 'a', 'shared', 'login.flow.yml');
    expect(selectFlows([root])).not.toContain(named);
    expect(selectFlows([named])).toEqual([named]);
  });

  it('rejects a path that is not a flow, and one that does not exist', () => {
    expect(() => selectFlows([path.join(root, 'a', 'notes.md')])).toThrow(/not a \.flow\.yml/);
    expect(() => selectFlows([path.join(root, 'nope')])).toThrow(/no such path/);
  });
});
