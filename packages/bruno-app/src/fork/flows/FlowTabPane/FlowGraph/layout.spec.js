import { layoutGraph, layoutSlotLane } from './layout';

// Minimal but §11.1-shaped fixtures: every field FlowNode/FlowEdge/FlowDescription declare is
// present, even where a given test only exercises a subset of them.
const markers = () => ({ conditional: false, allowsErrorStatus: false, usesSharedSlot: false });

const makeNode = (overrides) => ({
  kind: 'operation',
  operation: { api: 'payments', method: 'POST', path: '/payments' },
  outputs: [],
  markers: markers(),
  position: { line: 1, column: 1 },
  ...overrides
});

const makeDescription = (overrides) => ({
  id: 'flow.yml',
  name: 'flow',
  isLibrary: false,
  params: [],
  nodes: [],
  edges: [],
  slots: [],
  diagnostics: [],
  ...overrides
});

const noExpansion = { expandedSubflows: [] };

const chain = (ids) => ids.slice(1).map((id, index) => ({ from: ids[index], to: id, kind: 'sequence' }));

const byId = (nodes) => Object.fromEntries(nodes.map((node) => [node.id, node]));

/** Whether a routed segment passes through a box — the defect the routing exists to prevent. */
const segmentEntersBox = (from, to, box) => {
  const steps = 200;
  for (let step = 0; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return true;
  }
  return false;
};

const boxesCrossedBy = (edge, nodes) =>
  nodes.filter(
    (node) =>
      node.id !== edge.from
      && node.id !== edge.to
      && edge.points.slice(1).some((point, index) => segmentEntersBox(edge.points[index], point, node))
  );

