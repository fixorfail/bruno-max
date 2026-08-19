import { graphlib, layout } from '@dagrejs/dagre';

/**
 * Turns a `FlowDescription` (002 §11.1) into screen coordinates. `rank` is the engine's; pixels are
 * the renderer's — this module never recomputes ranking or topologically sorts, it only lays out
 * the ranks and the declaration order `describeFlow` already resolved.
 *
 * **Ranks advance left to right** (§5.2); steps sharing a rank stack downward. A step box is far
 * wider than it is tall, so a rank spent on the short axis costs the little that is scarce and a
 * flow's length runs along the axis the pane can scroll without pushing the graph off the top.
 *
 * **Ordering within a rank and edge routing are dagre's** (§13). The hand-rolled version placed a
 * box per rank and drew every edge as one bezier from the producer's right edge to the consumer's
 * left, which is correct for an edge between adjacent ranks and wrong for every other one: an edge
 * spanning six ranks ran flat through the five boxes between them, and a step with eleven outgoing
 * edges emitted all eleven from a single point. On a real flow — `seed-verified-company`, 18 steps —
 * 40 of 63 edges passed through a box they did not connect. Waypoint routing is the fix and is not
 * a small function; §13 records why the dependency is now worth its merge cost.
 *
 * **The engine still decides ranks, and dagre is not allowed to re-derive them.** §11.1 divides the
 * work at exactly that line, and dagre's own rankers answer a different question — its
 * `longest-path` measures to a *sink*, which slides a short branch rightward until it abuts the join
 * it feeds. Requiring each edge to span `rank(to) - rank(from)` layers makes the engine's assignment
 * the only tight solution, so the columns are 001's ranks and the layout is a presentation of them.
 */

const NODE_WIDTH = 220;
/**
 * §5.1's footer bar: the markers, and the binding the step calls, on a strip along the bottom of the
 * box. Exported because the box is measured here and drawn there, and a footer the drawing believed
 * was a different height from the one the layout reserved would sit over the status line or leave a
 * gap under it.
 */
export const NODE_FOOTER_HEIGHT = 18;
/**
 * Room for the three things a box shows once they wrap — a name over two lines, an operation over
 * two, and the run's status on the last — plus the footer under them. SVG text did not wrap, so the
 * old height only ever had to fit three single lines, and anything longer left the box rather than
 * growing it.
 */
const NODE_HEIGHT = 84 + NODE_FOOTER_HEIGHT;
/** Between one rank and the next — the direction the flow runs, and the room an edge turns in. */
const RANK_GAP = 72;
/** Between steps that share a rank. */
const SIBLING_GAP = 32;
/** Between two routes sharing a lane, which is what keeps parallel edges separable. */
const EDGE_GAP = 18;
const SLOT_WIDTH = 56;
const SLOT_HEIGHT = 56;

/**
 * A control edge outweighs a data edge, so the sequence stays the straight line through the drawing
 * and a data edge is what bends around it. Both are laid out; only the emphasis differs, and it
 * matches how the two read — §9.1's implicit chain is the spine of a flow, and a value passed
 * forward three steps is a detour off it.
 */
const EDGE_WEIGHT = { sequence: 4, depends: 4, data: 1 };

/**
 * How close to a box's corner an edge may attach. Endpoints spread along the border rather than
 * meeting at its midpoint — dagre hands back the border intersection, which for a route leaving
 * upward is on the box's *top*, and an arrow arriving at the top of a step reads as coming from the
 * rank above rather than from the one before. Rewriting both ends onto the vertical borders keeps
 * §5.2's promise that the arrow points along the flow, and keeps the fan: eleven edges out of one
 * step leave at eleven heights instead of from one pixel.
 */
const PORT_INSET = 14;

/** How much of a bend is rounded off. Enough to read as a turn, not enough to lose where it turned. */
const CORNER_RADIUS = 12;

/** Below the ranks, off the flow's own axis, so a slot never reads as a step in the sequence. */
const SLOT_LANE_GAP = 40;
const SLOT_ROW_GAP = 20;
/** Horizontal clearance between two glyphs before they are considered to share a row. */
const SLOT_GLYPH_GAP = 24;

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

const round = (value) => Math.round(value * 100) / 100;

/**
 * §5.4: a sub-flow's internals rank within their own flow, starting at 0, so an expanded sub-flow is
 * its own block of columns rather than a continuation of the parent's ranks. Folding the parent's
 * rank in is what puts that block directly after the container's column while leaving both flows'
 * own numbering untouched — and it puts every node in one rank space, which is what the `minlen`
 * constraints need to be expressed in.
 */
