import { layoutGraph } from './layout';

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

describe('layoutGraph', () => {
  it('lays out a linear flow as a single centered column', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'login', rank: 0 }),
        makeNode({ id: 'createOrder', rank: 1 }),
        makeNode({ id: 'payOrder', rank: 2 })
      ]
    });

    const { nodes } = layoutGraph(description, noExpansion);

    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    expect(byId.login.x).toBe(byId.createOrder.x);
    expect(byId.createOrder.x).toBe(byId.payOrder.x);
    expect(byId.login.y).toBeLessThan(byId.createOrder.y);
    expect(byId.createOrder.y).toBeLessThan(byId.payOrder.y);
  });

  it('orders nodes sharing a rank by declaration order, not by id', () => {
    const root = makeNode({ id: 'root', rank: 0 });
    const zeta = makeNode({ id: 'zeta', rank: 1 });
    const alpha = makeNode({ id: 'alpha', rank: 1 });
    const leaf = makeNode({ id: 'leaf', rank: 2 });

    const declaredOrder = layoutGraph(makeDescription({ nodes: [root, zeta, alpha, leaf] }), noExpansion);
    const declaredById = Object.fromEntries(declaredOrder.nodes.map((node) => [node.id, node]));
    expect(declaredById.zeta.x).toBeLessThan(declaredById.alpha.x);

    // Reversing the unrelated root/leaf entries — different ranks entirely — must not move zeta
    // relative to alpha, since their order comes from their own relative position in `nodes`.
    const reordered = layoutGraph(makeDescription({ nodes: [leaf, root, zeta, alpha] }), noExpansion);
    const reorderedById = Object.fromEntries(reordered.nodes.map((node) => [node.id, node]));
    expect(reorderedById.zeta.x).toBeLessThan(reorderedById.alpha.x);
    expect(reorderedById.zeta.x).toBe(declaredById.zeta.x);
    expect(reorderedById.alpha.x).toBe(declaredById.alpha.x);
  });

  it('excludes a collapsed sub-flow\'s internals and includes them once expanded', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'auth', rank: 1, kind: 'subflow', uses: 'auth.flow.yml', operation: undefined }),
        makeNode({ id: 'auth/login', rank: 0, parent: 'auth' }),
        makeNode({ id: 'auth/verify', rank: 1, parent: 'auth' })
      ]
    });

    const collapsed = layoutGraph(description, noExpansion);
    expect(collapsed.nodes.map((node) => node.id)).toEqual(['root', 'auth']);

    const expanded = layoutGraph(description, { expandedSubflows: ['auth'] });
    const expandedById = Object.fromEntries(expanded.nodes.map((node) => [node.id, node]));
    expect(Object.keys(expandedById).sort()).toEqual(['auth', 'auth/login', 'auth/verify', 'root']);

    // §11.1: internal ranks start at 0 and are laid out as their own block directly beneath the
    // container node's row, not continued from the parent's rank.
    expect(expandedById['auth/login'].y).toBeGreaterThan(expandedById.auth.y);
    expect(expandedById['auth/verify'].y).toBeGreaterThan(expandedById['auth/login'].y);
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
    expect(edges.some((edge) => edge.to === 'auth/login')).toBe(false);
  });

  it('draws a slot as a glyph with one edge per writer and per reader, never writer to reader', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'login', rank: 0, markers: { ...markers(), usesSharedSlot: true } }),
        makeNode({ id: 'createOrder', rank: 1, markers: { ...markers(), usesSharedSlot: true } }),
        makeNode({ id: 'refund', rank: 2, markers: { ...markers(), usesSharedSlot: true } })
      ],
      slots: [{ name: 'authToken', writers: ['login'], readers: ['createOrder', 'refund'] }]
    });

    const { slots, edges } = layoutGraph(description, noExpansion);

    expect(slots).toHaveLength(1);
    expect(slots[0].name).toBe('authToken');

    const slotEdges = edges.filter((edge) => edge.slot === 'authToken');
    expect(slotEdges).toHaveLength(3);
    expect(slotEdges.filter((edge) => edge.kind === 'slot-write')).toHaveLength(1);
    expect(slotEdges.filter((edge) => edge.kind === 'slot-read')).toHaveLength(2);
    expect(edges.some((edge) => edge.from === 'login' && edge.to === 'createOrder')).toBe(false);
    expect(edges.some((edge) => edge.from === 'login' && edge.to === 'refund')).toBe(false);
  });

  it('bounds every node within the returned width and height', () => {
    const description = makeDescription({
      nodes: [
        makeNode({ id: 'root', rank: 0 }),
        makeNode({ id: 'branchA', rank: 1 }),
        makeNode({ id: 'branchB', rank: 1 }),
        makeNode({ id: 'merge', rank: 2 })
      ],
      slots: [{ name: 'shared', writers: ['branchA'], readers: ['merge'] }]
    });

    const { nodes, slots, width, height } = layoutGraph(description, noExpansion);

    [...nodes, ...slots].forEach((box) => {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    });
  });
});
