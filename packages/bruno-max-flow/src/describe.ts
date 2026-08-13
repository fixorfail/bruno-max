/**
 * The resolved graph — 002 §11.1.
 *
 * Everything the app draws comes from here, because a renderer that read `.flow.yml` itself would
 * re-implement §9.1's implicit-sequence and join rules and could then draw a graph the CLI does not
 * execute (002 §11). The division is: this decides what the nodes and edges *are*, including a
 * step's rank; turning ranks into coordinates is presentation and stays in the app.
 *
 * It never dispatches and never reads run state. It resolves operations against the bound OpenAPI
 * documents, so it can fail the way `validateFlow` does — which is why `diagnostics` is a field
 * rather than a thrown error, and why a flow with errors still returns whatever could be built
 * (002 §6: a broken flow must still open).
 */
import * as path from 'path';

import { normalizeFlow, parseDocument, type NormalizedFlow, type NormalizedStep } from './document';
import { SpecLoader, type SpecIndex } from './openapi';
import { referenceKind, referencesOf } from './references';
import type { DescribeOptions } from './types/options';
import type { FlowDescription, FlowEdge, FlowNode } from './types/describe';
import type { FlowContext } from './types/ports';
import { validateFlow } from './validate';

/**
 * Longest path from a root (002 §5.2), which is what places a step below *every* one of its
 * dependencies rather than just the first — the property that makes the drawing readable as
 * execution order. A cycle cannot deepen a rank forever because a step already on the path is
 * skipped; `validateFlow` reports the cycle separately.
 */
const ranksOf = (steps: NormalizedStep[]): Map<string, number> => {
  const parents = new Map(steps.map((step) => [step.id, step.depends.entries.map((entry) => entry.on)]));
  const ranks = new Map<string, number>();

  const rankOf = (id: string, seen: Set<string>): number => {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;

    const above = (parents.get(id) || [])
      .filter((parent) => !seen.has(parent) && parents.has(parent))
      .map((parent) => rankOf(parent, new Set([...seen, parent])) + 1);
    const rank = above.length ? Math.max(...above) : 0;
    ranks.set(id, rank);
    return rank;
  };

  for (const step of steps) rankOf(step.id, new Set([step.id]));
  return ranks;
};

/**
 * §9.1's implicit sequence is a *different edge* from a declared one, not a stylistic variant: it is
 * not in the file, and drawing the two identically hides the one thing about the rule that surprises
 * authors (002 §5.3). `depends: [previous]` produces the same entries, so the flag normalization
 * records is the only thing that can still tell them apart here.
 */
const controlEdges = (steps: NormalizedStep[], prefix: string): FlowEdge[] =>
  steps.flatMap((step) =>
    step.depends.entries.map((entry): FlowEdge => ({
      from: `${prefix}${entry.on}`,
      to: `${prefix}${step.id}`,
      kind: step.depends.implicit ? 'sequence' : 'depends',
      // Absent means the default [success]; a renderer labels only what it is given, and an
      // unlabeled [failed] edge tells the reader a branch runs when it does not (002 §5.3).
      status: entry.status.length === 1 && entry.status[0] === 'success' ? undefined : entry.status,
      join: step.depends.entries.length > 1 ? step.depends.mode : undefined
    }))
  );

/**
 * §8.1's declared outputs, plus §8.3's raw access drawn in the warning style. Omitting the second
 * would make the graph assert there is no data path where the file has one (002 §5.3, U1.6).
 */
const dataEdges = (flow: NormalizedFlow, prefix: string): FlowEdge[] => {
  const seen = new Set<string>();

  return flow.steps.flatMap((step) =>
    referencesOf(step, flow).flatMap((reference): FlowEdge[] => {
      if (reference.root !== 'steps' || reference.name === step.id) return [];
      const producer = flow.steps.find((candidate) => candidate.id === reference.name);
      if (!producer) return [];

      const kind = referenceKind(reference, producer);
      if (kind === 'built-in' || kind === 'unknown') return [];

      const output = reference.field?.split('.')[0] as string;
      // One edge per producer/consumer/output triple however many times it is interpolated: a body
      // reading the same id three times is one data path, and three overlapping edges say nothing.
      const key = `${reference.name}->${step.id}:${output}`;
      if (seen.has(key)) return [];
      seen.add(key);

      return [
        {
          from: `${prefix}${reference.name}`,
          to: `${prefix}${step.id}`,
          kind: 'data',
          output,
          declared: kind === 'declared'
        }
      ];
    })
  );
};

/**
 * §9.1's slots deliberately do not name a producer, so they cannot be drawn writer-to-reader
 * without asserting a relationship the format denies. The two directed kinds are what let a
 * renderer put a glyph between them (002 §5.3, U1.7).
 */
const slotEdges = (flow: NormalizedFlow, prefix: string): FlowEdge[] => {
  const edges: FlowEdge[] = [];

  for (const step of flow.steps) {
    for (const { slot } of step.shared) {
      edges.push({ from: `${prefix}${step.id}`, to: slot, kind: 'slot-write', slot });
    }
    for (const reference of referencesOf(step, flow)) {
      if (reference.root !== 'shared') continue;
      if (edges.some((edge) => edge.kind === 'slot-read' && edge.slot === reference.name && edge.to === `${prefix}${step.id}`)) {
        continue;
      }
      edges.push({ from: reference.name, to: `${prefix}${step.id}`, kind: 'slot-read', slot: reference.name });
    }
  }

  return edges;
};

