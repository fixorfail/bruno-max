import React from 'react';
import StyledWrapper from './StyledWrapper';

/**
 * The pane below the graph — 002 §9's step detail and 005 §6's step editor share this and nothing
 * else. One is a machine over attempts and captures, the other over a draft and a pending edit;
 * what they have in common is the chrome: the height the split hands down, a header row, a tab
 * strip, and a body that scrolls. Kept as one component so the pane opens and resizes the same way
 * whichever it is (005 §6.1).
 *
 * `testId` lands on the root, because the root is what every locator scopes to and what the split
 * measures. `className` is forwarded so a caller can extend the styles with `styled(BottomSheet)`
 * and keep its own rules beside its own markup.
 */
const BottomSheet = ({ height, testId, className, header, notice, tabs = [], activeTab, onSelectTab, tabTestId, children }) => (
  <StyledWrapper className={className} style={typeof height === 'number' ? { height } : undefined} data-testid={testId}>
    <div className="sheet-header">{header}</div>

    {notice}

    {/* A pane with nothing to switch between — a step that never ran — has no strip rather than an
        empty one, so its message sits directly under the name. */}
    {tabs.length ? (
      <div className="sheet-tabs">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            className={name === activeTab ? 'active' : ''}
            onClick={() => onSelectTab(name)}
            data-testid={tabTestId(name)}
          >
            {name}
          </button>
        ))}
      </div>
    ) : null}

    <div className="sheet-body">{children}</div>
  </StyledWrapper>
);

export default BottomSheet;
