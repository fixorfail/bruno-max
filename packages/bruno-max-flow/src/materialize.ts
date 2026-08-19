/**
 * Request materialization — 001 §7, stages 2 through 5.
 *
 * Stage 1 (resolving the operation) is `openapi.ts`. What is left is deterministic and has no
 * side effects: seed from the spec, merge the binding's defaults and then the step's inline
 * values, interpolate, and resolve the base URL and auth profile the request goes out with.
 *
 * §7.5's media-type decision is made here rather than by a host, which is why `RequestBody` is a
 * tagged union: handing hosts a bare object would leave each of them re-deriving "is this
 * multipart?" from the body's shape.
 */
import { DROP, FileRef, type ApiBinding, type FlowConfig, type NormalizedStep } from './document';
import { basenameOf, contentTypeFor, parseStructured, type FileReader } from './files';
import { interpolateScalar, interpolateValue, type Scope } from './interpolate';
import { requestExample, requestMediaTypes, requestSchema, type ResolvedOperation } from './openapi';
import type { Auth, AuthMode } from '@usebruno/schema-types/common/auth';
import type { MaterializedRequest, MultipartPart, RequestBody } from './types/request';

export class MaterializationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * §7.1. Required properties are always seeded; optional ones only when they carry an `example` or
 * `default`, or an optional field with no meaningful value would be sent on every request.
 */
const seedFromSchema = (schema: Record<string, any> | undefined): unknown => {
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];

  switch (schema.type) {
    case 'object': {
      const required: string[] = schema.required || [];
      const seeded: Record<string, unknown> = {};
      for (const [name, property] of Object.entries<Record<string, any>>(schema.properties || {})) {
        // There is no useful placeholder for a file, and an empty string would upload zero bytes
        // while looking intentional (§7.5).
        if (property.format === 'binary') continue;
        const carries = property.example !== undefined || property.default !== undefined;
        if (!required.includes(name) && !carries) continue;
        seeded[name] = seedFromSchema(property);
      }
      return seeded;
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return '';
    default:
      return undefined;
  }
};

/** §7.2: objects deep-merge, arrays replace wholesale, `!...` removes a key the seed introduced. */
const merge = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base;
  if (!isMapping(base) || !isMapping(override)) return override;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === DROP) {
      delete merged[key];
      continue;
    }
    merged[key] = merge(merged[key], value);
  }
  return merged;
};

/**
 * §7.5. The operation decides the media type; `contentType:` is legal only where it declares more
 * than one, and nothing is inferred from the body's shape.
 */
const selectMediaType = (step: NormalizedStep, operation: Record<string, any>): string | undefined => {
  const declared = requestMediaTypes(operation);
  if (declared.length === 0) return undefined;
  if (step.contentType) {
    if (!declared.includes(step.contentType)) {
      throw new MaterializationError(
        'unknown-media-type',
        `${step.id}: the operation does not declare ${step.contentType}`
      );
    }
    return step.contentType;
  }
  if (declared.length > 1) {
    throw new MaterializationError(
      'ambiguous-media-type',
      `${step.id}: the operation declares ${declared.join(', ')} — set contentType: on the step`
    );
  }
  return declared[0];
};

/** §7.5's first row: the structured media types, assembled from the merged structure. */
const isStructured = (mediaType: string) =>
  mediaType.includes('json') || mediaType.includes('x-www-form-urlencoded');

const containsFile = (value: unknown): boolean => {
  if (value instanceof FileRef) return true;
  if (Array.isArray(value)) return value.some(containsFile);
  if (isMapping(value)) return Object.values(value).some(containsFile);
  return false;
};

const asStructuredBody = (mediaType: string, value: unknown): RequestBody => {
  if (value === undefined) return { kind: 'none' };
  if (mediaType.includes('json')) return { kind: 'json', value };
  return {
    kind: 'urlencoded',
    fields: Object.entries(isMapping(value) ? value : {}).map(([name, entry]) => ({ name, value: String(entry) }))
  };
};

/**
 * §7.5. Each key of the merged structure becomes a part; a `!file` value makes that part a file
 * upload and anything else a field. Repeated parts are an array, consistent with §7.2 replacing
 * arrays wholesale.
 */
