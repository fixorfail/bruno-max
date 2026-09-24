import React from 'react';
import MenuDropdown from 'ui/MenuDropdown';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §5.1's legend, and 005 §5.5's place to manage a flow's APIs.
 *
 * **Read-only, it lists what the drawing uses**: a binding declared and never called takes no row,
 * because a row for a service no box wears is a colour the reader goes looking for, and a flow using
 * none draws no legend at all. **Editable, it lists what the file declares**, in file order, merged
 * with the used set — a binding just added would otherwise vanish the instant it was written, and an
 * empty flow would have nowhere to add its first. An unused binding gets a row with no swatch, which
 * is §5.1's own rule: a swatch marks a tint the drawing actually has.
 *
 * This is the one place an API is added. Not in the step editor, where it would put a file-level
 * decision inside a step-level form, and not in the toolbar, which is the run's.
 */
const ApiLegend = ({ apiColors, declared, editable, onAddApi, onEditApi, onRemoveApi }) => {
  const entries = editable
    ? [...new Set([...declared.map((binding) => binding.alias), ...apiColors.keys()])].map((alias) => [alias, apiColors.get(alias)])
    : [...apiColors];

  if (!entries.length && !editable) {
    return null;
  }

  return (
    <StyledWrapper className={`flow-legend${editable ? ' is-editable' : ''}`} data-testid="flow-legend">
      <span className="flow-legend-title">API</span>
      {entries.map(([alias, color]) => {
        const entry = (
          <>
            {/* No swatch where there is no tint — a flow calling one service, a binding past the
                palette, or one no step calls yet. A chip in the key that no bar on the drawing wears
                is a colour the reader goes looking for. */}
            {color ? <span className="flow-legend-swatch" style={{ background: color }} /> : null}
            {alias}
          </>
        );

        return editable ? (
          <MenuDropdown
            key={alias}
            placement="bottom-end"
            data-testid={`flow-legend-${alias}`}
            items={[
              { id: 'edit', label: 'Edit binding…', onClick: () => onEditApi(alias) },
              { id: 'remove', label: 'Remove binding', onClick: () => onRemoveApi(alias) }
            ]}
          >
            <button type="button" className="flow-legend-entry" title={`${alias} — edit or remove this binding`} data-testid={`flow-legend-menu-${alias}`}>
              {entry}
            </button>
          </MenuDropdown>
        ) : (
          <span key={alias} className="flow-legend-entry">
            {entry}
          </span>
        );
      })}

      {editable ? (
        <button type="button" className="flow-legend-add" onClick={onAddApi} title="Bind an API document to this flow" data-testid="flow-legend-add">
          + API
        </button>
      ) : null}
    </StyledWrapper>
  );
};

export default ApiLegend;
