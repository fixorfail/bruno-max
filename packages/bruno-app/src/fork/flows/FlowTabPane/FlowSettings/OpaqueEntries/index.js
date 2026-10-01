import React from 'react';

/**
 * 005 §6.4 — the entries of a block that a settings table does not edit. The table shows their names
 * here, so the author knows that they exist and where to edit them. `kind` is the singular noun of
 * the block: `param`, `export` or `var`.
 */
const OpaqueEntries = ({ entries, kind }) => {
  const opaque = entries.filter((entry) => entry.opaque);
  if (!opaque.length) {
    return null;
  }

  return (
    <div className="editor-opaque" data-testid={`flow-settings-${kind}s-opaque`}>
      <div className="editor-opaque-title">Not editable here</div>
      {opaque.map(({ name }) => (
        <div key={name} className="editor-opaque-row" data-testid={`flow-settings-${kind}-opaque-${name}`}>
          <code>{name}</code>
          <span className="editor-hint">{`edit this ${kind} in the YAML tab`}</span>
        </div>
      ))}
    </div>
  );
};

export default OpaqueEntries;
