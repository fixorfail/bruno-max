import React, { useState } from 'react';
import { IconChevronDown, IconChevronRight, IconTrash } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §7.2 — the run configuration, beside §7.1's run control.
 *
 * Four of the table's six controls live here. **Environment is not one of them**: §7.2 puts it on
 * §4.2's header, at the end of the row where a collection's header keeps it, because it is the one
 * control in the table someone already knows the location of. **Capture is not one either** — §7.1
 * makes it a kind of run, chosen on the control, rather than a setting that is remembered.
 *
 * The panel is collapsed until it is opened, and says how much it is holding while it is shut. A
 * flow's run configuration is empty most of the time and the tab's vertical space belongs to the
 * graph; a panel that was always open would spend it on four empty boxes, and one that said nothing
 * while shut would hide an override somebody set an hour ago and has since forgotten — which is the
 * failure mode a run configuration has.
 */

/**
 * §7.2's `envVarOverrides` — the app's `--env-var`.
 *
 * Held as **rows** rather than as the object the engine is handed, because a mapping cannot hold a
 * half-typed key: renaming `toke` to `token` through an object drops the old key and creates a new
 * one on every keystroke, and a row whose name is still empty has nowhere to exist at all.
 * `actions.js` is what flattens these into the tier, which is also where a blank row is dropped.
 */
const rowsOf = (configuration) => configuration.variableOverrides || [];

const withRows = (configuration, rows) => ({ ...configuration, variableOverrides: rows });

const VariableOverrides = ({ configuration, onConfigurationChange, disabled }) => {
  const rows = rowsOf(configuration);

  const update = (index, patch) =>
    onConfigurationChange(withRows(configuration, rows.map((row, at) => (at === index ? { ...row, ...patch } : row))));

  return (
    <div className="run-config-field" data-testid="flow-config-variables">
      <span className="run-config-label">Variable overrides</span>

      {rows.map((row, index) => (
        <div className="run-config-row" key={index}>
          <input
            type="text"
            aria-label={`Override ${index + 1} name`}
            placeholder="name"
            value={row.name || ''}
            disabled={disabled}
            data-testid={`flow-config-variable-name-${index}`}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            type="text"
            aria-label={`Override ${index + 1} value`}
            placeholder="value"
            value={row.value || ''}
            disabled={disabled}
            data-testid={`flow-config-variable-value-${index}`}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="run-config-remove"
            title="Remove this override"
            disabled={disabled}
            data-testid={`flow-config-variable-remove-${index}`}
            onClick={() => onConfigurationChange(withRows(configuration, rows.filter((unused, at) => at !== index)))}
          >
            <IconTrash size={13} strokeWidth={1.5} />
          </button>
        </div>
      ))}

      <button
        type="button"
        className="run-config-add"
        disabled={disabled}
        data-testid="flow-config-variable-add"
        onClick={() => onConfigurationChange(withRows(configuration, [...rows, { name: '', value: '' }]))}
      >
        Add override
      </button>
    </div>
  );
};

/**
 * §12.5's params, for **any flow that declares them**.
 *
 * `library: true` says a flow is meant to be called by another one (001 §12.5); it does not decide
 * whether the flow takes params. A flow with a `params:` block is run with values for them whichever
 * it is, the engine refuses a run missing a required one either way, and §5.6's inputs node has
 * always drawn the block as the document declares it — so gating this panel on the flag put the one
 * surface that can *supply* a value behind a property that has nothing to do with taking one.
 *
 * The same `configuration.params` §5.6's inputs node edits, so the two surfaces are one value with
 * two views rather than two values to keep in step: both are controlled from the slice.
 */
