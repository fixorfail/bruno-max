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
import { DROP, type ApiBinding, type FlowConfig, type NormalizedStep } from './document';
import { interpolateScalar, interpolateValue, type Scope } from './interpolate';
import { requestExample, requestMediaTypes, requestSchema, type ResolvedOperation } from './openapi';
import type { Auth } from '@usebruno/schema-types/common/auth';
import type { MaterializedRequest, RequestBody } from './types/request';

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

const asBody = (mediaType: string | undefined, value: unknown): RequestBody => {
  if (mediaType === undefined || value === undefined) return { kind: 'none' };
  if (mediaType.includes('json')) return { kind: 'json', value };
  if (mediaType.includes('x-www-form-urlencoded')) {
    return {
      kind: 'urlencoded',
      fields: Object.entries(isMapping(value) ? value : {}).map(([name, entry]) => ({ name, value: String(entry) }))
    };
  }
  return { kind: 'text', value: typeof value === 'string' ? value : JSON.stringify(value), contentType: mediaType };
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
  if (!name || name === 'none') return { mode: 'none' } as Auth;

  const profile = profiles[name];
  if (!profile) throw new MaterializationError('unknown-auth-profile', `${step.id}: no auth profile named ${name}`);
  // A profile is authored data, so its shape is Bruno's `Auth` by declaration rather than by
  // construction — which is the point of §6.4: flows introduce no new auth mechanics, and the
  // engine hands over the same structure a request carries today.
  return interpolateValue(profile.fields, profile.scope()).value as unknown as Auth;
};

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

export const materialize = (
  step: NormalizedStep,
  binding: ApiBinding | undefined,
  resolved: ResolvedOperation,
  profiles: Record<string, AuthProfile>,
  config: FlowConfig,
  scope: Scope
): Materialized => {
  const mediaType = selectMediaType(step, resolved.operation);
  const seed = mediaType
    ? merge(seedFromSchema(requestSchema(resolved.operation, mediaType)), requestExample(resolved.operation, mediaType))
    : undefined;

  const authored = {
    body: merge(seed, step.body),
    query: merge(binding?.defaultQuery, step.query) || {},
    headers: merge(binding?.defaultHeaders, step.headers) || {},
    pathParams: step.pathParams
  };

  const { value, unresolved } = interpolateValue(authored, scope);
  const url = `${resolveBaseUrl(binding, config, resolved, scope)}${substitute(resolved.template, value.pathParams as Record<string, unknown>)}`;

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
      body: asBody(mediaType, value.body),
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
