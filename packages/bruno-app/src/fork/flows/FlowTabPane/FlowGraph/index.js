import React, { useMemo, useRef, useState } from 'react';
import { useTheme } from 'styled-components';
import { NODE_FOOTER_HEIGHT, layoutGraph, layoutInputsPanel, layoutSlotLane, layoutStages } from './layout';
import { assignApiColors } from './apiColors';
import { assignSubflowColors } from './subflowColors';
import { useFollowActiveNode } from './follow';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §5 — the graph, as hand-rolled inline SVG.
 *
 * Nothing here computes flow semantics: `describeFlow` supplies nodes, edges and ranks, `layout.js`
 * turns ranks into coordinates, and the run's node states come from `FlowEvent`s. §13 records what
 * declining a graph library trades away.
 */

/** §5.1's markers, each shown only when the step carries the thing it marks. */
const markersFor = (node) => {
  const markers = [];
  if (node.markers.conditional) markers.push({ key: 'when', glyph: 'when', title: 'Conditional (when:)' });
  if (node.markers.retryMaxAttempts) {
    markers.push({ key: 'retry', glyph: `↻ ${node.markers.retryMaxAttempts}`, title: 'Retries' });
  }
  // The word the file wrote, the way `when` is. A sub-flow was marked `⊂` — the subset sign, which
  // is a symbol for a relationship nobody draws that way and had to be learned from the tooltip.
  // There is no conventional glyph for "this step is another flow", so the key that declares it is
  // the most recognisable thing available, and it is already what an author searches the file for.
  if (node.kind === 'subflow') markers.push({ key: 'subflow', glyph: 'uses', title: 'Sub-flow (uses:)' });
  // A step that passes on a 403 is otherwise indistinguishable from one that passes on a 200, and
  // mistaking the first for the second is how a broken authorization check reads as green (§5.1).
  if (node.markers.allowsErrorStatus) markers.push({ key: 'negative', glyph: '!', title: 'Negative test' });
  if (node.markers.usesSharedSlot) markers.push({ key: 'slot', glyph: '⌸', title: 'Uses a shared slot' });
  return markers;
};

/**
 * §5.3: five drawing treatments over four `kind` values. A status-conditioned edge is a `depends`
 * edge with a non-empty `status`, and switching on `kind` alone would draw it as an ordinary one —
 * which is the mistake 002-C U1.3 exists to catch.
 */
const edgeClassName = (edge) => {
  if (edge.kind === 'slot-read' || edge.kind === 'slot-write') return 'edge edge-slot';
  if (edge.kind === 'data') return edge.declared === false ? 'edge edge-data edge-undeclared' : 'edge edge-data';
  if (edge.status && edge.status.length) return 'edge edge-conditional';
  return edge.kind === 'sequence' ? 'edge edge-sequence' : 'edge edge-depends';
};

const edgeLabel = (edge) => {
  if (edge.kind === 'data') return edge.output;
  if (edge.status && edge.status.length) return `[${edge.status.join(', ')}]`;
  return undefined;
};

/**
 * Which line above the path each label sits on.
 *
 * **Two steps can be joined by more than one edge**, and every edge between one pair runs the same
 * path: 001 §8.1 draws a connector per output, so a step consuming two of a producer's values has
 * two, and a status-conditioned `depends` can sit under a data edge as well. Placed identically they
 * land on top of each other and read as one unreadable label rather than as two values.
 *
 * They stack rather than spreading along the path, because the path is short, shared, and shrinks
 * with the layout — labels spread along one would drift over the nodes at either end and over each
 * other again on the next flow. A stack grows in the one direction the drawing has room in, and each
 * label stays its own element, with its own mark and its own hover (§5.3).
 *
 * Rows are counted over the edges actually being drawn, so hiding data edges closes the gaps rather
 * than leaving a `[failed]` floating a line above where it belongs.
 */
const LABEL_BASELINE = -4;
const LABEL_ROW = -11;

const labelRows = (edges) => {
  const taken = new Map();

  return edges.map((edge) => {
    if (!edgeLabel(edge)) {
      return 0;
    }
    const pair = `${edge.from}->${edge.to}`;
    const row = taken.get(pair) || 0;
    taken.set(pair, row + 1);
    return row;
  });
};

/**
 * The mark hangs to the *left* of the label rather than being prefixed to it.
 *
 * A label is laid out from the midpoint of its edge and runs rightward, so a prefix pushes the name
 * it identifies away from the edge it belongs to and toward the node it points at. Stepping back by
 * the mark's own advance and returning a hair of it as a gap leaves the name where an unmarked one
 * sits, with the mark in the space before it. The two are the mark's width at `.edge-label`'s font
 * size — a measurement is not available before layout, and being a pixel out here costs nothing.
 */
