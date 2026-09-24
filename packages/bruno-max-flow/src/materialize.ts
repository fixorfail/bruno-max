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
import { deref, requestExample, requestMediaTypes, requestSchema, type ResolvedOperation } from './openapi';
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
 *
 * Every schema is followed through its `$ref` first, since that is how a real document writes one —
 * `expanding` carries the references followed to reach this one, so a schema that refers back to
 * itself seeds nothing at the point the cycle closes instead of descending forever. No finite
 * payload satisfies such a schema anyway; terminating is what matters.
 */
/**
 * §7.1 over a composed schema — the properties and `required` names in force once `allOf`, `oneOf`
 * and `anyOf` are accounted for.
 *
 * **`allOf` is an intersection and `oneOf` / `anyOf` are a choice, so they are seeded differently.**
 * Every `allOf` branch contributes; alternatives contribute only their **first** branch, for the
 * same reason `enum` seeds its first member — a body merged from alternatives satisfies none of
 * them, and §10.1 would then reject a request the engine had built itself.
 *
 * `validate/operation.ts`'s `propertiesOf` merges all three instead, and the difference is
 * deliberate: it asks whether a field name is known *anywhere*, which is the permissive question a
 * warning should ask, while this has to produce a payload that is actually valid.
 *
 * A schema's own `properties` are applied last, so a composed schema that also narrows a branch's
 * property wins — the same order `propertiesOf` uses.
 */
const objectShape = (
  schema: Record<string, any>,
  definitions: Record<string, any>,
  expanding: ReadonlySet<string>
): { properties: Record<string, any>; required: string[] } => {
  const properties: Record<string, any> = {};
  const required = new Set<string>();

  const branches: Record<string, any>[] = schema.allOf || (schema.oneOf || schema.anyOf || []).slice(0, 1);
  for (const branch of branches) {
    const reference = typeof branch.$ref === 'string' ? branch.$ref : undefined;
    if (reference && expanding.has(reference)) continue;
    const resolved = reference ? deref(branch, definitions) : branch;
    if (!resolved) continue;
    const inner = objectShape(resolved, definitions, reference ? new Set([...expanding, reference]) : expanding);
    Object.assign(properties, inner.properties);
    for (const name of inner.required) required.add(name);
  }

  Object.assign(properties, schema.properties || {});
  for (const name of (schema.required || []) as string[]) required.add(name);

  return { properties, required: [...required] };
};

const seedFromSchema = (
  schema: Record<string, any> | undefined,
  definitions: Record<string, any>,
  expanding: ReadonlySet<string> = new Set()
): unknown => {
  if (!schema) return undefined;
  const reference = typeof schema.$ref === 'string' ? schema.$ref : undefined;
  if (reference && expanding.has(reference)) return undefined;

  const resolved = reference ? deref(schema, definitions) : schema;
  if (!resolved) return undefined;
  const followed = reference ? new Set([...expanding, reference]) : expanding;

  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (resolved.enum) return resolved.enum[0];

  // A composed schema usually declares no `type` of its own, so composition is what says this is an
  // object rather than the keyword being there to switch on.
  const composed = Boolean(resolved.allOf || resolved.oneOf || resolved.anyOf);
  if (resolved.type === 'object' || (composed && resolved.type === undefined)) {
    {
      const { properties, required } = objectShape(resolved, definitions, followed);
      const seeded: Record<string, unknown> = {};
      for (const [name, property] of Object.entries<Record<string, any>>(properties)) {
        // Read through the reference, because what decides both of these is the schema the property
        // resolves to and a document is as free to name it as to write it out.
        const declared = deref(property, definitions) || property;
        // There is no useful placeholder for a file, and an empty string would upload zero bytes
        // while looking intentional (§7.5).
        if (declared.format === 'binary') continue;
        const carries = declared.example !== undefined || declared.default !== undefined;
        if (!required.includes(name) && !carries) continue;
        seeded[name] = seedFromSchema(property, definitions, followed);
      }
      return seeded;
    }
  }

  switch (resolved.type) {
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

/**
 * An override subtree that `merge` returns as-is has no seed under it, so a `!...` in it has nothing
 * to remove — the key is absent. It must not stay in as the `DROP` symbol: `JSON.stringify` hides it
 * on the wire, but the body is also handed to scripts as `req.body`, where the symbol cannot go.
 *
 * An array replaces the seed's wholesale, so the same holds for each of its items: one that is
 * `!...` is removed, not sent as the `null` `JSON.stringify` makes of a symbol in an array.
 *
 * Only plain objects are rebuilt: a `FileRef` is a mapping to `isMapping` but must reach stage 5 as
 * itself.
 */
const stripDrops = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.filter((entry) => entry !== DROP).map(stripDrops);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== DROP) stripped[key] = stripDrops(entry);
  }
  return stripped;
};

