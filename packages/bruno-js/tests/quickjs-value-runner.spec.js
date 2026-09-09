const { describe, it, expect } = require('@jest/globals');
const { runScriptInQuickJsForValue } = require('../src/fork/quickjs-value-runner');

/**
 * `runScriptInQuickJsForValue` exists because bruno-js's own QuickJS script closure
 * (`wrapScriptInClosure`, `src/sandbox/quickjs/index.js`) always resolves to the fixed string
 * `'done'` and never marshals a script's value out of the VM. A caller whose script *is* an
 * expression — 001 §8.2's flow outputs, `when:` and `shouldRetry` — needs that value back.
 */
describe('runScriptInQuickJsForValue', () => {
  it('returns the value of a synchronous function', async () => {
    await expect(runScriptInQuickJsForValue({ source: '(value) => value * 2', args: [21] })).resolves.toBe(42);
  });

  it('returns the awaited value of an async function', async () => {
    await expect(
      runScriptInQuickJsForValue({ source: 'async (value) => { await null; return value + 1; }', args: [1] })
    ).resolves.toBe(2);
  });

  it('awaits a function that suspends across more than one microtask turn', async () => {
    await expect(
      runScriptInQuickJsForValue({
        source: 'async (value) => { await null; await Promise.resolve(); return value; }',
        args: ['through two turns']
      })
    ).resolves.toBe('through two turns');
  });

  it('marshals an object value out of the sandbox, not just a primitive', async () => {
    await expect(
      runScriptInQuickJsForValue({ source: '(a, b) => ({ sum: a + b, parts: [a, b] })', args: [1, 2] })
    ).resolves.toEqual({ sum: 3, parts: [1, 2] });
  });

  it('rejects with the script error when the function throws synchronously', async () => {
    await expect(
      runScriptInQuickJsForValue({ source: '() => { throw new Error("boom"); }', args: [] })
    ).rejects.toThrow('boom');
  });

  it('rejects with the script error when the returned promise rejects', async () => {
    await expect(
      runScriptInQuickJsForValue({ source: 'async () => { throw new Error("async boom"); }', args: [] })
    ).rejects.toThrow('async boom');
  });

  it('rejects when the source itself does not evaluate to a function', async () => {
    await expect(runScriptInQuickJsForValue({ source: '{ not: "a function" }', args: [] })).rejects.toThrow();
  });

  it('gives the script no console unless one is supplied', async () => {
    await expect(
      runScriptInQuickJsForValue({ source: '() => typeof console', args: [] })
    ).resolves.toBe('undefined');
  });

  it('wires a supplied console through to the sandbox', async () => {
    const log = jest.fn();

    await runScriptInQuickJsForValue({ source: '() => { console.log("from sandbox"); return null; }', args: [], console: { log } });

    expect(log).toHaveBeenCalledWith('from sandbox');
  });
});
