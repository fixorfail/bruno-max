/**
 * Static checks — 001 §14.3.
 *
 * `validateFlow` sends nothing and takes two ports, so the app can lint a flow without standing up
 * the machinery to run one. What it catches is everything the graph and the bound documents make
 * knowable before a request: an operation that does not exist, a reference to a step that is not a
 * proven ancestor, a slot read off the branch that writes it.
 *
 * The visibility rules are the reason this is not a nicety. Under parallel execution there is no
 * ordering guarantee between sibling branches, so a reference across them is a bug every time and
 * has to be caught statically rather than discovered as a flaky run (§8.4).
 */
import * as path from 'path';

import { normalizeFlow, parseDocument, type NormalizedFlow, type NormalizedStep } from './document';
import { SpecLoader } from './openapi';
import type { ValidateOptions } from './types/options';
import type { Diagnostic } from './types/result';
import type { FlowContext } from './types/ports';

const REFERENCE = /\{\{\s*(steps|shared)\.([^}\s.]+)(?:\.([^}\s]+))?\s*\}\}/g;

type Reference = { root: 'steps' | 'shared'; name: string; text: string };

const referencesIn = (value: unknown, found: Reference[] = []): Reference[] => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(REFERENCE)) {
      found.push({ root: match[1] as Reference['root'], name: match[2], text: `${match[1]}.${match[2]}` });
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => referencesIn(entry, found));
    return found;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => referencesIn(entry, found));
  }
  return found;
};

/** Bare `steps.x` / `shared.x` operands, which the expression dialect resolves as references. */
const expressionReferences = (step: NormalizedStep): Reference[] =>
  [...step.assert.map((assertion) => assertion.source), ...step.when.map((when) => (typeof when === 'string' ? when : ''))]
    .flatMap((source) => source.split(/\s+/))
    .flatMap((token) => {
      const [root, name] = token.split('.');
      return root === 'steps' || root === 'shared' ? [{ root, name, text: `${root}.${name}` } as Reference] : [];
    });

const ancestorsOf = (flow: NormalizedFlow): Map<string, Set<string>> => {
  const direct = new Map(flow.steps.map((step) => [step.id, step.depends.entries.map((entry) => entry.on)]));
  const closure = new Map<string, Set<string>>();

  const walk = (id: string, seen: Set<string>): Set<string> => {
    const cached = closure.get(id);
    if (cached) return cached;

    const ancestors = new Set<string>();
    for (const parent of direct.get(id) || []) {
      if (seen.has(parent)) continue;
      ancestors.add(parent);
      for (const older of walk(parent, new Set([...seen, parent]))) ancestors.add(older);
    }
    closure.set(id, ancestors);
    return ancestors;
  };

  for (const step of flow.steps) walk(step.id, new Set([step.id]));
  return closure;
};