const assembleMultipart = async (
  step: NormalizedStep,
  operation: Record<string, any>,
  merged: unknown,
  read: FileReader
): Promise<RequestBody> => {
  const content = operation.requestBody?.content?.['multipart/form-data'] || {};
  const encoding: Record<string, { contentType?: string }> = content.encoding || {};
  const schema: Record<string, any> = content.schema || {};
  const parts: MultipartPart[] = [];

  for (const [name, value] of Object.entries(isMapping(merged) ? merged : {})) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry instanceof FileRef) {
        parts.push({
          name,
          kind: 'file',
          file: {
            bytes: await read(entry.path),
            filename: entry.filename || basenameOf(entry.path),
            contentType: contentTypeFor(entry.path, entry.contentType, encoding[name]?.contentType),
            sourcePath: entry.path
          }
        });
        continue;
      }
      // A part typed `object` is sent as JSON, matching OpenAPI's default encoding rather than
      // flattening it to a string.
      const asJson = isMapping(entry) || Array.isArray(entry);
      parts.push({
        name,
        kind: 'field',
        value: asJson ? JSON.stringify(entry) : String(entry),
        contentType: asJson ? encoding[name]?.contentType || 'application/json' : encoding[name]?.contentType
      });
    }
  }

  // §7.1 never seeds a `format: binary` property, so a required one that nobody supplied is a
  // validation error naming the part — a better failure than a request the server rejects for
  // reasons the flow cannot explain.
  for (const required of schema.required || []) {
    const declared = schema.properties?.[required];
    if (declared?.format === 'binary' && !parts.some((part) => part.name === required)) {
      throw new MaterializationError('missing-binary-part', `${step.id}: the required part ${required} has no file`);
    }
  }

  return { kind: 'multipart', parts };
};

/**
 * §7.5's raw binary: the body *is* the file, with no merge layer and no interpolation —
 * substituting into bytes would corrupt them. `body: !file` and `bodyFile:` are one form with two
 * spellings, so both arrive here.
 */
const assembleBinary = async (
  step: NormalizedStep,
  reference: FileRef,
  scope: Scope,
  read: FileReader
): Promise<RequestBody> => {
  if (reference.filename || reference.contentType) {
    throw new MaterializationError(
      'binary-file-options',
      `${step.id}: filename: and contentType: are multipart-only — the payload's type is the operation's`
    );
  }

  const source = interpolateScalar(reference.path, scope);
  return {
    kind: 'binary',
    file: {
      bytes: await read(source),
      filename: basenameOf(source),
      contentType: contentTypeFor(source),
      sourcePath: source
    }
  };
};

/** §6.3, first match wins: the binding's `baseUrl`, then `config.baseUrl`, then `servers[0]`. */
const resolveBaseUrl = (
  binding: ApiBinding | undefined,
  config: FlowConfig,
  resolved: ResolvedOperation,
  scope: Scope
): string => {
  const candidate = binding?.baseUrl || config.baseUrl || resolved.servers[0] || '';
  return interpolateScalar(candidate, scope).replace(/\/$/, '');
};

/**
 * A profile carries the scope of the flow that *declared* it: §6.4 resolves profiles lexically, so
 * an inherited `{{steps.auth.token}}` reads the parent's step state and a sub-flow cannot use an
 * inherited profile to reach parent data indirectly (§12.3).
 */
export type AuthProfile = { fields: Record<string, unknown>; scope: () => Scope };

/**
 * §6.4, first match wins: the step's `auth:`, then the binding's, then `none`. The implicit
 * `collection` profile exists only for collection-scoped flows and is the host's to supply.
 */
const resolveAuth = (
  step: NormalizedStep,
  binding: ApiBinding | undefined,
  profiles: Record<string, AuthProfile>
): Auth => {
  const name = step.auth || binding?.auth;
  if (!name || name === 'none') return { mode: 'none' };

  const profile = profiles[name];
  if (!profile) throw new MaterializationError('unknown-auth-profile', `${step.id}: no auth profile named ${name}`);

  const { mode, ...fields } = interpolateValue(profile.fields, profile.scope()).value as {
    mode?: AuthMode;
    [field: string]: unknown;
  };
  if (!mode || mode === 'none') return { mode: 'none' };

  // §6.4: authored flat, delivered as Bruno's `Auth`, which nests each mode's fields under a key
  // named for the mode. Both hosts read the nested form — the app hands it straight to
  // `setAuthHeaders` — so converting here is what keeps them from writing an adapter each.
  return { mode, [authFieldKey(mode)]: fields } as Auth;
};

