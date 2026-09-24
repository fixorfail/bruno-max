import React, { useRef, useState } from 'react';
import { RANK_GAP } from '../layout';

/**
 * 005 §5.1, §5.2 — the affordances that make the drawing editable, drawn over it and only while
 * §4 says the graph is editable.
 *
 * Everything here writes to the document through the engine and nothing else; the layer never
 * moves a node or draws one the engine has not described. What it adds is the two controls that
 * mean something at a place on the canvas: a `+` on every sequence edge — the drawing of 001 §9.1's
 * implicit chain, so its midpoint is the one place that means *between these two* — and after the
 * last step, and a delete on the step that is selected.
 *
 * Steps inside an expanded sub-flow are another file's (002 §5.4) and get neither: an edge between
 * two of them is not a place in this document.
 *
 * §5.4's ports are the third control: an out-port on every step's right edge and an in-port on its
 * left, and a drag from one to the other writes the source into the target's `depends:`. A pair the
 * sequence already joins offers no drop — writing `depends: [above]` on a step that already follows
 * `above` implicitly is a no-op diff — and a declared edge carries a control that removes it. A
 * cycle is not refused here: the engine's diagnostic reports it within one describe, and refusing
 * at the port would mean the renderer computing reachability, which 002-C R4 keeps in the engine.
 */

const CONTROL_RADIUS = 9;
const PORT_RADIUS = 6;

/** The middle of a routed edge — the middle waypoint, or halfway between the two middle ones. */
const midpointOf = (points) => {
  const half = points.length / 2;
  if (points.length % 2) {
    return points[Math.floor(half)];
  }
  const [before, after] = [points[half - 1], points[half]];
  return { x: (before.x + after.x) / 2, y: (before.y + after.y) / 2 };
};

/**
 * The step `steps:` lists last — by line, since the description carries each step's position and
 * the file's order is what "after the last step" means. Sub-flow internals are excluded for the
 * reason above.
 */
const lastStepOf = (description) =>
  description.nodes
    .filter((node) => !node.parent)
    .reduce((last, node) => (!last || node.position.line > last.position.line ? node : last), undefined);

/**
 * The step `steps:` lists first, by the same measure. A step spliced before it becomes the one the
 * file's first step implicitly follows (001 §9.1) — "a new first step", without the author writing
 * `depends:` on the step that used to be first.
 */
const firstStepOf = (description) =>
  description.nodes
    .filter((node) => !node.parent)
    .reduce((first, node) => (!first || node.position.line < first.position.line ? node : first), undefined);

/**
 * The controls' marks are drawn, not typed. A `<text>` glyph is centred on the font's em box, and
 * where a `+` or `×` sits inside that box is the font's choice — on every face tried it rode low
 * and to one side of the circle. A pair of strokes has no box; it is centred because its geometry is.
 */
const PlusGlyph = ({ arm }) => <path className="flow-glyph" d={`M ${-arm} 0 H ${arm} M 0 ${-arm} V ${arm}`} />;

const CrossGlyph = ({ arm }) => (
  <path className="flow-glyph" d={`M ${-arm} ${-arm} L ${arm} ${arm} M ${arm} ${-arm} L ${-arm} ${arm}`} />
);

/* The arm is what a glyph reaches from the centre; a diagonal cross of the same arm covers more of
   the circle than a plus, so it is drawn a touch shorter to read as the same weight. */
const CONTROL_ARM = 4;
const CONTROL_CROSS_ARM = 3.25;
const PORT_CROSS_ARM = 2.25;

/** `at` is the place the picker will write to — `{ after }` or `{ before }` a step, in the file's order. */
const InsertControl = ({ x, y, at, onInsertStep }) => (
  <g
    className="flow-insert"
    transform={`translate(${x}, ${y})`}
    role="button"
    tabIndex={0}
    data-testid={at.after === undefined ? `flow-insert-before-${at.before}` : `flow-insert-after-${at.after}`}
    onClick={(event) => {
      event.stopPropagation();
      onInsertStep(at);
    }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onInsertStep(at);
      }
    }}
  >
    <title>{at.after === undefined ? `Add a step before ${at.before}` : `Add a step after ${at.after}`}</title>
    <circle r={CONTROL_RADIUS} />
    <PlusGlyph arm={CONTROL_ARM} />
  </g>
);