const hasCycle = (flow: NormalizedFlow): string | undefined => {
  const state = new Map<string, 'open' | 'closed'>();

  const visit = (id: string): string | undefined => {
    if (state.get(id) === 'open') return id;
    if (state.get(id) === 'closed') return undefined;
    state.set(id, 'open');
    const step = flow.steps.find((entry) => entry.id === id);
    for (const parent of step?.depends.entries || []) {
      const found = visit(parent.on);
      if (found) return found;
    }
    state.set(id, 'closed');
    return undefined;
  };

  for (const step of flow.steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return undefined;
};

type Tools = { specs: SpecLoader; readFlow: (file: string) => Promise<NormalizedFlow> };

const validateDocument = async (flow: NormalizedFlow, tools: Tools, seen: Set<string>): Promise<Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const file = flow.file;
  const error = (code: string, message: string, stepId?: string) =>
    diagnostics.push({ severity: 'error', code, message, file, stepId });
  const warn = (code: string, message: string, stepId?: string) =>
    diagnostics.push({ severity: 'warning', code, message, file, stepId });

  const ids = new Set(flow.steps.map((step) => step.id));
  const ancestors = ancestorsOf(flow);
  const slotWriters = new Map<string, string[]>();
  for (const step of flow.steps) {
    for (const { slot } of step.shared) slotWriters.set(slot, [...(slotWriters.get(slot) || []), step.id]);
  }

  for (const step of flow.steps) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.id)) {
      error('invalid-step-id', `${step.id} is not a valid step id — try ${step.id.replace(/[-.]/g, '_')}`, step.id);
    }
    for (const entry of step.depends.entries) {
      if (!ids.has(entry.on)) error('unknown-dependency', `${step.id} depends on ${entry.on}, which is not a step`, step.id);
    }
  }

  const cycle = hasCycle(flow);
  if (cycle) error('cyclic-dependency', `${cycle} takes part in a dependency cycle`, cycle);

  const specs = new Map<string, Awaited<ReturnType<SpecLoader['load']>>>();
  for (const binding of Object.values(flow.apis)) {
    try {
      specs.set(binding.alias, await tools.specs.load(binding.source, file));
    } catch (cause) {
      error('unresolved-alias', `${binding.alias} does not resolve: ${(cause as Error).message}`);
    }
  }

  for (const step of flow.steps) {
    if (!step.operation) continue;
    const spec = specs.get(step.operation.alias);
    if (!spec) {
      error('unresolved-alias', `${step.id} names the api alias ${step.operation.alias}, which is not bound`, step.id);
      continue;
    }
    if (!spec.operations.has(step.operation.operationId)) {
      error('unknown-operation', `${step.operation.operationId} is not an operation in ${spec.source}`, step.id);
    }
  }

  // §7.3: nothing has run when `vars:` are evaluated.
  for (const reference of referencesIn(flow.vars)) {
    error(
      'invalid-var-reference',
      `a vars: entry references ${reference.text}, which does not exist when vars: are evaluated`
    );
  }

  const checkReference = (step: NormalizedStep, reference: Reference, where: string) => {
    if (reference.root === 'steps') {
      if (!ids.has(reference.name)) {
        error('unknown-step-reference', `${where} references ${reference.text}, which is not a step`, step.id);
        return;
      }
      if (reference.name !== step.id && !ancestors.get(step.id)?.has(reference.name)) {
        error(
          'non-ancestor-reference',
          `${where} references ${reference.text}, which is not a transitive ancestor of ${step.id}`,
          step.id
        );
      }
      return;
    }

    if (!flow.shared.includes(reference.name)) {
      error('undeclared-slot', `${where} reads ${reference.text}, which no shared: block declares`, step.id);
      return;
    }
    const writers = slotWriters.get(reference.name) || [];
    const off = writers.filter((writer) => writer !== step.id && !ancestors.get(step.id)?.has(writer));
    if (off.length) {
      error(
        'slot-not-downstream',
        `${where} reads ${reference.text}, but ${off.join(', ')} writes it off this step's branch`,
        step.id
      );
    }
  };

  for (const step of flow.steps) {
    const inline = referencesIn([step.body, step.query, step.headers, step.pathParams, step.args, step.bodyFile]);
    for (const reference of [...inline, ...expressionReferences(step)]) {
      checkReference(step, reference, `${step.id}`);
    }

    // §6.4 and §6.3: an auth token and a host are data dependencies exactly as a body field is,
    // and a step that resolves either from a value the run has not produced does not fail
    // cleanly — it sends a real request with a malformed credential or to a malformed host.
    const profileName = step.auth || (step.operation ? flow.apis[step.operation.alias]?.auth : undefined);
    if (profileName && profileName !== 'none') {
      const profile = flow.authProfiles[profileName];
      if (!profile) {
        error('unknown-auth-profile', `${step.id} authenticates with ${profileName}, which is not declared`, step.id);
      } else {
        for (const reference of referencesIn(profile)) {
          checkReference(step, reference, `${step.id}'s auth profile ${profileName}`);
        }
      }
    }

    const binding = step.operation ? flow.apis[step.operation.alias] : undefined;
    if (binding) {
      for (const reference of referencesIn([binding.baseUrl, binding.defaultHeaders, binding.defaultQuery])) {
        checkReference(step, reference, `${step.id}'s api binding ${binding.alias}`);
      }
    }

    // §10.3: the opt-out alone allows any status at all, including the 500 it did not mean.
    if (!step.flags.failOnStatusCode && !step.assert.some((assertion) => assertion.expr.startsWith('res.status'))) {
      warn(
        'status-opt-out-without-assertion',
        `${step.id} sets failOnStatusCode: false with no res.status assertion, so it accepts any status`,
        step.id
      );
    }
  }

  for (const step of flow.steps) {
    if (!step.uses) continue;
    const target = path.resolve(path.dirname(file), step.uses);
    if (seen.has(target)) {
      error('cyclic-dependency', `${step.id} invokes ${step.uses}, which is already on the call path`, step.id);
      continue;
    }
    const child = await tools.readFlow(target);
    for (const name of Object.keys(step.args)) {
      if (!child.params[name]) {
        error('unknown-param', `${step.id} passes ${name}, which ${step.uses} does not declare`, step.id);
      }
    }
    for (const [name, declared] of Object.entries(child.params)) {
      if (declared.required && declared.default === undefined && step.args[name] === undefined) {
        error('missing-param', `${step.id} does not supply the required param ${name}`, step.id);
      }
    }
    diagnostics.push(...(await validateDocument(child, tools, new Set([...seen, target]))));
  }

  return diagnostics;
};

export const validateFlow = async (options: ValidateOptions): Promise<Diagnostic[]> => {
  const context: FlowContext = {
    runId: 'validate',
    flow: options.entry,
    scope: options.scope,
    signal: new AbortController().signal
  };

  const tools: Tools = {
    specs: new SpecLoader(options.ports.readSpec, context),
    readFlow: async (file) =>
      normalizeFlow(parseDocument((await options.ports.readFile(file, context)).toString('utf8')), file)
  };

  return validateDocument(await tools.readFlow(options.entry), tools, new Set([options.entry]));
};
