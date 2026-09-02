import { IconDatabase } from '@tabler/icons';

/**
 * 002 §4.6's tab label.
 *
 * Upright rather than italic, which §4.3's is: a fixture is an ordinary file being edited in the
 * ordinary way, not the non-standard way into something that has its own surfaces. A different icon
 * from §4.5's script, because in the strip the name alone would not say which of the two this is —
 * `seed.js` can be either.
 */
const FlowFixtureTabLabel = ({ tabName }) => (
  <>
    <IconDatabase size={14} strokeWidth={1.5} className="special-tab-icon flex-shrink-0" />
    <span className="ml-1 tab-name">{tabName || 'Fixture'}</span>
  </>
);

export default FlowFixtureTabLabel;
