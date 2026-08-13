/**
 * What a step reads from the run — 001 §8.1, §8.3 and §8.4.
 *
 * One extractor, because two things depend on the same answer and must never disagree: `validate.ts`
 * decides whether a reference is legal (§8.4's visibility rule, §8.3's undeclared-dependency
 * warning) and `describe.ts` draws it as a data edge (002 §5.3). A graph asserting a data path that
 * the validator does not warn about — or the reverse — is worse than either alone, since the drawing
 * is what makes §8.3's distinction enforceable by something the author looks at.
 */
import type { NormalizedFlow, NormalizedStep } from './document';

const REFERENCE = /\{\{\s*(steps|shared)\.([^}\s.]+)(?:\.([^}\s]+))?\s*\}\}/g;

export type Reference = {
  root: 'steps' | 'shared';
  /** The step id or slot name. */
  name: string;
  /** What was read off it — `paymentId`, `body.data.id`, `status`. Absent for a whole-value read. */
  field?: string;
  /** `steps.create`, for a message. */
  text: string;
  /** Where in the step it was written, for the diagnostic that names it. */
  where: string;
};

/** §8.3's always-available metadata. `body` and `headers` are the raw, undeclared escape hatch. */
const BUILT_IN = new Set(['status', 'duration', 'ok', 'skipped']);

const RAW_ACCESS = new Set(['body', 'headers']);

/**
 * A reference is a *declared* data path when it reads a name the producing step declares as an
 * output (§8.1). Built-in metadata is neither declared nor raw — it is always there and says
 * nothing about data flow — and `body` / `headers` are §8.3's raw access, which is permitted and
 * warned about rather than refused.
 */
export const referenceKind = (
  reference: Reference,
  producer: NormalizedStep | undefined
): 'declared' | 'built-in' | 'raw' | 'unknown' => {
  const root = reference.field?.split('.')[0];
  if (root === undefined) return 'unknown';
  if (producer?.outputs.some((output) => output.name === root)) return 'declared';
  if (BUILT_IN.has(root)) return 'built-in';
  return RAW_ACCESS.has(root) ? 'raw' : 'unknown';
};

const scan = (value: unknown, where: string, found: Reference[]): Reference[] => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(REFERENCE)) {
      found.push({
        root: match[1] as Reference['root'],
        name: match[2],
        field: match[3],
        text: `${match[1]}.${match[2]}`,
        where
      });
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => scan(entry, where, found));
    return found;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => scan(entry, where, found));
  }
  return found;
};

export const referencesIn = (value: unknown, where = ''): Reference[] => scan(value, where, []);

/** Bare `steps.x.y` / `shared.x` operands, which the expression dialect resolves as references. */
const expressionReferences = (step: NormalizedStep, where: string): Reference[] =>
  [
    ...step.assert.map((assertion) => assertion.source),
    ...step.when.map((when) => (typeof when === 'string' ? when : ''))
  ]
    .flatMap((source) => source.split(/\s+/))
    .flatMap((token) => {
      const [root, name, ...rest] = token.split('.');
      if (root !== 'steps' && root !== 'shared') return [];
      return [{ root, name, field: rest.length ? rest.join('.') : undefined, text: `${root}.${name}`, where }];
    });

/**
 * Every reference one step makes, from every position that can carry one. Kept in one place so a
 * new interpolated field is picked up by the validator and the graph together rather than by
 * whichever was remembered.
 */
export const referencesOf = (step: NormalizedStep, flow: NormalizedFlow): Reference[] => {
  const inline = referencesIn(
    [step.body, step.query, step.headers, step.pathParams, step.args, step.bodyFile],
    step.id
  );

  const profileName = step.auth || (step.operation ? flow.apis[step.operation.alias]?.auth : undefined);
  const profile
    = profileName && profileName !== 'none' && flow.authProfiles[profileName]
      ? referencesIn(flow.authProfiles[profileName], `${step.id}'s auth profile ${profileName}`)
      : [];

  const binding = step.operation ? flow.apis[step.operation.alias] : undefined;
  const bindingRefs = binding
    ? referencesIn(
        [binding.baseUrl, binding.defaultHeaders, binding.defaultQuery],
        `${step.id}'s api binding ${binding.alias}`
      )
    : [];

  return [...inline, ...expressionReferences(step, step.id), ...profile, ...bindingRefs];
};
