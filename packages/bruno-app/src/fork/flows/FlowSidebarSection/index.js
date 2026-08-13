import React, { useMemo } from 'react';
import path from 'path';
import { useDispatch, useSelector } from 'react-redux';
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

  const groups = useMemo(() => groupFlows(flows), [flows]);

  const openFlow = (flow) => {
    dispatch(
      addTab({
        uid: uuid(),
        type: 'flow',
        pathname: flow.pathname,
        tabName: flow.filename,
        collectionUid: undefined
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