const Parameters = ({ description, configuration, onConfigurationChange, disabled }) => {
  if (!description?.params.length) {
    return null;
  }

  const params = configuration.params || {};

  return (
    <div className="run-config-field" data-testid="flow-config-params">
      <span className="run-config-label">Parameters</span>

      {description.params.map((param) => (
        <div className="run-config-row" key={param.name}>
          <label className="run-config-param-name" htmlFor={`flow-param-${param.name}`}>
            {param.name}
            {param.required ? <span className="required" title="Required">*</span> : null}
          </label>
          <input
            id={`flow-param-${param.name}`}
            /* 001 §14.4 masks a secret param in the capture; the box it is typed into does the same,
               so a screen share during a run does not undo what the run recording is careful about. */
            type={param.secret ? 'password' : 'text'}
            placeholder={param.default === undefined ? '' : String(param.default)}
            value={params[param.name] ?? ''}
            disabled={disabled}
            data-testid={`flow-config-param-${param.name}`}
            onChange={(event) =>
              onConfigurationChange({
                ...configuration,
                params: { ...params, [param.name]: event.target.value }
              })}
          />
        </div>
      ))}
    </div>
  );
};

/**
 * What the panel is holding, said while it is shut. Counts rather than values: a summary that spelled
 * out an override would put a token on the toolbar of a tab somebody is screen-sharing.
 */
const summarize = (description, configuration) => {
  const parts = [];
  const overrides = rowsOf(configuration).filter((row) => (row.name || '').trim() !== '').length;

  if (overrides) {
    parts.push(`${overrides} variable${overrides === 1 ? '' : 's'}`);
  }
  if (configuration.dataset) {
    parts.push('dataset');
  }
  if (configuration.concurrency) {
    parts.push(`concurrency ${configuration.concurrency}`);
  }
  if (description?.params.length) {
    const supplied = Object.values(configuration.params || {}).filter((value) => String(value ?? '').trim() !== '');
    if (supplied.length) {
      parts.push(`${supplied.length} param${supplied.length === 1 ? '' : 's'}`);
    }
  }

  return parts.join(' · ');
};

const RunConfiguration = ({ description, configuration, onConfigurationChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const summary = summarize(description, configuration);

  return (
    <StyledWrapper>
      <button
        type="button"
        className={`run-config-toggle${open ? ' is-open' : ''}`}
        aria-expanded={open}
        data-testid="flow-run-configuration-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <IconChevronDown size={13} strokeWidth={1.5} /> : <IconChevronRight size={13} strokeWidth={1.5} />}
        Run configuration
        {summary ? (
          <span className="run-config-summary" data-testid="flow-run-configuration-summary">
            {summary}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="run-config-panel" data-testid="flow-run-configuration">
          <VariableOverrides
            configuration={configuration}
            onConfigurationChange={onConfigurationChange}
            disabled={disabled}
          />

          <div className="run-config-field">
            <label className="run-config-label" htmlFor="flow-config-dataset">
              Dataset
            </label>
            {/* 001 §9.4's file, replacing the one the flow declares or supplying one to a flow with
                none. Resolved by the engine against the flow's own directory, so what is typed here
                is the path as the file would have written it. */}
            <input
              id="flow-config-dataset"
              type="text"
              className="run-config-wide"
              placeholder={description?.dataset ? description.dataset.source : 'no dataset'}
              value={configuration.dataset || ''}
              disabled={disabled}
              data-testid="flow-config-dataset"
              onChange={(event) =>
                onConfigurationChange({ ...configuration, dataset: event.target.value || undefined })}
            />
          </div>

          <div className="run-config-field">
            <label className="run-config-label" htmlFor="flow-config-concurrency">
              Concurrency
            </label>
            {/* 001 §9.2's override. Empty means the flow's own, which is why the box is blank rather
                than pre-filled with a number nobody chose. */}
            <input
              id="flow-config-concurrency"
              type="number"
              min="1"
              placeholder="flow"
              value={configuration.concurrency || ''}
              disabled={disabled}
              data-testid="flow-config-concurrency"
              onChange={(event) =>
                onConfigurationChange({
                  ...configuration,
                  concurrency: Number(event.target.value) || undefined
                })}
            />
          </div>

          <Parameters
            description={description}
            configuration={configuration}
            onConfigurationChange={onConfigurationChange}
            disabled={disabled}
          />
        </div>
      ) : null}
    </StyledWrapper>
  );
};

export default RunConfiguration;
