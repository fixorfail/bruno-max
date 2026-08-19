/**
 * The fork's own test setup, registered beside upstream's in `jest.config.js`.
 *
 * A file of its own rather than lines in upstream's `jest.setup.js`: the fork's environment gaps are
 * the fork's, and the second one costs no further upstream edit
 * (`.claude/rules/architecture.md`).
 */

/**
 * jsdom ships no `structuredClone`, which dagre — the flow graph's layout engine (002 §5.2) — calls
 * while copying a graph. Chromium has had it since 98, so this is a gap in the *test* environment
 * only, and a deep clone over JSON is enough for what dagre puts through it: plain graph attributes,
 * no dates, maps or cycles.
 */
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
}
