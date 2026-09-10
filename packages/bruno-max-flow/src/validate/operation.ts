/**
 * A step checked against the operation it names — 001 §7.1, §7.5 and §14.3.
 *
 * §7.1 splits drift from a spec into two classes and treats them differently: a value that changed
 * flows through to every step that did not override it, and a *structural* change is an error. This
 * is where the second half is decided, because it is the only place both halves of the request are
 * known — the operation's schema, and what the step wrote over it.
 *
 * Without it the request silently carries a field the API ignores, and the test passes while
 * asserting nothing meaningful. Every rule here reports at validate time what materialization would
 * otherwise refuse mid-run, one dispatched step later, which is the difference between a spec edit
 * that fails a review and one that fails a nightly.
 */
import { FileRef, type NormalizedStep } from '../document';
import { deref, requestMediaTypes, type ResolvedOperation } from '../openapi';
import { suggest, type Report } from './report';

export type Schema = Record<string, any>;

const isMapping = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof FileRef);

/**
 * The properties a schema names, or `undefined` where it names none it can be held to — a free-form
 * object, a `$ref` outside the document, a composition with a branch of either kind.
 *
 * Silence is the right answer there rather than a guess: §14.3's check exists to catch a typo, and a
 * schema that documents nothing about its own keys cannot tell one from a field the API accepts.
 */
export const propertiesOf = (schema: Schema | undefined, definitions: Schema): Record<string, Schema> | undefined => {
  const resolved = deref(schema, definitions);
  if (!resolved || typeof resolved !== 'object') return undefined;
  if (resolved.additionalProperties) return undefined;

  const branches: Schema[] = [...(resolved.allOf || []), ...(resolved.oneOf || []), ...(resolved.anyOf || [])];
  if (branches.length) {
    const composed: Record<string, Schema> = {};
    for (const branch of branches) {
      const found = propertiesOf(branch, definitions);
      if (!found) return undefined;
      Object.assign(composed, found);
    }
    Object.assign(composed, resolved.properties || {});
    return composed;
  }

  if (!resolved.properties) return undefined;
  return resolved.properties as Record<string, Schema>;
};

const requestContent = (resolved: ResolvedOperation, mediaType: string): Schema =>
  resolved.operation.requestBody?.content?.[mediaType] || {};

/**
 * §7.5's media-type decision, made here exactly as materialization makes it, and reported instead of
 * thrown. The three failures are the three shapes of the same question: the step named a type the
 * operation does not offer, named one where the operation offers a single type and decides for
 * itself, or named none where the operation offers several.
 */
const selectMediaType = (step: NormalizedStep, resolved: ResolvedOperation, report: Report): string | undefined => {
  const declared = requestMediaTypes(resolved.operation);

  if (step.contentType) {
    if (!declared.includes(step.contentType)) {
      report.error(
        'unknown-media-type',
        `${step.id}: the operation does not declare ${step.contentType} — it declares `
        + `${declared.join(', ') || 'no request body at all'}`,
        step.id
      );
      return undefined;
    }
    if (declared.length === 1) {
      report.error(
        'unexpected-content-type',
        `${step.id}: contentType: selects between the request media types an operation declares, and this one `
        + `declares only ${declared[0]} (§7.5)`,
        step.id
      );
    }
    return step.contentType;
  }

  if (declared.length > 1) {
    report.error(
      'ambiguous-media-type',
      `${step.id}: the operation declares ${declared.join(', ')} — set contentType: on the step (§7.5)`,
      step.id
    );
    return undefined;
  }
  return declared[0];
};

const containsFile = (value: unknown): boolean => {
  if (value instanceof FileRef) return true;
  if (Array.isArray(value)) return value.some(containsFile);
  if (isMapping(value)) return Object.values(value).some(containsFile);
  return false;
};

