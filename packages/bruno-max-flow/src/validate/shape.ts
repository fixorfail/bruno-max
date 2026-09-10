/**
 * The checks that read what the document *says* — 001 §14.3.
 *
 * Everything here is decidable from one file, with no OpenAPI document and no graph beyond the one
 * the steps declare. What they have in common is the failure they catch: normalization applies every
 * default §5.2 and §5.3 name, so a `depends: { all: [] }` becomes an unconditional root and a
 * `retry:` on a `uses:` step becomes the policy every step has. The flow then runs — as something
 * nobody wrote. `NormalizedFlow.raw` is the document before that happened, and these are its readers.
 */
import { DROP, FileRef, OPERATORS, asRecord, type NormalizedFlow, type NormalizedStep } from '../document';
import { readsOutput, referenceKind, type FlowReads, type Reference } from '../references';
import { suggest, type Report } from './report';

/** §9.1's four outcomes, which is the whole of what a `status:` may name. */
const STATUSES = ['success', 'failed', 'skipped', 'cancelled'];

/** §12.4's table, error column: the fields that address a response, which a sub-flow does not have. */
const SUBFLOW_ERRORS = [
  'retry', 'timeout', 'failOnStatusCode', 'validateRequest', 'validateSchema', 'strictSchema',
  'failOnUnresolved', 'body', 'bodyFile', 'query', 'headers', 'pathParams', 'contentType', 'auth'
];

/** §7.2's positions a value can be dropped from — the three merge layers and the path params. */
const MERGEABLE = ['body', 'query', 'headers', 'pathParams'];

/** §7.3's namespaces. A variable of any of these names is shadowed by the namespace, in every scope. */
const RESERVED = ['steps', 'row', 'params', 'shared', 'flow', 'pre', 'process'];

/**
 * §8.2's two named objects, and what each one holds.
 *
 * They are not namespaces in §7.3's table — `{{env}}` and `{{vars}}` resolve to the variable, since
 * interpolation has no tier prefix. A *script* is the other half: the context carries every variable
 * flat and puts these two above the spread, so `ctx.env` is the environment tiers and `ctx.vars` is
 * the flow's own `vars:` whatever the flow named. A variable of either name is therefore reachable
 * from a request and invisible to every script that would read it, which is the half worth saying
 * out loud: the script compiles, runs, and reads the wrong object.
 */
const SCRIPT_NAMESPACES: Record<string, string> = {
  env: 'the environment tiers a host supplies',
  vars: 'the vars: block of the flow itself'
};

const rawSteps = (flow: NormalizedFlow): Record<string, unknown>[] =>
  (Array.isArray(flow.raw.steps) ? flow.raw.steps : []).map(asRecord);

/**
 * What a step publishes under its own id: its declared outputs, and — for a `uses:` step — the
 * sub-flow's `exports:`, which are the step's outputs with no re-declaration in the parent (§12.2).
 */
type Published = (step: NormalizedStep) => string[];

type Options = {
  /**
   * The param names a run would supply — `--param` for the entry, the call site's `with:` for a
   * sub-flow (§12.5). A required param the caller fills is not the mistake the library lint is about.
   */
  supplied: string[];
  /** Reached through a `uses:`, which is what makes a `dataset:` here an error rather than iteration. */
  invoked: boolean;
  published: Published;
  /** What the flow reads, shared with the call-site check that asks the same of a sub-flow's exports. */
  reads: FlowReads;
};

/** §5.3: unique within the flow. Two steps sharing an id collide in state, in captures and in reports. */
const checkStepIds = (flow: NormalizedFlow, report: Report) => {
  const seen = new Set<string>();
  for (const step of flow.steps) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.id)) {
      report.error('invalid-step-id', `${step.id} is not a valid step id — try ${step.id.replace(/[-.]/g, '_')}`, step.id);
    }
    if (seen.has(step.id)) {
      report.error(
        'duplicate-step-id',
        `${step.id} is declared twice — a second step of that id overwrites the first's outputs and captures`,
        step.id
      );
    }
    seen.add(step.id);
  }
};

/**
 * §9.1's three shapes, from the document rather than from the normalized edges.
 *
 * `{ all: [] }` normalizes to no edges at all, which is what `depends: []` means — an unconditional
 * root. So a join whose list was emptied by a bad edit runs *first* instead of failing, which is the
 * one outcome an author writing a join is guaranteed not to want.
 */
