import styled, { keyframes } from 'styled-components';

/**
 * One lap of the halo (§8.2). The offset covers the outline's whole length — the component measures
 * it onto `--halo-outline` — so the dash arrives back where it started and the loop has no seam.
 */
const haloSpin = keyframes`
  to {
    stroke-dashoffset: calc(var(--halo-outline) * -1);
  }
`;

/**
 * §5.3's edge treatments are the load-bearing part of this stylesheet: an implicit sequence edge is
 * muted where a declared one is not, and a data edge is dashed. Drawing them identically would hide
 * the one thing about 001 §9.1 that surprises authors.
 */
const StyledWrapper = styled.div`
  /* The box the graph area occupies. It scrolls *inside* — the .flow-graph-viewport below — so that the
     legend can be positioned against this one and stay put while the drawing moves under it. */
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;

  /* The graph takes the room the tab has left and scrolls inside it, on both axes — §5.2 runs the
     ranks rightward, so a long flow is wide rather than tall. Sizing this box to the SVG instead
     pushes the step detail (§9) past the tab's hidden overflow, where it is clipped rather than
     scrolled to; the zero min-height is what lets this box shrink at all.

     The SVG itself is deliberately left at its own width. It carries explicit width and height, so
     capping it would scale a twelve-step flow down to unreadable instead of letting this box
     scroll to it. */
  .flow-graph-viewport {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 1rem;
  }

  /* §5.1's key to the API colours. Over the drawing at the top right, out of the way of rank 0 and
     of the run's own left-to-right progress, and inert to the pointer so it never takes a click meant
     for the node beneath it. */
  .flow-legend {
    position: absolute;
    top: 0.5rem;
    right: 0.75rem;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.25rem 0.75rem;
    max-width: 60%;
    padding: 0.25rem 0.5rem;
    pointer-events: none;
    font-size: 0.6875rem;
    color: ${(props) => props.theme.colors.text.muted};
    background: ${(props) => props.theme.sidebar.collection.item.bg};
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 4px;
    opacity: 0.94;
  }

  /* Names the key for what it is: without it a lone alias over the drawing reads as a caption on the
     flow rather than as the binding its steps call. */
  .flow-legend-title {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
  }

  .flow-legend-entry {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    white-space: nowrap;
  }

  .flow-legend-swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }

  #flow-arrow path {
    fill: ${(props) => props.theme.colors.text.muted};
  }

  .edge path {
    fill: none;
    stroke: ${(props) => props.theme.colors.text.muted};
    stroke-width: 1.5;
  }

  .edge-path-anchor {
    stroke: none;
    fill: none;
  }

  .edge-sequence path {
    opacity: 0.45;
  }

  .edge-data path {
    stroke-dasharray: 4 3;
  }

  .edge-undeclared path {
    stroke: ${(props) => props.theme.colors.text.warning};
  }

  .edge-slot path {
    stroke-dasharray: 2 3;
  }

  .edge-label {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
  }

  /* The value that never arrived (§5.3). The mark is on the label rather than on the stroke because
     the label is what names the missing value and is the target the hover explanation hangs off. */
  .edge-unproduced .edge-label {
    fill: ${(props) => props.theme.colors.text.danger};
  }

  /**
   * §5.3's focus. Everything that does not touch the step under the pointer — or the step §9's pane
   * is reading — recedes rather than disappearing: a drawing that hid the rest would stop saying how
   * much else is going on, and the question being asked is *which of these lines is mine*.
   *
   * A line fades further than a box, because a box that faded as far would take the step's name with
   * it and the reader would lose where they are on the drawing.
   */
  .edge,
  .node,
  .slot,
  .slot-label {
    transition: opacity 0.12s ease-in-out;
  }

  .edge.dimmed {
    opacity: 0.12;
  }

  .node.dimmed,
  .slot.dimmed,
  .slot-label.dimmed {
    opacity: 0.3;
  }

  .node {
    cursor: pointer;
  }

  /* 002 §5.6's inputs panel — the same box the steps are drawn in, so it reads as part of the
     drawing rather than as a control strip that happens to sit beside it. */
  .flow-inputs .inputs-box {
    fill: ${(props) => props.theme.sidebar.bg};
    stroke: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    stroke-width: 1;
  }

  .inputs-body {
    padding: 0.375rem 0.5rem;
    font-size: 0.6875rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .inputs-title {
    font-weight: 600;
    color: ${(props) => props.theme.colors.text.default};
    margin-bottom: 0.25rem;
  }

  .inputs-section-label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.5625rem;
    opacity: 0.75;
    margin-top: 0.25rem;
  }

  .inputs-row {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    padding: 0.1875rem 0;
  }

  .inputs-name {
    color: ${(props) => props.theme.colors.text.default};
  }

  .inputs-required {
    color: ${(props) => props.theme.colors.text.danger};
    margin-left: 0.125rem;
  }

  .inputs-input {
    width: 100%;
    padding: 0.125rem 0.25rem;
    font-size: 0.6875rem;
    color: ${(props) => props.theme.colors.text.default};
    background: ${(props) => props.theme.modal.input.bg};
    border: 1px solid ${(props) => props.theme.modal.input.border};
    border-radius: 3px;

    &:focus {
      outline: none;
      border-color: ${(props) => props.theme.modal.input.focusBorder};
    }
  }

  /* A recorded value is text rather than a disabled input: a box you cannot type in still looks
     like one you should be able to, and this is a fact about a run that already happened. */
  .inputs-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
  }

  .node-box {
    fill: ${(props) => props.theme.sidebar.collection.item.bg};
    stroke: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    stroke-width: 1;
  }

  /**
   * Purple because every other hue on this graph already means an outcome — green passed, yellow
   * running, danger and warning failed — and a strip in any of them would read as a status the step
   * does not have. Selection uses purple as a *stroke*; this is a fill, so the two do not collide.
   */
  .node-pre-strip {
    fill: ${(props) => props.theme.colors.text.purple};
    stroke: none;
  }

  .node.selected .node-box {
    stroke: ${(props) => props.theme.colors.text.purple};
    stroke-width: 2;
  }

  .node[data-status='running'] .node-box,
  .node[data-status='retrying'] .node-box {
    stroke: ${(props) => props.theme.colors.text.yellow};
    stroke-width: 2;
  }

  .node[data-status='success'] .node-box {
    stroke: ${(props) => props.theme.colors.text.green};
  }

  .node[data-status='failed'] .node-box {
    stroke: ${(props) => props.theme.colors.text.danger};
  }

  .node[data-status='skipped'] .node-box,
  .node[data-status='cancelled'] .node-box {
    opacity: 0.55;
  }

  /* §8.2: a step with a request in flight. The colour property carries the glow, because a
     drop-shadow with no colour of its own is taken from it — so the ring and its bloom cannot end up
     set to two different colours. */
  .node-halo {
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    color: ${(props) => props.theme.colors.text.yellow};
    stroke: currentColor;
    /* Stacked rather than one wide blur: the tight pass keeps the arc itself a defined line while
       the wide one is the bloom around it. A single blur that reached as far would be a smudge. */
    filter: drop-shadow(0 0 2px currentColor) drop-shadow(0 0 6px currentColor);
    animation: ${haloSpin} 1.6s linear infinite;
  }

  /* §8.2 keeps retrying a state of its own because a poll that reads as running for a minute is
     indistinguishable from a hang. The colour change is that distinction at a glance, from across
     the graph, without reading the attempt count on the node. */
  .node[data-status='retrying'] .node-halo {
    color: ${(props) => props.theme.colors.text.warning};
  }

  /* The colour still says the step is in flight; only the motion goes. */
  @media (prefers-reduced-motion: reduce) {
    .node-halo {
      animation: none;
      stroke-dasharray: none;
    }
  }

  /* The box's text, in HTML through a foreignObject — SVG text does not wrap, so anything longer
     than the box used to run out of it. */
  .node-content {
    height: 100%;
    /* Containing block for the pre: strip's hover target below. */
    position: relative;
    /* The box is a click target (§5.1) and a drag across it should not start selecting its label. */
    user-select: none;
    padding: 0.25rem 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    /* The last resort: whatever the content is, it stays inside the box it describes. */
    overflow: hidden;

    /* anywhere, rather than break-word: the case is a single token wider than the box — a step id
       nobody spaced, or a path with one long segment — and break-word leaves that overflowing, since
       it only breaks where there was no break opportunity at all. */
    div,
    span {
      overflow-wrap: anywhere;
      line-height: 1.25;
    }
  }

  /* The pre: strip is an SVG <path> and carries a <title>, but no pointer ever reaches it: the two
     foreignObjects tile the whole box, and HTML in a foreignObject takes the pointer across its
     entire rect whether or not anything is painted there. That is why the footer's and the node's
     own <title> elements never show either, and why the footer markers — plain HTML title
     attributes — are the one tooltip on this box that does.

     So the strip borrows the mechanism that works: an empty HTML element over the strip's column,
     carrying the title attribute. It is a hover target only — the colour underneath is still the
     path's — and it is scoped to the strip so the tooltip belongs to the strip rather than to the
     whole step. Its width is set inline from PRE_STRIP_WIDTH so the two cannot drift apart. */
  .node-pre-hit {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
  }

  .node-id {
    color: ${(props) => props.theme.colors.text.subtext2};
    font-size: 12px;
    font-weight: 500;
    /* Two lines of a name, then an ellipsis: the box has three things to show and a name is allowed
       to take the room of one of them, not all of it. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    /* Clear of the markers and the diagnostic badge, which are drawn over this corner. */
    padding-right: 1.75rem;
  }

  .node-operation {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* The run's word about this step sits on the last line, with a poll's attempt count beside it. */
  .node-status-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.375rem;
    margin-top: auto;
    font-size: 10px;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .node-attempts {
    flex: none;
  }

  /* §5.1's footer bar. The tint carries the binding's colour, and only the tint does: the colour
     identifies a service and does not have to be the loudest thing on the box. Untinted, the bar is
     still a bar — the markers have a place of their own whether or not the flow binds more than one
     API. */
  .node-footer {
    fill: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    fill-opacity: 0.28;
  }

  /* A tinted band rather than a solid one, and the band alone — the divider above it stays neutral.
     One quiet statement per box reads as a distinction; the same colour twice per box, across a
     graph of eighteen of them, reads as decoration. */
  .node-footer[data-api] {
    fill-opacity: 0.22;
  }

  .node-footer-edge {
    stroke: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    stroke-width: 1;
    opacity: 0.7;
  }

  /* The footer's markers, from the right. A gap rather than a pitch: a retry count and a when are wider
     than any fixed step, and a fixed one put them on top of each other on exactly the steps carrying
     the most to say. Nothing wraps — a marker with no room is clipped by the bar rather than pushed
     onto a line the box does not have. */
  .node-markers {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    padding: 0 0.625rem;
    overflow: hidden;
    user-select: none;
  }

  /* Bold, because 10px muted glyphs on a tinted band are the smallest thing on the box and the
     tint takes contrast away from them. Weight rather than size: the bar's height is what keeps the
     step's own three lines their room. */
  .node-marker {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  .node-badge.error {
    fill: ${(props) => props.theme.colors.text.danger};
  }

  .node-badge.warning {
    fill: ${(props) => props.theme.colors.text.warning};
  }

  .slot rect {
    fill: none;
    stroke: ${(props) => props.theme.colors.text.muted};
    stroke-dasharray: 3 2;
  }

  .slot text {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 14px;
  }

  /* The lane is a row of identical squares, and the glyph alone was readable only while there was
     one of them. §9.1's slots are told apart by name or not at all. */
  .slot-label {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
  }

  /* §5.4: where an expanded sub-flow is. A wash rather than a fill — the boxes standing on it keep
     their own background, and the band has to read as ground behind a dozen of them without
     competing with any. The boundary is drawn as well as the tint, because a wash alone disappears
     against a busy stretch of graph. */
  .subflow-band {
    fill-opacity: 0.07;
    stroke-opacity: 0.35;
    stroke-width: 1;
  }

  /* A container past the palette takes no colour of its own and still needs its boundary. */
  .subflow-band.uncoloured {
    fill: ${(props) => props.theme.colors.text.muted};
    stroke: ${(props) => props.theme.colors.text.muted};
  }

  /* Outside the box, so the border underneath goes on carrying the step's outcome (§8.2). */
  .subflow-ring {
    fill: none;
    stroke-width: 2;
    stroke-opacity: 0.85;
  }

  /* §5.5: the divider between one stage and the next. Dashed and faint — it is the only line on this
     drawing that is not a relationship between two steps, and a solid rule at edge strength would be
     read as one. */
  .stage-rule {
    stroke: ${(props) => props.theme.colors.text.muted};
    stroke-width: 1;
    stroke-dasharray: 3 5;
    stroke-opacity: 0.4;
  }

  /* The name of the region to its right, in the strip above the drawing. Tracked out and upper-case
     so it reads as a heading over the graph rather than as one more label on it. */
  .stage-label {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* Italic, because it is the view telling the reader what it can do rather than anything the flow
     says — every other word on this drawing comes out of the file or the run. */
  .node-hint {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
    font-style: italic;
  }
`;

export default StyledWrapper;
