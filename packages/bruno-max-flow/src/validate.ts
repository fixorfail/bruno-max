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
import { referenceKind, referencesIn, referencesOf, type Reference } from './references';
import type { ValidateOptions } from './types/options';
import type { Diagnostic } from './types/result';
import type { FlowContext } from './types/ports';

export const ancestorsOf = (flow: NormalizedFlow): Map<string, Set<string>> => {
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

  // Every check below reads the model, and a document that did not parse has none worth reading —
  // reporting "step undefined depends on undefined" over a stray indent buries the one line that
  // matters. 002 §6 anchors these in the document view, which is why they carry a position.
  if (flow.errors.length) {
    return flow.errors.map((error) => ({
      severity: 'error' as const,
      code: 'parse-error',
      message: error.message,
      file,
      line: error.line,
      column: error.column
    }));
  }

  /**
   * A diagnostic anchors to the step it names, or to an explicit node for the checks no step owns
   * (002 §6 puts these in the gutter of the document view, so one without a line has nowhere to
   * land). Steps carry their own position from the parse; anything else is addressed by path.
   */
  const at = (stepId?: string, node?: (string | number)[]) => {
    if (node) return flow.positions.at(node);
    return stepId === undefined ? undefined : flow.steps.find((step) => step.id === stepId)?.position;
  };

  const report = (
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    stepId?: string,
    node?: (string | number)[]
  ) => diagnostics.push({ severity, code, message, file, stepId, ...at(stepId, node) });

  const error = (code: string, message: string, stepId?: string, node?: (string | number)[]) =>
    report('error', code, message, stepId, node);
  const warn = (code: string, message: string, stepId?: string, node?: (string | number)[]) =>
    report('warning', code, message, stepId, node);

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
    // Two sources for one value, with no obvious precedence (§7.4).
    if (step.body !== undefined && step.bodyFile !== undefined) {
      error('body-and-body-file', `${step.id} declares both body: and bodyFile:`, step.id);
    }
    if (step.operation && step.uses) {
      error('operation-and-uses', `${step.id} declares both operation: and uses:`, step.id);
    }
  }

  const cycle = hasCycle(flow);
  if (cycle) error('cyclic-dependency', `${cycle} takes part in a dependency cycle`, cycle);

  const specs = new Map<string, Awaited<ReturnType<SpecLoader['load']>>>();
  for (const binding of Object.values(flow.apis)) {
    try {
      specs.set(binding.alias, await tools.specs.load(binding.source, file));
    } catch (cause) {
      error('unresolved-alias', `${binding.alias} does not resolve: ${(cause as Error).message}`, undefined, [
        'apis',
        binding.alias
      ]);
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
      `a vars: entry references ${reference.text}, which does not exist when vars: are evaluated`,
      undefined,
      ['vars']
    );
  }

  const checkReference = (step: NormalizedStep, reference: Reference) => {
    const where = reference.where;
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
        return;
      }

      // §8.3: raw `.body` / `.headers` access is permitted — refusing it would push people to
      // declare junk outputs — but it is not a declared data path, and the warning is what keeps
      // "make data paths explicit" enforceable by tooling rather than by convention.
      const producer = flow.steps.find((candidate) => candidate.id === reference.name);
      if (referenceKind(reference, producer) === 'raw') {
        warn(
          'undeclared-dependency',
          `${where} reads ${reference.text}.${reference.field} directly instead of a declared output`,
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
    // §6.4 and §6.3 are covered by the same sweep: an auth token and a host are data dependencies
    // exactly as a body field is, and a step resolving either from a value the run has not produced
    // does not fail cleanly — it sends a real request with a malformed credential or host.
    for (const reference of referencesOf(step, flow)) {
      checkReference(step, reference);
    }

    const profileName = step.auth || (step.operation ? flow.apis[step.operation.alias]?.auth : undefined);
    if (profileName && profileName !== 'none' && !flow.authProfiles[profileName]) {
      error('unknown-auth-profile', `${step.id} authenticates with ${profileName}, which is not declared`, step.id);
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