const checkDepends = (flow: NormalizedFlow, report: Report) => {
  rawSteps(flow).forEach((raw, index) => {
    const stepId = flow.steps[index]?.id;
    const declared = raw.depends;
    const node = ['steps', index, 'depends'];

    const entries = (() => {
      if (declared === undefined) return [];
      if (Array.isArray(declared)) return declared;

      const mapping = asRecord(declared);
      const modes = ['all', 'any'].filter((mode) => mapping[mode] !== undefined);
      if (modes.length !== 1) {
        report.error(
          'invalid-depends',
          `${stepId}: depends: as a mapping carries exactly one of all: or any: — this one carries `
          + `${modes.length ? modes.join(' and ') : `neither (${Object.keys(mapping).join(', ') || 'nothing'})`}`,
          stepId,
          node
        );
        return [];
      }
      const list = mapping[modes[0]];
      if (!Array.isArray(list) || list.length === 0) {
        report.error(
          'invalid-depends',
          `${stepId}: depends.${modes[0]} is empty, which is not a join — it makes ${stepId} a root that runs first`,
          stepId,
          node
        );
        return [];
      }
      return list;
    })();

    for (const entry of entries) {
      if (typeof entry === 'string') continue;
      const mapping = asRecord(entry);
      const statuses = Array.isArray(mapping.status) ? mapping.status : [mapping.status].filter((one) => one !== undefined);
      for (const status of statuses) {
        if (STATUSES.includes(String(status))) continue;
        report.error(
          'invalid-dependency-status',
          `${stepId}: ${status} is not a step outcome — depends.status takes ${STATUSES.join(', ')}`
          + suggest(String(status), STATUSES),
          stepId,
          node
        );
      }
    }
  });
};

/**
 * §12.4's table. A field that addresses a response is not merely useless on a `uses:` step — a
 * sub-flow has many responses or none — and it parses and is ignored, which is the silence the
 * table exists to end. `retry:` is the one with teeth: replaying a sequence replays every side
 * effect it already committed.
 */
const checkSubflowSteps = (flow: NormalizedFlow, report: Report, invoked: boolean) => {
  rawSteps(flow).forEach((raw, index) => {
    const step = flow.steps[index];
    if (!step || step.kind !== 'subflow') return;
    for (const field of SUBFLOW_ERRORS) {
      if (raw[field] === undefined) continue;
      report.error(
        'invalid-subflow-field',
        `${step.id}: ${field}: is not a field a uses: step may carry — it addresses one response, and a `
        + 'sub-flow has many or none (§12.4)',
        step.id,
        ['steps', index, field]
      );
    }
  });

  if (invoked && flow.dataset) {
    report.error(
      'subflow-dataset',
      'dataset: iterates a top-level flow only — nesting it multiplies the run out combinatorially (§12.4)',
      undefined,
      ['dataset']
    );
  }
};

/**
 * §7.2: `!...` removes a key a seed introduced, so it means nothing outside a merge layer — and
 * §8.5's `outputs:`, where it removes an entry a connector file supplied.
 */
const checkDropPlacement = (flow: NormalizedFlow, report: Report) => {
  const walk = (value: unknown, path: (string | number)[]) => {
    if (value === DROP) {
      const inStep = path[0] === 'steps' && typeof path[1] === 'number';
      const inMergeLayer = inStep && MERGEABLE.includes(String(path[2]));
      const inOutputs = inStep && path[2] === 'outputs' && path.length === 4;
      if (!inMergeLayer && !inOutputs) {
        report.error(
          'misplaced-drop',
          `!... removes a key the spec seeded or an output a connector supplied, so it belongs in a step's `
          + `${MERGEABLE.join(', ')} or outputs — at ${path.join('.') || 'the top level'} it drops nothing and reads as null`,
          typeof path[1] === 'number' ? flow.steps[path[1] as number]?.id : undefined,
          path
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...path, index]));
      return;
    }
    if (value && typeof value === 'object' && !(value instanceof FileRef)) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walk(entry, [...path, key]);
    }
  };

  walk(flow.raw, []);
};

