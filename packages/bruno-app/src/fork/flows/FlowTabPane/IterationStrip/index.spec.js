import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import IterationStrip from './index';

/**
 * 002 §8.3 — *a dataset flow gets an iteration selector; the graph shows one iteration at a time,
 * with a per-iteration status strip above it*, and *under `parallel: > 1` several iterations advance
 * at once and the strip shows that*.
 *
 * The graph can only draw one row, so without the strip a parallel dataset shows one iteration in
 * flight and says nothing at all about the others.
 */

const theme = themes.dark || Object.values(themes)[0];

const renderStrip = (run) => {
  const onSelect = jest.fn();
  render(
    <ThemeProvider theme={theme}>
      <IterationStrip run={run} onSelect={onSelect} />
    </ThemeProvider>
  );
  return onSelect;
};

const run = (extras) => ({ iterationCount: 3, selectedIteration: 0, steps: {}, iterationStatus: {}, ...extras });

describe('the iteration strip (§8.3)', () => {
  /** A flow with no dataset has one iteration, and a strip of one chip says nothing. */
  it('is absent for a flow that is not iterating', () => {
    renderStrip(run({ iterationCount: 1 }));

    expect(screen.queryByTestId('flow-iteration-strip')).not.toBeInTheDocument();
  });

  it('is absent when there is no run', () => {
    renderStrip(undefined);

    expect(screen.queryByTestId('flow-iteration-strip')).not.toBeInTheDocument();
  });

  /**
   * The three states are read off the events rather than folded out of the steps — 002-C R4 keeps
   * status derivation out of the renderer, and `iteration:end` is where the word comes from.
   */
  it('shows a row that has finished by the word the engine reported', () => {
    renderStrip(run({ steps: { 0: {} }, iterationStatus: { 0: 'failed' } }));

    expect(screen.getByTestId('flow-iteration-0')).toHaveAttribute('data-status', 'failed');
  });

  it('shows a row that has started and not finished as in flight', () => {
    renderStrip(run({ steps: { 0: {}, 1: {} }, iterationStatus: { 0: 'passed' } }));

    expect(screen.getByTestId('flow-iteration-1')).toHaveAttribute('data-status', 'running');
  });

  it('shows a row the run has not reached as pending', () => {
    renderStrip(run({ steps: { 0: {} } }));

    expect(screen.getByTestId('flow-iteration-2')).toHaveAttribute('data-status', 'pending');
  });

  /** The point of the strip under a parallel dataset: more than one row is in flight at once. */
  it('shows every row in flight, not only the one being drawn', () => {
    renderStrip(run({ steps: { 0: {}, 1: {}, 2: {} }, iterationStatus: { 0: 'passed' } }));

    expect(screen.getByTestId('flow-iteration-1')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('flow-iteration-2')).toHaveAttribute('data-status', 'running');
  });

  /** The selected iteration is just which one is drawn (§8.3), and the strip is a way to change it. */
  it('marks which row the graph is drawing, and selects another', () => {
    const onSelect = renderStrip(run({ selectedIteration: 1, steps: { 0: {}, 1: {} } }));

    expect(screen.getByTestId('flow-iteration-1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('flow-iteration-0')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('flow-iteration-2'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
