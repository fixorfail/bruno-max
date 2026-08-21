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
import { collectLibrary, resolveLibrary, IDENTIFIER, SCRIPT_ARGUMENTS } from './functions';
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

type Tools = {
  specs: SpecLoader;
  readFlow: (file: string) => Promise<NormalizedFlow>;
  readText: (file: string) => Promise<string>;
};

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

  /**
   * §8.6's library. A file that cannot be read is an error rather than a run-time surprise: every
   * script in the flow is composed with it, so one missing helper file fails every script position
   * at once, and `script-error` would name whichever step happened to run first.
   */
  const library = await (async () => {
    try {
      return await collectLibrary(flow.functions, file, async (source, from) =>
        tools.readText(path.resolve(path.dirname(from), source)));
    } catch (cause) {
      error('unresolved-function-library', `functions: ${(cause as Error).message}`, undefined, ['functions', 'use']);
      return [];
    }
  })();

  for (const entry of library) {
    if (!entry.name) continue;
    if (!IDENTIFIER.test(entry.name)) {
      // It becomes a declaration, so a name that is not an identifier is a program that does not
      // parse — and a syntax error in the prelude fails every script in the flow, naming none.
      error('invalid-function-name', `functions.${entry.name} is not a JavaScript identifier`, undefined, [
        'functions',
        entry.name
      ]);
    } else if (SCRIPT_ARGUMENTS.includes(entry.name)) {
      warn(
        'function-shadows-script-argument',
        `functions.${entry.name} shadows the ${entry.name} every script is handed (§8.2)`,
        undefined,
        ['functions', entry.name]
      );
    }
  }

  const specs = new Map<string, Awaited<ReturnType<SpecLoader['load']>>>();
  for (const binding of Object.values(flow.apis)) {
    /**
     * §6.2's colour is `#rgb` or `#rrggbb` and nothing else. A warning rather than an error, because
     * it decides how a graph is drawn and never what a flow does — but a warning rather than
     * silence, because a colour the renderer cannot parse falls back to the unpainted default, which
     * is exactly what a *missing* colour looks like. Nothing else would tell the author their typo
     * from a binding they never coloured.
     */
    if (binding.color !== undefined && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(binding.color)) {
      warn(
        'invalid-api-color',
        `${binding.alias} declares color: ${binding.color}, which is not a #rgb or #rrggbb colour`,
        undefined,
        ['apis', binding.alias, 'color']
      );
    }

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

    const slot = flow.shared[reference.name];
    if (!slot) {
      error('undeclared-slot', `${where} reads ${reference.text}, which no shared: block declares`, step.id);
      return;
    }

    const writers = slotWriters.get(reference.name) || [];
    const upstream = (writer: string) => writer === step.id || Boolean(ancestors.get(step.id)?.has(writer));

    /**
     * §9.1's two shapes. Under `all` — the default — every writer must be upstream, so the read
     * cannot race a branch still in flight. Under `any` the writers are alternatives, and one of them
     * being upstream is the whole of what can be asked: no step descends from every writer when only
     * one of them ever runs.
     *
     * A slot nobody writes stays legal either way. §9.1 resolves it empty rather than skipping the
     * reader, and a flow whose fallback branch is the only writer is exactly that case seen early.
     */
    if (slot.writers === 'any') {
      if (writers.length && !writers.some(upstream)) {
        error(
          'slot-not-downstream',
          `${where} reads ${reference.text}, and none of its writers (${writers.join(', ')}) is upstream of this step`,
          step.id
        );
      }
      return;
    }

    const off = writers.filter((writer) => !upstream(writer));
    if (off.length) {
      error(
        'slot-not-downstream',
        `${where} reads ${reference.text}, but ${off.join(', ')} writes it off this step's branch`
        + ` — declare the slot \`writers: any\` if its writers are alternatives (§9.1)`,
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

/**
 * §8.6's library, resolved for display — what `bru flow validate` prints beneath a flow so the
 * functions its scripts may call stay discoverable without opening every file it names.
 *
 * Beside `validateFlow` rather than folded into it: diagnostics are what a host acts on, and a
 * listing is not one. A caller that wants neither pays for neither.
 */
export const resolveFunctions = async (options: ValidateOptions): Promise<{ name?: string; from: string }[]> => {
  const context: FlowContext = {
    runId: 'validate',
    flow: options.entry,
    scope: options.scope,
    signal: new AbortController().signal
  };

  const flow = normalizeFlow(
    parseDocument((await options.ports.readFile(options.entry, context)).toString('utf8')),
    options.entry
  );

  return resolveLibrary(flow, async (source, from) =>
    (await options.ports.readFile(path.resolve(path.dirname(from), source), context)).toString('utf8'));
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
      normalizeFlow(parseDocument((await options.ports.readFile(file, context)).toString('utf8')), file),
    readText: async (file) => (await options.ports.readFile(file, context)).toString('utf8')
  };

  return validateDocument(await tools.readFlow(options.entry), tools, new Set([options.entry]));
};
