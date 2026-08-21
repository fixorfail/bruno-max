/**
 * 002 §5.4 — a colour per expanded `uses:` node, worn twice: as a ring around the container and as
 * the band behind the sub-flow that container drew.
 *
 * Expanded, a sub-flow's steps are simply more boxes in the same picture — its own block of ranks,
 * continuing rightward — and nothing on the drawing said where the caller stopped and the sub-flow
 * began. The band is that boundary, and the ring is what ties it to the step it came out of, which
 * matters the moment two sub-flows are open at once and the drawing is three flows deep.
 *
 * **The colours are neither the run's nor an API's.** §8.2 owns green, red and yellow — a step's
 * outcome — and §5.1 spends blue, orange and green on the `apis:` bindings, whose bars sit inside
 * these boxes. What is left, and what these are, are the hues neither of those two answers uses.
 *
 * **A container keeps its colour whatever else is expanded**, because the slot comes from its
 * position among the flow's `uses:` steps rather than from the order they were opened in: a colour
 * that changed when a *different* sub-flow was collapsed would be saying something about this one.
 *
 * **Past the list a container takes no colour**, for §5.1's reason — two bands in one colour on a
 * drawing that has both open is worse than a band with none, because the reader has no way to tell
 * and no reason to doubt. Such a band draws in the neutral outline instead.
 */

const PALETTE = [
  { light: '#0e8f9c', dark: '#3bb6c4' },
  { light: '#c14a92', dark: '#e07ab5' },
  { light: '#7b53c9', dark: '#a78bfa' },
  { light: '#8a6a2f', dark: '#b08a52' }
];

/** `Map` of a `uses:` step's id to its colour, in the order the flow declares them. */
export const assignSubflowColors = (nodes, mode) => {
  const step = mode === 'light' ? 'light' : 'dark';

  return new Map(
    nodes
      .filter((node) => node.kind === 'subflow')
      .map((node, index) => [node.id, PALETTE[index]?.[step]])
  );
};
