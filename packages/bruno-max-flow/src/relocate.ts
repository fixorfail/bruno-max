/**
 * Moving a flow to another directory — 002 §4.1d.
 *
 * Every path a flow writes resolves against the flow's own directory (§6.2, §7.4, §8.6, §12.2), so a
 * flow moved one folder deeper reads its documents, fixtures, scripts and sub-flows one folder too
 * deep. This rewrites each of them to name the same file from the new place.
 *
 * **Only the moved flow's own paths.** A flow that `uses:` the moved one still names the old path,
 * for §4.5's reason: rewriting files the author did not touch, on a guess about which paths meant
 * this one, is not an edit a move can make on their behalf. `bru flow validate` reports what broke.
 *
 * **The engine writes it, rather than the host,** for `meta.ts`' reason: a host editing the document
 * with a YAML library of its own would be a second serializer, and it would have to know §5.4's local
 * tags to find the `!file` paths at all.
 */
import * as path from 'path';

import * as YAML from 'yaml';

import { PARSE_OPTIONS } from './serialize';

const FILE_TAG = '!file';

/**
 * A path the rewrite leaves as written: a URL (§6.2's remote document), §12.2's `workspace:` prefix,
 * an absolute path, or an interpolated one — all of which name the same file from any directory, or
 * name one only a run can resolve.
 *
 * The scheme test covers the first two, and a Windows drive letter with them.
 */
const isRelativePath = (value: string): boolean =>
  value.trim() !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.isAbsolute(value) && !value.includes('{{');

/**
 * The same file, named from `to`. POSIX separators whatever the platform, because the file is shared
 * across machines and §7.4 resolves either spelling. A `./` the author wrote is kept where the new
 * path still needs no `../`.
 */
const rebase = (value: string, from: string, to: string): string => {
  const relative = path.relative(to, path.resolve(from, value)).split(path.sep).join('/');
  if (value.startsWith('./') && !relative.startsWith('.')) {
    return `./${relative}`;
  }
  return relative || '.';
};

/** A scalar holding a path in one of the format's two shapes: bare, or under a mapping's `source`. */
const pathNodeOf = (node: unknown, key: string): unknown => (YAML.isMap(node) ? node.get(key, true) : node);

const seqItemsOf = (node: unknown): unknown[] => (YAML.isSeq(node) ? node.items : [node]);

/**
 * Every node holding a path, each once.
 *
 * A set, because one node can be reached twice — a `bodyFile: !file x` is both a step's `bodyFile`
 * and a `!file` — and rebasing it twice would move it two directories.
 */
const pathNodesOf = (document: YAML.Document): Set<unknown> => {
  const found = new Set<unknown>();

  const apis = document.get('apis', true);
  if (YAML.isMap(apis)) {
    apis.items.forEach((pair) => found.add(pathNodeOf(pair.value, 'source')));
  }

  const functions = document.get('functions', true);
  if (YAML.isMap(functions)) {
    seqItemsOf(functions.get('use', true)).forEach((node) => found.add(node));
  }

  found.add(pathNodeOf(document.get('dataset', true), 'source'));

  const steps = document.get('steps', true);
  if (YAML.isSeq(steps)) {
    for (const step of steps.items) {
      if (YAML.isMap(step)) {
        found.add(step.get('uses', true));
        found.add(step.get('bodyFile', true));
      }
    }
  }

  YAML.visit(document, {
    Scalar: (key, node) => {
      if (node.tag === FILE_TAG) found.add(node);
    },
    Map: (key, node) => {
      if (node.tag === FILE_TAG) found.add(node.get('path', true));
    }
  });

  return found;
};

/**
 * The flow's text with every relative path rebased from `from` to `to` — both the flow's own absolute
 * path, before and after the move.
 *
 * `undefined` for text that does not parse, for `writeFlowProperties`' reason: there is no document to
 * rewrite, and moving it unchanged would break its paths without a word. The text itself comes back
 * when nothing needed rewriting, so a move within one directory is not an edit.
 */
export const rebaseFlowPaths = (text: string, from: string, to: string): string | undefined => {
  const document = YAML.parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length) return undefined;

  const fromDirectory = path.dirname(from);
  const toDirectory = path.dirname(to);
  let changed = false;

  for (const node of pathNodesOf(document)) {
    if (!YAML.isScalar(node) || typeof node.value !== 'string' || !isRelativePath(node.value)) continue;

    const next = rebase(node.value, fromDirectory, toDirectory);
    if (next !== node.value) {
      node.value = next;
      changed = true;
    }
  }

  return changed ? String(document) : text;
};
