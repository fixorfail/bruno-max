/**
 * Reading a `.flow.yml` into the model the rest of the engine runs on — 001 §5.
 *
 * Parsing resolves §5.4's local tags to values with identity, and normalization applies every
 * default §5.2 and §5.3 name so no later stage has to ask whether a field was written. The two
 * belong together: a stage that saw the raw document would have to re-derive the implicit sequence
 * (§9.1) or a step's effective flags, and two derivations drift.
 */
import * as yaml from 'js-yaml';

import type { StepStatus } from './types/result';

/** §7.2's removal token. `null` keeps its ordinary meaning and sends a literal JSON null. */
export const DROP = Symbol('bruno.flow.drop');

/** §7.4's file reference. A class, so a hostile body cannot forge one by shape (§5.4). */
export class FileRef {
  path: string;
  filename?: string;
  contentType?: string;

  constructor(data: string | { path: string; filename?: string; contentType?: string }) {
    const fields = typeof data === 'string' ? { path: data } : data;
    this.path = fields.path;
    this.filename = fields.filename;
    this.contentType = fields.contentType;
  }
}

const SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!file', { kind: 'scalar', construct: (data) => new FileRef(data) }),
  new yaml.Type('!file', { kind: 'mapping', construct: (data) => new FileRef(data) }),
  new yaml.Type('!...', { kind: 'scalar', construct: () => DROP })
]);

export type Depends = { mode: 'all' | 'any'; entries: { on: string; status: StepStatus[] }[] };

export type RetryPolicy = {
  maxAttempts: number;
  delay: number;
  backoff: 'fixed' | 'exponential';
  maxDelay: number;
  jitter: 'none' | 'full';
  shouldRetry?: string;
};

export type OutputSpec = {
  name: string;
  from: 'body' | 'headers' | 'status';
  path?: string;
  script?: string;
};

export type AssertionSpec = { expr: string; op: string; value?: string; source: string };

export type StepFlags = {
  failOnStatusCode: boolean;
  failOnUnresolved: boolean;
  validateRequest: boolean;
  validateSchema: boolean;
  strictSchema: boolean;
};

export type NormalizedStep = {
  id: string;
  name?: string;
  kind: 'operation' | 'subflow';
  operation?: { alias: string; operationId: string };
  uses?: string;
  args: Record<string, unknown>;
  auth?: string;
  depends: Depends;
  when: (string | { script: string })[];
  body?: unknown;
  bodyFile?: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  pathParams: Record<string, unknown>;
  contentType?: string;
  outputs: OutputSpec[];
  shared: { slot: string; output: string }[];
  assert: AssertionSpec[];
  retry: RetryPolicy;
  flags: StepFlags;
  timeout?: number;
  maxDuration?: number;
};

export type ApiBinding = {
  alias: string;
  source: string;
  baseUrl?: string;
  auth?: string;
  defaultHeaders: Record<string, unknown>;
  defaultQuery: Record<string, unknown>;
};

export type FlowConfig = StepFlags & {
  baseUrl?: string;
  concurrency: number;
  maxRunDuration?: number;
  cleanupGrace: number;
  retry?: Partial<RetryPolicy>;
};

export type NormalizedFlow = {
  /** Absolute path; a flow's identity is its path (§5.2). */
  file: string;
  version: number;
  meta: { name?: string; description?: string; tags: string[]; library: boolean };
  apis: Record<string, ApiBinding>;
  config: FlowConfig;
  authProfiles: Record<string, Record<string, unknown>>;
  vars: Record<string, unknown>;
  shared: string[];
  dataset?: { source: string; parallel: number };
  params: Record<string, { required: boolean; default?: unknown }>;
  exports: Record<string, string>;
  steps: NormalizedStep[];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  return value === undefined || value === null ? [] : [value as T];
};

const DEFAULT_STATUS: StepStatus[] = ['success'];

/**
 * A step with no `depends` depends on the step immediately above it (§9.1), so a plain list is a
 * plain sequence and an author who never writes `depends` never has to think about the graph.
 */
const normalizeDepends = (raw: unknown, previous?: string): Depends => {
  const entry = (item: unknown): { on: string; status: StepStatus[] } => {
    if (typeof item === 'string') return { on: item, status: DEFAULT_STATUS };
    const mapping = asRecord(item);
    return {
      on: String(mapping.on),
      status: (asArray<StepStatus>(mapping.status).length ? (mapping.status as StepStatus[]) : DEFAULT_STATUS)
    };
  };

  if (raw === undefined) {
    return { mode: 'all', entries: previous ? [{ on: previous, status: DEFAULT_STATUS }] : [] };
  }
  if (Array.isArray(raw)) return { mode: 'all', entries: raw.map(entry) };

  const mapping = asRecord(raw);
  if (Array.isArray(mapping.any)) return { mode: 'any', entries: mapping.any.map(entry) };
  return { mode: 'all', entries: asArray(mapping.all).map(entry) };
};