/**
 * §8.5: `null` keeps its ordinary meaning everywhere in the format, and `!...` is the removal
 * token. An output written `state: null` — or `state:` with nothing after it — drops nothing and
 * declares an output no path can ever produce, so it is refused rather than read as either.
 */
const checkNullOutputs = (flow: NormalizedFlow, report: Report) => {
  rawSteps(flow).forEach((raw, index) => {
    const stepId = flow.steps[index]?.id;
    for (const [name, value] of Object.entries(asRecord(raw.outputs))) {
      if (value !== null) continue;
      report.error(
        'null-output',
        `${stepId}: outputs.${name} is null, which is not the removal token — an inherited connector entry is `
        + 'dropped with !... (§8.5)',
        stepId,
        ['steps', index, 'outputs', name]
      );
    }
  });
};

/** §7.3: a variable named for a namespace is shadowed by it, and nothing at run time says so. */
const checkReservedNames = (flow: NormalizedFlow, report: Report) => {
  for (const [block, names] of [
    ['vars', Object.keys(flow.vars)],
    ['params', Object.keys(flow.params)]
  ] as const) {
    for (const name of names) {
      if (RESERVED.includes(name)) {
        report.warn(
          'shadowed-reserved-name',
          `${block}.${name} is shadowed by the ${name}.* namespace, so {{${name}}} never reads it (§7.3)`,
          undefined,
          [block, name]
        );
      } else if (SCRIPT_NAMESPACES[name]) {
        report.warn(
          'shadowed-reserved-name',
          `${block}.${name} is shadowed inside every script by ctx.${name}, which is ${SCRIPT_NAMESPACES[name]} `
          + `— only {{${name}}} reads this one (§8.2)`,
          undefined,
          [block, name]
        );
      }
    }
  }
};

/**
 * §8.2: `bru` is not in a flow script's scope, in either sandbox or either host.
 *
 * A script reaching for it compiles and then throws `ReferenceError` mid-run, which names the symbol
 * and not the reason — and the author most likely to write it is one porting a `.bru` script, where
 * `bru.setVar` is how data moves. In a flow it moves through `outputs:` and `shared:` instead, and
 * the difference is the point rather than an omission: those are *declared*, so §9.1 can order the
 * writers against the readers and 002 §5 can draw the edge. A `bru.setVar` write is a side channel
 * the graph cannot show and the validator cannot order.
 *
 * A warning rather than an error, because the match is textual: `bru` inside a string or a comment
 * is not a call, and refusing to run a flow over a substring would be worse than the throw it
 * replaces.
 */
const BRU_REFERENCE = /\bbru\s*\./;

const checkBruUsage = (flow: NormalizedFlow, report: Report) => {
  const scripts: { source: string; stepId?: string; node: (string | number)[] }[] = [];

  for (const [name, source] of Object.entries(flow.functions.define)) {
    scripts.push({ source, node: ['functions', 'define', name] });
  }

  flow.steps.forEach((step, index) => {
    step.pre.forEach((entry, at) => {
      scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'pre', at] });
    });
    step.when.forEach((entry, at) => {
      if (typeof entry !== 'string') {
        scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'when', at] });
      }
    });
    step.outputs.forEach((entry, at) => {
      if (entry.script) {
        scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'outputs', at] });
      }
    });
    if (step.retry.shouldRetry) {
      scripts.push({
        source: step.retry.shouldRetry,
        stepId: step.id,
        node: ['steps', index, 'retry', 'shouldRetry']
      });
    }
  });

  for (const { source, stepId, node } of scripts) {
    if (!BRU_REFERENCE.test(source)) continue;
    report.warn(
      'bru-unavailable',
      'bru is not in scope in a flow script and this will throw at run time — a value a later step '
      + 'needs is declared with outputs: or a shared: slot, which is what lets the graph order it (§8.2)',
      stepId,
      node
    );
  }
};

/**
 * §12.5's lint. A required param with no default and no `library: true` is a flow a glob run fires
 * and reports as a missing-param failure that says nothing about the cause. A warning, because
 * taking the param from `--param` on every invocation is legitimate.
 */
const checkLibraryFlag = (flow: NormalizedFlow, report: Report, supplied: string[]) => {
  if (flow.meta.library) return;
  for (const [name, declared] of Object.entries(flow.params)) {
    if (!declared.required || declared.default !== undefined || supplied.includes(name)) continue;
    report.warn(
      'required-param-without-library',
      `${name} is required with no default, and this flow is not marked meta.library: true — a directory `
      + 'run will fire it and report a missing param (§12.5)',
      undefined,
      ['params', name]
    );
  }
};

