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

import { Connectors } from './connectors';
import {
  asRecord,
  normalizeFlow,
  parseDocument,
  type NormalizedFlow,
  type NormalizedStep,
  type RateLimit
} from './document';
import { resolveSubflowTarget } from './files';
import { collectLibrary, declaredNames, effectiveLibrary, resolveLibrary, IDENTIFIER, SCRIPT_ARGUMENTS } from './functions';
import { ranksOf, resolveStages } from './graph';
import { SpecLoader, resolveOperation, resolveSpecSource } from './openapi';
import {
  readsOf,
  referenceKind,
  referencesIn,
  referencesOf,
  type Reference
} from './references';
import { checkDocumentSchema } from './schema';
import { checkSignedHeaders } from './validate/auth';
import { checkConnectors } from './validate/connectors';
import { checkOperation } from './validate/operation';
import { checkPaths } from './validate/paths';
import { checkFunctionCalls } from './validate/scripts';
import { createReport, suggest } from './validate/report';
import { checkShape } from './validate/shape';
import type { Scope, ValidateOptions } from './types/options';
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
  scope: Scope;
  scopeRoot: string;
  readFlow: (file: string) => Promise<NormalizedFlow>;
  readText: (file: string) => Promise<string>;
  /**
   * §6.2's `rateLimit:` per resolved document, accumulated across the whole reachable graph — one
   * map for the entry and every sub-flow, because a disagreement is only visible from above.
   *
   * The run merges disagreeing limits to the strictest (004 §6) and never fails over one; this is
   * only how the author is told two files say different things.
   */
  rateLimits: Map<string, { limit: RateLimit; file: string; alias: string }>;
};

/** Whether two declarations mean the same limit — `per` and `requests` only through the interval. */
const sameLimit = (a: RateLimit, b: RateLimit): boolean =>
  a.burst === b.burst && WINDOW_MS[a.per] / a.requests === WINDOW_MS[b.per] / b.requests;

const WINDOW_MS: Record<RateLimit['per'], number> = { second: 1000, minute: 60_000, hour: 3_600_000 };

const describeLimit = (limit: RateLimit): string =>
  `${limit.requests} per ${limit.per}${limit.burst > 1 ? `, burst ${limit.burst}` : ''}`;

/**
 * §6.2's `rateLimit:` as a *number*, which the schema cannot settle on its own: `requests: "{{rps}}"`
 * is a string the schema rejects, but `rateLimit: 5` — the shorthand an author reaches for first —
 * is a scalar the binding's `type: ['string','object']` lets through, and normalization turns both
 * into `NaN`. A limit that is `NaN` paces nothing, which looks exactly like a limit nobody wrote.
 */
const checkRateLimit = (
  limit: RateLimit,
  alias: string,
  node: (string | number)[],
  error: (code: string, message: string, stepId?: string, node?: (string | number)[]) => void
): void => {
  for (const [key, value] of [
    ['requests', limit.requests],
    ['burst', limit.burst]
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      error(
        'invalid-rate-limit',
        `${alias} declares rateLimit.${key} as ${Number.isNaN(value) ? 'a value that is not a number' : String(value)} — it is a whole number of at least 1`,
        undefined,
        [...node, key]
      );
    }
  }
};

/**
 * Where in the call graph a document is being checked, which two rules turn on: §12.4 refuses a
 * `dataset:` in a sub-flow, and §12.5's library lint asks what a run would supply — `--param` for a
 * flow run directly, the call site's `with:` for one invoked.
 */
type Visit = { seen: Set<string>; supplied: string[]; invoked: boolean };