const MARK_OFFSET = -13;
const MARK_GAP = 3;

const TERMINAL_STATES = new Set(['success', 'failed', 'skipped', 'cancelled']);

/**
 * The room around the drawing, which the halo of a step in the first column or the top row bleeds
 * into: the ring stands `HALO_PAD` off the box, its stroke half a unit further, and the bloom
 * further again. Anything past the viewBox is clipped, and a glow clipped down one side looks like
 * a rendering fault rather than a margin that is too small.
 */
const GRAPH_MARGIN = 16;

/**
 * How far §5.4's band stands off the sub-flow it encloses. Far enough to read as a region the boxes
 * sit inside rather than as an outline drawn on them, and inside `GRAPH_MARGIN` — a sub-flow on the
 * top row or in the first column stands as close to the edge of the drawing as anything does, and
 * the extent the viewBox is cut to is measured over the boxes and the lines, not over this.
 */
const BAND_PAD = 12;

/** The open container's own ring, just clear of its box — the same statement as the band. */
const RING_PAD = 4;

/**
 * §5.1: the strip down the left edge of a step that computes values before its request (001 §8.7).
 *
 * A marker on the footer bar says *that* a step has something; this says it at a glance across a
 * whole graph, which is what a reader scanning for where a signature is built actually does. It is
 * the one fact on the box that changes what the step **sends**, and the footer is already the busiest
 * part of it.
 *
 * `NODE_BOX_RADIUS` matches the box's own `rx`, so the strip's left corners follow the box rather
 * than poking out of it — the right edge stays square because it meets the box's fill, not its edge.
 */
const PRE_STRIP_WIDTH = 6;
const NODE_BOX_RADIUS = 4;

const preStripPath = (height) =>
  `M ${NODE_BOX_RADIUS},0`
  + ` H ${PRE_STRIP_WIDTH} V ${height} H ${NODE_BOX_RADIUS}`
  + ` A ${NODE_BOX_RADIUS},${NODE_BOX_RADIUS} 0 0 1 0,${height - NODE_BOX_RADIUS}`
  + ` V ${NODE_BOX_RADIUS}`
  + ` A ${NODE_BOX_RADIUS},${NODE_BOX_RADIUS} 0 0 1 ${NODE_BOX_RADIUS},0 Z`;

/**
 * Where §5.4's expansion hint sits below its node: clear of the box, and inside both the 32px gap
 * between siblings and the margin the viewBox leaves around the drawing, so it never lands on the
 * step below it or gets clipped off the bottom rank.
 */
const NODE_HINT_OFFSET = 12;

/**
 * §5.5's stage names sit in a strip of their own above the drawing, added to the viewBox only when
 * there are stages to name. `GRAPH_MARGIN` is already spoken for — a running step in the top row
 * blooms into it — so a name written there would be read through the halo of whichever step
 * happened to be executing.
 */
const STAGE_BAND = 20;
const STAGE_LABEL_BASELINE = -(GRAPH_MARGIN + 4);

/**
 * The footer's outline. It cannot be a plain rect: the box is rounded, and a square strip laid along
 * its foot puts two corners outside the border it is supposed to sit inside — which reads as a
 * rendering fault at every node rather than as a bar. The radius is the box's own.
 */
const NODE_RADIUS = 4;

const footerPath = (node) => {
  const top = node.height - NODE_FOOTER_HEIGHT;
  return [
    `M 0 ${top}`,
    `H ${node.width}`,
    `V ${node.height - NODE_RADIUS}`,
    `A ${NODE_RADIUS} ${NODE_RADIUS} 0 0 1 ${node.width - NODE_RADIUS} ${node.height}`,
    `H ${NODE_RADIUS}`,
    `A ${NODE_RADIUS} ${NODE_RADIUS} 0 0 1 0 ${node.height - NODE_RADIUS}`,
    'Z'
  ].join(' ');
};

/**
 * §8.2's two pre-terminal states, **while the run they belong to is still going**.
 *
 * A node's state is the last thing the engine said about that step, and a step that announced
 * `step:start` and never announced its end leaves it at `running` — which is true of the report and
 * false about the world the moment the run ends. Nothing is invented to cover that: the run's own
 * terminal state is the engine's answer to *is anything still in flight*, and it is the one the
 * marker asks. The node keeps the status it was given, and 002-C R6 stays satisfied.
 */
const IN_FLIGHT_STATES = new Set(['running', 'retrying']);

const isInFlight = (state, running) => running && IN_FLIGHT_STATES.has(state?.state);

