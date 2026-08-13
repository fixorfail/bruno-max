/**
 * The fork's tab types, as a leaf module that imports **nothing**.
 *
 * Kept out of `registry.js` because the registry pulls in the whole component tree, and a fork
 * component reaching back into an upstream slice would make that a cycle — one that fails at
 * module-init, in whichever evaluation order the bundler happens to pick. A leaf can be imported
 * from anywhere.
 */

/** 002 §4.2's tab type, keyed on the flow's pathname. */
export const FORK_TAB_TYPES = ['flow'];
