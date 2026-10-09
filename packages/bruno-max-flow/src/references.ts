/**
 * What a step reads from the run — 001 §8.1, §8.3 and §8.4.
 *
 * One extractor, because two things depend on the same answer and must never disagree: `validate.ts`
 * decides whether a reference is legal (§8.4's visibility rule, §8.3's undeclared-dependency
 * warning) and `describe.ts` draws it as a data edge (002 §5.3). A graph asserting a data path that
 * the validator does not warn about — or the reverse — is worse than either alone, since the drawing
 * is what makes §8.3's distinction enforceable by something the author looks at.
 */
import * as path from 'path';

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
 * The names that a `loop:` step publishes in addition to the metadata of §8.3 (006 §4).
 * They are built-ins for the same reason as that metadata. They are always present. They say
 * nothing about data flow. Only a step with `loop:` has them. For a step without `loop:`,
 * `steps.x.count` is still a name that the step does not produce.
 */
export const LOOP_BUILT_INS = ['matched', 'iterations', 'count', 'index'];

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
  if (BUILT_IN.has(root) || (producer?.loop && LOOP_BUILT_INS.includes(root))) return 'built-in';
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
  // 006 §2: the engine reads `over:` and `start:` when the loop starts. They read the steps that
  // they name, in the same way as a body. They make a dependency edge, and the validator checks
  // that the step is an ancestor.
  const inline = referencesIn(
    [step.body, step.query, step.headers, step.pathParams, step.args, step.bodyFile, step.loop?.over, step.loop?.start],
    step.id
  );

  const profileName = step.auth || (step.operation ? flow.apis[step.operation.alias]?.auth : undefined);
  /**
   * A profile a connector file supplied says where it was written (§8.5). A step that inherits its
   * binding's `auth:` names neither the profile nor the file, so a `{{shared.x}}` inside one reads
   * as a step depending on a slot nothing in the flow refers to — the file is the missing half.
   */
  const origin = profileName ? flow.authProfileOrigins[profileName] : undefined;
  const profile
    = profileName && profileName !== 'none' && flow.authProfiles[profileName]
      ? referencesIn(
          flow.authProfiles[profileName],
          `${step.id}'s auth profile ${profileName}${origin ? ` (from ${path.basename(origin)})` : ''}`
        )
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

/** Matches `{{loop}}` and `{{loop.x}}`. It does not match other text that contains the word. */
const INTERPOLATED_LOOP = /\{\{\s*loop\s*[.}]/;

/** Matches an operand or expression with `loop` as the first segment. This is the rule of §10.2. */
const BARE_LOOP = /(^|\s)loop(\.|\s|$)/;

/**
 * Tells if a step addresses the `loop.*` namespace in a position that can hold a reference (006 §3).
 *
 * The positions are the same as in `referencesOf`. Two expression positions are added. They read
 * a reserved root without braces. A script that reads `ctx.loop` is not found. The check reads
 * text only, and §8.2 has the same limit for `ctx.steps`.
 */
export const readsLoop = (step: NormalizedStep): boolean => {
  const interpolated = JSON.stringify([step.body, step.query, step.headers, step.pathParams, step.args, step.bodyFile]);
  const expressions = [...step.assert.map((assertion) => assertion.source), ...step.when.flatMap((when) => (typeof when === 'string' ? [when] : []))];

  return INTERPOLATED_LOOP.test(interpolated)
    || expressions.some((expression) => INTERPOLATED_LOOP.test(expression) || BARE_LOOP.test(expression));
};

const OUTPUT_READ = /\b(?:previous|outputs)\s*\??\.\s*([A-Za-z_$][\w$]*)|\b(?:previous|outputs)\s*\[\s*['"]([^'"]+)['"]\s*\]/g;

/**
 * The outputs of a `loop:` step that its own `next:` and `until:` read (006 §10).
 * `next` reads the outputs of the iteration before as `previous`, and `until` reads the outputs of
 * the iteration as `ctx.outputs`. A cursor loop declares an output for this reason, and for no other.
 * The scan reads text, as the scan of `ctx.steps` in §8.2 does. A script that reads the outputs in
 * another way, for example by destructuring, is not found.
 */
const loopScriptReads = (step: NormalizedStep): string[] =>
  [step.loop?.next, step.loop?.until].flatMap((source) =>
    source ? [...source.matchAll(OUTPUT_READ)].map((match) => match[1] || match[2]) : []);

/** `loop.iterations` in a script holds the outputs of every iteration that finished (006 §3). */
const LOOP_ITERATIONS_READ = /\bloop\s*\??\.\s*iterations\b/;

const loopScriptReadsIterations = (step: NormalizedStep): boolean =>
  [step.loop?.next, step.loop?.until].some((source) => source !== undefined && LOOP_ITERATIONS_READ.test(source));

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

  const looped = new Set(flow.steps.filter((step) => step.loop).map((step) => step.id));

  const read = (stepId: string, field: string | undefined) => {
    const name = field?.split('.')[0].split('[')[0];
    // `steps.x.iterations` is every output of every iteration of a loop (006 §4), so it reads them all.
    if (!name || (name === 'iterations' && looped.has(stepId))) wholeSteps.add(stepId);
    else outputs.set(stepId, new Set([...(outputs.get(stepId) || []), name]));
  };

  for (const step of flow.steps) {
    for (const reference of referencesOf(step, flow)) {
      if (reference.root === 'shared') slots.add(reference.name);
      else read(reference.name, reference.field);
    }
    // Publishing an output into a slot is a use of it, whoever reads the slot afterwards.
    for (const { output } of step.shared) read(step.id, output);
    for (const name of loopScriptReads(step)) read(step.id, name);
    // A script that reads `loop.iterations` can read any output of the step, as `steps.<id>.iterations` can.
    if (loopScriptReadsIterations(step)) wholeSteps.add(step.id);
  }
  /**
   * §12.1: an export is a read. A library whose slot leaves only through the boundary reads it
   * nowhere else, and without this that correct flow is warned `unused-slot`.
   *
   * The interpolated spelling counts too. `token: "{{shared.x}}"` is not a valid export — §12.1
   * takes a bare path, and `unknown-export` says so — but it is the mistake an author makes on the
   * way to the right one, and following it with `unused-slot` reports the same misunderstanding
   * twice while naming the wrong thing to fix. One mistake, one message.
   */
  for (const exported of Object.values(flow.exports)) {
    const [root, target, ...rest] = exported.split('.');
    if (root === 'steps' && target) read(target, rest.join('.'));
    else if (root === 'shared' && target) slots.add(target);
  }
  for (const reference of referencesIn(Object.values(flow.exports), 'exports')) {
    if (reference.root === 'shared') slots.add(reference.name);
    else read(reference.name, reference.field);
  }

  return { outputs, wholeSteps, slots };
};

/** Whether anything in the flow read `<stepId>.<name>`. A whole-value read of the step takes every name. */
export const readsOutput = (reads: FlowReads, stepId: string, name: string): boolean =>
  reads.wholeSteps.has(stepId) || Boolean(reads.outputs.get(stepId)?.has(name));
