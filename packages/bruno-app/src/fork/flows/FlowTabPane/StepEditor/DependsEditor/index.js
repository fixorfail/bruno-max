import React from 'react';
import Button from 'ui/Button';

/**
 * 005 §6.2 — a step's `depends:` (001 §9.1), in every form the file may have written it.
 *
 * The document has four spellings for one idea: a bare list of ids, entries with a `status`, and
 * either wrapped in `all:` or `any:`. They are read into one shape here — a join and a list of
 * `{ on, status }` — and written back in the plainest spelling that still says the same thing: a
 * bare list where every entry accepts the default outcome and the join is `all`, the longer forms
 * only where they carry something. `depends: []` is a spelling of its own — an explicit root (001
 * §9.1) — and is kept apart from the key being absent, which means the implicit sequence.
 *
 * Every change commits at once: these are choices, not typing, and each is one edit.
 */

const DEFAULT_STATUS = ['success'];

const entryOf = (entry) =>
  typeof entry === 'string' ? { on: entry, status: [] } : { on: entry.on, status: Array.isArray(entry.status) ? entry.status : [] };

export const readDepends = (depends) => {
  if (depends === undefined) return { join: 'all', entries: [], root: false };
  if (Array.isArray(depends)) return { join: 'all', entries: depends.map(entryOf), root: depends.length === 0 };
  if (Array.isArray(depends.any)) return { join: 'any', entries: depends.any.map(entryOf), root: false };
  if (Array.isArray(depends.all)) return { join: 'all', entries: depends.all.map(entryOf), root: false };
  return { join: 'all', entries: [], root: false };
};

const isDefault = (status) => !status.length || (status.length === 1 && status[0] === DEFAULT_STATUS[0]);

const writeEntry = ({ on, status }) => (isDefault(status) ? on : { on, status });

export const writeDepends = ({ join, entries, root }) => {
  const named = entries.filter((entry) => entry.on);
  if (!named.length) {
    return root ? [] : undefined;
  }
  const written = named.map(writeEntry);
  if (join === 'any') {
    return { any: written.map((entry) => (typeof entry === 'string' ? { on: entry } : entry)) };
  }
  return written;
};

const DependsEditor = ({ step, model, onPatch }) => {
  const current = readDepends(step.fields.depends);
  const others = model.steps.map((entry) => entry.id).filter((id) => id !== step.id);
  const statuses = model.vocabulary.statuses || ['success', 'failed', 'skipped', 'cancelled'];

  const write = (next) => {
    const depends = writeDepends(next);
    onPatch(depends === undefined ? { unset: ['depends'] } : { set: { depends } });
  };
  const update = (index, change) =>
    write({ ...current, entries: current.entries.map((entry, at) => (at === index ? { ...entry, ...change } : entry)) });

  return (
    <div className="editor-section" data-testid="flow-step-depends">
      <div className="editor-section-title">Depends on</div>

      {current.entries.length === 0 ? (
        <label className="editor-check">
          <input
            type="checkbox"
            checked={current.root}
            onChange={(event) => write({ ...current, root: event.target.checked })}
            data-testid="flow-step-depends-root"
          />
          A root — runs first, depending on nothing (otherwise it follows the step above it)
        </label>
      ) : null}

      {current.entries.map((entry, index) => (
        <div key={index} className="editor-depends-row" data-testid={`flow-step-depends-${index}`}>
          <select
            className="textbox"
            value={entry.on}
            onChange={(event) => update(index, { on: event.target.value })}
            data-testid={`flow-step-depends-${index}-on`}
          >
            <option value="">— choose a step —</option>
            {others.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>

          <span className="editor-hint">when it</span>
          {statuses.map((status) => (
            <label key={status} className="editor-check">
              <input
                type="checkbox"
                checked={isDefault(entry.status) ? status === DEFAULT_STATUS[0] : entry.status.includes(status)}
                onChange={(event) => {
                  const base = isDefault(entry.status) ? DEFAULT_STATUS : entry.status;
                  const status_ = event.target.checked ? [...base, status] : base.filter((name) => name !== status);
                  update(index, { status: statuses.filter((name) => status_.includes(name)) });
                }}
                data-testid={`flow-step-depends-${index}-${status}`}
              />
              {status}
            </label>
          ))}

          <Button
            size="xs"
            variant="outline"
            color="secondary"
            onClick={() => write({ ...current, entries: current.entries.filter((unused, at) => at !== index) })}
            data-testid={`flow-step-depends-${index}-remove`}
          >
            Remove
          </Button>
        </div>
      ))}

      <div className="editor-depends-actions">
        <Button
          size="xs"
          variant="outline"
          color="secondary"
          onClick={() => write({ ...current, root: false, entries: [...current.entries, { on: others[0] || '', status: [] }] })}
          disabled={!others.length}
          data-testid="flow-step-depends-add"
        >
          Add a dependency
        </Button>

        {current.entries.length > 1 ? (
          <label className="editor-check">
            Satisfied when
            <select
              className="textbox"
              value={current.join}
              onChange={(event) => write({ ...current, join: event.target.value })}
              data-testid="flow-step-depends-join"
            >
              <option value="all">all of them are</option>
              <option value="any">any of them is</option>
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
};

export default DependsEditor;
