import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import SuiteStrip from './index';

/**
 * 003 §4 — *the tab shows the selected flow's graph, and a strip above it carries one chip per flow
 * in the suite with its live status*.
 *
 * The graph draws one flow (002 §5.2 refuses to scale it to fit), so without the strip a suite
 * running three flows at once shows one and says nothing about the other two. The sidebar's
 * `3 / 7` counter says how many are done and never which.
 */

const theme = themes.dark || Object.values(themes)[0];

const flow = (over = {}) => ({
  entry: '/w/flows/checkout.flow.yml',
  id: 'flows/checkout',
  name: 'Checkout',
  state: 'pending',
  scope: { workspaceRoot: '/w' },
  ...over
});

const renderStrip = (suite, selectedEntry) => {
  const onSelect = jest.fn();
  render(
    <ThemeProvider theme={theme}>
      <SuiteStrip suite={suite} selectedEntry={selectedEntry} onSelect={onSelect} />
    </ThemeProvider>
  );
  return onSelect;
};

const suiteOf = (flows) => ({ suiteId: 'suite-1', state: 'running', flows });

describe('SuiteStrip', () => {
  it('draws nothing when there is no suite', () => {
    renderStrip(null);

    expect(screen.queryByTestId('flow-suite-strip')).toBeNull();
  });

  it('draws nothing for a suite of one, which the tab is already showing', () => {
    renderStrip(suiteOf([flow()]));

    expect(screen.queryByTestId('flow-suite-strip')).toBeNull();
  });

  it('shows every flow in the suite, by name', () => {
    renderStrip(suiteOf([flow(), flow({ entry: '/w/flows/refund.flow.yml', id: 'flows/refund', name: 'Refund' })]));

    expect(screen.getByTestId('flow-suite-flows/checkout')).toHaveTextContent('Checkout');
    expect(screen.getByTestId('flow-suite-flows/refund')).toHaveTextContent('Refund');
  });

  /**
   * The case the strip exists for: two flows in flight at once, which is what 003 §2 makes possible
   * and what a progress counter cannot express.
   */
  it('marks more than one flow as running at the same time', () => {
    renderStrip(
      suiteOf([
        flow({ state: 'running' }),
        flow({ entry: '/w/flows/refund.flow.yml', id: 'flows/refund', name: 'Refund', state: 'running' })
      ])
    );

    expect(screen.getByTestId('flow-suite-flows/checkout')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('flow-suite-flows/refund')).toHaveAttribute('data-status', 'running');
  });

  /** 002-C R4: the engine's own word, not a verdict the renderer folded out of the steps. */
  it('carries the engine outcome once a flow has ended', () => {
    renderStrip(
      suiteOf([
        flow({ state: 'done', outcome: 'passed' }),
        flow({ entry: '/w/flows/refund.flow.yml', id: 'flows/refund', name: 'Refund', state: 'done', outcome: 'failed' })
      ])
    );

    expect(screen.getByTestId('flow-suite-flows/checkout')).toHaveAttribute('data-status', 'passed');
    expect(screen.getByTestId('flow-suite-flows/refund')).toHaveAttribute('data-status', 'failed');
  });

  it('marks the flow the tab is showing, and hands back the one that was clicked', () => {
    const refund = flow({ entry: '/w/flows/refund.flow.yml', id: 'flows/refund', name: 'Refund' });
    const onSelect = renderStrip(suiteOf([flow(), refund]), '/w/flows/checkout.flow.yml');

    expect(screen.getByTestId('flow-suite-flows/checkout')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('flow-suite-flows/refund')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('flow-suite-flows/refund'));

    // The whole entry, scope included: the caller opens a tab with it, and a selection can span a
    // workspace and the collections inside it.
    expect(onSelect).toHaveBeenCalledWith(refund);
  });
});
