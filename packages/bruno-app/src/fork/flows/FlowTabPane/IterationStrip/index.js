import React from 'react';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §8.3 — a dataset flow's per-iteration status strip, above the graph.
 *
 * The graph draws one iteration at a time, because iterations are independent by contract (001 §9.4)
 * and overlaying them would need a node to hold several states at once. What that costs is the shape
 * of the whole run: under `dataset.parallel > 1` several rows advance together and the drawing shows
 * exactly one of them. The strip is where the rest of them are.
 *
 * **Each chip's word is the engine's**, reported at `iteration:end` (001 §13.2). Nothing here folds
 * an iteration's steps into a verdict — that is status derivation, which 002-C R4 keeps out of the
 * renderer, and under a parallel dataset it would have to guess at a row that has simply not
 * finished yet.
 */

/**
 * A row that has reported its outcome shows it; one with steps and no outcome is in flight; one the
 * run has not reached yet is pending. Which of the three is a fact the events already carry —
 * `iteration:start` opens the bucket and `iteration:end` fills the status.
 */
const stateOf = (run, index) => {
  const status = run.iterationStatus?.[index];
  if (status) {
    return status;
  }
  return run.steps?.[index] ? 'running' : 'pending';
};

const IterationStrip = ({ run, onSelect }) => {
  if (!run || run.iterationCount <= 1) {
    return null;
  }

  const selected = run.selectedIteration || 0;

  return (
    <StyledWrapper data-testid="flow-iteration-strip">
      {Array.from({ length: run.iterationCount }, (unused, index) => index).map((index) => {
        const state = stateOf(run, index);

        return (
          <button
            key={index}
            type="button"
            className={`iteration-chip ${state}${index === selected ? ' is-selected' : ''}`}
            aria-pressed={index === selected}
            title={`Iteration ${index + 1} — ${state}`}
            data-status={state}
            data-testid={`flow-iteration-${index}`}
            onClick={() => onSelect(index)}
          >
            {index + 1}
          </button>
        );
      })}
    </StyledWrapper>
  );
};

export default IterationStrip;
