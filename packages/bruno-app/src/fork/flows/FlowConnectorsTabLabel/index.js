import { IconPlugConnected } from '@tabler/icons';

/**
 * 001 §8.5's connector file, in the tab strip.
 *
 * Upright rather than italic, which §4.3's is: this is an ordinary file edited in the ordinary way,
 * not the non-standard way into something that has its own surfaces. The icon carries what it is,
 * because `connectors.yml` in the strip would otherwise read as one more YAML file.
 */
const FlowConnectorsTabLabel = ({ tabName }) => (
  <>
    <IconPlugConnected size={14} strokeWidth={1.5} className="special-tab-icon flex-shrink-0" />
    <span className="ml-1 tab-name">{tabName || 'Connectors'}</span>
  </>
);

export default FlowConnectorsTabLabel;
