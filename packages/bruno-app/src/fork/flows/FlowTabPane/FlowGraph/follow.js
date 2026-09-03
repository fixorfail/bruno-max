import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * 002 §5.2 — the graph is drawn at its own size and scrolls inside its box rather than being scaled
 * to fit, so on any flow longer than the tab is wide the step that is executing is routinely off the
 * right edge. §8.2's halo answers *which* step is in flight; it says nothing to a reader looking at
 * a part of the drawing the run has already left, and following a run by dragging the graph after it
 * is the same work the halo exists to save.
 *
 * **The reader's own selection wins.** Selecting a step (§9) is a statement about what is being
 * read, and a view that scrolled away from the step whose response is open in the pane below it
 * would be moving the drawing out from under the thing it is explaining. So this follows only while
 * nothing is selected — which is also the state a graph opened to watch a run is in.
 */

/**
 * Room left around the followed node, so it arrives inside the box rather than flush against its
 * edge — the step after it is the next thing to be interested in, and an edge-aligned node hides the
 * arrow leaving it.
 */
export const FOLLOW_PAD = 32;

/**
 * The scroll offset on one axis that shows `[start, start + size]`, moving as little as possible.
 *
 * Minimal rather than centring: consecutive ranks are less than a box apart, so centring every step
 * would swing the whole drawing on each `step:start` where nudging it keeps the steps either side of
 * the running one in view. A node already inside the box does not move it at all, which is what lets
 * a reader scroll somewhere during a run and stay there until the run moves on.
 *
 * A node bigger than the viewport cannot satisfy both edges; showing its start is the tie-break,
 * because the start is where its name is.
 */
export const followScroll = (start, size, viewport, scroll, pad = FOLLOW_PAD) => {
  const showingStart = Math.max(0, start - pad);
  const showingEnd = Math.max(0, start + size + pad - viewport);

  if (showingEnd > showingStart) return showingStart;
  if (scroll > showingStart) return showingStart;
  if (scroll < showingEnd) return showingEnd;
  return scroll;
};

/**
 * `scrollIntoView` would do this in one call and is the wrong call: it scrolls every scrollable
 * ancestor, so following a node inside the graph would also scroll the tab and whatever else the app
 * has nested this in. The graph's own box is the only thing that should move.
 */
const scrollBox = (container, left, top, behavior) => {
  if (left === container.scrollLeft && top === container.scrollTop) {
    return;
  }

  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ left, top, behavior });
    return;
  }
  container.scrollLeft = left;
  container.scrollTop = top;
};

/** Where a node sits in the drawing, in the scrolled content's own coordinates. */
const nodeContentPosition = (container, node) => {
  const box = node.getBoundingClientRect();
  const view = container.getBoundingClientRect();

  return {
    left: box.left - view.left + container.scrollLeft,
    top: box.top - view.top + container.scrollTop,
    width: box.width,
    height: box.height
  };
};

const scrollNodeIntoView = (container, node) => {
  const position = nodeContentPosition(container, node);
  const left = followScroll(position.left, position.width, container.clientWidth, container.scrollLeft);
  const top = followScroll(position.top, position.height, container.clientHeight, container.scrollTop);

  // The same reading §8.2's halo answers to: a graph that slides is one whose motion says the run
  // moved on, where a graph that jumps looks like it redrew itself.
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  scrollBox(container, left, top, reduceMotion ? 'auto' : 'smooth');
};

/**
 * Where a node currently sits **on screen**, as an offset from the top left of the graph's box.
 *
 * Read before the click that selects it is dispatched, which is the only moment it can be read: by
 * the time the pane below has opened, the box is a different size and this is the thing being
 * restored rather than measured.
 */
export const nodeViewportOffset = (container, node) => {
  if (!container || !node) {
    return null;
  }

  const box = node.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  return { left: box.left - view.left, top: box.top - view.top };
};

/**
 * Puts the node back where the pointer left it, and settles for showing it whole when the box is no
 * longer tall enough for both.
 *
 * **No padding, unlike the follow.** A pad would move a node that is merely *near* an edge, and not
 * moving is the entire point here: a step selected by a click that is about to be the first half of
 * a double-click has to still be under the pointer when the second half arrives.
 *
 * Instant rather than smooth for the same reason — an animation is the graph moving out from under
 * the second click over the next few hundred milliseconds.
 */
const holdNodeInView = (container, node, offset) => {
  const position = nodeContentPosition(container, node);
  const wantedLeft = offset ? position.left - offset.left : container.scrollLeft;
  const wantedTop = offset ? position.top - offset.top : container.scrollTop;

  const left = followScroll(position.left, position.width, container.clientWidth, wantedLeft, 0);
  const top = followScroll(position.top, position.height, container.clientHeight, wantedTop, 0);

  scrollBox(container, left, top, 'auto');
};

/**
 * Keeps the selected step in the graph's box across the layout change its own selection causes.
 *
 * Selecting a step opens §9's pane, which takes its height out of the graph's box — so a step
 * clicked in the lower part of the drawing is behind the pane explaining it by the time the pane is
 * there, and the click that opened it reads as a click that did nothing. This runs in a layout
 * effect, after the pane is in the DOM and before the frame is painted, so the correction is part of
 * the same visual step rather than a jump after it.
 *
 * `offsetRef` carries where the node was on screen when it was clicked, so a node the pane has not
 * covered is held exactly where it was rather than being re-aligned to an edge.
 */
export const useSelectedNodeInView = ({ containerRef, nodeRefs, selectedStep, offsetRef }) => {
  useLayoutEffect(() => {
    const offset = offsetRef.current;
    offsetRef.current = null;

    if (!selectedStep) {
      return;
    }

    const container = containerRef.current;
    const node = nodeRefs.current.get(selectedStep);
    if (container && node) {
      holdNodeInView(container, node, offset && offset.id === selectedStep ? offset : null);
    }
  }, [selectedStep, containerRef, nodeRefs, offsetRef]);
};

/**
 * Follows the step in flight, given the in-flight ids **in layout order** (§5.2: rank, then file
 * order).
 *
 * **The node being followed is held until it stops being in flight**, rather than re-picked from the
 * set on every event. Under `concurrency > 1` (§8.3) several steps run at once and each
 * `step:attempt` of a poll rewrites the set; choosing afresh each time would swing the view between
 * branches on events that say nothing about where to look. Holding one until it ends, then taking
 * the first of whatever is still running, moves the view once per step — and takes the earliest node
 * in the layout for the same reason §5.2 orders a rank by the file rather than by the run.
 */
export const useFollowActiveNode = ({ containerRef, nodeRefs, inFlight, enabled }) => {
  const followed = useRef(null);
  // Read inside the effect, which runs on what the set *says* rather than on the array — a new array
  // arrives on every render, and re-running on one that says the same thing would scroll over a
  // reader who has moved the view somewhere else.
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;
  const key = inFlight.join(' ');

  useEffect(() => {
    if (!enabled) {
      // Selecting a step ends the follow; deselecting picks up whatever is running *then*, rather
      // than resuming from the step that was in flight when the selection was made.
      followed.current = null;
      return;
    }

    const ids = inFlightRef.current;
    if (ids.includes(followed.current)) {
      return;
    }

    const next = ids[0];
    if (!next) {
      return;
    }
    followed.current = next;

    const container = containerRef.current;
    const node = nodeRefs.current.get(next);
    if (container && node) {
      scrollNodeIntoView(container, node);
    }
  }, [key, enabled, containerRef, nodeRefs]);
};