const validateDocument = async (flow: NormalizedFlow, tools: Tools, visit: Visit): Promise<Diagnostic[]> => {
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

  const report = createReport(flow);
  const { diagnostics, error, warn } = report;

  /**
   * §5.4's document schema, which §14.3 runs **first**: it is the only pass that needs neither the
   * graph nor the bound documents, and it catches the class of mistake that happens while typing —
   * `assertt:`, a string where a number belongs — that every check below reads straight past.
   *
   * It does not stop the rest. A document that parsed still has a graph and a set of references
   * worth checking, and halting here would let one mistyped key hide every real error under it.
   */
  for (const issue of checkDocumentSchema(flow.raw)) {
    // A rule §14.3 names with a code of its own is reported by the check named for it, further
    // down. The schema states it anyway, because an editor runs the schema and nothing else — but a
    // reader of `bru flow validate` gets one diagnostic per mistake rather than two spellings of it.
    if (issue.named) continue;
    const stepId = issue.node[0] === 'steps' && typeof issue.node[1] === 'number'
      ? flow.steps[issue.node[1]]?.id
      : undefined;
    (issue.severity === 'error' ? error : warn)(issue.code, issue.message, stepId, issue.node);
  }

  /**
   * Sub-flows are read before anything else asks a question about a step, because a `uses:` step's
   * outputs are the sub-flow's `exports:` with no re-declaration in the parent (§12.2). A check that
   * did not have them would call every reference to one an unknown output.
   */
  const children = new Map<string, NormalizedFlow>();
  for (const step of flow.steps) {
    if (!step.uses) continue;

    // §12.2's `workspace:` prefix and its containment (§7.4) are the same rule one command
    // earlier than `files.ts` enforces it at run time — reported rather than thrown, for the same
    // reason a missing target below is: a mistake in one document should not stop the rest.
    let target: string;
    try {
      target = resolveSubflowTarget(step.uses, file, tools.scope);
    } catch {
      error('path-outside-scope', `${step.id} invokes ${step.uses}, which resolves outside the scope root (§7.4)`, step.id);
      continue;
    }

    if (visit.seen.has(target)) {
      error('cyclic-dependency', `${step.id} invokes ${step.uses}, which is already on the call path`, step.id);
      continue;
    }
    try {
      children.set(step.id, await tools.readFlow(target));
    } catch (cause) {
      // Reported rather than thrown: a `uses:` naming a file that is not there is an ordinary
      // mistake in a document, and refusing to produce diagnostics for the rest of it would leave
      // the author fixing one typo per run.
      error('unresolved-subflow', `${step.id} invokes ${step.uses}: ${(cause as Error).message}`, step.id);
    }
  }

  const published = (step: NormalizedStep): string[] => [
    ...step.outputs.map((output) => output.name),
    ...Object.keys(children.get(step.id)?.exports || {})
  ];

  // §14.3's unused-value lints, over one index of what the flow reads.
  const reads = readsOf(flow);

  checkShape(flow, report, { supplied: visit.supplied, invoked: visit.invoked, published, reads });

  const ids = new Set(flow.steps.map((step) => step.id));
  const ancestors = ancestorsOf(flow);
  const slotWriters = new Map<string, string[]>();
  for (const step of flow.steps) {
    for (const { slot } of step.shared) slotWriters.set(slot, [...(slotWriters.get(slot) || []), step.id]);
  }

  /**
   * `index` is here for the anchors below: `Positions.at` resolves a path from the *document root*,
   * and the report takes the path it is given without falling back to the step — so a path naming a
   * step's own field without saying which step resolves to nothing, and the diagnostic reaches the
   * author with no line at all.
   */
  for (const [index, step] of flow.steps.entries()) {
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

    /**
     * §8.7's promotions, checked here because both failures are silent at run time.
     *
     * A `from: pre` naming nothing the step computes extracts `undefined`, which §8.1 makes an
     * ordinary "not produced" — so the output is simply missing and the reference to it skips a
     * downstream step for a reason that names the reference rather than the typo.
     */
    const computed = new Set(step.pre.map((entry) => entry.name));
    for (const output of step.outputs) {
      if (output.from === 'pre' && !computed.has(output.path as string)) {
        error(
          'unknown-pre-value',
          `${step.id}: outputs.${output.name} takes from: pre ${output.path}, which the step does not compute`,
          step.id,
          ['steps', index, 'outputs', output.name]
        );
      }

      /**
       * §8.1's string form is a **path**, not an interpolation, and `{{pre.x}}` written there
       * selects nothing — leaving the output unset with no error anywhere. It is the mistake the
       * shape invites, so it is the one worth reporting.
       */
      if (output.path && /\{\{.*\}\}/.test(output.path)) {
        warn(
          'interpolation-in-output-path',
          `${step.id}: outputs.${output.name} is a path into the response, not an interpolation`
          + ` — ${output.path} selects nothing`,
          step.id,
          ['steps', index, 'outputs', output.name]
        );
      }

      /**
       * The same mistake from the other side: a script written as the string form is a *path* whose
       * text happens to be a function, so it selects nothing and the output is quietly unset. It is
       * what §8.1's shorthand invites — `pre:` values are scripts, and an author who has written one
       * there reasonably expects the same here — and a path can never contain `=>`, so saying so
       * costs no false report.
       */
      if (output.path && output.path.includes('=>')) {
        warn(
          'script-in-output-path',
          `${step.id}: outputs.${output.name} is a path into the response, not a script`
          + ' — write it as `script: ...` for it to run',
          step.id,
          ['steps', index, 'outputs', output.name]
        );
      }
    }

    /**
     * The third silent failure in this position, and the one the shape invites hardest.
     *
     * §8.7's scripts all share one context, built before the first of them runs, so `ctx.pre` is
     * empty in every one of them however they are ordered. Computing a nonce in one entry and
     * signing `ctx.pre.nonce` in the next therefore signs `undefined` — and nothing says so: the
     * script returns a value, the step succeeds, and a real request goes out carrying a signature
     * over nothing. An assertion downstream is the earliest anything notices, and only if the API
     * happens to reject it.
     *
     * This is `outputs:`' behaviour too, which is the point — §8.7 is that block one stage earlier
     * and inherits the property by being built the same way. So the rule is not what is reported
     * here; the silence is. Reading a sibling stays legal JavaScript and always resolves the same
     * way, which is exactly why it needs saying out loud.
     *
     * A source check rather than a semantic one: `ctx.pre.x` is the form people write, and
     * destructuring the parameter slips past. A warning that catches the common spelling is worth
     * more than none, and a false positive costs a reader one glance at a line they did mean.
     */
    for (const entry of step.pre) {
      if (/\bctx\s*\??\.\s*pre\b/.test(entry.script)) {
        warn(
          'pre-reads-sibling-value',
          `${step.id}: pre.${entry.name} reads ctx.pre, which is empty in every pre: script`
          + ' — compute both halves in one entry, or share a functions: helper',
          step.id,
          ['steps', index, 'pre', entry.name]
        );
      }
    }
  }

  const cycle = hasCycle(flow);
  if (cycle) error('cyclic-dependency', `${cycle} takes part in a dependency cycle`, cycle);

  /**
   * §5.5's boundaries, warned about for §6.2's reason: a boundary that cannot be drawn leaves a
   * graph with no rule where the author wrote one, which is exactly what declaring no stage at all
   * looks like. Silence would hide the mistake rather than its consequence.
   */
  for (const problem of resolveStages(flow, ranksOf(flow.steps)).problems) {
    warn(problem.code, problem.message, undefined, ['stages', problem.stage]);
  }

  /**
   * §5.3's `meta:` is an open mapping the engine never reads, so a scalar written where the mapping
   * belongs cannot fail anything — it simply arrives at the reporter as no metadata at all, which
   * is indistinguishable from a step that declared none. A warning is the only thing that tells the
   * author the case id they wrote is not in the report.
   */
  for (const stepId of flow.malformedMeta) {
    warn('invalid-step-meta', `${stepId} declares meta: as something other than a mapping`, stepId);
  }

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

  /**
   * §8.6 — a script calling a helper nothing puts in scope. Checked here rather than in `shape.ts`
   * because the answer is only knowable once the library's files have been read, which is the one
   * thing the shape checks are defined not to need.
   *
   * A raw file contributes the names it declares, which is the same reading `resolveLibrary` gives a
   * host — so what the check believes is in scope is what the listing prints and the editor offers.
   */
  checkFunctionCalls(
    flow,
    effectiveLibrary(library).flatMap((entry) => (entry.name ? [entry.name] : declaredNames(entry.source))),
    report
  );

  const specs = new Map<string, Awaited<ReturnType<SpecLoader['load']>>>();
  /**
   * What this document's own `apis:` block wrote for an alias, as opposed to what §8.5's connector
   * files filled in beneath it.
   *
   * The checks below anchor at `['apis', <alias>, <field>]` in *this* file, so running them over an
   * inherited value would report a connector file's mistake at a line the flow does not have — and
   * report it once per flow that binds the document, rather than once where it is written.
   * `validate/connectors.ts` checks those against the file that wrote them.
   */
  const authored = (alias: string): Record<string, unknown> => asRecord(asRecord(flow.raw.apis)[alias]);

  for (const binding of Object.values(flow.apis)) {
    const own = authored(binding.alias);
    /**
     * §6.2's colour is `#rgb` or `#rrggbb` and nothing else. A warning rather than an error, because
     * it decides how a graph is drawn and never what a flow does — but a warning rather than
     * silence, because a colour the renderer cannot parse falls back to the unpainted default, which
     * is exactly what a *missing* colour looks like. Nothing else would tell the author their typo
     * from a binding they never coloured.
     */
    if (own.color !== undefined && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(binding.color || '')) {
      warn(
        'invalid-api-color',
        `${binding.alias} declares color: ${binding.color}, which is not a #rgb or #rrggbb colour`,
        undefined,
        ['apis', binding.alias, 'color']
      );
    }

    if (binding.rateLimit) {
      // Shape is only this file's business where this file wrote it; a connector file's is checked
      // against the connector file. The conflict below is tracked either way — a disagreement is
      // between two declarations, and one of them being inherited does not make it agree.
      if (own.rateLimit !== undefined) {
        checkRateLimit(binding.rateLimit, binding.alias, ['apis', binding.alias, 'rateLimit'], error);
      }

      /**
       * 004 §6: two flows in one call graph can bind the same document and ask for different rates.
       * The run merges them to the strictest and carries on — nobody wants a validation error over
       * politeness — but silence would leave the looser file reading as though it were in force.
       *
       * Keyed on where the `source:` resolves to, not on the alias, because that is what the run
       * shares a bucket on: two aliases for one document are one limit, and the same alias in two
       * flows pointing at different documents is two.
       */
      const identity = resolveSpecSource(binding.source, file);
      const seen = tools.rateLimits.get(identity);
      if (!seen) {
        tools.rateLimits.set(identity, { limit: binding.rateLimit, file, alias: binding.alias });
      } else if (!sameLimit(seen.limit, binding.rateLimit) && !(seen.file === file && seen.alias === binding.alias)) {
        warn(
          'conflicting-rate-limit',
          `${binding.alias} declares rateLimit ${describeLimit(binding.rateLimit)} for ${identity}, which `
          + `${path.basename(seen.file)} binds as ${seen.alias} at ${describeLimit(seen.limit)} — the run takes the stricter`,
          undefined,
          own.rateLimit === undefined ? ['apis', binding.alias] : ['apis', binding.alias, 'rateLimit']
        );
      }
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
    const resolved = resolveOperation(spec, step.operation.operationId);
    if (!resolved) {
      error('unknown-operation', `${step.operation.operationId} is not an operation in ${spec.source}`, step.id);
      continue;
    }
    if (resolved === 'ambiguous') {
      error(
        'ambiguous-operation',
        `${step.operation.operationId} is declared by more than one operation in ${spec.source} —`
        + ' an operationId identifies one (§6.5)',
        step.id
      );
      continue;
    }
    checkOperation(step, resolved, report);
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

      const producer = flow.steps.find((candidate) => candidate.id === reference.name);
      const kind = referenceKind(reference, producer, producer ? published(producer) : []);

      // §8.3: raw `.body` / `.headers` access is permitted — refusing it would push people to
      // declare junk outputs — but it is not a declared data path, and the warning is what keeps
      // "make data paths explicit" enforceable by tooling rather than by convention.
      if (kind === 'raw') {
        warn(
          'undeclared-dependency',
          `${where} reads ${reference.text}.${reference.field} directly instead of a declared output`,
          step.id
        );
      }

      /**
       * §8.4's other half. A reference to a *name* the ancestor never produces resolves to nothing,
       * and §11.2 turns that into a skip — so the step furthest from the typo is the one reported,
       * with a reason naming the reference rather than the misspelling in it.
       */
      if (kind === 'unknown' && reference.field !== undefined && producer) {
        error(
          'unknown-output-reference',
          `${where} reads ${reference.text}.${reference.field}, which ${reference.name} does not produce`
          + suggest(reference.field.split('.')[0], published(producer)),
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
    const profile = profileName && profileName !== 'none' ? flow.authProfiles[profileName] : undefined;
    /**
     * §6.4's implicit `collection` profile is never declared in a flow's own `authProfiles:` — it is
     * the host's to supply at run time, through `RunOptions.authProfiles.collection`. A scope with a
     * `collectionRoot` always has a collection to inherit one from, so `auth: collection` there is
     * resolvable in principle; whether the host actually passed one is a run-time concern the run
     * itself reports (`unknown-auth-profile` again, from `materialize.ts`, if it did not). A
     * workspace-only scope has no collection at all, and `auth: collection` there stays unresolved.
     */
    const implicitCollection = profileName === 'collection' && !profile && Boolean(tools.scope.collectionRoot);
    if (profileName && profileName !== 'none' && !profile && !implicitCollection) {
      const reason = profileName === 'collection'
        ? 'and this scope has no collection to inherit an auth profile from'
        : 'which is not declared';
      error('unknown-auth-profile', `${step.id} authenticates with ${profileName}, ${reason}`, step.id);
    }
    if (profileName && profile) checkSignedHeaders(step, profileName, profile, report);

    // §10.3: the opt-out alone allows any status at all, including the 500 it did not mean.
    if (!step.flags.failOnStatusCode && !step.assert.some((assertion) => assertion.expr.startsWith('res.status'))) {
      warn(
        'status-opt-out-without-assertion',
        `${step.id} sets failOnStatusCode: false with no res.status assertion, so it accepts any status`,
        step.id
      );
    }
  }

  await checkPaths(flow, report, tools.scopeRoot, tools.readText);

  for (const step of flow.steps) {
    const child = children.get(step.id);
    if (!child) continue;
    for (const name of Object.keys(step.args)) {
      if (!child.params[name]) {
        error(
          'unknown-param',
          `${step.id} passes ${name}, which ${step.uses} does not declare`
          + suggest(name, Object.keys(child.params)),
          step.id
        );
      }
    }
    for (const [name, declared] of Object.entries(child.params)) {
      if (declared.required && declared.default === undefined && step.args[name] === undefined) {
        error('missing-param', `${step.id} does not supply the required param ${name}`, step.id);
      }
    }
    diagnostics.push(
      ...(await validateDocument(child, tools, {
        seen: new Set([...visit.seen, child.file]),
        supplied: Object.keys(step.args),
        invoked: true
      }))
    );
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

  const specs = new SpecLoader(options.ports.readSpec, context);
  const readText = async (file: string) => (await options.ports.readFile(file, context)).toString('utf8');
  // §8.5's files, applied to every document read here — the entry and each sub-flow by its own
  // location — so a reference to a connector-supplied output is as declared as one to `outputs:`.
  const connectors = await Connectors.load(options.scope, readText, specs);

  const tools: Tools = {
    specs,
    scope: options.scope,
    scopeRoot: options.scope.collectionRoot || options.scope.workspaceRoot,
    readFlow: async (file) => connectors.apply(normalizeFlow(parseDocument(await readText(file)), file)),
    readText,
    rateLimits: new Map()
  };

  const diagnostics = await validateDocument(await tools.readFlow(options.entry), tools, {
    seen: new Set([options.entry]),
    // §12.5: a flow run directly takes its params from `--param`, exactly as an invoking `uses:`
    // step supplies them, so the required-param lint sees what this run would actually have.
    supplied: Object.keys(options.params || {}),
    invoked: false
  });

  return [...diagnostics, ...checkConnectors(connectors)];
};