/** Every mode's fields live under its own name in `Auth`; only Akamai's key is not the mode string. */
const authFieldKey = (mode: AuthMode): string => (mode === 'akamai-edgegrid' ? 'akamaiEdgegrid' : mode);

const substitute = (template: string, params: Record<string, unknown>): string =>
  template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : encodeURIComponent(String(params[name]))
  );

const toQuery = (query: Record<string, unknown>): { name: string; value: string }[] =>
  Object.entries(query).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((entry) => ({ name, value: String(entry) }))
  );

export type Materialized = {
  request: MaterializedRequest;
  mediaType?: string;
  /** `steps.*` references naming an output the run never produced (§11.2). */
  unresolved: string[];
};

/**
 * The inline layer a step contributes, which is its `body:` or its `bodyFile:` — never both (§7.2).
 * The order for a file is: interpolate the path, read it, merge the contents, then interpolate the
 * contents, which is what makes a fixture selectable by something an earlier step produced.
 */
const inlineLayer = async (step: NormalizedStep, scope: Scope, read: FileReader): Promise<unknown> => {
  if (!step.bodyFile) return step.body;
  const source = interpolateScalar(step.bodyFile, scope);
  return parseStructured(source, (await read(source)).toString('utf8'));
};

export const materialize = async (
  step: NormalizedStep,
  binding: ApiBinding | undefined,
  resolved: ResolvedOperation,
  profiles: Record<string, AuthProfile>,
  config: FlowConfig,
  scope: Scope,
  read: FileReader
): Promise<Materialized> => {
  const mediaType = selectMediaType(step, resolved.operation);
  const raw = mediaType !== undefined && !isStructured(mediaType) && mediaType !== 'multipart/form-data';

  const seed = mediaType && !raw
    ? merge(seedFromSchema(requestSchema(resolved, mediaType)), requestExample(resolved.operation, mediaType))
    : undefined;

  const authored = {
    // A raw payload takes no merge layer at all, so the seed and the step's value never meet.
    body: raw ? undefined : merge(seed, await inlineLayer(step, scope, read)),
    query: merge(binding?.defaultQuery, step.query) || {},
    headers: merge(binding?.defaultHeaders, step.headers) || {},
    pathParams: step.pathParams
  };

  const { value, unresolved } = interpolateValue(authored, scope);
  const url = `${resolveBaseUrl(binding, config, resolved, scope)}${substitute(resolved.template, value.pathParams as Record<string, unknown>)}`;

  let body: RequestBody = { kind: 'none' };
  if (raw) {
    const reference = step.bodyFile ? new FileRef(step.bodyFile) : step.body;
    if (!(reference instanceof FileRef)) {
      throw new MaterializationError(
        'missing-binary-body',
        `${step.id}: ${mediaType} takes the raw bytes of a bodyFile: or a body: !file`
      );
    }
    body = await assembleBinary(step, reference, scope, read);
  } else if (mediaType === 'multipart/form-data') {
    body = await assembleMultipart(step, resolved.operation, value.body, read);
  } else if (mediaType !== undefined) {
    if (containsFile(value.body)) {
      throw new MaterializationError(
        'file-not-allowed',
        `${step.id}: !file is only a value where the operation accepts one — ${mediaType} does not`
      );
    }
    body = asStructuredBody(mediaType, value.body);
  }

  return {
    mediaType,
    unresolved,
    request: {
      method: resolved.method,
      url,
      query: toQuery(value.query as Record<string, unknown>),
      headers: Object.fromEntries(
        Object.entries(value.headers as Record<string, unknown>).map(([name, entry]) => [name, String(entry)])
      ),
      body,
      auth: resolveAuth(step, binding, profiles),
      operation: {
        api: binding?.alias || '',
        operationId: resolved.operationId,
        method: resolved.method,
        path: resolved.template
      }
    }
  };
};