/** §7.1's structural drift, one key at a time, wherever the schema is specific about its keys. */
const checkFields = (
  where: string,
  value: unknown,
  schema: Schema | undefined,
  definitions: Schema,
  step: NormalizedStep,
  report: Report
) => {
  const properties = propertiesOf(schema, definitions);
  if (!properties || !isMapping(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      report.error(
        'unknown-field',
        `${step.id}: ${where}.${key} is not in the operation's schema${suggest(key, Object.keys(properties))}`,
        step.id
      );
      continue;
    }
    const property = deref(properties[key], definitions);
    if (isMapping(entry)) checkFields(`${where}.${key}`, entry, property, definitions, step, report);
    if (Array.isArray(entry) && property?.items) {
      entry.forEach((item) => checkFields(`${where}.${key}[]`, item, property.items, definitions, step, report));
    }
  }
};

/**
 * The declared parameters of one location, or `undefined` where the document says nothing this
 * check can hold a step to: a `$ref` out of reach, or — for `query` — an operation that documents no
 * parameter of that kind at all.
 *
 * The second is the same judgment `propertiesOf` makes about a free-form schema. `parameters:` is
 * optional in OpenAPI and routinely left off, and a document that names none of an endpoint's query
 * parameters cannot tell a typo from one it did not bother to write down — so what a check would
 * report there is the document's silence, at every step that reaches the operation.
 */
const parameterNames = (resolved: ResolvedOperation, location: string): string[] | undefined => {
  const names: string[] = [];
  for (const parameter of resolved.parameters) {
    const declared = deref(parameter, resolved.definitions);
    if (!declared || !declared.name) return undefined;
    if (declared.in === location) names.push(String(declared.name));
  }
  return names.length ? names : undefined;
};

/** §7.5's multipart rules: one part per key, and a binary part is supplied as a file or not at all. */
const checkMultipart = (step: NormalizedStep, resolved: ResolvedOperation, report: Report) => {
  const schema = requestContent(resolved, 'multipart/form-data').schema;
  const declared = deref(schema, resolved.definitions);
  const properties = propertiesOf(schema, resolved.definitions);
  const body = isMapping(step.body) ? step.body : {};

  if (properties) {
    for (const key of Object.keys(body)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      report.error(
        'unknown-field',
        `${step.id}: body.${key} is not a part the operation declares${suggest(key, Object.keys(properties))}`,
        step.id
      );
    }
  }

  for (const [name, part] of Object.entries(properties || {})) {
    const supplied = body[name];
    const required = (declared?.required || []).includes(name);
    if (deref(part, resolved.definitions)?.format !== 'binary') continue;

    if (supplied === undefined) {
      // §7.1 never seeds a binary property, so a required one nobody supplied is not seeded either.
      if (required) {
        report.error('missing-binary-part', `${step.id}: the required part ${name} has no !file`, step.id);
      }
      continue;
    }
    const entries = Array.isArray(supplied) ? supplied : [supplied];
    if (entries.every((entry) => entry instanceof FileRef)) continue;
    report.error(
      'missing-binary-part',
      `${step.id}: the part ${name} is declared format: binary, and body.${name} is text — a file is written `
      + '`!file ./path`, and the tag is what makes it one (§5.4)',
      step.id
    );
  }
};

/** §7.5's raw payload: the body *is* the file, and the tag's options have nothing to name. */
const checkBinaryBody = (step: NormalizedStep, mediaType: string, report: Report) => {
  const reference = step.bodyFile ? new FileRef(step.bodyFile) : step.body;
  if (!(reference instanceof FileRef)) {
    if (step.body === undefined && step.bodyFile === undefined) {
      report.error(
        'missing-binary-body',
        `${step.id}: ${mediaType} takes the raw bytes of a bodyFile: or a body: !file`,
        step.id
      );
      return;
    }
    report.error(
      'missing-binary-body',
      `${step.id}: ${mediaType} takes the raw bytes of a bodyFile: or a body: !file — a plain value is `
      + 'not a file, whatever it spells (§5.4)',
      step.id
    );
    return;
  }

  if (reference.filename || reference.contentType) {
    report.error(
      'binary-file-options',
      `${step.id}: filename: and contentType: are multipart-only — a raw payload's type is the operation's (§7.5)`,
      step.id
    );
  }
};

