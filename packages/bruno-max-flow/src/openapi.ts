/**
 * Resolving an `operation:` reference against a bound OpenAPI document — 001 §6.
 *
 * The engine reads a document through the `ReadSpec` port and indexes it by `operationId`, which
 * is the identity §6.1 references. Nothing here dispatches or interpolates: this stage answers
 * only "which method, which path template, which schemas".
 */
import * as path from 'path';
import * as YAML from 'yaml';

/**
 * `merge: true` matches the flow parser (`document.ts`), and `logLevel: 'silent'` keeps the library
 * from writing to whatever console the host owns — §13.1 has the engine report through its return
 * value, and a fixture with an odd construct must not print over the CLI's own output (§14.7).
 */
const YAML_OPTIONS = { merge: true, logLevel: 'silent' as const };

import { normalizeApis, parseDocument } from './document';
import type { FlowContext, ReadSpec } from './types/ports';

export type ResolvedOperation = {
  /** Absent where the document declares none, which is what §6.1's method+path fallback exists for. */
  operationId?: string;
  method: string;
  /** The path template, path parameters unsubstituted. */
  template: string;
  operation: Record<string, any>;
  /** Merged path-item and operation parameters, the operation's winning. */
  parameters: Record<string, any>[];
  servers: string[];
  /**
   * The document's definition sections, carried alongside every operation it declares — §10.1's
   * schema checks are the consumer.
   *
   * A schema lifted out of an OpenAPI document is a *fragment* of it, and nearly every real one
   * refers to the rest: `$ref: '#/components/schemas/Thing'` resolves against the root of whatever
   * is being validated, which for a bare fragment is the fragment. Handing a validator one on its
   * own therefore fails on the first `$ref` — for a spec of any size, on essentially every schema —
   * and it fails by refusing to compile rather than by validating loosely.
   */
  definitions: Record<string, any>;
};

/**
 * §6.1's normalization, by the same rules `openapi-sync.js` applies when it builds its
 * `METHOD:/path` endpoint identity — strip interpolations and the origin, drop the query, convert
 * `{param}` to `:param`, collapse and trim slashes — so flows and openapi-sync agree on what a path
 * *is*.
 *
 * **The same rules, deliberately not the same function.** `normalizeUrlPath` is private to
 * `bruno-electron`, which this package may not import (§13.1); extracting it would mean editing one
 * of the most-churned files in the app and paying for it at every upstream merge.
 */
const normalizeUrlPath = (source: string): string =>
  source
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');

/**
 * `POST /payments/{id}/refund` as one key — §6.1's fallback identity, for the documents where
 * `operationId` is absent. A method and a space are what tell it from an operation id, which §5.3's
 * pattern gives neither.
 */
export const endpointKey = (method: string, template: string): string =>
  `${method.toUpperCase()}:${normalizeUrlPath(template)}`;

const asEndpoint = (reference: string): string | undefined => {
  const [, method, template] = reference.match(/^([a-zA-Z]+)\s+(\S.*)$/) || [];
  return method ? endpointKey(method, template) : undefined;
};

/**
 * Both of §6.1's identities in one lookup, so every reader of a bound document — the run, the graph
 * and `bru flow validate` — resolves a reference the same way. A second index consulted by only
 * some of them would resolve an operation for a run that validation had refused.
 */
class OperationIndex extends Map<string, ResolvedOperation> {
  get(reference: string): ResolvedOperation | undefined {
    const endpoint = asEndpoint(reference);
    return super.get(reference) || (endpoint ? super.get(endpoint) : undefined);
  }

  has(reference: string): boolean {
    return this.get(reference) !== undefined;
  }
}

