import React from 'react';
import StyledWrapper from './StyledWrapper';

/**
 * 003 §4 — a suite's per-flow status strip, above the graph.
 *
 * The tab draws one flow, because 002 §5.2 refuses to scale a graph to fit and two graphs side by
 * side are two scroll regions. What that costs is the shape of the whole suite, and under 003 §2
 * several flows advance at once — so the strip is where the rest of them are, and clicking a chip
 * opens that flow.
 *
 * This is 002 §8.3's `IterationStrip` one level up, deliberately: the interaction is one the reader
 * has already learned from a dataset run, and a second shape for the same idea would be a second
 * thing to learn.
 *
 * **Each chip's word is the engine's**, reported at `suite:flow-end` (001 §14.6). Nothing here folds
 * a flow's steps into a verdict — 002-C R4 keeps status derivation out of the renderer, and under
 * concurrency it would have to guess at a flow that has simply not finished yet.
 */

/**
 * `pending` until the suite reaches it, `running` from `suite:flow-start`, and the engine's own
 * outcome once `suite:flow-end` carries one. The reducer already holds all three (`slice.js`), so
 * this reads rather than derives.
 */
const stateOf = (flow) => {
  if (flow.state === 'done') {
    return flow.outcome || 'done';
  }
  return flow.state || 'pending';
};

const SuiteStrip = ({ suite, selectedEntry, onSelect }) => {
  // One flow is not a suite worth a strip — the tab is already showing it.
  if (!suite || !suite.flows || suite.flows.length <= 1) {
    return null;
  }

  return (
    <StyledWrapper data-testid="flow-suite-strip">
      <span className="suite-label">Suite</span>
      {suite.flows.map((flow) => {
        const state = stateOf(flow);
        const selected = flow.entry === selectedEntry;

        return (
          <button
            key={flow.entry}
            type="button"
            className={`suite-chip ${state}${selected ? ' is-selected' : ''}`}
            aria-pressed={selected}
            title={`${flow.name || flow.id} — ${state}`}
            data-status={state}
            data-testid={`flow-suite-${flow.id}`}
            onClick={() => onSelect(flow)}
          >
            {flow.name || flow.id}
          </button>
        );
      })}
    </StyledWrapper>
  );
};

export default SuiteStrip;