const effectiveRanks = (nodes) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ranks = new Map();

  const rankOf = (node, seen) => {
    const cached = ranks.get(node.id);
    if (cached !== undefined) return cached;

    const parent = node.parent && !seen.has(node.parent) ? byId.get(node.parent) : undefined;
    const rank = parent ? rankOf(parent, new Set([...seen, parent.id])) + 1 + node.rank : node.rank;
    ranks.set(node.id, rank);
    return rank;
  };

  nodes.forEach((node) => rankOf(node, new Set([node.id])));
  return ranks;
};

/**
 * A node whose rank is above 0 but which has no edge coming in — its producers are inside a
 * collapsed sub-flow, or the description carries ranks without the edges that earned them. Dagre
 * ranks from edges alone, so without something to hang it from it lands in the first column, on top
 * of the flow's roots.
 *
 * The scaffolding says only what the engine already said: this step is a rank behind that one. It is
 * never drawn, and the node it hangs from is the container for a sub-flow's own root and otherwise
 * the first node of the rank before — file order, so the choice is inspectable rather than incidental.
 */
const anchorEdges = (graph, nodes, edges, ranks) => {
  const connected = new Set(edges.map((edge) => edge.to));
  const firstOfRank = new Map();
  nodes.forEach((node) => {
    const rank = ranks.get(node.id);
    if (!firstOfRank.has(rank)) firstOfRank.set(rank, node.id);
  });

  nodes.forEach((node) => {
    const rank = ranks.get(node.id);
    if (rank === 0 || connected.has(node.id)) return;

    const from = node.parent && graph.hasNode(node.parent) ? node.parent : firstOfRank.get(rank - 1);
    if (!from || from === node.id) return;
    graph.setEdge(from, node.id, { minlen: Math.max(1, rank - ranks.get(from)), weight: 1 }, `anchor:${node.id}`);
  });
};

const edgeKey = (index) => `edge:${index}`;

const runDagre = (nodes, edges, ranks) => {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: 'LR',
    nodesep: SIBLING_GAP,
    ranksep: RANK_GAP,
    edgesep: EDGE_GAP,
    marginx: 0,
    marginy: 0
  });
  graph.setDefaultEdgeLabel(() => ({}));

  // Insertion order is file order, and dagre seeds its ordering pass from it — so where two
  // arrangements cross equally often, the file's own order is the one that survives (§5.2).
  nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge, index) => {
    graph.setEdge(
      edge.from,
      edge.to,
      {
        // The engine's ranks, restated as the layering constraint that reproduces them exactly.
        minlen: Math.max(1, ranks.get(edge.to) - ranks.get(edge.from)),
        weight: EDGE_WEIGHT[edge.kind] || 1
      },
      edgeKey(index)
    );
  });
  anchorEdges(graph, nodes, edges, ranks);

  layout(graph);
  return graph;
};

/**
 * The endpoints, rewritten onto the vertical borders — see `PORT_INSET`. The height each end attaches
 * at is the height the route arrives at, so an edge that travels a lane above the boxes leaves high
 * and arrives high, and two edges between the same pair of steps stay two visible lines.
 */
const withPorts = (points, source, target) => {
  const interior = points.slice(1, -1);
  const towardTarget = interior[0] || { y: target.y + target.height / 2 };
  const towardSource = interior[interior.length - 1] || { y: source.y + source.height / 2 };

  return [
    { x: source.x + source.width, y: clamp(towardTarget.y, source.y + PORT_INSET, source.y + source.height - PORT_INSET) },
    ...interior,
    { x: target.x, y: clamp(towardSource.y, target.y + PORT_INSET, target.y + target.height - PORT_INSET) }
  ];
};

const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * A polyline with its corners rounded off, rather than a spline through the same points.
 *
 * The points are lane centres: the route is *the* fact the drawing has to carry, and a spline that
 * smooths several of them into one sweep is a line that no longer says which lane it took. Cutting
 * each corner by the smaller of a fixed radius and half the shorter leg keeps the straight runs
 * exactly where dagre put them, and never overshoots a segment shorter than the radius.
 */