const normalizeOutputs = (raw: unknown): OutputSpec[] =>
  Object.entries(asRecord(raw)).map(([name, value]) => {
    if (typeof value === 'string') return { name, from: 'body' as const, path: value.replace(/^\$\./, '') };
    const mapping = asRecord(value);
    if (typeof mapping.script === 'string') return { name, from: 'body' as const, script: mapping.script };
    return {
      name,
      from: (mapping.from as OutputSpec['from']) || 'body',
      path: mapping.path === undefined ? undefined : String(mapping.path).replace(/^\$\./, '')
    };
  });

const normalizeShared = (raw: unknown): { slot: string; output: string }[] => {
  if (Array.isArray(raw)) return raw.map((slot) => ({ slot: String(slot), output: String(slot) }));
  return Object.entries(asRecord(raw)).map(([slot, output]) => ({ slot, output: String(output) }));
};

/**
 * `<expr> <op> <value>`, the triple §10.2 compiles to. The operator is the first token that is a
 * known operator name, so an expression may contain spaces and a value may be a quoted string
 * carrying one.
 */
const OPERATORS = new Set([
  'eq', 'neq', '==', '!=', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains', 'notContains',
  'length', 'matches', 'notMatches', 'startsWith', 'endsWith', 'between', 'isEmpty', 'isNotEmpty',
  'isNull', 'isUndefined', 'isDefined', 'isTruthy', 'isFalsy', 'isJson', 'isNumber', 'isString',
  'isBoolean', 'isArray'
]);

export const parseAssertion = (raw: unknown): AssertionSpec => {
  if (raw && typeof raw === 'object') {
    const mapping = asRecord(raw);
    const value = mapping.value === undefined ? undefined : String(mapping.value);
    return {
      expr: String(mapping.expr),
      op: String(mapping.op),
      value,
      source: `${mapping.expr} ${mapping.op}${value === undefined ? '' : ` ${value}`}`
    };
  }

  const source = String(raw).trim();
  const tokens = source.split(/\s+/);
  const at = tokens.findIndex((token, index) => index > 0 && OPERATORS.has(token));
  if (at === -1) return { expr: source, op: 'isTruthy', source };

  return {
    expr: tokens.slice(0, at).join(' '),
    op: tokens[at],
    value: tokens.slice(at + 1).join(' ') || undefined,
    source
  };
};

const normalizeRetry = (raw: unknown, fallback?: Partial<RetryPolicy>): RetryPolicy => {
  const mapping = { ...fallback, ...asRecord(raw) } as Record<string, unknown>;
  return {
    maxAttempts: mapping.maxAttempts === undefined ? 1 : Number(mapping.maxAttempts),
    delay: mapping.delay === undefined ? 0 : Number(mapping.delay),
    backoff: mapping.backoff === 'exponential' ? 'exponential' : 'fixed',
    maxDelay: mapping.maxDelay === undefined ? 30000 : Number(mapping.maxDelay),
    jitter: mapping.jitter === 'full' ? 'full' : 'none',
    shouldRetry: mapping.shouldRetry === undefined ? undefined : String(mapping.shouldRetry)
  };
};

const flag = (step: Record<string, unknown>, config: StepFlags, key: keyof StepFlags): boolean =>
  step[key] === undefined ? config[key] : Boolean(step[key]);

const normalizeApis = (raw: unknown): Record<string, ApiBinding> =>
  Object.fromEntries(
    Object.entries(asRecord(raw)).map(([alias, value]) => {
      const mapping = typeof value === 'string' ? { source: value } : asRecord(value);
      return [
        alias,
        {
          alias,
          source: String(mapping.source),
          baseUrl: mapping.baseUrl === undefined ? undefined : String(mapping.baseUrl),
          auth: mapping.auth === undefined ? undefined : String(mapping.auth),
          defaultHeaders: asRecord(mapping.defaultHeaders),
          defaultQuery: asRecord(mapping.defaultQuery)
        }
      ];
    })
  );

