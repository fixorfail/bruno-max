import React from 'react';

/**
 * 001 §10.2's operator, chosen from the list the **engine** sent (005 §9.2).
 *
 * The collections pane's `AssertionOperator` is the same control and reads the same way; what it
 * cannot do is take its list from anywhere. The flow dialect accepts everything that one offers plus
 * the `==` and `!=` aliases, so a file written with `==` would meet a select with no such option —
 * blank, and rewritten to something else by the first edit to that row. 002-C R4 is the rule this
 * follows: a dropdown that offers what the engine does not accept, or withholds what it does, is the
 * renderer deciding semantics.
 *
 * The two labels are upstream's, because they are the two operators whose names are not their
 * meaning. Everything else reads as it is written in the file.
 */

const LABELS = { eq: 'equals', neq: 'notEquals' };

const OperatorSelect = ({ operator, operators, onChange, testId }) => (
  <select
    className="mousetrap"
    value={operator}
    onChange={(event) => onChange(event.target.value)}
    data-testid={testId}
  >
    {/* An operator the file holds that this build's engine does not list still shows, so a row is
        never silently re-pointed at another one by the act of opening the tab. */}
    {(operators.includes(operator) ? operators : [operator, ...operators]).map((name) => (
      <option key={name} value={name}>
        {LABELS[name] || name}
      </option>
    ))}
  </select>
);

export default OperatorSelect;
