/**
 * The resolved graph — 002 §11.1.
 *
 * `rank` is the engine's and pixels are the renderer's: longest-path ranking is a fact about the
 * resolved DAG, so computing it in a renderer would be a second implementation of scheduling order.
 */
import type { Diagnostic, StepStatus } from './result';

export type FlowNode = {
  /** Sub-flow internals namespaced: "auth/login". */
  id: string;
  name?: string;
  kind: 'operation' | 'subflow';
  operation?: { api: string; method: string; path: string; operationId?: string };
  /** Sub-flow path, when kind is 'subflow'. */
  uses?: string;
  /** The uses: node this internal step belongs to. */
  parent?: string;
  /** Longest path from a root. */
  rank: number;
  /** Declared output names (§8.1, §8.5). */
  outputs: string[];
  markers: {
    /** when: (§9.3) */
    conditional: boolean;
    /** retry: (§11.1) */
    retryMaxAttempts?: number;
    /** failOnStatusCode: false (§10.3) */
    allowsErrorStatus: boolean;
    /** (§9.1) */
    usesSharedSlot: boolean;
  };
  position: { line: number; column: number };
};

/**
 * `'sequence'` is how an implicit edge (§9.1) is distinguished from a declared one — the renderer
 * cannot infer it, and 002 §5.3 makes that distinction the most useful thing the drawing says.
 * A status-conditioned edge is a `'depends'` edge with a non-empty `status`, not its own kind.
 */
export type FlowEdge = {
  from: string;
  to: string;
  kind: 'sequence' | 'depends' | 'data' | 'slot-write' | 'slot-read';
  /** depends edges, when not the default [success]. */
  status?: StepStatus[];
  /** depends edges. */
  join?: 'all' | 'any';
  /** data edges: the connector's name. */
  output?: string;
  /** data edges: false for raw .body access (§8.3). */
  declared?: boolean;
  /** slot edges. */
  slot?: string;
};

export type FlowDescription = {
  /** Path relative to the scope root (§5.2). */
  id: string;
  /** meta.name, or the filename. */
  name: string;
  /** meta.library: true (§12.5). */
  isLibrary: boolean;
  params: { name: string; required: boolean; default?: unknown; secret: boolean }[];
  /**
   * The flow's `vars:` as the file declares them — the *expression*, not the resolved value.
   *
   * §7.3 resolves these once per iteration against the run's environment, so a value here would be
   * a value only for one iteration of one run. 002 §5.6 shows them beside the params so the inputs
   * node is the whole of what a run starts from, and the expression is what an author changes.
   */
  vars: { name: string; expression: string }[];
  /**
   * The flow's `apis:` bindings in file order, with §6.2's declared colour where there is one — 002
   * §5.1 draws by binding and is the only reader. Declared rather than used: what the file says.
   */
  apis: { alias: string; color?: string }[];
  dataset?: { source: string; parallel: number };
  nodes: FlowNode[];
  edges: FlowEdge[];
  slots: { name: string; writers: string[]; readers: string[] }[];
  /**
   * §5.5's stage boundaries in file order, each resolved to the rank whose column its rule is drawn
   * in front of. Only the ones the schedule allows: a boundary the run contradicts is dropped here
   * and reported as a warning instead (§14.3), so the picture never implies an order that is not
   * real. The entry flow's own; an expanded sub-flow's are not drawn.
   */
  stages: { name: string; from: string; rank: number }[];
  /** The same set validateFlow returns. */
  diagnostics: Diagnostic[];
};