/** §7.5's first row: a structured body is a structure, and a file is not a value it can carry. */
const checkStructuredBody = (
  step: NormalizedStep,
  resolved: ResolvedOperation,
  mediaType: string,
  report: Report
) => {
  if (containsFile(step.body)) {
    report.error(
      'file-not-allowed',
      `${step.id}: !file is only a value where the operation accepts one — ${mediaType} does not (§7.5)`,
      step.id
    );
    return;
  }
  checkFields('body', step.body, requestContent(resolved, mediaType).schema, resolved.definitions, step, report);
};

const isStructured = (mediaType: string) =>
  mediaType.includes('json') || mediaType.includes('x-www-form-urlencoded');

/**
 * §6.2: only the bound document is read, so a `$ref` naming another file resolves to nothing.
 *
 * Every field check above is written to fall silent when it cannot see a schema — which is right for
 * an operation that genuinely declares a free-form body, and wrong here. The two are
 * indistinguishable from `propertiesOf`'s `undefined`, so the difference has to be found before it:
 * a step whose body is checked against nothing looks validated, and the failure surfaces one
 * dispatch later as a schema the validator could not compile, blaming the schema rather than the
 * file boundary.
 *
 * A warning, not an error: the flow is well-formed and the document is legal OpenAPI. What is
 * missing is the engine's ability to follow it, and saying so is worth more than refusing to run.
 */
const checkExternalRefs = (step: NormalizedStep, resolved: ResolvedOperation, mediaType: string, report: Report) => {
  const seen = new Set<string>();
  let named: string | undefined;

  const walk = (node: unknown) => {
    if (named || !isMapping(node)) return;

    const reference = typeof node.$ref === 'string' ? node.$ref : undefined;
    if (reference) {
      if (!reference.startsWith('#/')) {
        named = reference;
        return;
      }
      // An internal reference can still lead out of the document, so it is followed — once.
      if (seen.has(reference)) return;
      seen.add(reference);
      walk(deref(node, resolved.definitions));
      return;
    }

    for (const branch of ['allOf', 'oneOf', 'anyOf'] as const) {
      for (const entry of (node[branch] || []) as unknown[]) walk(entry);
    }
    for (const property of Object.values(node.properties || {})) walk(property);
    walk(node.items);
  };

  walk(requestContent(resolved, mediaType).schema);
  if (named === undefined) return;

  report.warn(
    'external-schema-ref',
    `${step.id}: the operation's schema reaches ${named}, which is in another document — only the `
    + 'bound one is read (§6.2), so this step\'s body is checked against nothing and the run will '
    + 'fail it when the validator cannot compile the reference',
    step.id
  );
};

export const checkOperation = (step: NormalizedStep, resolved: ResolvedOperation, report: Report) => {
  const mediaType = selectMediaType(step, resolved, report);
  if (mediaType) checkExternalRefs(step, resolved, mediaType, report);

  if (mediaType === 'multipart/form-data') checkMultipart(step, resolved, report);
  else if (mediaType && !isStructured(mediaType)) checkBinaryBody(step, mediaType, report);
  else if (mediaType) checkStructuredBody(step, resolved, mediaType, report);

  const query = parameterNames(resolved, 'query');
  for (const key of Object.keys(step.query)) {
    if (!query || query.includes(key)) continue;
    report.error(
      'unknown-field',
      `${step.id}: query.${key} is not a query parameter the operation declares${suggest(key, query)}`,
      step.id
    );
  }

  // The template decides this one, and it is never silent the way `parameters:` can be: a path
  // parameter is in the URL whether or not the document also declares it, and a `pathParams:` key
  // the template does not name substitutes into nothing at all.
  const templated = [...resolved.template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const known = [...new Set([...(parameterNames(resolved, 'path') || []), ...templated])];
  for (const key of Object.keys(step.pathParams)) {
    if (known.includes(key)) continue;
    report.error(
      'unknown-field',
      `${step.id}: pathParams.${key} is not in ${resolved.template}${suggest(key, known)}`,
      step.id
    );
  }
};
