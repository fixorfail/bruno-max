/**
 * 002 §7.2's workspace environment, selected by name — the app's run-configuration control and
 * `bru flow run --global-env` naming the same file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { workspaceEnvironment } = require('../../../src/fork/flow');

const write = (root, file, body) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

describe('the workspace environment', () => {
  let workspace;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-env-'));
    write(workspace, 'workspace.yml', 'name: probe\n');
    write(
      workspace,
      'environments/staging.yml',
      [
        'name: staging',
        'variables:',
        '  - name: baseUrl',
        '    value: https://staging.example.com',
        '    enabled: true',
        '  - name: retired',
        '    value: https://old.example.com',
        // The yml environment format spells this `disabled`, not `enabled: false`.
        '    disabled: true'
      ].join('\n') + '\n'
    );
  });

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  /** The same file `bru run --global-env` reads, so the two commands cannot disagree about it. */
  it('reads the named environment out of the workspace', () => {
    expect(workspaceEnvironment('staging', workspace).baseUrl).toBe('https://staging.example.com');
  });

  it('leaves a disabled variable out, as every other tier does', () => {
    expect(workspaceEnvironment('staging', workspace)).not.toHaveProperty('retired');
  });

  /**
   * A name that matches no file is a usage error the command reports before a request goes out —
   * discovering it after the first flow has already run is the version of this nobody wants.
   */
  it('refuses a name that matches no file, naming what it looked for', () => {
    expect(() => workspaceEnvironment('nope', workspace)).toThrow(/environments[/\\]nope\.yml/);
  });
});