const pathOf = (points) => {
  const [first] = points;
  let path = `M ${round(first.x)} ${round(first.y)}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const radius = Math.min(CORNER_RADIUS, distance(previous, corner) / 2, distance(corner, next) / 2);

    if (radius < 0.5) continue;

    const enter = {
      x: corner.x + ((previous.x - corner.x) * radius) / distance(previous, corner),
      y: corner.y + ((previous.y - corner.y) * radius) / distance(previous, corner)
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) * radius) / distance(corner, next),
      y: corner.y + ((next.y - corner.y) * radius) / distance(corner, next)
    };

    path += ` L ${round(enter.x)} ${round(enter.y)} Q ${round(corner.x)} ${round(corner.y)} ${round(leave.x)} ${round(leave.y)}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${round(last.x)} ${round(last.y)}`;
};

/**
 * §5.2 and §5.3: the nodes and the edges between them — the control and data edges, both routed,
 * whichever of them the view is currently drawing. A toggle is a view of one drawing rather than a
 * second drawing, so hiding data edges must not move a single box; they stay in the layout and only
 * their rendering is filtered (§5.3).
 *
 * Shared slots are **not** here: they are a layer of their own, laid out by `layoutSlotLane` against
 * the result of this, so turning them on cannot shift a step either.
 */
export const layoutGraph = (description, options = {}) => {
  const expandedSubflows = new Set(options.expandedSubflows || []);
  const nodes = description.nodes.filter((node) => !node.parent || expandedSubflows.has(node.parent));
  const laidOut = new Set(nodes.map((node) => node.id));

  // §5.3: an edge whose endpoints aren't both laid out — a collapsed sub-flow's internals — has no
  // box to anchor to, so it is dropped rather than emitted with a degenerate path.
  const edges = description.edges.filter(
    (edge) => edge.kind !== 'slot-read' && edge.kind !== 'slot-write' && laidOut.has(edge.from) && laidOut.has(edge.to)
  );

  if (!nodes.length) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const ranks = effectiveRanks(nodes);
  const graph = runDagre(nodes, edges, ranks);

  const positioned = nodes.map((node) => {
    const placed = graph.node(node.id);
    return {
      ...node,
      x: placed.x - NODE_WIDTH / 2,
      y: placed.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    };
  });
  const positionedById = new Map(positioned.map((node) => [node.id, node]));

  const routed = edges.map((edge, index) => ({
    ...edge,
    points: withPorts(
      graph.edge(edge.from, edge.to, edgeKey(index)).points,
      positionedById.get(edge.from),
      positionedById.get(edge.to)
    )
  }));

  // A route may travel above the first rank or below the last, so the drawing's extent is measured
  // over the lines as well as the boxes — anything outside it is clipped by the viewBox, and a lane
  // cut off at the top reads as a rendering fault rather than as a margin that is too small.
  const xs = [...positioned.flatMap((node) => [node.x, node.x + node.width]), ...routed.flatMap((edge) => edge.points.map((point) => point.x))];
  const ys = [...positioned.flatMap((node) => [node.y, node.y + node.height]), ...routed.flatMap((edge) => edge.points.map((point) => point.y))];
  const originX = Math.min(...xs);
  const originY = Math.min(...ys);

  positioned.forEach((node) => {
    node.x = round(node.x - originX);
    node.y = round(node.y - originY);
  });

  return {
    nodes: positioned,
    edges: routed.map((edge) => {
      const points = edge.points.map((point) => ({ x: point.x - originX, y: point.y - originY }));
      return { ...edge, points, path: pathOf(points) };
    }),
    width: round(Math.max(...xs) - originX),
    height: round(Math.max(...ys) - originY)
  };
};

/** Where a slot edge meets its step: along the box's bottom border, one lane per edge on that step. */
const SLOT_PORT_GAP = 16;

const slotPortX = (node, index, total) => {
  const spread = Math.min(SLOT_PORT_GAP, (node.width - PORT_INSET * 2) / Math.max(1, total));
  return node.x + node.width / 2 + (index - (total - 1) / 2) * spread;
};

/**
 * A slot edge is drawn vertically out of the step and into the lane: the control and data edges own
 * the horizontal axis, and a line that left a step sideways to reach a glyph under it would read as
 * one more step-to-step relationship.
 */
const slotPath = (from, to) => {
  // Both control points lean toward the other end, so a read — which travels *up* out of the lane
  // into its step — curves the way it runs rather than doubling back through the glyph it left.
  const direction = to.y >= from.y ? 1 : -1;
  const reach = Math.max(24, Math.abs(to.y - from.y) / 2) * direction;
  return `M ${round(from.x)} ${round(from.y)} C ${round(from.x)} ${round(from.y + reach)}, ${round(to.x)} ${round(to.y - reach)}, ${round(to.x)} ${round(to.y)}`;
};

/**
 * §5.3 and §9.1: shared slots, as a layer over the laid-out graph.
 *
 * **Every glyph gets its own place in the lane.** The first version centred each on the span of its
 * participants and drew them all on one line, which on any flow whose slots span it — a session
 * token read by every authenticated step — put four glyphs at one coordinate: a single square where
 * four should be, with 34 edges converging on it. Placement now walks the lane left to right in
 * barycentre order and never lets one glyph start before the last one ended, so slots that want the
 * same spot spread along the lane instead of stacking on it, and only a lane that runs out of room
 * wraps to a second row.
 *
 * **The layer is drawn on demand** (§5.3): all of it, or only the slots the focused step touches.
 * A slot is a relationship between steps that never name each other, which makes it the one thing on
 * this drawing that cannot be traced by following the lines — so it is worth seeing, and worth not
 * seeing all at once.
 *
 * `only` narrows the edges to one step's own without narrowing the glyph, which is what focusing a
 * step asks for: `userAuthToken` on this flow has fourteen participants, and answering *what does
 * this step share* with fourteen lines answers a question nobody asked. The glyph names the rest —
 * every writer and reader is on its hover — so nothing is hidden, only undrawn.
 */
export const layoutSlotLane = (graph, slots, visible, options = {}) => {
  const { only } = options;
  const shown = new Set(visible || []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const wanted = slots
    .filter((slot) => shown.has(slot.name))
    .map((slot) => {
      const participants = [
        ...slot.writers.map((id) => ({ id, kind: 'slot-write' })),
        ...slot.readers.map((id) => ({ id, kind: 'slot-read' }))
      ].filter((participant) => byId.has(participant.id));

      const centers = participants.map((participant) => {
        const node = byId.get(participant.id);
        return node.x + node.width / 2;
      });
      return {
        slot,
        participants,
        // Under the middle of the steps that use it, which is the only thing about a slot's position
        // that carries information — it says where on the drawing this value is being passed around.
        ideal: participants.length ? (Math.min(...centers) + Math.max(...centers)) / 2 - SLOT_WIDTH / 2 : 0
      };
    })
    .filter((entry) => entry.participants.length)
    .sort((left, right) => left.ideal - right.ideal || slots.indexOf(left.slot) - slots.indexOf(right.slot));

  const limit = Math.max(0, graph.width - SLOT_WIDTH);
  const placed = [];
  const connections = [];
  let row = 0;
  let cursor = 0;

  wanted.forEach((entry) => {
    let x = clamp(Math.max(entry.ideal, cursor), 0, limit);
    if (cursor > 0 && x < cursor) {
      row += 1;
      cursor = 0;
      x = clamp(entry.ideal, 0, limit);
    }
    cursor = x + SLOT_WIDTH + SLOT_GLYPH_GAP;

    placed.push({
      ...entry.slot,
      id: `slot:${entry.slot.name}`,
      x: round(x),
      y: round(graph.height + SLOT_LANE_GAP + row * (SLOT_HEIGHT + SLOT_ROW_GAP)),
      width: SLOT_WIDTH,
      height: SLOT_HEIGHT
    });
    entry.participants
      .filter((participant) => !only || participant.id === only)
      .forEach((participant) => connections.push({ ...participant, slot: entry.slot.name }));
  });

  const rows = placed.length ? row + 1 : 0;

  const glyphById = new Map(placed.map((slot) => [slot.name, slot]));
  // How many slot edges each step carries, so its own can be spread along its border rather than
  // stacked on its midpoint — the same fan the routed edges get, on the axis this layer uses.
  const perNode = new Map();
  connections.forEach((connection) => perNode.set(connection.id, (perNode.get(connection.id) || 0) + 1));
  const taken = new Map();

  const edges = connections.map((connection) => {
    const node = byId.get(connection.id);
    const glyph = glyphById.get(connection.slot);
    const index = taken.get(connection.id) || 0;
    taken.set(connection.id, index + 1);

    const port = { x: slotPortX(node, index, perNode.get(connection.id)), y: node.y + node.height };
    const mouth = { x: glyph.x + glyph.width / 2, y: glyph.y };
    const write = connection.kind === 'slot-write';

    return {
      from: write ? connection.id : `slot:${connection.slot}`,
      to: write ? `slot:${connection.slot}` : connection.id,
      kind: connection.kind,
      slot: connection.slot,
      step: connection.id,
      path: write ? slotPath(port, mouth) : slotPath(mouth, port)
    };
  });

  return {
    slots: placed,
    edges,
    height: rows ? SLOT_LANE_GAP + rows * (SLOT_HEIGHT + SLOT_ROW_GAP) - SLOT_ROW_GAP : 0
  };
};