/**
 * §10.2's triple, checked for the half a parse cannot refuse: an operator nobody implements.
 *
 * `parseAssertion` reads the first token that *is* an operator, so a misspelled one is not found and
 * the whole line becomes an expression asserted for truthiness — `res.status equals 200` passes
 * every time, asserting that a non-empty string is non-empty.
 */
const checkExpressions = (flow: NormalizedFlow, report: Report) => {
  for (const step of flow.steps) {
    for (const assertion of step.assert) {
      const source = assertion.source.trim();
      // An operator that was found split the line, leaving `expr` shorter than the source it came
      // from. A single-token line has no operator to find and is a legal truthiness assertion.
      const split = assertion.expr !== source;
      if (OPERATORS.has(assertion.op) && (split || !/\s/.test(source))) continue;

      const written = split ? assertion.op : source.split(/\s+/)[1];
      report.error(
        'unknown-operator',
        `${step.id}: ${written} is not an assertion operator — ${source} is read as an expression asserted `
        + `for truthiness${suggest(String(written), [...OPERATORS])}`,
        step.id
      );
    }

    for (const when of step.when) {
      if (typeof when !== 'string') continue;
      const source = when.trim();
      const found = source.match(/\b(res|req)\.[a-zA-Z_$]/);
      if (found) {
        report.error(
          'condition-reads-response',
          `${step.id}: when: reads ${found[1]}.*, which does not exist before the request is built — `
          + 'a condition is evaluated first, and only an assertion sees the exchange (§9.3)',
          step.id
        );
      }
    }
  }
};

/**
 * §12.1: an export names an internal step's output or a whole slot, which is what the invoking step
 * then reads.
 *
 * **A slot is exportable because an export resolves after the schedule has ended.** Every writer has
 * finished by then, so the topology question §9.1 asks of a reader *inside* the flow —
 * `slot-not-downstream`, whether the read can race a branch still in flight — cannot arise at the
 * boundary. Which is the whole point: two branches that exclude each other have no step that
 * descends from both, and before this the value they share could not leave the flow at all.
 *
 * **A whole slot only — `shared.<slot>` takes no sub-path.** A miss *inside* a value that is present
 * leaves the placeholder in place (§11.2), which within a flow is evidence its author can see and
 * across the boundary is a `{{shared.a.b}}` string arriving at a caller as a value. Widening this
 * later is additive; narrowing it would not be.
 */
const checkExports = (flow: NormalizedFlow, report: Report, published: Published) => {
  for (const [name, path] of Object.entries(flow.exports)) {
    const [root, target, ...rest] = path.split('.');
    const node = ['exports', name];

    if (root === 'shared') {
      if (!target || rest.length > 0) {
        report.error(
          'unknown-export',
          `exports.${name} is ${path} — an export names a whole slot, as shared.<slot>`,
          undefined,
          node
        );
      } else if (!flow.shared[target]) {
        report.error(
          'unknown-export',
          `exports.${name} takes ${path}, which no shared: block declares`
          + suggest(target, Object.keys(flow.shared)),
          undefined,
          node
        );
      }
      continue;
    }

    if (root !== 'steps' || !target || rest.length === 0) {
      report.error(
        'unknown-export',
        `exports.${name} is ${path} — an export names a step output, as steps.<step>.<output>, `
        + 'or a slot, as shared.<slot>',
        undefined,
        node
      );
      continue;
    }

    const producer = flow.steps.find((step) => step.id === target);
    if (!producer) {
      report.error('unknown-export', `exports.${name} names ${target}, which is not a step`, undefined, node);
      continue;
    }

    const reference: Reference = { root: 'steps', name: target, field: rest.join('.'), text: path, where: name };
    if (referenceKind(reference, producer, published(producer)) === 'unknown') {
      report.error(
        'unknown-export',
        `exports.${name} takes ${path}, which ${target} does not produce`
        + suggest(rest[0], published(producer)),
        undefined,
        node
      );
    }
  }
};

