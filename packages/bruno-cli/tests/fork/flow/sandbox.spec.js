/**
 * `bru flow run`'s script sandbox — 001-C R7.5 and R7.6.
 *
 * 001 §8.2 promises flows introduce "no new security posture": a script runs in the same sandbox
 * mode a plain request in this collection would get. `bru run` names that mode with `--sandbox`,
 * defaulting to `safe`, and §14.1 gives `bru flow run` the same flag with the same default — so
 * these are the unit-level proofs that an unflagged invocation reaches QuickJS, and that the flag
 * reaches `node:vm` when and only when it asks for `developer`.
 */
const { createPorts } = require('../../../src/fork/flow/ports');

describe('R7.5 an unflagged CLI runs flow scripts in QuickJS, never node:vm', () => {
  const { runScript } = createPorts({ collectionPath: __dirname });

  it('returns the script\'s own value', async () => {
    await expect(runScript('(a, b) => a + b', [1, 2])).resolves.toBe(3);
  });

  it('awaits an async script and returns its resolved value', async () => {
    await expect(runScript('async (value) => { await null; return value * 2; }', [21])).resolves.toBe(42);
  });

  /**
   * `require` is node:vm's own escape hatch (`sandbox/node-vm/cjs-loader.js`) — a script that could
   * reach it could read or write anything the CLI process can, which is exactly the escalation §8.2
   * rules out for a collection that never asked for `developer` mode.
   */
  it('has no access to node:vm\'s globals', async () => {
    await expect(runScript('() => typeof require', [])).resolves.toBe('undefined');
    await expect(runScript('() => typeof process', [])).resolves.toBe('undefined');
  });

  it('rejects with the script\'s own error when it throws', async () => {
    await expect(runScript('() => { throw new Error("boom"); }', [])).rejects.toThrow('boom');
  });

  // `safe` is the default rather than a second mode: naming it explicitly must land where naming
  // nothing does, or the flag would change the sandbox of an invocation that asked for the default.
  it('is what --sandbox safe selects too', async () => {
    const { runScript: safely } = createPorts({ collectionPath: __dirname, sandbox: 'safe' });
    await expect(safely('() => typeof require', [])).resolves.toBe('undefined');
  });
});

describe('R7.6 --sandbox developer runs flow scripts in node:vm', () => {
  const { runScript } = createPorts({ collectionPath: __dirname, sandbox: 'developer' });

  it('returns the script\'s own value', async () => {
    await expect(runScript('(a, b) => a + b', [1, 2])).resolves.toBe(3);
  });

  it('awaits an async script and returns its resolved value', async () => {
    await expect(runScript('async (value) => { await null; return value * 2; }', [21])).resolves.toBe(42);
  });

  /**
   * The one observable difference, and the whole reason the mode exists: `developer` is `bru run`'s
   * name for the sandbox that can load modules, so a flow script gets `require` there exactly as a
   * pre-request script in the same collection would.
   */
  it('gives the script node:vm\'s require, which safe withholds', async () => {
    await expect(runScript('() => typeof require', [])).resolves.toBe('function');
  });

  it('rejects with the script\'s own error when it throws', async () => {
    await expect(runScript('() => { throw new Error("boom"); }', [])).rejects.toThrow('boom');
  });
});
