/**
 * 001 §5.2's five flags, in one list because they are set in two places (005 §6.5).
 *
 * A step overrides them and the flow's `config:` declares them, and the two panes that do so must
 * offer the same five under the same names — a flag added to one and not the other is a setting an
 * author can turn off for a step and not for the flow, or the reverse, with nothing saying why.
 *
 * `fallback` is what 001 §5.2 does when nobody writes the key. A step's pane never needs it (its
 * silence means *whatever `config:` says*, which is a value it can point at), but the flow's does:
 * there is nothing above `config:` to inherit from, so its silence means this, and a control that
 * said "inherit" there would be naming a thing that does not exist.
 */
export const FLAGS = [
  { field: 'failOnStatusCode', label: 'Fail on status ≥ 400', fallback: true, hint: '001 §10.1' },
  { field: 'failOnUnresolved', label: 'Fail the flow when skipped for an unmet dependency', fallback: true, hint: '001 §11.2' },
  { field: 'validateRequest', label: 'Validate the request against the spec before sending', fallback: true, hint: '001 §10.1' },
  { field: 'validateSchema', label: 'Validate the response against the spec', fallback: true, hint: '001 §10.1' },
  { field: 'strictSchema', label: 'Fail on an undocumented status', fallback: false, hint: '001 §10.1' }
];
