import React from 'react';
import KeyValueSection from '../KeyValueSection';
import OutputsTable from '../OutputsTable';

/**
 * 005 §6.2's Outputs tab — what a step publishes: `outputs` (001 §8.1) and `shared` (§9.1's write
 * side). Each is a mapping and a table; an output written in its `{ from, path }` form shows as that
 * JSON and is written back as the mapping when the text still parses as one. What the step computes
 * before its request (§8.7's `pre`) is a script, and has the Scripts tab.
 *
 * A `uses:` step publishes what its library exports (001 §12.1), and those come first: they are what
 * `outputs:` and `shared:` on the step have to name, and the author cannot see them without opening
 * the other file. They are read off the engine's description of the draft — the node carries them
 * when the library could be read — never off the library's text, which 002-C R4 keeps out of the
 * renderer.
 */
/** `shared:` is still a name and a name (§9.1); only `outputs:` needed a table of its own. */
const SHARED = { field: 'shared', label: 'Shared slots' };

const Exports = ({ step, node }) => {
  const exports = node && node.exports;
  return (
    <div className="editor-section" data-testid="flow-step-exports">
      <div className="editor-section-title">{`Exported by ${step.fields.uses}`}</div>
      {!exports ? <div className="editor-hint">The library could not be read — see the graph's diagnostics</div> : null}
      {exports && !exports.length ? <div className="editor-hint">The library exports nothing</div> : null}
      {(exports || []).map((entry) => (
        <div key={entry.name} className="editor-export-row" data-testid={`flow-step-export-${entry.name}`}>
          <code>{`steps.${step.id}.${entry.name}`}</code>
          <span className="editor-hint">{`← ${entry.source}`}</span>
        </div>
      ))}
    </div>
  );
};

const OutputsTab = ({ step, flow, model, node, onPatch }) => (
  <>
    {step.fields.uses !== undefined ? <Exports step={step} node={node} /> : null}
    {step.opaque.some((entry) => entry.key === 'outputs') ? null : (
      <OutputsTable step={step} flow={flow} model={model} onPatch={onPatch} />
    )}
    {step.opaque.some((entry) => entry.key === SHARED.field) ? null : (
      <KeyValueSection
        field={SHARED.field}
        label={SHARED.label}
        value={step.fields[SHARED.field]}
        testId={`flow-step-${SHARED.field}`}
        onPatch={onPatch}
      />
    )}
  </>
);

export default OutputsTab;
