import { FOLLOW_PAD, followScroll } from './follow';

/**
 * 002 §5.2 — the arithmetic behind following a run across a graph that scrolls rather than scaling.
 *
 * The behaviour worth pinning is that it moves *as little as it can*: a node already in the box does
 * not move the view at all, which is what lets a reader look somewhere during a run and stay there
 * until the run reaches a step they cannot see.
 */
describe('followScroll', () => {
  const VIEWPORT = 600;

  it('leaves a node already in view where it is', () => {
    expect(followScroll(200, 220, VIEWPORT, 100)).toBe(100);
  });

  /** The node is off to the right: scroll just far enough that its far edge clears the padding. */
  it('scrolls forward until the node ends inside the box', () => {
    expect(followScroll(900, 220, VIEWPORT, 0)).toBe(900 + 220 + FOLLOW_PAD - VIEWPORT);
  });

  /** And back the other way, for a run that moves the view somewhere the reader has scrolled past. */
  it('scrolls back until the node starts inside the box', () => {
    expect(followScroll(300, 220, VIEWPORT, 800)).toBe(300 - FOLLOW_PAD);
  });

  it('leaves the padding around the node it moved to', () => {
    const scroll = followScroll(900, 220, VIEWPORT, 0);

    expect(900 - scroll).toBeGreaterThanOrEqual(FOLLOW_PAD);
    expect(VIEWPORT - (900 + 220 - scroll)).toBeGreaterThanOrEqual(FOLLOW_PAD);
  });

  /** Neither edge of the drawing has anything past it, and a negative offset is not a scroll. */
  it('never scrolls past the start of the drawing', () => {
    expect(followScroll(10, 220, VIEWPORT, 400)).toBe(0);
    expect(followScroll(0, 220, 100, 0)).toBe(0);
  });

  /**
   * A node wider than the box cannot show both its edges, and the start is where its name is — the
   * alternative shows the reader the empty end of a box and calls it following the run.
   */
  it('shows the start of a node too big for the box', () => {
    expect(followScroll(500, 900, VIEWPORT, 0)).toBe(500 - FOLLOW_PAD);
    expect(followScroll(500, 900, VIEWPORT, 2000)).toBe(500 - FOLLOW_PAD);
  });
});
