/**
 * Turns a `FlowDescription` (002 §11.1) into screen coordinates. `rank` is the engine's; pixels are
 * the renderer's — this module never recomputes ranking or topologically sorts, it only lays out
 * the ranks and declaration order `describeFlow` already resolved.
 */

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;
const RANK_GAP = 56;
const COLUMN_GAP = 32;
const SLOT_WIDTH = 56;
const SLOT_HEIGHT = 56;

// §5.2: order within a rank is declaration order in `nodes`, which is file order (§11.1). Grouping
// by walking the array in order and pushing into per-rank buckets preserves that order without ever
// sorting by id or any run-derived value.
const groupByRank = (nodes) => {
  const byRank = new Map();
  nodes.forEach((node) => {
    const bucket = byRank.get(node.rank);
    if (bucket) {
      bucket.push(node);
    } else {
      byRank.set(node.rank, [node]);
    }
  });
  return [...byRank.keys()].sort((a, b) => a - b).map((rank) => byRank.get(rank));
};

// §5.4: a sub-flow's internals rank within their own flow, starting at 0, so an expanded sub-flow is
// its own block of rows rather than a continuation of the parent's ranks. Inserting that block right
// after the parent's row is what "positioned beneath their parent node" means for a row-based layout.
const buildRows = (nodes, expandedSubflows) => {
  const topLevelNodes = nodes.filter((node) => !node.parent);
  const rows = [];

  groupByRank(topLevelNodes).forEach((rankNodes) => {
    rows.push(rankNodes);
    rankNodes.forEach((node) => {
      if (!expandedSubflows.has(node.id)) {
        return;
      }
      const internalNodes = nodes.filter((candidate) => candidate.parent === node.id);
      groupByRank(internalNodes).forEach((internalRankNodes) => rows.push(internalRankNodes));
    });
  });

  return rows;
};

const rowWidth = (nodeCount) => nodeCount * NODE_WIDTH + Math.max(0, nodeCount - 1) * COLUMN_GAP;

const placeRows = (rows) => {
  const contentWidth = Math.max(0, ...rows.map((row) => rowWidth(row.length)));
  const positioned = [];
  const positionedById = new Map();

  rows.forEach((rowNodes, rowIndex) => {
    const y = rowIndex * (NODE_HEIGHT + RANK_GAP);
    const startX = (contentWidth - rowWidth(rowNodes.length)) / 2;
    rowNodes.forEach((node, columnIndex) => {
      const x = startX + columnIndex * (NODE_WIDTH + COLUMN_GAP);
      const positionedNode = { ...node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT };
      positioned.push(positionedNode);
      positionedById.set(node.id, positionedNode);
    });
  });

  return { positioned, positionedById, contentWidth };
};

// A cubic bezier from the bottom-center of one box to the top-center of another — §5's edges connect
// step boxes this way, and the same anchor works for a slot glyph since it is laid out as a box too.
const pathBetween = (from, to) => {
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const controlY = (startY + endY) / 2;
  return `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`;
};

// §5.3: an edge whose endpoints aren't both laid out — a collapsed sub-flow's internals — would draw
// with no box to anchor to, so it is dropped rather than emitted with a degenerate path.
const layoutEdges = (edges, positionedById) => edges
  .filter((edge) => positionedById.has(edge.from) && positionedById.has(edge.to))
  .map((edge) => ({ ...edge, path: pathBetween(positionedById.get(edge.from), positionedById.get(edge.to)) }));

// §5.3, §9.1: a slot has no producer/consumer relationship to draw, so it gets its own glyph and
// `slot-write` / `slot-read` edges to and from it — never a writer-to-reader edge. Writers or readers
// that live inside a collapsed sub-flow are skipped the same way a dangling node-to-node edge is.
const layoutSlots = (slots, positionedById, contentWidth) => {
  const slotNodes = [];
  const slotEdges = [];
  const slotX = contentWidth + COLUMN_GAP;

  slots.forEach((slot) => {
    const participants = [...slot.writers, ...slot.readers]
      .map((id) => positionedById.get(id))
      .filter((node) => node !== undefined);
    if (participants.length === 0) {
      return;
    }

    const centers = participants.map((node) => node.y + node.height / 2);
    const slotY = (Math.min(...centers) + Math.max(...centers)) / 2 - SLOT_HEIGHT / 2;
    const slotNode = { ...slot, id: `slot:${slot.name}`, x: slotX, y: slotY, width: SLOT_WIDTH, height: SLOT_HEIGHT };
    slotNodes.push(slotNode);

    slot.writers.forEach((writerId) => {
      const writer = positionedById.get(writerId);
      if (writer) {
        slotEdges.push({
          from: writerId,
          to: `slot:${slot.name}`,
          kind: 'slot-write',
          slot: slot.name,
          path: pathBetween(writer, slotNode)
        });
      }
    });
    slot.readers.forEach((readerId) => {
      const reader = positionedById.get(readerId);
      if (reader) {
        slotEdges.push({
          from: `slot:${slot.name}`,
          to: readerId,
          kind: 'slot-read',
          slot: slot.name,
          path: pathBetween(slotNode, reader)
        });
      }
    });
  });

  return { slotNodes, slotEdges };
};

export const layoutGraph = (description, options = {}) => {
  const expandedSubflows = new Set(options.expandedSubflows || []);
  const rows = buildRows(description.nodes, expandedSubflows);
  const { positioned, positionedById, contentWidth } = placeRows(rows);

  const { slotNodes, slotEdges } = layoutSlots(description.slots, positionedById, contentWidth);
  const edges = [...layoutEdges(description.edges, positionedById), ...slotEdges];

  const rowsHeight = rows.length > 0 ? rows.length * NODE_HEIGHT + (rows.length - 1) * RANK_GAP : 0;
  const slotsExtent = Math.max(0, ...slotNodes.map((slot) => slot.y + slot.height));
  const width = contentWidth + (slotNodes.length > 0 ? COLUMN_GAP + SLOT_WIDTH : 0);
  const height = Math.max(rowsHeight, slotsExtent);

  return { nodes: positioned, edges, slots: slotNodes, width, height };
};
