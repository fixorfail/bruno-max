/**
 * `--grep`, `--grep-invert` and comma-separated paths — the selection rules of 001 §14.1.
 *
 * What a pattern *matches* is the engine's, and is pinned in `bruno-max-flow`'s own conformance
 * spec; what is pinned here is the CLI's half of the bargain — that the pattern is compiled
 * case-insensitively, that an unusable one is refused rather than run, and that the filter narrows
 * a selection the paths already made rather than searching the disk of its own.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { selectFlows, compileFilters, narrowToPattern } = require('../../../src/fork/flow');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

describe('selecting flows by pattern', () => {
  let root;
  /** Every non-library flow under the workspace, which is what a pattern is applied to. */
  let selected;

  const kept = (options) =>
    narrowToPattern(selected, compileFilters(options)).map((file) =>
      path.relative(root, file).split(path.sep).join('/')
    );

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-grep-')));
    write(root, 'workspace.yml', 'name: grep\n');

    write(
      root,
      'flows/checkout.flow.yml',
      [
        'version: 1',
        'meta:',
        '  name: Checkout happy path',
        '  testId: C1000',
        '  tags: [smoke, payments]',
        'steps:',
        '  - id: pay',
        '    name: Pay with a saved card',
        '    meta:',
        '      jira: PAY-42',
        ''
      ].join('\n')
    );

    write(
      root,
      'flows/nightly.flow.yml',
      [
        'version: 1',
        'meta:',
        '  name: Ledger reconciliation',
        '  tags: [slow]',
        'steps:',
        '  - id: fetch',
        '    name: Fetch the ledger',
        ''
      ].join('\n')
    );

    // Matchable by nothing but the path its id is derived from — no name, no tags, no step metadata.
    write(root, 'ops/purge.flow.yml', 'version: 1\n');

    // Indented into nothing a parser accepts; §5.2's identity survives it, the steps do not.
    write(root, 'flows/broken.flow.yml', 'version: 1\nsteps:\n  - id: a\n   name: Sends nothing\n');

    write(root, 'flows/shared/login.flow.yml', 'version: 1\nmeta:\n  library: true\n  name: Log in\n');

    selected = selectFlows([root]);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches a tag, the flow\'s name and its case id, whatever case each was typed in', () => {
    expect(kept({ grep: 'payments' })).toEqual(['flows/checkout.flow.yml']);
    expect(kept({ grep: 'LEDGER RECONCILIATION' })).toEqual(['flows/nightly.flow.yml']);
    expect(kept({ grep: 'c1000' })).toEqual(['flows/checkout.flow.yml']);
  });

  it('matches a step\'s name and a value in its open meta:, but never a meta: key', () => {
    expect(kept({ grep: 'saved card' })).toEqual(['flows/checkout.flow.yml']);
    expect(kept({ grep: 'PAY-42' })).toEqual(['flows/checkout.flow.yml']);
    // Greping a key would select every flow whose steps declare one, which is every flow in a
    // workspace written for a tracker.
    expect(kept({ grep: 'jira' })).toEqual([]);
  });

  // The scope-relative id, so a flow with no `meta:` at all is still selectable by where it lives.
  it('matches the path a flow is named by', () => {
    expect(kept({ grep: '^ops/' })).toEqual(['ops/purge.flow.yml']);
  });

  /** A flow the author is midway through editing stays selectable by the name it already has. */
  it('matches a flow whose text does not parse', () => {
    expect(kept({ grep: 'broken' })).toEqual(['flows/broken.flow.yml']);
  });

  it('excludes with --grep-invert, and lets it narrow --grep further', () => {
    expect(kept({ grepInvert: 'slow' })).toEqual([
      'flows/broken.flow.yml',
      'flows/checkout.flow.yml',
      'ops/purge.flow.yml'
    ]);
    expect(kept({ grep: '^flows/', grepInvert: 'slow' })).toEqual([
      'flows/broken.flow.yml',
      'flows/checkout.flow.yml'
    ]);
  });

  // Neither flag given is not an empty pattern: it is no filter, and the selection is untouched.
  it('returns the selection itself when neither flag was given', () => {
    expect(narrowToPattern(selected, compileFilters({}))).toBe(selected);
  });

  /**
   * §12.5's library exclusion happens in the selection, so a pattern cannot reach past it — a
   * library flow is run when it is named, never because a pattern matched it.
   */
  it('cannot select a library flow a directory run excluded', () => {
    expect(kept({ grep: 'log in' })).toEqual([]);
  });

  // The pattern is applied to a roster's files exactly as to a directory's — one rule, one place.
  it('narrows any list of files, which is what makes --retry-failed obey it', () => {
    const roster = [path.join(root, 'flows', 'checkout.flow.yml'), path.join(root, 'flows', 'nightly.flow.yml')];

    expect(narrowToPattern(roster, compileFilters({ grep: 'smoke' }))).toEqual([roster[0]]);
  });
});

describe('compiling the patterns', () => {
  it('names the flag that would not compile, so the message says which to fix', () => {
    expect(() => compileFilters({ grep: 'checkout(' })).toThrow(/^--grep is not a valid regular expression: /);
    expect(() => compileFilters({ grepInvert: '[slow' })).toThrow(/^--grep-invert is not a valid regular expression: /);
  });
});

describe('comma-separated paths', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-paths-')));
    for (const name of ['a', 'b', 'c']) write(root, `flows/${name}.flow.yml`, 'version: 1\n');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // The spelling for a CI `command:` line or an npm script, where several paths are one quoted word.
  it('names several flows in one argument, beside the space-separated form', () => {
    const at = (name) => path.join(root, 'flows', `${name}.flow.yml`);

    expect(selectFlows([`${at('a')},${at('b')}`, at('c')])).toEqual([at('a'), at('b'), at('c')]);
  });

  // A trailing comma or a padded argument is a typo, not a path that does not exist.
  it('ignores the empty pieces a stray comma or space leaves behind', () => {
    const at = (name) => path.join(root, 'flows', `${name}.flow.yml`);

    expect(selectFlows([` ${at('a')} , ,${at('b')},`])).toEqual([at('a'), at('b')]);
  });
});
