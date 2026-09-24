/**
 * The `apis:` bindings a flow the Create Flow form just made is created with — 001 §6.2's aliases,
 * paired with the spec each one points at.
 *
 * **The document itself is written by the host, not here** (002-C R4). A renderer that serialized
 * `.flow.yml` would be a second writer of the format beside 001 §5.1's one, and it would have to
 * know §5.4's local tags to leave a fixture alone. What is left here is the naming — which is string
 * work over an OpenAPI document the renderer is the only side holding.
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
export const uniqueAlias = (alias, taken) => {
  let candidate = alias;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${alias}-${suffix}`;
  }

  taken.add(candidate);
  return candidate;
};

/**
 * The bindings, in the order the specs were selected, each naming the spec by its **absolute** path.
 *
 * §6.2 resolves a binding against the flow's own directory, so what the file gets is a relative path
 * — computed by the host, which is the side that owns paths. The renderer's own `path` is a POSIX
 * shim, and a Windows flow written with a POSIX relative path is one the engine cannot resolve.
 */
export const apiBindingsFor = (apiSpecs = []) => {
  const taken = new Set();

  return apiSpecs.map((apiSpec) => ({
    alias: uniqueAlias(aliasFor(apiSpec), taken),
    source: apiSpec.pathname
  }));
};
