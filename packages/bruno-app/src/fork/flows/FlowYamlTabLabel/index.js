import React from 'react';
import { IconPencil } from '@tabler/icons';

/**
 * 002 §4.3's tab label.
 *
 * The pencil and the italic name are the whole signal that this tab is the **non-standard** way to
 * edit a flow: everywhere else in the app a flow is edited through its own surfaces, and a tab that
 * looked like the run view's would be indistinguishable from one at a glance in the strip.
 */
const FlowYamlTabLabel = ({ tabName }) => (
  <>
    <IconPencil size={14} strokeWidth={1.5} className="special-tab-icon flex-shrink-0" />
    <span className="ml-1 tab-name italic">{tabName || 'Flow'}</span>
  </>
);

export default FlowYamlTabLabel;
