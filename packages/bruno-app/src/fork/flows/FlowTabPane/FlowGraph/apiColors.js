/**
 * 002 §5.1 — a colour per `apis:` binding, for the footer bar of every step that calls it.
 *
 * A flow binding more than one API is the case this exists for: `seed-verified-company` drives a
 * backend and a test-harness service, and which of the two a step talks to is the first thing a
 * reader wants and the one thing the box did not say. The alias is on the bar as text; the colour is
 * what makes the shape of the flow — *this stretch is all one service, and then it is not* — visible
 * without reading a single box.
 *
 * **A colour the file declares wins** (001 §6.2). Assignment is a default, and a default that
 * overrode what an author wrote would be the tool arguing with the file — teams colour a service to
 * match whatever they already recognise it by, and that is worth more than any ordering this module
 * could choose. It applies even to a flow binding one API, where the automatic rule assigns nothing:
 * having said which colour, the author has said there is a colour.
 *
 * **The rest are assigned in file order, from a fixed list, never cycled.** The alias's position in
 * the flow's own nodes decides its slot, so the same flow draws the same colours every time and
 * adding a step to the end changes nothing. A slot matching a colour already declared is skipped, so
 * an author's choice does not collide with an assignment made around it. Past the list, a binding
 * takes no colour rather than reusing one: two services sharing a colour is worse than one having
 * none, because the reader cannot tell which they are looking at and has no reason to doubt it.
 *
 * **The colours are not the run's.** 002 §8.2 owns green, red and yellow — a step's outcome — and a
 * binding painted in any of them would say `failed` from across the graph. These are the categorical
 * slots from the `dataviz` reference palette, stepped per mode, with those three hues left out of
 * the first three so the common case never collides with a status.
 *
 * The first three slots are validated for every pair on both surfaces (all-pairs CVD ΔE 9.2 light /
 * 9.4 dark, normal-vision 24.0 / 20.9). No fourth slot clears the all-pairs floors in *both* modes —
 * checked against the whole list — which is why the alias is drawn on the bar rather than the colour
 * being asked to carry identity on its own.
 */

const PALETTE = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
  { light: '#008300', dark: '#008300' }
];

/**
 * The aliases the drawing actually calls, in the order the file declares the steps that call them.
 *
 * Taken from the nodes rather than from a list of bindings, because a binding declared and never used
 * would take a slot and a legend row for a service no box on the screen belongs to. A step whose
 * operation did not resolve (§6: the flow still opens) names no API and is simply uncoloured.
 */
const apisOf = (nodes) => {
  const aliases = [];
  for (const node of nodes) {
    const alias = node.operation?.api;
    if (alias && !aliases.includes(alias)) {
      aliases.push(alias);
    }
  }
  return aliases;
};

/**
 * `Map` of alias to colour, in file order — which is the order §5.1's key lists them in.
 *
 * **Every binding the drawing calls is in it; the colour is what is conditional.** A flow calling one
 * service gets an entry with no colour unless the file declares one: there is nothing for a colour to
 * distinguish, and a tint that never varies is a decoration — but *which* service the flow drives is
 * worth saying whether or not there is a second one, and the key is where it is said. Past the
 * palette an entry is colourless for the other reason: a second binding in the same colour is worse
 * than one with none.
 *
 * `apis` is the description's own binding list (001 §6.2), which carries the declared colours. It is
 * absent from a run recorded before the field existed (§10 draws the description the run executed),
 * and a flow that declares none is the same case — so it defaults to nothing rather than being
 * required.
 */
export const assignApiColors = (nodes, mode, apis = []) => {
  const aliases = apisOf(nodes);
  const step = mode === 'light' ? 'light' : 'dark';
  const declared = new Map(apis.filter((binding) => binding.color).map((binding) => [binding.alias, binding.color]));

  // Only the colours actually on the drawing are avoided: a binding the flow declares and never
  // calls paints no bar, so holding a slot back for it would spend a colour on nothing.
  const spoken = new Set(
    aliases.map((alias) => declared.get(alias)).filter(Boolean).map((color) => color.toLowerCase())
  );

  let slot = 0;
  const nextColor = () => {
    while (slot < PALETTE.length && spoken.has(PALETTE[slot][step].toLowerCase())) slot += 1;
    const color = PALETTE[slot]?.[step];
    slot += 1;
    return color;
  };

  return new Map(
    aliases.map((alias) => [alias, declared.get(alias) || (aliases.length > 1 ? nextColor() : undefined)])
  );
};