const slotsOf = (flow: NormalizedFlow): FlowDescription['slots'] =>
  flow.shared.map((name) => ({
    name,
    writers: flow.steps.filter((step) => step.shared.some((entry) => entry.slot === name)).map((step) => step.id),
    readers: flow.steps
      .filter((step) => referencesOf(step, flow).some((reference) => reference.root === 'shared' && reference.name === name))
      .map((step) => step.id)
  }));

const nodesOf = (flow: NormalizedFlow, specs: Map<string, SpecIndex>, prefix: string, parent?: string): FlowNode[] => {
  const ranks = ranksOf(flow.steps);

  return flow.steps.map((step): FlowNode => {
    const binding = step.operation ? flow.apis[step.operation.alias] : undefined;
    const resolved = binding ? specs.get(binding.alias)?.operations.get(step.operation?.operationId || '') : undefined;

    return {
      id: `${prefix}${step.id}`,
      name: step.name,
      kind: step.kind,
      // The method and path are what the step *does*, and resolving them is the whole point of
      // having an engine describe the flow rather than the renderer reading the YAML (002 §5.1).
      operation: resolved && step.operation
        ? {
            api: step.operation.alias,
            method: resolved.method.toUpperCase(),
            path: resolved.template,
            operationId: resolved.operationId
          }
        : undefined,
      uses: step.uses,
      parent,
      rank: ranks.get(step.id) as number,
      outputs: step.outputs.map((output) => output.name),
      markers: {
        conditional: step.when.length > 0,
        retryMaxAttempts: step.retry.maxAttempts > 1 ? step.retry.maxAttempts : undefined,
        allowsErrorStatus: !step.flags.failOnStatusCode,
        usesSharedSlot:
          step.shared.length > 0
          || referencesOf(step, flow).some((reference) => reference.root === 'shared')
      },
      position: step.position as FlowNode['position']
    };
  });
};

type Loader = {
  specs: SpecLoader;
  readFlow: (file: string) => Promise<NormalizedFlow>;
};

/**
 * A sub-flow contributes its own nodes and edges under namespaced ids, so the app can expand a
 * `uses:` node into the graph beneath it (002 §5.4). Ranks are relative to the sub-flow's own
 * roots, because that is the graph being drawn — a sub-flow's first step is a root of the picture
 * it appears in, not rank 4 of its caller's.
 */
const collect = async (
  flow: NormalizedFlow,
  loader: Loader,
  prefix: string,
  parent: string | undefined,
  seen: Set<string>
): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> => {
  const specs = new Map<string, SpecIndex>();
  for (const binding of Object.values(flow.apis)) {
    try {
      specs.set(binding.alias, await loader.specs.load(binding.source, flow.file));
    } catch {
      // An unresolvable binding is `validateFlow`'s to report; the node still draws, without its
      // method and path, because 002 §6 requires a broken flow to open.
    }
  }

  const nodes = nodesOf(flow, specs, prefix, parent);
  const edges = [...controlEdges(flow.steps, prefix), ...dataEdges(flow, prefix), ...slotEdges(flow, prefix)];

  for (const step of flow.steps) {
    if (!step.uses) continue;
    const target = path.resolve(path.dirname(flow.file), step.uses);
    if (seen.has(target)) continue;

    try {
      const child = await loader.readFlow(target);
      const inner = await collect(
        child,
        loader,
        `${prefix}${step.id}/`,
        `${prefix}${step.id}`,
        new Set([...seen, target])
      );
      nodes.push(...inner.nodes);
      edges.push(...inner.edges);
    } catch {
      // A sub-flow that cannot be read leaves its container node in place, marked and empty.
    }
  }

  return { nodes, edges };
};

export const describeFlow = async (options: DescribeOptions): Promise<FlowDescription> => {
  const context: FlowContext = {
    runId: 'describe',
    flow: options.entry,
    scope: options.scope,
    signal: new AbortController().signal
  };

  const loader: Loader = {
    specs: new SpecLoader(options.ports.readSpec, context),
    readFlow: async (file) =>
      normalizeFlow(parseDocument((await options.ports.readFile(file, context)).toString('utf8')), file)
  };

  // The same set `validateFlow` returns, by calling it rather than by re-deriving it — the app and
  // `bru flow validate` cannot then disagree about whether a flow is correct (002 §6).
  const diagnostics = await validateFlow({ entry: options.entry, scope: options.scope, ports: options.ports });

  const root = options.scope.collectionRoot || options.scope.workspaceRoot;
  const identity = {
    id: path.relative(root, options.entry),
    name: path.basename(options.entry).replace(/\.flow\.yml$/, ''),
    isLibrary: false,
    params: [],
    nodes: [],
    edges: [],
    slots: [],
    diagnostics
  };

  let flow: NormalizedFlow;
  try {
    flow = await loader.readFlow(options.entry);
  } catch {
    return identity;
  }

  // A file that did not parse has no graph to draw, and `diagnostics` already carries the anchored
  // syntax error. Returning the shell rather than throwing is what lets the tab open (002 §6).
  if (flow.errors.length) return identity;

  const { nodes, edges } = await collect(flow, loader, '', undefined, new Set([options.entry]));

  return {
    ...identity,
    name: flow.meta.name || identity.name,
    isLibrary: flow.meta.library,
    params: Object.entries(flow.params).map(([name, declared]) => ({
      name,
      required: declared.required,
      default: declared.default
    })),
    dataset: flow.dataset,
    nodes,
    edges,
    slots: slotsOf(flow)
  };
};
