import { validateName, validateNameError } from 'utils/common/regex';

/**
 * What a `.flow.yml` may be called — 002 §4.1 and §4.4.
 *
 * Shared by the two forms that name a flow file, because they are naming the same thing: a create
 * that accepted a name a rename rejects would be two rules where the filesystem has one.
 */

/** 255 is the limit on the whole filename, and `.flow.yml` is appended to what the author typed. */
export const MAX_FILE_NAME_LENGTH = 255 - '.flow.yml'.length;

export const FLOW_EXTENSION = '.flow.yml';

/** 002 §4.5's scripts are plain `.js`; the watcher lists nothing else out of `flows/scripts/`. */
export const SCRIPT_EXTENSION = '.js';

/**
 * Lowercase, words joined by hyphens — how the flows and specs already on disk are named.
 *
 * **Not lodash's `kebabCase`**, which splits a letter from a digit: it turns `Auth V2` into
 * `auth-v-2`, and version suffixes are everywhere here (`auth-v2.yml`, `f2-login.flow.yml`). Only a
 * lower-to-upper boundary starts a new word, so `OrderFulfillment` still splits.
 *
 * Letters and digits are kept by Unicode class rather than by `a-z0-9`, so a name written in a
 * non-Latin script yields a filename instead of an empty string — `validateName` accepts those.
 */
export const kebabCase = (value) =>
  String(value || '')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1-$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/**
 * The stem a form holds, from the filename on disk — a rename starts from what the file is called,
 * and the extension is not the author's to edit.
 */
export const fileNameStem = (filename, extension = FLOW_EXTENSION) => {
  const name = String(filename || '');
  return name.toLowerCase().endsWith(extension.toLowerCase()) ? name.slice(0, -extension.length) : name;
};

/**
 * Why this stem cannot be a flow file, or `undefined` when it can.
 *
 * Returned rather than thrown so each form can raise it the way its own validation does; the rules
 * themselves live here once.
 */
export const flowFileNameError = (stem, extension = FLOW_EXTENSION) => {
  if (!stem) {
    return 'File name cannot be empty.';
  }
  // The extension is appended, and 255 is the limit on the whole filename rather than on the part
  // the author typed.
  const limit = 255 - extension.length;
  if (stem.length > limit) {
    return `File name cannot exceed ${limit} characters.`;
  }
  return validateName(stem) ? undefined : validateNameError(stem);
};