describe('layoutGraph', () => {
  /**
   * The shape that took the tab down: `f3-batch-settlement` in the conformance corpus, whose
   * `get_batch` feeds two connectors to one step and four to another. Dagre mislays some
   * arrangements of parallel edges and throws out of `layout()` — during render, so the flow tab
   * caught it and showed nothing at all. It is not a shape a flow can be told to avoid: 001 §8.1
   * draws a connector per output, and this one is an ordinary flow.
   */
  it('lays out several connectors between one pair of steps', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'get_batch', rank: 0 }),
        makeNode({ id: 'elevate', rank: 1 }),
        makeNode({ id: 'create_audit_record', rank: 1 }),
        makeNode({ id: 'submit_settlement', rank: 2 })
      ],
      edges: [
        { from: 'get_batch', to: 'elevate', kind: 'sequence' },
        { from: 'get_batch', to: 'create_audit_record', kind: 'depends' },
        { from: 'get_batch', to: 'submit_settlement', kind: 'data', output: 'batch' },
        { from: 'get_batch', to: 'submit_settlement', kind: 'data', output: 'batchId' },
        { from: 'get_batch', to: 'create_audit_record', kind: 'data', output: 'batchId' },
        { from: 'get_batch', to: 'create_audit_record', kind: 'data', output: 'batch' }
      ]
    });

    const graph = layoutGraph(description, noExpansion);

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(6);
    // Every connector between one pair draws the pair's own route: the stacked labels are what tell
    // them apart, which is why merging them for the layout costs the drawing nothing.
    const toAudit = graph.edges.filter((edge) => edge.to === 'create_audit_record');
    expect(new Set(toAudit.map((edge) => edge.path)).size).toBe(1);
  });

  /** A sub-flow expanded into a graph with that shape is the same layout, and the same trap. */
  it('lays them out with a sub-flow expanded beside them', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'auth', kind: 'subflow', operation: undefined, uses: '../lib/auth.flow.yml', rank: 0 }),
        makeNode({ id: 'auth/login', parent: 'auth', rank: 0 }),
        makeNode({ id: 'get_batch', rank: 1 }),
        makeNode({ id: 'elevate', rank: 2 }),
        makeNode({ id: 'submit_settlement', rank: 3 })
      ],
      edges: [
        { from: 'auth', to: 'get_batch', kind: 'sequence' },
        { from: 'get_batch', to: 'elevate', kind: 'sequence' },
        { from: 'get_batch', to: 'submit_settlement', kind: 'data', output: 'batch' },
        { from: 'get_batch', to: 'submit_settlement', kind: 'data', output: 'batchId' },
        { from: 'elevate', to: 'submit_settlement', kind: 'data', output: 'token' }
      ]
    });

    const graph = layoutGraph(description, { expandedSubflows: ['auth'] });

    expect(graph.nodes.map((node) => node.id)).toContain('auth/login');
  });

  it('lays out a linear flow as a single row, advancing left to right', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'login', rank: 0 }),
        makeNode({ id: 'createOrder', rank: 1 }),
        makeNode({ id: 'payOrder', rank: 2 })
      ],
      edges: chain(['login', 'createOrder', 'payOrder'])
    });

    const nodes = byId(layoutGraph(description, noExpansion).nodes);

    expect(nodes.login.y).toBe(nodes.createOrder.y);
    expect(nodes.createOrder.y).toBe(nodes.payOrder.y);
    expect(nodes.login.x).toBeLessThan(nodes.createOrder.x);
    expect(nodes.createOrder.x).toBeLessThan(nodes.payOrder.x);
  });

  /**
   * §11.1 divides the work at exactly this line: the engine decides which rank a step is in, and this
   * module decides where that rank sits. A layout engine with rankers of its own is the obvious place
   * to lose that — dagre's own answer slides a short branch rightward until it meets the join it
   * feeds, which is a different graph from the one 001 computed.
   */
  it('draws the engine\'s ranks as the columns, whatever the edges suggest', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'probe', rank: 0 }),
        makeNode({ id: 'short', rank: 1 }),
        makeNode({ id: 'longA', rank: 1 }),
        makeNode({ id: 'longB', rank: 2 }),
        makeNode({ id: 'join', rank: 3 })
      ],
      edges: [
        { from: 'probe', to: 'short', kind: 'depends' },
        { from: 'probe', to: 'longA', kind: 'depends' },
        { from: 'longA', to: 'longB', kind: 'sequence' },
        { from: 'short', to: 'join', kind: 'depends' },
        { from: 'longB', to: 'join', kind: 'depends' }
      ]
    });

    const nodes = byId(layoutGraph(description, noExpansion).nodes);

    // The one-step branch stays in the column its rank names rather than being pushed against the join.
    expect(nodes.short.x).toBe(nodes.longA.x);
    expect(nodes.longA.x).toBeLessThan(nodes.longB.x);
    expect(nodes.longB.x).toBeLessThan(nodes.join.x);
  });

  /**
   * §5.2: order within a rank is chosen to minimise crossings, and what has to hold is that the
   * choice is a function of the description alone — U1.10's graph that does not move between runs.
   */
  it('places the same description identically every time', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'zeta', rank: 1 }),
        makeNode({ id: 'alpha', rank: 1 }),
        makeNode({ id: 'leaf', rank: 2 })
      ],
      edges: [
        { from: 'root', to: 'zeta', kind: 'depends' },
        { from: 'root', to: 'alpha', kind: 'depends' },
        { from: 'zeta', to: 'leaf', kind: 'depends' },
        { from: 'alpha', to: 'leaf', kind: 'depends' }
      ]
    });

    const first = layoutGraph(description, noExpansion).nodes.map((node) => [node.id, node.x, node.y]);
    const second = layoutGraph(description, noExpansion).nodes.map((node) => [node.id, node.x, node.y]);

    expect(second).toEqual(first);
    // Siblings share a rank, so they share a column and are told apart down the short axis.
    const nodes = byId(layoutGraph(description, noExpansion).nodes);
    expect(nodes.zeta.x).toBe(nodes.alpha.x);
    expect(nodes.zeta.y).not.toBe(nodes.alpha.y);
  });

  /**
   * The defect the routing exists for: an edge between steps six ranks apart used to be drawn as one
   * curve from the producer's right edge to the consumer's left, straight through every box between
   * them. On `seed-verified-company` that was 40 of 63 edges.
   */
  it('routes an edge spanning several ranks clear of the steps between them', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'first', rank: 0 }),
        makeNode({ id: 'second', rank: 1 }),
        makeNode({ id: 'third', rank: 2 }),
        makeNode({ id: 'fourth', rank: 3 })
      ],
      edges: [
        ...chain(['first', 'second', 'third', 'fourth']),
        { from: 'first', to: 'fourth', kind: 'data', output: 'token', declared: true }
      ]
    });

    const graph = layoutGraph(description, noExpansion);

    graph.edges.forEach((edge) => expect(boxesCrossedBy(edge, graph.nodes)).toEqual([]));
  });

  /**
   * §5.2: eleven edges out of one step used to leave from one pixel, which is exactly the state in
   * which nobody can tell which line goes where.
   */
  it('spreads the edges leaving one step along its border', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'producer', rank: 0 }),
        makeNode({ id: 'consumerA', rank: 1 }),
        makeNode({ id: 'consumerB', rank: 1 }),
        makeNode({ id: 'consumerC', rank: 1 })
      ],
      edges: [
        { from: 'producer', to: 'consumerA', kind: 'depends' },
        { from: 'producer', to: 'consumerB', kind: 'depends' },
        { from: 'producer', to: 'consumerC', kind: 'depends' }
      ]
    });

    const graph = layoutGraph(description, noExpansion);
    const exits = graph.edges.map((edge) => edge.points[0].y);

    expect(new Set(exits).size).toBe(3);
  });

  /** An edge leaves the right border of one box and arrives at the left border of the next. */
  it('anchors an edge horizontally, so the arrow points along the flow', () => {
    const description = makeDescription({
      nodes: [makeNode({ id: 'first', rank: 0 }), makeNode({ id: 'second', rank: 1 })],
      edges: [{ from: 'first', to: 'second', kind: 'sequence' }]
    });

    const graph = layoutGraph(description, noExpansion);
    const nodes = byId(graph.nodes);
    const [edge] = graph.edges;
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];

    expect(start.x).toBeCloseTo(nodes.first.x + nodes.first.width);
    expect(start.y).toBeGreaterThan(nodes.first.y);
    expect(start.y).toBeLessThan(nodes.first.y + nodes.first.height);
    expect(end.x).toBeCloseTo(nodes.second.x);
    expect(end.y).toBeGreaterThan(nodes.second.y);
    expect(end.y).toBeLessThan(nodes.second.y + nodes.second.height);
    expect(edge.path.startsWith(`M ${start.x}`)).toBe(true);
  });

  it('excludes a collapsed sub-flow\'s internals and includes them once expanded', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'auth', rank: 1, kind: 'subflow', uses: 'auth.flow.yml', operation: undefined }),
        makeNode({ id: 'auth/login', rank: 0, parent: 'auth' }),
        makeNode({ id: 'auth/verify', rank: 1, parent: 'auth' })
      ],
      edges: [
        { from: 'root', to: 'auth', kind: 'sequence' },
        { from: 'auth/login', to: 'auth/verify', kind: 'sequence' }
      ]
    });

    const collapsed = layoutGraph(description, noExpansion);
    expect(collapsed.nodes.map((node) => node.id)).toEqual(['root', 'auth']);

    const expanded = layoutGraph(description, { expandedSubflows: ['auth'] });
    const nodes = byId(expanded.nodes);
    expect(Object.keys(nodes).sort()).toEqual(['auth', 'auth/login', 'auth/verify', 'root']);

    // §11.1: internal ranks start at 0 and are laid out as their own block directly after the
    // container node's column, not continued from the parent's rank.
    expect(nodes['auth/login'].x).toBeGreaterThan(nodes.auth.x);
    expect(nodes['auth/verify'].x).toBeGreaterThan(nodes['auth/login'].x);
  });

  it('drops an edge whose target is inside a collapsed sub-flow instead of drawing it with NaN', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'auth', rank: 1, kind: 'subflow', uses: 'auth.flow.yml', operation: undefined }),
        makeNode({ id: 'auth/login', rank: 0, parent: 'auth' })
      ],
      edges: [
        { from: 'root', to: 'auth', kind: 'sequence' },
        { from: 'root', to: 'auth/login', kind: 'data', output: 'token', declared: true }
      ]
    });

    const { edges } = layoutGraph(description, noExpansion);

    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe('root');
    expect(edges[0].to).toBe('auth');
  });

  /**
   * A hidden data edge still occupies the layout: a toggle is a view of one drawing, and a graph that
   * re-laid itself around what is currently ticked would move every box under the reader's cursor.
   */
  it('bounds every node and every route within the returned width and height', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'branchA', rank: 1 }),
        makeNode({ id: 'branchB', rank: 1 }),
        makeNode({ id: 'merge', rank: 2 })
      ],
      edges: [
        { from: 'root', to: 'branchA', kind: 'depends' },
        { from: 'root', to: 'branchB', kind: 'depends' },
        { from: 'branchA', to: 'merge', kind: 'depends' },
        { from: 'branchB', to: 'merge', kind: 'depends' },
        { from: 'root', to: 'merge', kind: 'data', output: 'token', declared: true }
      ]
    });

    const { nodes, edges, width, height } = layoutGraph(description, noExpansion);

    nodes.forEach((node) => {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(width);
      expect(node.y + node.height).toBeLessThanOrEqual(height);
    });
    edges.forEach((edge) =>
      edge.points.forEach((point) => {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(width);
        expect(point.y).toBeLessThanOrEqual(height);
      })
    );
  });

  it('returns an empty drawing for a description with no nodes', () => {
    expect(layoutGraph(makeDescription({}), noExpansion)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

/**
 * §5.3 and §9.1: the slot layer. 001 §9.1 has a slot name no producer, so it is drawn through a
 * glyph and never writer-to-reader — and it is drawn only when asked for, because a session token
 * read by every authenticated step is one line from every box on the drawing.
 */
describe('layoutSlotLane', () => {
  const description = makeDescription({
    nodes: [
      makeNode({ id: 'login', rank: 0, markers: { ...markers(), usesSharedSlot: true } }),
      makeNode({ id: 'createOrder', rank: 1, markers: { ...markers(), usesSharedSlot: true } }),
      makeNode({ id: 'refund', rank: 2, markers: { ...markers(), usesSharedSlot: true } })
    ],
    edges: chain(['login', 'createOrder', 'refund']),
    slots: [
      { name: 'authToken', writers: ['login'], readers: ['createOrder', 'refund'] },
      { name: 'orderId', writers: ['createOrder'], readers: ['refund'] }
    ]
  });

  const graph = () => layoutGraph(description, noExpansion);

  it('draws nothing while no slot is asked for', () => {
    const lane = layoutSlotLane(graph(), description.slots, []);

    expect(lane.slots).toEqual([]);
    expect(lane.edges).toEqual([]);
    expect(lane.height).toBe(0);
  });

  it('draws a glyph with one edge per writer and per reader, never writer to reader', () => {
    const lane = layoutSlotLane(graph(), description.slots, ['authToken']);

    expect(lane.slots.map((slot) => slot.name)).toEqual(['authToken']);
    expect(lane.edges.filter((edge) => edge.kind === 'slot-write')).toHaveLength(1);
    expect(lane.edges.filter((edge) => edge.kind === 'slot-read')).toHaveLength(2);
    expect(lane.edges.some((edge) => edge.from === 'login' && edge.to === 'createOrder')).toBe(false);

    const write = lane.edges.find((edge) => edge.kind === 'slot-write');
    const read = lane.edges.find((edge) => edge.kind === 'slot-read');
    expect(write.from).toBe('login');
    expect(write.to).toBe('slot:authToken');
    expect(read.from).toBe('slot:authToken');
    expect(read.to).toBe('createOrder');
  });

  /** Off the flow's own axis: below the ranks, so a slot never reads as a step in the sequence. */
  it('puts the lane below every step', () => {
    const laidOut = graph();
    const lane = layoutSlotLane(laidOut, description.slots, ['authToken', 'orderId']);

    const lowestStep = Math.max(...laidOut.nodes.map((node) => node.y + node.height));
    lane.slots.forEach((slot) => expect(slot.y).toBeGreaterThanOrEqual(lowestStep));
    expect(lane.height).toBeGreaterThan(0);
  });

  /**
   * Four slots spanning the same flow used to be centred on the same coordinate — one square where
   * four should be, with every slot edge in the flow converging on it.
   */
  it('never places two glyphs on top of each other', () => {
    const lane = layoutSlotLane(graph(), description.slots, ['authToken', 'orderId']);

    expect(lane.slots).toHaveLength(2);
    const [first, second] = lane.slots;
    const apart = first.y !== second.y || first.x + first.width <= second.x || second.x + second.width <= first.x;
    expect(apart).toBe(true);
  });

  /**
   * Focusing a step asks what *this step* shares, and the glyph still names the rest — so the answer
   * is that step's own edges rather than every participant's.
   */
  it('narrows the edges to one step without hiding the slot', () => {
    const lane = layoutSlotLane(graph(), description.slots, ['authToken'], { only: 'refund' });

    expect(lane.slots.map((slot) => slot.name)).toEqual(['authToken']);
    expect(lane.edges).toHaveLength(1);
    expect(lane.edges[0].step).toBe('refund');
  });

  it('skips a slot whose participants are all inside a collapsed sub-flow', () => {
    const lane = layoutSlotLane(graph(), [{ name: 'ghost', writers: ['auth/login'], readers: [] }], ['ghost']);

    expect(lane.slots).toEqual([]);
    expect(lane.height).toBe(0);
  });
});