/**
 * §7.2: objects deep-merge, arrays replace wholesale, `!...` removes a key the seed introduced.
 *
 * Exported for the other place a layer sits beneath a binding's defaults: §8.5's connector files,
 * where a flow's own `defaultHeaders:` overrides the scope's key by key. One implementation, because
 * two layerings of the same block that disagreed about `!...` would be indistinguishable from a bug.
 */
export const merge = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base;
  if (!isMapping(base) || !isMapping(override)) return stripDrops(override);

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
  resolved: ResolvedOperation,
  merged: unknown,
  read: FileReader
): Promise<RequestBody> => {
  const content = resolved.operation.requestBody?.content?.['multipart/form-data'] || {};
  const encoding: Record<string, { contentType?: string }> = content.encoding || {};
  const schema: Record<string, any> = deref(content.schema, resolved.definitions) || {};
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
    const declared = deref(schema.properties?.[required], resolved.definitions);
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

/**
 * §6.3, first match wins: the binding's `baseUrl`, then `config.baseUrl`, then a connector file's
 * (§8.5), then `servers[0]`.
 *
 * **A connector file's host ranks below the flow's own `config.baseUrl`, not beside the binding's.**
 * §8.5's layers are a *default* for what a flow did not say, and `config.baseUrl` is the flow
 * saying it — an author reading a file that sets `config.baseUrl` and watching requests go somewhere
 * else entirely, because of a file two directories up, is the worst version of the locality §8.5
 * already costs. A binding that writes its own `baseUrl:` still outranks both, exactly as before.
 */
const resolveBaseUrl = (
  binding: ApiBinding | undefined,
  config: FlowConfig,
  resolved: ResolvedOperation,
  scope: Scope
): string => {
  const candidate
    = binding?.baseUrl || config.baseUrl || binding?.inheritedBaseUrl || resolved.servers[0] || '';
  return interpolateScalar(candidate, scope).replace(/\/$/, '');
};

/**
 * A profile carries the scope of the flow that *declared* it: §6.4 resolves profiles lexically, so
 * an inherited `{{steps.auth.token}}` reads the parent's step state and a sub-flow cannot use an
 * inherited profile to reach parent data indirectly (§12.3).
 *
 * `scope` is absent on a profile a host supplied (`RunOptions.authProfiles` — §6.4's implicit
 * `collection`): no flow declared it, so there is no lexical scope to carry, and it resolves in the
 * scope of the step that uses it.
 */
export type AuthProfile = { fields: Record<string, unknown>; scope?: () => Scope };

/**
 * §6.4, first match wins: the step's `auth:`, then the binding's, then the implicit `collection`
 * profile, then `none`. That third rank is what makes §6.4's promise true — a collection flow
 * calling one API "declares no `authProfiles` at all and authenticates exactly as the collection
 * does" — so a step naming nothing sends the collection's credentials rather than none.
 *
 * The implicit profile exists only for collection-scoped flows and is the host's to supply, through
 * `RunOptions.authProfiles`; `scope` is the using step's, which is what such a profile resolves in.
 * Where no host supplied one — a workspace-scoped run — there is no default to fall to and the step
 * sends `none`.
 *
 * `auth: none` stays the opt-out, on the step or on the binding: the step that must *not* carry the
 * collection's credentials is the only one that has to say so.
 */
const resolveAuth = (
  step: NormalizedStep,
  binding: ApiBinding | undefined,
  profiles: Record<string, AuthProfile>,
  scope: Scope
): Auth => {
  const name = step.auth || binding?.auth || (profiles.collection ? 'collection' : 'none');
  if (name === 'none') return { mode: 'none' };

  const profile = profiles[name];
  if (!profile) throw new MaterializationError('unknown-auth-profile', `${step.id}: no auth profile named ${name}`);

  const { mode, ...fields } = interpolateValue(profile.fields, profile.scope ? profile.scope() : scope).value as {
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

/**
 * §6.4's implicit `collection` profile: a collection's stored auth block, as the `AuthProfile` a
 * host hands to `RunOptions.authProfiles`.
 *
 * Bruno stores auth nested — `{ mode: 'bearer', bearer: { token } }`, which is what `setAuthHeaders`
 * reads and what `collection.bru` and `opencollection.yml` parse to — while a profile's fields are
 * authored flat, `mode:` beside that mode's own fields. This is that nesting undone, and it lives
 * beside the `resolveAuth` that nests it back for §13.1's reason: every host reads its own files,
 * but a mapping each of them owned a copy of is a mapping the CLI and the app can disagree about.
 *
 * **Never fails, and always answers.** A collection whose auth is `none`, is `inherit` — there is
 * nothing above a collection root to inherit from — is absent, or is not an auth block at all
 * yields `{ fields: { mode: 'none' } }`. §6.4 promises a collection flow "authenticates exactly as
 * the collection does", and a collection that authenticates with nothing is still one of those, so
 * `auth: collection` resolves for every collection rather than for the ones somebody had filled in.
 *
 * No `scope`: a profile's scope decides what its `{{...}}` resolve against, and §6.4 resolves a
 * *declared* profile lexically against the flow that declared it. No flow declared this one, so it
 * resolves in the using step's scope — which is what makes `{{authToken}}` in a collection's bearer
 * token read the run's variables rather than nothing.
 */
export const collectionAuthProfile = (auth: unknown): AuthProfile => {
  const stored = isMapping(auth) ? auth : {};
  const mode = stored.mode as AuthMode | undefined;
  if (!mode || mode === 'none' || mode === 'inherit') return { fields: { mode: 'none' } };

  const fields = stored[authFieldKey(mode)];
  return { fields: { mode, ...(isMapping(fields) ? fields : {}) } };
};

/**
 * §14.4's provenance half, over the credentials the engine resolves itself: which field of each
 * mode *is* the secret.
 *
 * The line drawn is between a field that **authenticates** — a password, a token, a shared secret, a
 * signing key — and one that only identifies who is calling. `username`, `clientId`, `consumerKey`,
 * an AWS `accessKeyId`, an Akamai `clientToken` and an API key's header `key` are names: useless on
 * their own, and masking them would blank a recognizable string out of every URL, body and message a
 * report shows while protecting nothing. §14.4's own examples — `token`, `password`, `clientSecret`,
 * `privateKey` — are all of the first kind.
 */
const CREDENTIAL_FIELDS: Record<AuthMode, string[]> = {
  'inherit': [],
  'none': [],
  'awsv4': ['secretAccessKey', 'sessionToken'],
  'basic': ['password'],
  'bearer': ['token'],
  'digest': ['password'],
  'ntlm': ['password'],
  'oauth1': ['consumerSecret', 'accessToken', 'accessTokenSecret', 'privateKey'],
  'oauth2': ['password', 'clientSecret'],
  'wsse': ['password'],
  'apikey': ['value'],
  'akamai-edgegrid': ['clientSecret', 'accessToken']
};

/**
 * The credential values this request's auth resolved to, for the run to mask wherever they later
 * appear (§14.4).
 *
 * Read off the resolved `Auth` rather than the profile's authored fields, so a credential written as
 * `{{loginPassword}}` is tracked as the value that went out rather than as the reference.
 */
const credentialValues = (auth: Auth): string[] => {
  const fields = (auth as unknown as Record<string, unknown>)[authFieldKey(auth.mode)] as
    | Record<string, unknown>
    | undefined;
  if (!fields) return [];
  return CREDENTIAL_FIELDS[auth.mode]
    .map((name) => fields[name])
    .filter((value): value is string => typeof value === 'string');
};

const substitute = (template: string, params: Record<string, unknown>): string =>
  template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : encodeURIComponent(String(params[name]))
  );

const toQuery = (query: Record<string, unknown>): { name: string; value: string }[] =>
  Object.entries(query).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((entry) => ({ name, value: String(entry) }))
  );

/**
 * §10.1's checkable view of a multipart body: every part but the files, whose bytes are one of the
 * three things the check is "not applicable" to. Dropping them here rather than at the check keeps
 * `FileRef` — §7.5's marker — inside the module that assembles bodies out of it.
 */
const withoutFileParts = (merged: unknown): Record<string, unknown> | undefined =>
  isMapping(merged)
    ? Object.fromEntries(Object.entries(merged).filter(([, value]) => !containsFile(value)))
    : undefined;

export type Materialized = {
  request: MaterializedRequest;
  mediaType?: string;
  /**
   * The body as the operation's schema describes it — the merged structure, before §7.5 encoded it
   * for the wire. §10.1 validates *this* rather than `request.body`, because a urlencoded field is
   * a string on the wire whatever the schema declares and a multipart part is its own document:
   * checking the encoded form would fail every request the schema types as anything but a string.
   *
   * Absent where §10.1 has nothing to check — a raw binary body, or no body at all.
   */
  validatableBody?: unknown;
  /** `steps.*` references naming an output the run never produced (§11.2). */
  unresolved: string[];
  /** What the resolved auth profile contributed to §14.4's set of secret values. */
  secrets: string[];
};

/**
 * The inline layer a step contributes, which is its `body:` or its `bodyFile:` — never both (§7.2).
 * The order for a file is: interpolate the path, read it, merge the contents, then interpolate the
 * contents, which is what makes a fixture selectable by something an earlier step produced.
 */
/**
 * §7.1's seed for a structured or multipart body: the schema's, with the operation's example over it.
 *
 * Exported for validation, which asks whether a step's `!...` names a key this produces. One
 * implementation, because a check that seeded differently would warn about the wrong keys.
 */
export const seedBody = (resolved: ResolvedOperation, mediaType: string): unknown =>
  merge(seedFromSchema(requestSchema(resolved, mediaType), resolved.definitions), requestExample(resolved.operation, mediaType));

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

  const seed = mediaType && !raw ? seedBody(resolved, mediaType) : undefined;

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
  let validatableBody: unknown;
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
    body = await assembleMultipart(step, resolved, value.body, read);
    validatableBody = withoutFileParts(value.body);
  } else if (mediaType !== undefined) {
    if (containsFile(value.body)) {
      throw new MaterializationError(
        'file-not-allowed',
        `${step.id}: !file is only a value where the operation accepts one — ${mediaType} does not`
      );
    }
    body = asStructuredBody(mediaType, value.body);
    if (body.kind !== 'none') validatableBody = value.body;
  }

  const auth = resolveAuth(step, binding, profiles, scope);

  return {
    mediaType,
    validatableBody,
    unresolved,
    secrets: credentialValues(auth),
    request: {
      method: resolved.method,
      url,
      query: toQuery(value.query as Record<string, unknown>),
      headers: Object.fromEntries(
        Object.entries(value.headers as Record<string, unknown>).map(([name, entry]) => [name, String(entry)])
      ),
      body,
      auth,
      operation: {
        api: binding?.alias || '',
        operationId: resolved.operationId,
        method: resolved.method,
        path: resolved.template
      }
    }
  };
};