/**
 * The halo around a step that is executing — §8.2's animated border, drawn as a light travelling
 * around the box.
 *
 * It is a ring of its own rather than the box's own stroke because it glows: a blur on the box would
 * blur its fill and its text with it. The dash travels by animating the offset over exactly the
 * outline's own length, which is what makes each lap continuous — an offset that covered any other
 * distance would jump where the keyframes wrap, once per turn, which reads as a stutter rather than
 * as a spin. The length is measured off the node rather than assumed, so a change to the box's size
 * cannot leave the seam behind.
 *
 * **The lap length carries `px`, and that is load-bearing.** `stroke-dashoffset` takes a
 * `<length-percentage>`, so a `calc()` over a unitless custom property is invalid there and the
 * browser drops the keyframe without a word — leaving the dash parked at the start of the path,
 * which on a rectangle is a solid line along its top edge and no motion at all. That reads as a
 * styling choice rather than as a broken animation, which is what makes it worth stating here. In
 * SVG user space `px` *is* the user unit, so carrying one changes nothing but validity.
 */
const HALO_PAD = 5;
const HALO_RADIUS = 8;
/** Lit fraction of the outline — enough arc to read as one travelling light, not a moving border. */
const HALO_LIT = 0.3;

const haloOutline = (node) => {
  const width = node.width + HALO_PAD * 2;
  const height = node.height + HALO_PAD * 2;
  // The four straight runs, plus the one circle the four rounded corners describe between them.
  return 2 * (width - 2 * HALO_RADIUS) + 2 * (height - 2 * HALO_RADIUS) + 2 * Math.PI * HALO_RADIUS;
};

/**
 * The pattern is an attribute and the lap length is a custom property, which is the same decision
 * made from both sides: unitless numbers are unambiguously valid in an SVG attribute, and a length
 * is what `stroke-dashoffset` requires of the keyframe that reads the property.
 */
const haloProps = (node) => {
  const outline = haloOutline(node);
  return {
    strokeDasharray: `${outline * HALO_LIT} ${outline * (1 - HALO_LIT)}`,
    style: { '--halo-outline': `${outline}px` }
  };
};

/**
 * §5.3: the data edge whose value never arrived — the one 001 §11.2 skips the consumer for, and
 * §8.2's case where the run is red and every node it drew is green or grey.
 *
 * **The run's own verdict is what marks it, not this component's reading of the graph.** The consumer
 * reporting `unresolved-dependency` is the engine saying its references went unproduced; the producer
 * is then asked which of *its* outputs is missing, because a step referencing two values that failed
 * on one must not paint both edges. Both halves are facts the run reported (001 §8.1 makes an absent
 * key the definition of "not produced"), so nothing here decides what a flow means.
 */
const isUnproduced = (edge, nodeStates) => {
  if (edge.kind !== 'data' || nodeStates[edge.to]?.reason !== 'unresolved-dependency') {
    return false;
  }

  const producer = nodeStates[edge.from];
  // A run stored before outputs were recorded reports none rather than an empty set, and "we were
  // not told" is not "it was never produced".
  if (!producer || !TERMINAL_STATES.has(producer.state) || !producer.outputs) {
    return false;
  }
  return producer.outputs[edge.output] === undefined;
};

/**
 * A structured output is a whole response fragment (001 §8.1), and a tooltip is not a viewer: past
 * the point where a glance answers "which value went down this edge", §9's pane is where to read it.
 */
const VALUE_PREVIEW_LIMIT = 200;

const preview = (value) => {
  const text = JSON.stringify(value);
  return text.length > VALUE_PREVIEW_LIMIT ? `${text.slice(0, VALUE_PREVIEW_LIMIT)}…` : text;
};

/**
 * §5.3: what a data edge says on hover once a run is on the graph.
 *
 * The edge names the connector and the drawing says a value moved along it; the value itself is
 * otherwise only in §9's pane, behind selecting the producing step and opening a tab. Reading a
 * graph is following values between steps, and this is that question answered where it is asked —
 * without giving the labels room for a value that could be a whole response fragment.
 *
 * The edge that never carried one says so instead, in the consumer's own words (001 §14.6) rather
 * than in a second wording here: the pane, the node's hover and this must not drift apart.
 */
const dataEdgeTitle = (edge, nodeStates, unproduced) => {
  if (edge.kind !== 'data') {
    return undefined;
  }
  if (unproduced) {
    return nodeStates[edge.to].message;
  }

  const producer = nodeStates[edge.from];
  // Before the producing step ends there is no value to show, and no claim to make about one.
  if (!producer || !TERMINAL_STATES.has(producer.state) || !producer.outputs) {
    return undefined;
  }
  const value = producer.outputs[edge.output];
  return value === undefined ? undefined : `${edge.output} = ${preview(value)}`;
};

/**
 * §5.3: which slots a step touches. A slot is the one relationship on this drawing that cannot be
 * traced by following the lines — 001 §9.1 has it name no producer — so the step being read brings
 * its own along, whether or not the whole layer is on.
 */