const normalizeConfig = (raw: unknown): FlowConfig => {
  const mapping = asRecord(raw);
  const bool = (key: string, fallback: boolean) => (mapping[key] === undefined ? fallback : Boolean(mapping[key]));
  return {
    baseUrl: mapping.baseUrl === undefined ? undefined : String(mapping.baseUrl),
    failOnStatusCode: bool('failOnStatusCode', true),
    failOnUnresolved: bool('failOnUnresolved', true),
    validateRequest: bool('validateRequest', true),
    validateSchema: bool('validateSchema', true),
    strictSchema: bool('strictSchema', false),
    concurrency: mapping.concurrency === undefined ? 5 : Number(mapping.concurrency),
    maxRunDuration: mapping.maxRunDuration === undefined ? undefined : Number(mapping.maxRunDuration),
    cleanupGrace: mapping.cleanupGrace === undefined ? 30000 : Number(mapping.cleanupGrace),
    retry: mapping.retry === undefined ? undefined : (asRecord(mapping.retry) as Partial<RetryPolicy>)
  };
};

const normalizeDataset = (raw: unknown): NormalizedFlow['dataset'] => {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return { source: raw, parallel: 1 };
  const mapping = asRecord(raw);
  return { source: String(mapping.source), parallel: mapping.parallel === undefined ? 1 : Number(mapping.parallel) };
};

const normalizeParams = (raw: unknown): NormalizedFlow['params'] =>
  Object.fromEntries(
    Object.entries(asRecord(raw)).map(([name, value]) => {
      const mapping = asRecord(value);
      return [name, { required: Boolean(mapping.required), default: mapping.default }];
    })
  );

export const parseDocument = (text: string): Record<string, unknown> =>
  asRecord(yaml.load(text, { schema: SCHEMA }));

export const normalizeFlow = (document: Record<string, unknown>, file: string): NormalizedFlow => {
  const config = normalizeConfig(document.config);
  const meta = asRecord(document.meta);
  const rawSteps = asArray<Record<string, unknown>>(document.steps).map(asRecord);

  const steps = rawSteps.map((raw, index): NormalizedStep => {
    const id = String(raw.id);
    const previous = index === 0 ? undefined : String(rawSteps[index - 1].id);
    const [alias, operationId] = raw.operation === undefined ? [] : String(raw.operation).split('#');

    return {
      id,
      name: raw.name === undefined ? undefined : String(raw.name),
      kind: raw.uses === undefined ? 'operation' : 'subflow',
      operation: alias === undefined ? undefined : { alias, operationId },
      uses: raw.uses === undefined ? undefined : String(raw.uses),
      args: asRecord(raw.with),
      auth: raw.auth === undefined ? undefined : String(raw.auth),
      depends: normalizeDepends(raw.depends, previous),
      when: asArray(raw.when),
      body: raw.body,
      bodyFile: raw.bodyFile === undefined ? undefined : String(raw.bodyFile),
      query: asRecord(raw.query),
      headers: asRecord(raw.headers),
      pathParams: asRecord(raw.pathParams),
      contentType: raw.contentType === undefined ? undefined : String(raw.contentType),
      outputs: normalizeOutputs(raw.outputs),
      shared: normalizeShared(raw.shared),
      assert: asArray(raw.assert).map(parseAssertion),
      retry: normalizeRetry(raw.retry, config.retry),
      flags: {
        failOnStatusCode: flag(raw, config, 'failOnStatusCode'),
        failOnUnresolved: flag(raw, config, 'failOnUnresolved'),
        validateRequest: flag(raw, config, 'validateRequest'),
        validateSchema: flag(raw, config, 'validateSchema'),
        strictSchema: flag(raw, config, 'strictSchema')
      },
      timeout: raw.timeout === undefined ? undefined : Number(raw.timeout),
      maxDuration: raw.maxDuration === undefined ? undefined : Number(raw.maxDuration)
    };
  });

  return {
    file,
    version: Number(document.version),
    meta: {
      name: meta.name === undefined ? undefined : String(meta.name),
      description: meta.description === undefined ? undefined : String(meta.description),
      tags: asArray<string>(meta.tags),
      library: Boolean(meta.library)
    },
    apis: normalizeApis(document.apis),
    config,
    authProfiles: Object.fromEntries(
      Object.entries(asRecord(document.authProfiles)).map(([name, value]) => [name, asRecord(value)])
    ),
    vars: asRecord(document.vars),
    shared: asArray<string>(document.shared).map(String),
    dataset: normalizeDataset(document.dataset),
    params: normalizeParams(document.params),
    exports: Object.fromEntries(
      Object.entries(asRecord(document.exports)).map(([name, value]) => [name, String(value)])
    ),
    steps
  };
};
