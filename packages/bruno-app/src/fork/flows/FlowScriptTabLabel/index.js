import { IconFileCode } from '@tabler/icons';

/**
 * 002 §4.5's tab label.
 *
 * Upright rather than italic, which §4.3's is: a script is an ordinary file being edited in the
 * ordinary way, not the non-standard way into something that has its own surfaces. The icon carries
 * what kind of file it is, because in the strip the name alone would not.
 */
const FlowScriptTabLabel = ({ tabName }) => (
  <>
    <IconFileCode size={14} strokeWidth={1.5} className="special-tab-icon flex-shrink-0" />
    <span className="ml-1 tab-name">{tabName || 'Script'}</span>
  </>
);

export default FlowScriptTabLabel;
