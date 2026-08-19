import { useEffect, useRef } from 'react';

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
const scrollNodeIntoView = (container, node) => {
  const box = node.getBoundingClientRect();
  const view = container.getBoundingClientRect();

  const left = followScroll(
    box.left - view.left + container.scrollLeft,
    box.width,
    container.clientWidth,
    container.scrollLeft
  );
  const top = followScroll(
    box.top - view.top + container.scrollTop,
    box.height,
    container.clientHeight,
    container.scrollTop
  );

  if (left === container.scrollLeft && top === container.scrollTop) {
    return;
  }

  // The same reading §8.2's halo answers to: a graph that slides is one whose motion says the run
  // moved on, where a graph that jumps looks like it redrew itself.
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = reduceMotion ? 'auto' : 'smooth';

  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ left, top, behavior });
    return;
  }
  container.scrollLeft = left;
  container.scrollTop = top;
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
