import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import CodeMarker from './index';

/**
 * B4.15 — 001 §8.2's script positions and §10.2's expression positions look alike in a form and
 * behave differently. The marker is where that difference is said, and its payload is the sentence:
 * an icon nobody can read the tooltip of has told the author nothing.
 */

describe('the code marker', () => {
  it('says the shared functions are in scope where they are', () => {
    render(<CodeMarker kind="script" />);

    expect(screen.getByTestId('flow-code-marker-script')).toHaveAccessibleName(/shared functions are in scope/i);
  });

  /** The box that most invites a shared function is the one that says least when you use one. */
  it('says they are not where they are not, and what to do instead', () => {
    render(<CodeMarker kind="expression" />);

    const marker = screen.getByTestId('flow-code-marker-expression');

    expect(marker).toHaveAccessibleName(/not in scope/i);
    expect(marker).toHaveAccessibleName(/compute the value in an output/i);
  });

  /**
   * The same sentence reaches a pointer, which is how most readers will meet it — through the app's
   * own tooltip rather than the browser's, which waits about a second and so is never read.
   */
  it('shows the app\'s tooltip on hover, not the browser\'s', async () => {
    const { container } = render(<CodeMarker kind="script" />);

    // A `title` is the one that waits about a second, so its absence is half the assertion.
    expect(screen.getByTestId('flow-code-marker-script')).not.toHaveAttribute('title');

    fireEvent.mouseOver(container.querySelector('[data-tooltip-id]'));

    expect(await screen.findByText(/shared functions are in scope/i)).toBeInTheDocument();
  });
});