const slotsOf = (slots, stepId) =>
  slots.filter((slot) => slot.writers.includes(stepId) || slot.readers.includes(stepId)).map((slot) => slot.name);

const FlowGraph = ({
  description,
  nodeStates,
  diagnostics,
  selectedStep,
  expandedSubflows,
  onSelectStep,
  onToggleSubflow,
  showDataEdges,
  showSlotEdges,
  running,
  /**
   * 002 §5.6. `paramValues` is what the boxes hold; `onParamChange` is absent when the tab is
   * showing a stored run, and its absence is what makes the panel read-only — a run's inputs are a
   * fact about that run, and a box you can type in says the opposite.
   */
  paramValues,
  varValues,
  onParamChange
}) => {
  const graph = useMemo(
    () => layoutGraph(description, { expandedSubflows }),
    [description, expandedSubflows]
  );

  /**
   * §5.1: a colour per `apis:` binding — the one the file declares (001 §6.2) where there is one, and
   * otherwise assigned, and assigned only where there is a second binding for it to distinguish from.
   * The theme's own mode picks the step of an assigned colour, because a palette chosen for one
   * surface is unreadable on the other; a declared colour is the author's on both.
   */
  const theme = useTheme();
  const apiColors = useMemo(
    () => assignApiColors(graph.nodes, theme.mode, description.apis),
    [graph.nodes, theme.mode, description.apis]
  );

  /**
   * §5.4: the colour each `uses:` step wears while it is open — on its own ring, and on the band
   * behind the steps it drew. Taken from the description rather than from the laid-out graph, so a
   * container's colour does not depend on which of them happen to be expanded.
   */
  const subflowColors = useMemo(
    () => assignSubflowColors(description.nodes, theme.mode),
    [description.nodes, theme.mode]
  );

  /**
   * The region an expanded sub-flow occupies: the box around every step it contributed, which are
   * exactly the nodes namespaced under it (001 §13.2). Nested sub-flows nest here too, and the
   * larger band is drawn first so the one inside it stays legible.
   */
  const bands = useMemo(
    () =>
      expandedSubflows
        .map((id) => {
          const inside = graph.nodes.filter((node) => node.id.startsWith(`${id}/`));
          if (!inside.length) {
            return null;
          }

          const x = Math.min(...inside.map((node) => node.x)) - BAND_PAD;
          const y = Math.min(...inside.map((node) => node.y)) - BAND_PAD;
          return {
            id,
            x,
            y,
            width: Math.max(...inside.map((node) => node.x + node.width)) + BAND_PAD - x,
            height: Math.max(...inside.map((node) => node.y + node.height)) + BAND_PAD - y,
            color: subflowColors.get(id)
          };
        })
        .filter(Boolean)
        .sort((first, second) => second.width * second.height - first.width * first.height),
    [graph.nodes, expandedSubflows, subflowColors]
  );

  /**
   * §5.5: where each stage's region begins. The engine resolved which boundaries can be drawn and
   * dropped the rest with a warning (001 §5.5), so a stage arriving here is one this drawing can
   * state truthfully.
   */
  const stages = useMemo(() => layoutStages(graph, description.stages), [graph, description.stages]);

  /**
   * §5.3's focus: what the pointer is over, or failing that what §9's pane is reading. Hover is the
   * cheaper of the two questions — it costs nothing to ask and nothing to undo — and it is the one a
   * reader asks of a drawing this size, edge by edge, without wanting to change what the pane below
   * is showing.
   */
  const [hoveredStep, setHoveredStep] = useState(null);
  const focusedStep = (hoveredStep && graph.nodes.some((node) => node.id === hoveredStep) ? hoveredStep : null) || selectedStep;

  const visibleSlots = useMemo(
    () => (showSlotEdges ? description.slots.map((slot) => slot.name) : focusedStep ? slotsOf(description.slots, focusedStep) : []),
    [description.slots, showSlotEdges, focusedStep]
  );
  const lane = useMemo(
    // With the layer off, the slots on screen are the focused step's and so are the edges: the glyph
    // is there to say what the value is called and who else touches it, not to draw all of them.
    () => layoutSlotLane(graph, description.slots, visibleSlots, { only: showSlotEdges ? undefined : focusedStep }),
    [graph, description.slots, visibleSlots, showSlotEdges, focusedStep]
  );

  const badgedSteps = useMemo(() => {
    const byStep = {};
    for (const diagnostic of diagnostics) {
      if (diagnostic.stepId) {
        byStep[diagnostic.stepId] = diagnostic.severity === 'error' ? 'error' : byStep[diagnostic.stepId] || 'warning';
      }
    }
    return byStep;
  }, [diagnostics]);

  const edges = [...(showDataEdges ? graph.edges : graph.edges.filter((edge) => edge.kind !== 'data')), ...lane.edges];
  const rows = labelRows(edges);

  /**
   * §5.3: with the focus on, everything not touching the focused step recedes rather than
   * disappearing. Removing it would answer a different question — the drawing would stop saying how
   * much else is going on — and the thing being asked is *which of these lines is mine*.
   *
   * A step's neighbours stay lit with it, because an edge is a statement about both of its ends: a
   * lit line into a dimmed box says the value went somewhere but not where.
   */
  const litEdge = (edge) => !focusedStep || edge.from === focusedStep || edge.to === focusedStep;
  const lit = new Set(focusedStep ? [focusedStep] : []);
  if (focusedStep) {
    edges.filter(litEdge).forEach((edge) => {
      lit.add(edge.from);
      lit.add(edge.to);
    });
  }
  const litNode = (id) => !focusedStep || lit.has(id);

  const height = graph.height + lane.height;
  const band = stages.length ? STAGE_BAND : 0;
  /**
   * §10 draws a stored run from the description *that run* recorded, and one written before §5.6
   * carries neither list — so these are defaulted rather than read straight off the description.
   * The panel is then simply absent for an old run, which is the truth about it.
   */
  const inputParams = description.params || [];
  const inputVars = description.vars || [];
  const inputs = layoutInputsPanel(graph, { params: inputParams, vars: inputVars });
  // The gutter the panel claims, added to the drawing's extent the way the slot lane adds to its
  // height — the viewBox starts further left rather than the graph being shifted right. The panel
  // sits at a negative x, so the room it needs is exactly how far left it starts.
  const gutter = inputs ? -inputs.x : 0;

  /**
   * The drawing scrolls inside this box (§5.2), so the run walks off the edge of it on any flow
   * longer than the tab is wide — `follow.js` is what keeps the step in flight in view while nobody
   * has said they are reading a different one. The ids are taken off the laid-out nodes rather than
   * off `nodeStates`, so the order they arrive in is the order they are drawn in.
   */
  const viewportRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const inFlight = graph.nodes.filter((node) => isInFlight(nodeStates[node.id], running)).map((node) => node.id);

  useFollowActiveNode({ containerRef: viewportRef, nodeRefs, inFlight, enabled: !selectedStep });

  return (
    <StyledWrapper>
      {/**
        * §5.1's legend, over the drawing rather than inside it. The graph is far wider than its box
        * and scrolls (§5.2), so a key drawn into the picture is one that is off-screen for all but
        * the first rank — which is the state a legend exists to prevent. Outside the scrolling box it
        * stays where it was put.
        *
        * It is drawn for a single binding too, where it has no colour to explain: which service a
        * flow drives is a question every one of these graphs is asked, and the operation line answers
        * it with a path that names no host.
        */}
      {apiColors.size ? (
        <div className="flow-legend" data-testid="flow-legend">
          <span className="flow-legend-title">API</span>
          {[...apiColors].map(([api, color]) => (
            <span key={api} className="flow-legend-entry">
              {/* No swatch where there is no tint — a flow calling one service, or a binding past the
                  palette. A chip in the key that no bar on the drawing wears is a colour the reader
                  goes looking for. */}
              {color ? <span className="flow-legend-swatch" style={{ background: color }} /> : null}
              {api}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flow-graph-viewport" ref={viewportRef} data-testid="flow-graph-viewport">
        <svg
          className="flow-graph"
          viewBox={`${-GRAPH_MARGIN - gutter} ${-GRAPH_MARGIN - band} ${graph.width + gutter + GRAPH_MARGIN * 2} ${Math.max(height, inputs?.height || 0) + GRAPH_MARGIN * 2 + band}`}
          width={graph.width + gutter + GRAPH_MARGIN * 2}
          height={Math.max(height, inputs?.height || 0) + GRAPH_MARGIN * 2 + band}
          data-focus={focusedStep || undefined}
          data-testid="flow-graph"
        >
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>

          {/* 002 §5.6: what the run starts from, in the gutter to the left of rank 0. Editable while
              the tab shows the flow as it stands; a record of values once it shows a stored run. */}
          {inputs ? (
            <g className="flow-inputs" transform={`translate(${inputs.x}, ${inputs.y})`} data-testid="flow-inputs">
              <rect className="inputs-box" width={inputs.width} height={inputs.height} rx="4" />
              <foreignObject x="0" y="0" width={inputs.width} height={inputs.height}>
                <div className="inputs-body" xmlns="http://www.w3.org/1999/xhtml">
                  <div className="inputs-title">{onParamChange ? 'Inputs' : 'Inputs · as run'}</div>

                  {inputParams.length ? (
                    <div className="inputs-section">
                      <div className="inputs-section-label">Params</div>
                      {inputParams.map((param) => (
                        <label className="inputs-row" key={param.name}>
                          <span className="inputs-name">
                            {param.name}
                            {param.required ? <span className="inputs-required">*</span> : null}
                          </span>
                          {onParamChange ? (
                            <input
                              type={param.secret ? 'password' : 'text'}
                              className="inputs-input"
                              data-testid={`flow-input-${param.name}`}
                              value={paramValues?.[param.name] ?? ''}
                              placeholder={param.default === undefined ? '' : String(param.default)}
                              onChange={(event) => onParamChange(param.name, event.target.value)}
                            />
                          ) : (
                            /* A run that predates the record says so rather than showing an empty
                               box, which would read as "nothing was supplied". */
                            <span className="inputs-value" data-testid={`flow-input-${param.name}`}>
                              {paramValues === undefined
                                ? 'not recorded'
                                : paramValues[param.name] === undefined
                                  ? '—'
                                  : String(paramValues[param.name])}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  ) : null}

                  {/* §7.3 resolves `vars:` per iteration, so what is shown is the expression the
                      file declares — the same thing in both modes, and what an author would edit. */}
                  {inputVars.length ? (
                    <div className="inputs-section">
                      <div className="inputs-section-label">Vars</div>
                      {inputVars.map((entry) => (
                        <div className="inputs-row" key={entry.name}>
                          <span className="inputs-name">{entry.name}</span>
                          {/* The value this run resolved where there is one, and the expression
                              otherwise: `{{$guid}}` is the interesting thing about a flow that has
                              not run and the least interesting thing about one that has. The
                              expression stays reachable as the title. */}
                          <span
                            className="inputs-value"
                            title={entry.expression}
                            data-testid={`flow-var-${entry.name}`}
                          >
                            {varValues && entry.name in varValues
                              ? String(varValues[entry.name])
                              : entry.expression}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </foreignObject>
            </g>
          ) : null}

          {/* §5.5: the rule down the gap before a stage's first column, and the stage's name in the
              strip above it. Behind everything, because it divides the drawing rather than being
              part of it — and the line stops at the foot of the boxes: the slot lane below is a
              layer over the whole graph (§5.3), not a rank of it to be cut up. */}
          {stages.map((stage) => (
            <g key={`stage-${stage.name}`} className="stage" data-testid={`flow-stage-${stage.name}`}>
              {stage.rule === undefined ? null : (
                <line
                  className="stage-rule"
                  x1={stage.rule}
                  y1={-GRAPH_MARGIN}
                  x2={stage.rule}
                  y2={graph.height}
                  data-testid={`flow-stage-rule-${stage.name}`}
                />
              )}
              <text className="stage-label" x={stage.labelX} y={STAGE_LABEL_BASELINE}>
                {stage.name}
              </text>
            </g>
          ))}

          {/* Behind the edges and the boxes: the band is the ground the sub-flow stands on, and a
              wash drawn over a line would take the line's colour with it. */}
          {bands.map((band) => (
            <rect
              key={`band-${band.id}`}
              className={`subflow-band${band.color ? '' : ' uncoloured'}`}
              x={band.x}
              y={band.y}
              width={band.width}
              height={band.height}
              rx="8"
              fill={band.color}
              stroke={band.color}
              data-testid={`flow-subflow-band-${band.id}`}
            />
          ))}

          {edges.map((edge, index) => {
            const label = edgeLabel(edge);
            const unproduced = isUnproduced(edge, nodeStates);
            const title = dataEdgeTitle(edge, nodeStates, unproduced);
            return (
              <g
                key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
                className={`${edgeClassName(edge)}${unproduced ? ' edge-unproduced' : ''}${litEdge(edge) ? '' : ' dimmed'}`}
                data-testid={
                  edge.slot ? `flow-edge-${edge.kind}-${edge.slot}-${edge.step}` : `flow-edge-${edge.kind}-${edge.from}-${edge.to}`
                }
              >
                {/* The value that travelled along the edge, or why none did. On the group rather than
                  on the label, so the path answers for itself too. */}
                {title ? <title>{title}</title> : null}
                <path d={edge.path} markerEnd="url(#flow-arrow)" />
                {label ? (
                  <text className="edge-label" dy={LABEL_BASELINE + rows[index] * LABEL_ROW}>
                    <textPath href={`#edge-path-${index}`} startOffset="50%">
                      {unproduced ? (
                        <>
                          <tspan className="edge-mark" dx={MARK_OFFSET}>
                            ✗
                          </tspan>
                          <tspan dx={MARK_GAP}>{label}</tspan>
                        </>
                      ) : (
                        label
                      )}
                    </textPath>
                  </text>
                ) : null}
                <path id={`edge-path-${index}`} d={edge.path} className="edge-path-anchor" />
              </g>
            );
          })}

          {lane.slots.map((slot) => (
            <g
              key={slot.id}
              className={`slot${litNode(slot.id) ? '' : ' dimmed'}`}
              transform={`translate(${slot.x}, ${slot.y})`}
              data-testid={`flow-slot-${slot.name}`}
            >
              <rect width={slot.width} height={slot.height} rx="4" />
              <text x={slot.width / 2} y={slot.height / 2} textAnchor="middle" dominantBaseline="middle">
                ⌸
              </text>
              {/* 001 §9.1 gives a slot no producer, so who writes it is a list rather than an edge —
                and the list is the thing a reader of a `shared:` value actually needs. */}
              <title>{`shared slot: ${slot.name}\nwritten by ${slot.writers.join(', ') || 'nothing'}\nread by ${slot.readers.join(', ') || 'nothing'}`}</title>
            </g>
          ))}
          {/* The name under the glyph: a lane of identical squares says nothing about which slot is
            which, and the glyph alone was readable only while there was one of them. */}
          {lane.slots.map((slot) => (
            <text
              key={`${slot.id}-label`}
              className={`slot-label${litNode(slot.id) ? '' : ' dimmed'}`}
              x={slot.x + slot.width / 2}
              y={slot.y + slot.height + 12}
              textAnchor="middle"
            >
              {slot.name}
            </text>
          ))}

          {graph.nodes.map((node) => {
            const state = nodeStates[node.id];
            const apiColor = node.operation ? apiColors.get(node.operation.api) : undefined;
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element) {
                    nodeRefs.current.set(node.id, element);
                  } else {
                    nodeRefs.current.delete(node.id);
                  }
                }}
                className={`node${node.id === selectedStep ? ' selected' : ''}${litNode(node.id) ? '' : ' dimmed'}`}
                transform={`translate(${node.x}, ${node.y})`}
                data-testid={`flow-node-${node.id}`}
                data-status={state?.state || 'pending'}
                onMouseEnter={() => setHoveredStep(node.id)}
                onMouseLeave={() => setHoveredStep((current) => (current === node.id ? null : current))}
                /* Clicking the selected step again clears the selection — a selection is a statement
                 about what is being read (§9), and the click that made it is the one that takes it
                 back. Without it the pane below cannot be closed and the graph cannot be returned to
                 following the run (§5.2), since both answer to nothing being selected. */
                onClick={() => onSelectStep(node.id === selectedStep ? null : node.id)}
                onDoubleClick={() => (node.kind === 'subflow' ? onToggleSubflow(node.id) : undefined)}
              >
                {/* The tie between the step and the band it opened, drawn *outside* the box rather
                    than on it: the box's own border is how §8.2 says passed, failed or in flight,
                    and a step whose outline had been repainted to group it would have stopped
                    saying what happened to it. */}
                {node.kind === 'subflow' && expandedSubflows.includes(node.id) && subflowColors.get(node.id) ? (
                  <rect
                    className="subflow-ring"
                    x={-RING_PAD}
                    y={-RING_PAD}
                    width={node.width + RING_PAD * 2}
                    height={node.height + RING_PAD * 2}
                    rx="8"
                    stroke={subflowColors.get(node.id)}
                    data-testid={`flow-subflow-ring-${node.id}`}
                  />
                ) : null}

                {/* Behind the box, so the glow spills outward rather than over the step's own text. */}
                {isInFlight(state, running) ? (
                  <rect
                    className="node-halo"
                    data-testid={`flow-node-halo-${node.id}`}
                    x={-HALO_PAD}
                    y={-HALO_PAD}
                    width={node.width + HALO_PAD * 2}
                    height={node.height + HALO_PAD * 2}
                    rx={HALO_RADIUS}
                    {...haloProps(node)}
                  />
                ) : null}
                <rect className="node-box" width={node.width} height={node.height} rx={NODE_BOX_RADIUS} />

                {node.markers.computesValues ? (
                  <path
                    className="node-pre-strip"
                    d={preStripPath(node.height)}
                    data-testid={`flow-node-pre-${node.id}`}
                  >
                    <title>step includes a pre script</title>
                  </path>
                ) : null}

                {/**
                * The node's text is laid out as HTML rather than as SVG `<text>`, because SVG text
                * does not wrap — at all, by any attribute. A step id or a path longer than the box
                * simply ran out of it and across whatever it met, and the longest names are exactly
                * the ones worth reading. `foreignObject` is the seam SVG provides for this, and CSS
                * on the other side of it wraps mid-word when a single word is wider than the box.
                */}
                <foreignObject x="0" y="0" width={node.width} height={node.height - NODE_FOOTER_HEIGHT}>
                  <div xmlns="http://www.w3.org/1999/xhtml" className="node-content">
                    {/* The hover target for the pre: strip painted below this layer — see
                        .node-pre-hit in the stylesheet for why the strip's own <title> cannot be
                        the tooltip. */}
                    {node.markers.computesValues ? (
                      <span
                        className="node-pre-hit"
                        style={{ width: PRE_STRIP_WIDTH }}
                        title="step includes a pre script"
                        data-testid={`flow-node-pre-hit-${node.id}`}
                      />
                    ) : null}
                    <div className="node-id">{node.name || node.id}</div>
                    <div className="node-operation">
                      {node.operation ? `${node.operation.method} ${node.operation.path}` : node.uses}
                    </div>
                    <div className="node-status-row">
                      {/* §8.2: the reason is on the node, not behind a click — the four skip reasons
                        are the substance of a run's outcome. */}
                      <span className="node-status">
                        {state ? [state.state, state.reason].filter(Boolean).join(' · ') : ''}
                      </span>
                      {state?.state === 'retrying' && node.markers.retryMaxAttempts ? (
                        <span className="node-attempts">
                          {`attempt ${state.attempt}/${node.markers.retryMaxAttempts}`}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </foreignObject>

                {/**
                * §5.1's footer bar. The markers were drawn over the box's top-right corner, where
                * they sat on top of the step's name — the longest names being the ones worth reading
                * — and every one of them is a fact about the step rather than part of what it is
                * called. On a strip of their own they have room, a fixed place to be looked for, and
                * the room to say which service the step calls beside them.
                */}
                <path
                  className="node-footer"
                  d={footerPath(node)}
                  /* Inline rather than a `fill` attribute: the stylesheet carries the untinted
                     default, and a presentation attribute loses to any CSS declaration. */
                  style={apiColor ? { fill: apiColor } : undefined}
                  data-api={node.operation?.api}
                  data-testid={`flow-node-footer-${node.id}`}
                >
                  {/* The alias is not drawn on the bar — the colour and §5.1's key carry it — so the
                      bar is where it can still be asked for without one more label per box. */}
                  {apiColor ? <title>{node.operation.api}</title> : null}
                </path>
                {/* The bar's top edge stays the neutral divider whatever the binding is. It carried
                    the colour at full strength and was the loudest thing on a graph of eighteen
                    boxes: the tint below it already says which service this is, and saying it twice
                    per box turned a distinction into decoration. */}
                <line
                  className="node-footer-edge"
                  x1="0"
                  y1={node.height - NODE_FOOTER_HEIGHT}
                  x2={node.width}
                  y2={node.height - NODE_FOOTER_HEIGHT}
                />
                {badgedSteps[node.id] ? (
                  <circle className={`node-badge ${badgedSteps[node.id]}`} cx={node.width - 10} cy="12" r="5" />
                ) : null}
                {/* The node has room for the state and its reason and no more, so §14.6's message —
                  which names the response, the reference or the assertion behind that reason — is
                  here. A grey node reading `skipped · unresolved-dependency` is exactly the one whose
                  explanation you want before deciding whether it is worth opening. */}
                {state?.message ? <title>{`${state.state} · ${state.reason} — ${state.message}`}</title> : null}
                {/**
                  * The markers are laid out as HTML, for the same reason §5.1's node text is: SVG
                  * has no layout. Positioned on a fixed pitch they overlapped each other the moment
                  * one of them was wider than the pitch — `↻ 16` and `when` are words, not glyphs —
                  * and the overlap fell on whichever pair a given step happened to carry. A flex row
                  * measures what it is actually laying out.
                  */}
                <foreignObject
                  x="0"
                  y={node.height - NODE_FOOTER_HEIGHT}
                  width={node.width}
                  height={NODE_FOOTER_HEIGHT}
                >
                  <div xmlns="http://www.w3.org/1999/xhtml" className="node-markers">
                    {markersFor(node).map((marker) => (
                      <span key={marker.key} className="node-marker" title={marker.title}>
                        {marker.glyph}
                      </span>
                    ))}
                  </div>
                </foreignObject>

                {/* §5.4 expands a sub-flow on a double-click, which is the one thing this drawing
                    does that nothing on it says. It is written under the selected node only: on
                    every `uses:` node at once it is a second label per box competing with the
                    sub-flow path each of them already carries, and the reader who selected one is
                    the reader asking what it holds. Outside the box, because the three lines inside
                    it are the step, and this is the view talking about itself. */}
                {node.kind === 'subflow' && node.id === selectedStep && !expandedSubflows.includes(node.id) ? (
                  <text
                    className="node-hint"
                    x="0"
                    y={node.height + NODE_HINT_OFFSET}
                    data-testid={`flow-node-hint-${node.id}`}
                  >
                    double click to expand
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </StyledWrapper>
  );
};

export default FlowGraph;
