import React from 'react';
import { IconSitemap } from '@tabler/icons';
import EnvironmentPicker from './EnvironmentPicker';
import StyledWrapper from './StyledWrapper';

/**
 * The header above a flow tab's strip — 002 §4.2.
 *
 * A flow tab borrows a collection so the app's tab model can hold it (§4.2), and that borrowing is
 * an implementation detail the user should never see. Upstream's `CollectionHeader` renders the
 * collection it is given: for a workspace-scoped flow that is the *scratch* collection, and its
 * header is the workspace's own — a workspace switcher, and the Overview and Environments tabs that
 * live there permanently. None of it has anything to do with the flow being looked at.
 *
 * So flows carry their own header, naming the feature. There is no workspace switcher, because there
 * is nothing to switch: which flows exist is the sidebar's question, and which one is open is the tab
 * strip's.
 *
 * **The environment selector is the exception, and it is here because this is where it lives.** A
 * collection's header ends with it (§7.2), so this is where someone looks for it — and since this
 * header stands in for that one, a flow that put it anywhere else would be asking them to learn a
 * second place for a control they already know.
 */
const FlowTabHeader = ({ tab }) => (
  <StyledWrapper data-testid="flow-tab-header">
    <div className="flex items-center gap-2 py-2 px-4">
      <IconSitemap size={18} strokeWidth={1.5} className="flow-header-icon" />
      <span className="flow-header-title">API Flows</span>

      {/* Last on the row, as it is on a collection's. */}
      <div className="flow-header-environment">
        <EnvironmentPicker collectionUid={tab.collectionUid} />
      </div>
    </div>
  </StyledWrapper>
);

export default FlowTabHeader;
