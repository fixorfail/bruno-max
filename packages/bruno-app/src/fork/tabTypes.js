/**
 * The fork's tab types, as a leaf module that imports **nothing**.
 *
 * Kept out of `registry.js` because the registry pulls in the whole component tree, and a fork
 * component reaching back into an upstream slice would make that a cycle — one that fails at
 * module-init, in whichever evaluation order the bundler happens to pick. A leaf can be imported
 * from anywhere.
 */

/**
 * 002 §4.2's tab type and §4.3's, both keyed on the flow's pathname.
 *
 * They are separate types rather than one tab with a mode, because upstream dedupes a tab on
 * pathname *and* type: a flow's run view and its raw editor are then two tabs of one file, each
 * reopening into itself, and neither can displace the other.
 */
export const FORK_TAB_TYPES = ['flow', 'flow-yaml'];

export const isForkTab = (tab) => FORK_TAB_TYPES.includes(tab?.type);
