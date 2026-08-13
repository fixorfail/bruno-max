import React, { useMemo } from 'react';
import path from 'path';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import { IconSitemap } from '@tabler/icons';
import SidebarSection from 'components/Sidebar/SidebarSection';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.1 — one section, grouped by scope, rather than flows nested inside their collection.
 *
 * Nesting them in the collection tree would put fork logic inside upstream's most-churned recursive
 * renderer (`Sidebar/Collections/.../CollectionItem/`) and be re-merged forever, for an adjacency a
 * group header communicates nearly as well.
 */

const groupFlows = (flows) => {
  const groups = new Map();

  for (const flow of flows) {
    const root = flow.collectionRoot || flow.workspaceRoot;
    const label = flow.collectionRoot ? path.basename(flow.collectionRoot) : 'Workspace';
    const group = groups.get(root) || { root, label, flows: [] };
    group.flows.push(flow);
    groups.set(root, group);
  }

  // Workspace first, then collections by name — a stable order that does not depend on which
  // watcher reported first.
  return [...groups.values()]
    .map((group) => ({ ...group, flows: [...group.flows].sort((a, b) => a.pathname.localeCompare(b.pathname)) }))
    .sort((a, b) => {
      if (a.label === 'Workspace') return -1;
      if (b.label === 'Workspace') return 1;
      return a.label.localeCompare(b.label);
    });
};

const FlowSidebarSection = () => {
  const dispatch = useDispatch();
  const flows = useSelector((state) => state.flows.flows);
  const descriptions = useSelector((state) => state.flows.descriptions);
  const runs = useSelector((state) => state.flows.runs);
  const collections = useSelector((state) => state.collections.collections);
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);

  const groups = useMemo(() => groupFlows(flows), [flows]);

  /**
   * **Every tab in this app belongs to a collection**, and a workspace-level one belongs to the
   * workspace's *scratch* collection — which is how upstream's own `workspaceOverview` and
   * `workspaceEnvironments` tabs exist (`slices/workspaces/actions.js:668`). The tab strip renders
   * per active collection, `findTabByPathname` bails without a `collectionUid`, and the snapshot
   * middleware groups tabs by collection, so a tab without one is outside the model rather than
   * merely unusual.
   */
  const collectionUidFor = (flow) => {
    if (flow.collectionRoot) {
      return find(collections, (entry) => entry.pathname === flow.collectionRoot)?.uid;
    }
    return find(workspaces, (workspace) => workspace.uid === activeWorkspaceUid)?.scratchCollectionUid;
  };

  const openFlow = (flow) => {
    dispatch(
      addTab({
        uid: uuid(),
        type: 'flow',
        pathname: flow.pathname,
        tabName: flow.filename,
        collectionUid: collectionUidFor(flow),
        // Permanent rather than a preview tab. Upstream gets this from `nonReplaceableTabTypes`,
        // which flows must stay out of: that list is singleton *per type*, and it would collapse
        // every flow in a collection into one tab. Pathname dedupe is what a flow wants.
        preview: false
      })
    );
  };

  return (
    <SidebarSection id="flows" title="Flows" icon={IconSitemap} className="flows-section">
      <StyledWrapper>
        {groups.length === 0 ? <div className="flows-empty">No flows found</div> : null}

        {groups.map((group) => (
          <div key={group.root} className="flow-group">
            <div className="flow-group-label">{group.label}</div>
            {group.flows.map((flow) => {
              const run = runs[flow.pathname];
              // §4.1: a library flow is marked, because it is excluded from glob runs and running
              // one requires supplying parameters (001 §12.5).
              const isLibrary = descriptions[flow.pathname]?.description?.isLibrary;

              return (
                <div
                  key={flow.pathname}
                  className="flow-row"
                  data-testid={`flow-row-${flow.filename}`}
                  data-run-state={run?.state}
                  onClick={() => openFlow(flow)}
                >
                  <span className="flow-name">{flow.filename}</span>
                  {isLibrary ? <span className="flow-tag">library</span> : null}
                  {run ? <span className={`flow-run-mark ${run.status || run.state}`} /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </StyledWrapper>
    </SidebarSection>
  );
};

export default FlowSidebarSection;
