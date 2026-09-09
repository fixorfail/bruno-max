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
  producer: NormalizedStep | undefined,
  /**
   * What a `uses:` producer publishes — its sub-flow's `exports:` (§12.2). They are the invoking
   * step's outputs with no re-declaration in the parent, so a reference to one is as declared as a
   * reference to an `outputs:` entry, and a caller that cannot see the child would have to call it
   * unknown.
   */
  exports: string[] = []
): 'declared' | 'built-in' | 'raw' | 'unknown' => {
  // `items[0].id` selects into the output `items` — bruno-query's own syntax (§8.1), and the name
  // being read is the part in front of the index.
  const root = reference.field?.split('.')[0].split('[')[0];
  if (root === undefined || root === '') return 'unknown';
  if (producer?.outputs.some((output) => output.name === root) || exports.includes(root)) return 'declared';
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

/**
 * What one flow reads out of its own run state, indexed by what is read.
 *
 * §14.3's "declared and never used" asks this of a flow's own outputs and slots, and asks it of
 * every position at once — so the index is built in one pass rather than per check: a new position
 * that can carry a reference is then picked up by all of them, or by none.
 */
export type FlowReads = {
  /** The output names read off each step, by step id. */
  outputs: Map<string, Set<string>>;
  /** Steps read whole — `{{steps.login}}` takes everything the step publishes. */
  wholeSteps: Set<string>;
  /** The slots read, whoever wrote them. */
  slots: Set<string>;
};

export const readsOf = (flow: NormalizedFlow): FlowReads => {
  const outputs = new Map<string, Set<string>>();
  const wholeSteps = new Set<string>();
  const slots = new Set<string>();

  const read = (stepId: string, field: string | undefined) => {
    const name = field?.split('.')[0].split('[')[0];
    if (!name) wholeSteps.add(stepId);
    else outputs.set(stepId, new Set([...(outputs.get(stepId) || []), name]));
  };

  for (const step of flow.steps) {
    for (const reference of referencesOf(step, flow)) {
      if (reference.root === 'shared') slots.add(reference.name);
      else read(reference.name, reference.field);
    }
    // Publishing an output into a slot is a use of it, whoever reads the slot afterwards.
    for (const { output } of step.shared) read(step.id, output);
  }
  // §12.1: an export is a read. A library whose slot leaves only through the boundary reads it
  // nowhere else, and without this line that correct flow is warned `unused-slot`.
  for (const exported of Object.values(flow.exports)) {
    const [root, target, ...rest] = exported.split('.');
    if (root === 'steps' && target) read(target, rest.join('.'));
    else if (root === 'shared' && target) slots.add(target);
  }

  return { outputs, wholeSteps, slots };
};

/** Whether anything in the flow read `<stepId>.<name>`. A whole-value read of the step takes every name. */
export const readsOutput = (reads: FlowReads, stepId: string, name: string): boolean =>
  reads.wholeSteps.has(stepId) || Boolean(reads.outputs.get(stepId)?.has(name));