export type SpecIndex = {
  source: string;
  operations: OperationIndex;
  servers: string[];
  /**
   * The operation ids the document declares more than once. §6.5 makes that a validation error: the
   * reference identifies one operation, and an index built by assignment silently keeps the last.
   */
  duplicates: Set<string>;
};

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const indexDocument = (document: Record<string, any>, source: string): SpecIndex => {
  const servers = (document.servers || []).map((server: Record<string, any>) => String(server.url));
  const operations = new OperationIndex();
  const duplicates = new Set<string>();
  // OpenAPI 3 keeps its schemas under `components`, Swagger 2 under `definitions`, and a `$ref`
  // names whichever its document uses. Carrying both costs a reference and reads either.
  const definitions: Record<string, any> = {};
  if (document.components) definitions.components = document.components;
  if (document.definitions) definitions.definitions = document.definitions;

  for (const [template, item] of Object.entries<Record<string, any>>(document.paths || {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const resolved: ResolvedOperation = {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        template,
        operation,
        parameters: [...(item.parameters || []), ...(operation.parameters || [])],
        definitions,
        servers: (operation.servers || item.servers || document.servers || []).map((server: Record<string, any>) =>
          String(server.url)
        )
      };

      // Indexed under both identities, because §6.1's fallback exists for the operations that have
      // only the second one — a document where `operationId` is absent is exactly where a step has
      // to address the method and path.
      operations.set(endpointKey(method, template), resolved);
      if (!operation.operationId) continue;
      if (operations.has(operation.operationId)) duplicates.add(operation.operationId);
      operations.set(operation.operationId, resolved);
    }
  }

  return { source, operations, servers, duplicates };
};

/**
 * §6.1 and §6.5 in one answer: the operation a step's reference names, `undefined` where nothing
 * does, and `ambiguous` where the document declares the id twice and the reference therefore names
 * two operations.
 */
export const resolveOperation = (
  spec: SpecIndex,
  reference: string
): ResolvedOperation | 'ambiguous' | undefined => {
  if (spec.duplicates.has(reference)) return 'ambiguous';
  return spec.operations.get(reference);
};

/**
 * Where a `source:` resolves to — a URL as written, a file against the document that named it (§6.2).
 *
 * Shared with `flowSpecSources` below rather than written twice: a host watching the documents a
 * flow binds has to arrive at the same path the loader will read, or it watches a file nothing opens.
 */
export const resolveSpecSource = (source: string, from: string): string =>
  /^https?:\/\//.test(source) ? source : path.resolve(path.dirname(from), source);

/**
 * The local documents a flow binds, as absolute paths — 001 §6.2's `apis:`, read as text.
 *
 * **A read, not a resolve**, in `search.ts`'s sense: it opens nothing, so a host can run it over
 * every flow in a directory. It exists for the app's watcher, whose problem is that a flow's
 * diagnostics depend on files outside the directory it watches — an OpenAPI document changing under
 * a flow is invisible to a watcher over `flows/`, and the flow keeps reporting the operations and
 * fields the old document had.
 *
 * Remote documents are omitted: `readSpec` fetches those, and there is no file to watch. A document
 * that does not parse yields nothing rather than throwing — the flow is being edited, and a watcher
 * is not the place a syntax error is reported.
 */
export const flowSpecSources = (file: string, text: string): string[] => {
  const { model, errors } = parseDocument(text);
  if (errors.length) return [];

  return Object.values(normalizeApis(model.apis))
    .map((binding) => resolveSpecSource(binding.source, file))
    .filter((source) => !/^https?:\/\//.test(source));
};

/**
 * Sources are cached per run: an alias pair binding the same document to two hosts (§6.3) would
 * otherwise read and parse it twice, and `ReadSpec`'s `from` field exists so a host can report
 * where a document came from — not so the engine can ask twice.
 */
export class SpecLoader {
  private readonly cache = new Map<string, Promise<SpecIndex>>();

  constructor(private readonly readSpec: ReadSpec, private readonly ctx: FlowContext) {}

  load(source: string, from: string): Promise<SpecIndex> {
    const resolved = resolveSpecSource(source, from);
    const cached = this.cache.get(resolved);
    if (cached) return cached;

    const loading = this.readSpec(resolved, this.ctx).then((document) =>
      indexDocument((YAML.parse(document.text, YAML_OPTIONS) || {}) as Record<string, any>, resolved)
    );
    this.cache.set(resolved, loading);
    return loading;
  }
}

/** The request body schema for a media type, or the sole one when the operation declares one. */
export const requestMediaTypes = (operation: Record<string, any>): string[] =>
  Object.keys(operation.requestBody?.content || {});

/**
 * A schema fragment rooted in its own document, so the `$ref`s it is written with resolve. Ajv reads
 * `#/...` against the root of the schema it was handed, so the definition sections travel with it.
 */
const rooted = (
  schema: Record<string, any> | undefined,
  definitions: Record<string, any>
): Record<string, any> | undefined => (schema ? { ...schema, ...definitions } : undefined);

export const requestSchema = (resolved: ResolvedOperation, mediaType: string): Record<string, any> | undefined =>
  rooted(resolved.operation.requestBody?.content?.[mediaType]?.schema, resolved.definitions);

export const requestExample = (operation: Record<string, any>, mediaType: string): unknown => {
  const content = operation.requestBody?.content?.[mediaType];
  if (!content) return undefined;
  if (content.example !== undefined) return content.example;
  const examples = Object.values<Record<string, any>>(content.examples || {});
  return examples.length ? examples[0].value : undefined;
};

export const responseSchema = (
  resolved: ResolvedOperation,
  status: number
): { schema?: Record<string, any>; documented: boolean } => {
  const responses = resolved.operation.responses || {};
  const entry = responses[String(status)] || responses[`${Math.floor(status / 100)}XX`] || responses.default;
  if (!entry) return { documented: false };

  const content = entry.content || {};
  const json = Object.entries<Record<string, any>>(content).find(([type]) => type.includes('json'));
  return { schema: json ? rooted(json[1].schema, resolved.definitions) : undefined, documented: true };
};