/** Where the pointer is, in the drawing's own coordinates — the SVG is scrolled and offset. */
const pointOf = (svg, event) => {
  const matrix = svg.getScreenCTM?.();
  if (!matrix) {
    return undefined;
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
};

/** The in-port under the pointer, if any — the drop target of a connector drag. */
const inPortAt = (event) => {
  if (typeof document.elementFromPoint !== 'function') {
    return undefined;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return target?.closest?.('[data-port-in]')?.getAttribute('data-port-in') || undefined;
};

const EditLayer = ({ graph, description, selectedStep, onInsertStep, onDeleteStep, onConnect, onDisconnect }) => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const topLevel = (id) => byId.has(id) && !byId.get(id).parent;
  // The drag in flight, held in a ref for the handlers — a pointer-up can land in the same task as
  // the pointer-down that started it, before a render has given the handlers the state — and
  // mirrored into state for the preview line, which is the only thing that draws it.
  const dragRef = useRef(null);
  const [drag, setDragState] = useState(null);
  const setDrag = (next) => {
    dragRef.current = next;
    setDragState(next);
  };

  const sequenceEdges = graph.edges.filter((edge) => edge.kind === 'sequence' && topLevel(edge.from) && topLevel(edge.to));
  const declaredEdges = graph.edges.filter((edge) => edge.kind === 'depends' && topLevel(edge.from) && topLevel(edge.to));
  const steps = graph.nodes.filter((node) => !node.parent);
  const last = lastStepOf(description);
  const lastPlaced = last ? byId.get(last.id) : undefined;
  const first = firstStepOf(description);
  const firstPlaced = first ? byId.get(first.id) : undefined;
  const selected = selectedStep && topLevel(selectedStep) ? byId.get(selectedStep) : undefined;

  const joinedBySequence = (from, to) => sequenceEdges.some((edge) => edge.from === from && edge.to === to);
  const canDrop = (from, to) => Boolean(to) && to !== from && !joinedBySequence(from, to);

  const startDrag = (node, event) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = { x: node.x + node.width, y: node.y + node.height / 2 };
    setDrag({ from: node.id, origin, pointer: pointOf(event.currentTarget.ownerSVGElement, event) || origin, over: undefined });
  };
  const moveDrag = (event) => {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const pointer = pointOf(event.currentTarget.ownerSVGElement, event);
    setDrag({ ...current, pointer: pointer || current.pointer, over: inPortAt(event) });
  };
  const endDrag = (event) => {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const to = inPortAt(event);
    setDrag(null);
    if (canDrop(current.from, to)) {
      onConnect({ from: current.from, to });
    }
  };

  return (
    <g className="flow-edit-layer" data-testid="flow-edit-layer">
      {sequenceEdges.map((edge) => {
        const point = midpointOf(edge.points);
        return <InsertControl key={`${edge.from}-${edge.to}`} x={point.x} y={point.y} at={{ after: edge.from }} onInsertStep={onInsertStep} />;
      })}

      {firstPlaced ? (
        <InsertControl x={firstPlaced.x - RANK_GAP / 2} y={firstPlaced.y + firstPlaced.height / 2} at={{ before: firstPlaced.id }} onInsertStep={onInsertStep} />
      ) : null}

      {lastPlaced ? (
        <InsertControl
          x={lastPlaced.x + lastPlaced.width + RANK_GAP / 2}
          y={lastPlaced.y + lastPlaced.height / 2}
          at={{ after: lastPlaced.id }}
          onInsertStep={onInsertStep}
        />
      ) : null}

      {steps.map((node) => (
        <g key={node.id} className="flow-ports">
          <circle
            className={`flow-port flow-port-in${drag && drag.over === node.id && canDrop(drag.from, node.id) ? ' is-target' : ''}`}
            cx={node.x}
            cy={node.y + node.height / 2}
            r={PORT_RADIUS}
            data-port-in={node.id}
            data-testid={`flow-port-in-${node.id}`}
          >
            <title>{`${node.id} depends on… — drop a connector here`}</title>
          </circle>
          <circle
            className="flow-port flow-port-out"
            cx={node.x + node.width}
            cy={node.y + node.height / 2}
            r={PORT_RADIUS}
            data-testid={`flow-port-out-${node.id}`}
            onPointerDown={(event) => startDrag(node, event)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={() => setDrag(null)}
          >
            <title>{`Drag to a step that should depend on ${node.id}`}</title>
          </circle>
        </g>
      ))}

      {drag ? (
        <line
          className="flow-connector-preview"
          x1={drag.origin.x}
          y1={drag.origin.y}
          x2={drag.pointer.x}
          y2={drag.pointer.y}
          data-testid="flow-connector-preview"
        />
      ) : null}

      {declaredEdges.map((edge) => {
        const point = midpointOf(edge.points);
        return (
          <g
            key={`remove-${edge.from}-${edge.to}`}
            className="flow-edge-remove"
            transform={`translate(${point.x}, ${point.y})`}
            role="button"
            tabIndex={0}
            data-testid={`flow-edge-remove-${edge.from}-${edge.to}`}
            onClick={(event) => {
              event.stopPropagation();
              onDisconnect({ from: edge.from, to: edge.to });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onDisconnect({ from: edge.from, to: edge.to });
              }
            }}
          >
            <title>{`Remove ${edge.to}'s dependency on ${edge.from}`}</title>
            <circle r={PORT_RADIUS} />
            <CrossGlyph arm={PORT_CROSS_ARM} />
          </g>
        );
      })}

      {selected ? (
        <g
          className="flow-delete"
          transform={`translate(${selected.x + selected.width}, ${selected.y})`}
          role="button"
          tabIndex={0}
          data-testid={`flow-delete-${selected.id}`}
          /* The node under this control is the selected one, and a click here is not a statement
             about the selection — stopping it is what keeps the delete from also deselecting. */
          onClick={(event) => {
            event.stopPropagation();
            onDeleteStep(selected.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onDeleteStep(selected.id);
            }
          }}
        >
          <title>{`Remove ${selected.id}`}</title>
          <circle r={CONTROL_RADIUS} />
          <CrossGlyph arm={CONTROL_CROSS_ARM} />
        </g>
      ) : null}
    </g>
  );
};

export default EditLayer;
