import React from 'react';
import { FLAGS } from '../../flags';

/**
 * 005 §6.5 — the five flags a step may override, each three ways.
 *
 * `failOnStatusCode`, `failOnUnresolved`, `validateRequest`, `validateSchema` and `strictSchema`
 * each have a default in 001 §5.2 *and* a flow-level setting under `config:` that a step inherits.
 * An absent key does not mean the default; it means whatever `config:` says. A two-state box —
 * `true` when ticked, deleted when not — silently overrides a flow-level `false` on tick and
 * silently reverts to it on untick, in the one place where a change alters what a flow *does*
 * without changing what it draws. So each is *inherit* · *on* · *off*, where *inherit* deletes the
 * key and the other two write it.
 *
 * The five themselves live beside the pane over `config:` (`../../flags`), which offers the same
 * ones: a flag added to one and not the other is a setting a step can turn off and a flow cannot.
 */

const stateOf = (value) => (value === true ? 'on' : value === false ? 'off' : 'inherit');

const SettingsTab = ({ step, onPatch }) => (
  <div className="editor-section" data-testid="flow-step-settings">
    <div className="editor-section-title">Overrides</div>
    <div className="editor-fields">
      {FLAGS.map(({ field, label }) => (
        <React.Fragment key={field}>
          <label className="editor-label" htmlFor={`flow-step-flag-${field}`}>
            {label}
          </label>
          <div className="editor-field">
            <select
              id={`flow-step-flag-${field}`}
              className="textbox"
              value={stateOf(step.fields[field])}
              onChange={(event) => {
                const next = event.target.value;
                onPatch(next === 'inherit' ? { unset: [field] } : { set: { [field]: next === 'on' } });
              }}
              data-testid={`flow-step-flag-${field}`}
            >
              <option value="inherit">inherit — what the flow's config says</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
            <code className="editor-hint">{field}</code>
          </div>
        </React.Fragment>
      ))}
    </div>
  </div>
);

export default SettingsTab;
