import React from 'react';
import { IconSitemap } from '@tabler/icons';

/** 002 §4.2's tab label. §4.1 puts the run's pass/fail mark here too; the slice carries it. */
const FlowTabLabel = ({ tabName }) => (
  <>
    <IconSitemap size={14} strokeWidth={1.5} className="special-tab-icon flex-shrink-0" />
    <span className="ml-1 tab-name">{tabName || 'Flow'}</span>
  </>
);

export default FlowTabLabel;
