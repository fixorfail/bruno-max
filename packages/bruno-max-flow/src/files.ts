/**
 * File sources — 001 §7.4.
 *
 * Paths resolve relative to the flow file and must stay **within the scope root**. That
 * containment is enforced here, before the `ReadFile` port is called, so no host can forget it and
 * a run that would have read the file and then rejected it has already read it.
 *
 * It is not hypothetical hygiene: flows are committed and shared, so a flow arriving on a
 * teammate's branch runs on your machine with your credentials, and `!file ../../../.ssh/id_rsa`
 * would be read and sent. §14.4's redaction cannot help — a file's contents have no
 * secret-variable provenance to trace.
 */
import * as path from 'path';
import * as YAML from 'yaml';

/**
 * `merge: true` matches the flow parser (`document.ts`), and `logLevel: 'silent'` keeps the library
 * from writing to whatever console the host owns — §13.1 has the engine report through its return
 * value, and a fixture with an odd construct must not print over the CLI's own output (§14.7).
 */
const YAML_OPTIONS = { merge: true, logLevel: 'silent' as const };

import { parseDataset } from './dataset';
import type { FlowContext, ReadFile } from './types/ports';

export class FileAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Resolves against the flow that named the path, then refuses anything outside the scope root.
 * `path.relative` is what decides containment: a result that climbs out starts with `..`, and one
 * that is absolute means a different volume.
 */
export const resolveWithin = (source: string, flowFile: string, scopeRoot: string): string => {
  const resolved = path.resolve(path.dirname(flowFile), source);
  const relative = path.relative(scopeRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FileAccessError('path-outside-scope', `${source} resolves outside the scope root`);
  }
  return resolved;
};

export type FileReader = (source: string) => Promise<Buffer>;

export const createFileReader = (readFile: ReadFile, ctx: FlowContext, scopeRoot: string): FileReader =>
  async (source) => {
    const resolved = resolveWithin(source, ctx.flow, scopeRoot);
    try {
      return await readFile(resolved, ctx);
    } catch (cause) {
      throw new FileAccessError('file-read-failed', `${source}: ${(cause as Error).message}`);
    }
  };

/** The loader `!file` and `dataset:` share (§7.4) — one rule, so a fixture reads the same either way. */
export const parseStructured = (source: string, text: string): unknown => {
  const extension = path.extname(source).toLowerCase();
  if (extension === '.json') return JSON.parse(text);
  if (extension === '.yml' || extension === '.yaml') return YAML.parse(text, YAML_OPTIONS);
  if (extension === '.csv') return parseDataset(source, text);
  throw new FileAccessError('unsupported-file-format', `${source}: expected .json, .yml or .csv`);
};

/**
 * §7.5's four-step resolution for a part's content type, first match wins. The spec's `encoding` is
 * consulted before the extension because the API's own declaration is better evidence than a suffix.
 */
const EXTENSION_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip'
};

export const contentTypeFor = (source: string, explicit?: string, declared?: string): string =>
  explicit || declared || EXTENSION_TYPES[path.extname(source).toLowerCase()] || 'application/octet-stream';

export const basenameOf = (source: string): string => path.basename(source);
