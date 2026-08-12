/**
 * Resolving an `operation:` reference against a bound OpenAPI document — 001 §6.
 *
 * The engine reads a document through the `ReadSpec` port and indexes it by `operationId`, which
 * is the identity §6.1 references. Nothing here dispatches or interpolates: this stage answers
 * only "which method, which path template, which schemas".
 */
import * as path from 'path';
import * as yaml from 'js-yaml';

import type { FlowContext, ReadSpec } from './types/ports';

export type ResolvedOperation = {
  operationId: string;
  method: string;
  /** The path template, path parameters unsubstituted. */
  template: string;
  operation: Record<string, any>;
  /** Merged path-item and operation parameters, the operation's winning. */
  parameters: Record<string, any>[];
  servers: string[];
};

export type SpecIndex = {
  source: string;
  operations: Map<string, ResolvedOperation>;
  servers: string[];
};

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const indexDocument = (document: Record<string, any>, source: string): SpecIndex => {
  const servers = (document.servers || []).map((server: Record<string, any>) => String(server.url));
  const operations = new Map<string, ResolvedOperation>();

  for (const [template, item] of Object.entries<Record<string, any>>(document.paths || {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || !operation.operationId) continue;
      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        template,
        operation,
        parameters: [...(item.parameters || []), ...(operation.parameters || [])],
        servers: (operation.servers || item.servers || document.servers || []).map((server: Record<string, any>) =>
          String(server.url)
        )
      });
    }
  }

  return { source, operations, servers };
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
    const resolved = /^https?:\/\//.test(source) ? source : path.resolve(path.dirname(from), source);
    const cached = this.cache.get(resolved);
    if (cached) return cached;

    const loading = this.readSpec(resolved, this.ctx).then((document) =>
      indexDocument((yaml.load(document.text) || {}) as Record<string, any>, resolved)
    );
    this.cache.set(resolved, loading);
    return loading;
  }
}

/** The request body schema for a media type, or the sole one when the operation declares one. */
export const requestMediaTypes = (operation: Record<string, any>): string[] =>
  Object.keys(operation.requestBody?.content || {});

export const requestSchema = (operation: Record<string, any>, mediaType: string): Record<string, any> | undefined =>
  operation.requestBody?.content?.[mediaType]?.schema;

export const requestExample = (operation: Record<string, any>, mediaType: string): unknown => {
  const content = operation.requestBody?.content?.[mediaType];
  if (!content) return undefined;
  if (content.example !== undefined) return content.example;
  const examples = Object.values<Record<string, any>>(content.examples || {});
  return examples.length ? examples[0].value : undefined;
};

export const responseSchema = (
  operation: Record<string, any>,
  status: number
): { schema?: Record<string, any>; documented: boolean } => {
  const responses = operation.responses || {};
  const entry = responses[String(status)] || responses[`${Math.floor(status / 100)}XX`] || responses.default;
  if (!entry) return { documented: false };

  const content = entry.content || {};
  const json = Object.entries<Record<string, any>>(content).find(([type]) => type.includes('json'));
  return { schema: json ? json[1].schema : undefined, documented: true };
};
