/**
 * The fork's tab types, as a leaf module that imports **nothing**.
 *
 * Kept out of `registry.js` because the registry pulls in the whole component tree, and a fork
 * component reaching back into an upstream slice would make that a cycle — one that fails at
 * module-init, in whichever evaluation order the bundler happens to pick. A leaf can be imported
 * from anywhere.
 */

/**
 * 002 §4.2's tab type, §4.3's, §4.5's and §4.6's, each keyed on its file's pathname.
 *
 * The first two are separate types rather than one tab with a mode, because upstream dedupes a tab
 * on pathname *and* type: a flow's run view and its raw editor are then two tabs of one file, each
 * reopening into itself, and neither can displace the other. The last two are separate because they
 * open different files entirely — a `.js` helper and a data file, neither of which has a run view or
 * a graph.
 */
export const FORK_TAB_TYPES = ['flow', 'flow-yaml', 'flow-script', 'flow-fixture'];

export const isForkTab = (tab) => FORK_TAB_TYPES.includes(tab?.type);
