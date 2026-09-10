/**
 * Where a flow's file references point — 001 §7.4 and §14.3.
 *
 * Two questions, asked of every statically-known path: does it stay inside the scope root, and is it
 * there? The first is the one that matters. Flows are committed and shared, so a flow arriving on a
 * teammate's branch runs on your machine with your credentials, and `!file ../../../.ssh/id_rsa`
 * would be read and sent — §14.4's redaction cannot help, because a file's contents have no
 * secret-variable provenance to trace. `files.ts` enforces containment before the read at run time;
 * this is the same rule one command earlier, where the answer costs nothing to act on.
 *
 * A path carrying `{{...}}` is left alone: §7.4 resolves it when the step materializes, precisely so
 * a fixture can be selected by something an earlier step produced, and there is nothing to look up
 * until then. Containment is still enforced at run time, where the value exists.
 */
import path from 'node:path';

import { FileRef, type NormalizedFlow } from '../document';
import { resolveWithin } from '../files';
import type { Report } from './report';

type Located = { source: string; stepId?: string; node: (string | number)[]; where: string };

const interpolated = (source: string) => source.includes('{{');

/** Every path the document names: `!file` wherever it appears, `bodyFile:`, and `dataset:`. */
const sourcesIn = (flow: NormalizedFlow): Located[] => {
  const found: Located[] = [];

  const walk = (value: unknown, path: (string | number)[]) => {
    if (value instanceof FileRef) {
      found.push({
        source: value.path,
        stepId: path[0] === 'steps' && typeof path[1] === 'number' ? flow.steps[path[1]]?.id : undefined,
        node: path,
        where: `!file ${value.path}`
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...path, index]));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walk(entry, [...path, key]);
    }
  };

  walk(flow.raw, []);

  flow.steps.forEach((step, index) => {
    if (step.bodyFile === undefined) return;
    found.push({ source: step.bodyFile, stepId: step.id, node: ['steps', index, 'bodyFile'], where: 'bodyFile' });
  });

  if (flow.dataset) {
    found.push({ source: flow.dataset.source, node: ['dataset'], where: 'dataset' });
  }

  return found;
};

/** §9.4's three, spelled as `path.extname` reports them. `.yaml` is the same loader as `.yml`. */
const DATASET_FORMATS = ['.csv', '.json', '.yml', '.yaml'];

export const checkPaths = async (
  flow: NormalizedFlow,
  report: Report,
  scopeRoot: string,
  read: (file: string) => Promise<unknown>
) => {
  for (const { source, stepId, node, where } of sourcesIn(flow)) {
    if (interpolated(source)) continue;

    let resolved: string;
    try {
      resolved = resolveWithin(source, flow.file, scopeRoot);
    } catch {
      report.error(
        'path-outside-scope',
        `${where} resolves outside the scope root — a flow reads only what the collection or workspace `
        + 'that owns it holds (§7.4)',
        stepId,
        node
      );
      continue;
    }

    try {
      await read(resolved);
    } catch {
      report.error('missing-file', `${where} does not resolve to a file that exists`, stepId, node);
      continue;
    }

    // §9.4's three formats, checked here rather than left to the loader: `parseDataset` refuses an
    // extension it does not know by *throwing*, which rejects the run rather than failing a step —
    // so without this a flow validates clean and then dies with no step to attribute it to.
    if (where === 'dataset' && !DATASET_FORMATS.includes(path.extname(source).toLowerCase())) {
      report.error(
        'unknown-dataset-format',
        `dataset ${source} is not one of the formats §9.4 supports — ${DATASET_FORMATS.join(', ')}`,
        stepId,
        node
      );
    }
  }
};
