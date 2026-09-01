import yaml from 'js-yaml';
import { getRelativePath } from 'utils/common/path';

/**
 * The text of a flow the Create Flow form just made — 001 §5.1's `version` and `meta`, plus the
 * `apis:` bindings the form selected, and nothing else.
 *
 * It lives with the form rather than in `flows/actions.js` because `getRelativePath` is upstream:
 * `actions.js` is reached eagerly from `fork/registry.js`, whose import graph has to stay clear of
 * upstream modules — `registry.spec.js` asserts it. The form is lazily loaded and has no such rule.
 *
 * **No steps are written.** The app cannot guess one, and a placeholder step would be a step the
 * author has to delete before the flow runs — worse than the empty document, which 002 §6 already
 * reports as needing steps. What this file is for is getting the four things a hand-edit is tedious
 * to start from right: the version, the name, the description and the relative path to every spec.
 */

/**
 * An `apis:` key is typed by hand in every step that uses it — `alias#operationId` (001 §5.3) — so
 * it is derived from the spec's *filename* rather than its OpenAPI title: a title is prose, and
 * `Payments API v2 (beta)#createOrder` is not something anyone wants to write.
 */
export const aliasFor = (apiSpec) => {
  const base = String(apiSpec?.filename || apiSpec?.name || '').replace(/\.(ya?ml|json)$/i, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'api';
};

/**
 * Two specs whose filenames slug to the same alias would silently collapse into one binding, since
 * `apis:` is a mapping — so the second one takes a suffix instead.
 */
const uniqueAlias = (alias, taken) => {
  let candidate = alias;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${alias}-${suffix}`;
  }

  taken.add(candidate);
  return candidate;
};

/**
 * §12.3: a binding's source is resolved against the flow's own directory, so it is written relative
 * to where the file is about to be created rather than to the workspace.
 *
 * The `./` prefix is cosmetic — `path.resolve` treats a bare `foo.yml` identically — but a source
 * that reads as a bare word next to ones that read as paths invites being mistaken for a URL.
 */
const relativeSource = (directory, pathname) => {
  const relative = getRelativePath(directory, pathname);
  return relative.startsWith('.') ? relative : `./${relative}`;
};

export const buildFlowDocument = ({ name, description, tags = [], library, directory, apiSpecs = [] }) => {
  const taken = new Set();
  const apis = Object.fromEntries(
    apiSpecs.map((apiSpec) => [uniqueAlias(aliasFor(apiSpec), taken), relativeSource(directory, apiSpec.pathname)])
  );

  const trimmedDescription = String(description || '').trim();
  const meta = {
    name,
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
    // Written only when there are any, for the same reason `library` is: `tags: []` is what §14.1's
    // `--tags` filtering already does with a flow that declares none.
    ...(tags.length ? { tags } : {}),
    // 001 §12.5's flag is written only when it is set: `library: false` and an absent key mean the
    // same thing to the engine (`Boolean(meta.library)`), and a flow that spells out the default
    // invites being read as having opted into something.
    ...(library ? { library: true } : {})
  };

  // Dumped a block at a time and joined by a blank line: `js-yaml` emits one document as one run of
  // lines, and the format's own examples separate the top-level blocks — which is the difference
  // between a file that reads like the ones beside it and one that reads like output.
  return [{ version: 1 }, { meta }, ...(Object.keys(apis).length ? [{ apis }] : [])]
    .map((block) => yaml.dump(block, { lineWidth: 100, noRefs: true }))
    .join('\n');
};