/** §9.1's write side: a step publishes one of its own outputs into a slot the flow declares. */
const checkSharedWrites = (flow: NormalizedFlow, report: Report, published: Published) => {
  for (const step of flow.steps) {
    for (const { slot, output } of step.shared) {
      if (!flow.shared[slot]) {
        report.error(
          'invalid-shared-entry',
          `${step.id} publishes into ${slot}, which no shared: block declares`
          + suggest(slot, Object.keys(flow.shared)),
          step.id
        );
      }
      const names = published(step);
      if (!names.includes(output)) {
        report.error(
          'invalid-shared-entry',
          `${step.id} publishes ${output} into ${slot}, and ${step.id} does not produce ${output}`
          + suggest(output, names),
          step.id
        );
      }
    }
  }
};

/**
 * §14.3's three "declared and never used" warnings, over one index of what the flow reads.
 *
 * A value nothing consumes is not an error — a run records every output, and reading one back from
 * a capture is a legitimate thing to declare it for — but it is nearly always the other half of a
 * typo whose first half was reported as an unknown reference somewhere else.
 */
const checkUnused = (flow: NormalizedFlow, report: Report, reads: FlowReads) => {
  const raw = rawSteps(flow);
  flow.steps.forEach((step, index) => {
    // The step's own block only: a connector file supplies an operation's outputs to every flow
    // that targets it (§8.5), and most flows read a few of them — that is the design, not a typo.
    const inline = new Set(Object.keys(asRecord(raw[index]?.outputs)));
    for (const output of step.outputs) {
      if (!inline.has(output.name) || readsOutput(reads, step.id, output.name)) continue;
      report.warn(
        'unused-output',
        `${step.id}.${output.name} is declared and nothing in this flow reads it`,
        step.id,
        ['outputs', output.name]
      );
    }
  });

  const writers = new Map<string, string[]>();
  for (const step of flow.steps) {
    for (const { slot } of step.shared) writers.set(slot, [...(writers.get(slot) || []), step.id]);
  }

  for (const slot of Object.keys(flow.shared)) {
    if (!writers.has(slot)) {
      report.warn(
        'slot-without-writer',
        `shared.${slot} is declared and no step publishes into it, so every read of it resolves empty (§11.2)`,
        undefined,
        ['shared', slot]
      );
    }
    if (!reads.slots.has(slot)) {
      report.warn('unused-slot', `shared.${slot} is declared and nothing reads it`, undefined, ['shared', slot]);
    }
  }
};

/**
 * A step no scheduler will ever reach. In a graph whose edges all name real steps and carry no
 * cycle this set is empty, so what it reports is the *consequence* of the two errors that are: the
 * cycle diagnostic names one step, and this names every step that will not run because of it.
 */
const checkReachability = (flow: NormalizedFlow, report: Report) => {
  const ids = new Set(flow.steps.map((step) => step.id));
  const reachable = new Set<string>();

  for (let pass = 0; pass < flow.steps.length; pass += 1) {
    const before = reachable.size;
    for (const step of flow.steps) {
      if (reachable.has(step.id)) continue;
      const parents = step.depends.entries.map((entry) => entry.on);
      const satisfied = parents.length === 0
        ? true
        : step.depends.mode === 'any'
          ? parents.some((parent) => reachable.has(parent))
          : parents.every((parent) => reachable.has(parent) && ids.has(parent));
      if (satisfied) reachable.add(step.id);
    }
    if (reachable.size === before) break;
  }

  for (const step of flow.steps) {
    if (reachable.has(step.id)) continue;
    report.warn(
      'unreachable-step',
      `${step.id} can never run — nothing it depends on reaches a root`,
      step.id
    );
  }
};

/** Everything above, in the order a reader meets the document. */
export const checkShape = (flow: NormalizedFlow, report: Report, options: Options) => {
  checkStepIds(flow, report);
  checkDepends(flow, report);
  checkSubflowSteps(flow, report, options.invoked);
  checkDropPlacement(flow, report);
  checkNullOutputs(flow, report);
  checkReservedNames(flow, report);
  checkBruUsage(flow, report);
  checkLibraryFlag(flow, report, options.supplied);
  checkExpressions(flow, report);
  checkExports(flow, report, options.published);
  checkSharedWrites(flow, report, options.published);
  checkUnused(flow, report, options.reads);
  checkReachability(flow, report);
};
