import React, { forwardRef, useMemo, useRef, useState } from 'react';
import path from 'path';
import { useDispatch, useSelector } from 'react-redux';
import { IconDots, IconEdit, IconPlus, IconSitemap } from '@tabler/icons';
import toast from 'react-hot-toast';
import Dropdown from 'components/Dropdown';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import { normalizePath } from 'utils/common/path';
import { collectionUidForScope } from '../collectionScope';
import { flowsFolderFor } from '../actions';
import CreateFlow from '../CreateFlow';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.1 — one section, grouped by scope, rather than flows nested inside their collection.
 *
 * Nesting them in the collection tree would put fork logic inside upstream's most-churned recursive
 * renderer (`Sidebar/Collections/.../CollectionItem/`) and be re-merged forever, for an adjacency a
 * group header communicates nearly as well.
 */

/**
 * The flows of the workspace the sidebar is currently showing — the same narrowing upstream's own
 * collection list does, and for the same reason: the sidebar is about one workspace at a time.
 *
 * **`state.flows.flows` is the union of every scope ever watched**, which is wider than it looks.
 * Electron sends `main:workspace-opened` for the default workspace *and* every previously opened one
 * at startup (`ipc/workspace.js`'s `main:renderer-ready`), each is watched, and nothing unwatches a
 * scope when the active workspace changes — `unwatchScope` exists and has no caller. Without this
 * filter the section lists every workspace's flows at once and switching workspaces changes nothing.
 *
 * **A collection-scoped flow is matched by its collection, not by `workspaceRoot`.** No emitter of
 * `main:collection-opened` passes a `workspacePath`, so `ipcEvents` falls back to the collection's own
 * path as the scope's workspace root; matching on that would hide every collection flow there is.
 * `workspace.collections` is the list upstream's `Sidebar/Collections` filters on, so the two sections
 * agree on what belongs to the workspace by construction.
 */
const flowsInWorkspace = (flows, workspace) => {
  if (!workspace) {
    return [];
  }

  const collectionRoots = new Set(
    (workspace.collections || []).map((entry) => entry.path).filter(Boolean).map(normalizePath)
  );
  const workspaceRoot = normalizePath(workspace.pathname);

  return flows.filter((flow) =>
    flow.collectionRoot
      ? collectionRoots.has(normalizePath(flow.collectionRoot))
      : Boolean(workspaceRoot) && normalizePath(flow.workspaceRoot) === workspaceRoot
  );
};

/**
 * 002 §4.3's row menu — the way into raw YAML editing, and the place any later per-flow action goes.
 *
 * `Dropdown` with a forwarded-ref trigger is upstream's own sidebar-row menu shape (`ApiSpecItem`),
 * reused rather than re-invented so the hover reveal, the placement and the tippy behaviour match the
 * rows above it. Its clicks are stopped here: every one of them lands on a row whose job is to open
 * the flow, and opening the run view behind the menu you just opened is not what any of them mean.
 */
const MenuIcon = forwardRef((props, ref) => (
  <div ref={ref} data-testid="flow-menu-trigger">
    <IconDots size={16} strokeWidth={1.5} />
  </div>
));

const FlowMenu = ({ flow, onEditYaml }) => {
  const dropdownRef = useRef();
  // Tippy's own `aria-expanded` would do for the CSS, but only while it keeps setting it on the
  // trigger; an open menu that vanished when the pointer left the row would be the failure.
  const [open, setOpen] = useState(false);

  return (
    <div className={`flow-menu${open ? ' is-open' : ''}`} onClick={(event) => event.stopPropagation()}>
      <Dropdown
        onCreate={(ref) => (dropdownRef.current = ref)}
        onShow={() => setOpen(true)}
        onHide={() => setOpen(false)}
        icon={<MenuIcon />}
        placement="bottom-end"
      >
        <div
          className="dropdown-item"
          data-testid={`flow-edit-yaml-${flow.filename}`}
          onClick={() => {
            dropdownRef.current.hide();
            onEditYaml();
          }}
        >
          <span className="dropdown-icon">
            <IconEdit size={16} strokeWidth={1.5} />
          </span>
          Edit Yaml
        </div>
      </Dropdown>
    </div>
  );
};

/**
 * §4.1: a flow reads by the `meta.name` it declares, and by its filename when it declares none. The
 * watcher carries the name on the tree entry, so a flow is named in the sidebar without having been
 * opened — nothing here would otherwise know it, and describing every listed flow to find out would
 * resolve each one's OpenAPI documents over the network.
 */
const flowLabel = (flow) => flow.name || flow.filename;

/**
 * §4.1: within a scope, library flows are listed last and under their own label.
 *
 * They are a different kind of thing to run: 001 §12.5 excludes them from a glob run, and running one
 * directly means supplying its `params:` first — so a list that interleaves them answers "what can I
 * run here" with a mix of flows and things that are really the parts other flows are built from.
 *
 * Only the libraries are labeled. The scope's header already names what the flows above are, and a
 * second header over them would be a heading per item type where one of the two types is the
 * exception — which is the same reason §5.1's markers mark what a step *has* rather than labeling
 * every step with what it is.
 */
const LIBRARY_LABEL = 'Libraries';

const sectionsOf = (flows, libraries) =>
  [
    { key: 'flows', label: undefined, flows },
    { key: 'libraries', label: LIBRARY_LABEL, flows: libraries }
  ].filter((section) => section.flows.length);

const groupFlows = (flows) => {
  const groups = new Map();

  for (const flow of flows) {
    const root = flow.collectionRoot || flow.workspaceRoot;
    const label = flow.collectionRoot ? path.basename(flow.collectionRoot) : 'Workspace';
    const group = groups.get(root) || { root, label, flows: [], libraries: [] };
    // The flag rides the watcher's tree entry (§11.3): the section lists flows nobody has opened, and
    // `describeFlow` — the only other source of it — resolves each flow's OpenAPI documents.
    (flow.library ? group.libraries : group.flows).push(flow);
    groups.set(root, group);
  }

  const byPathname = (a, b) => a.pathname.localeCompare(b.pathname);

  // Workspace first, then collections by name — a stable order that does not depend on which
  // watcher reported first.
  return [...groups.values()]
    .map((group) => ({ ...group, sections: sectionsOf([...group.flows].sort(byPathname), [...group.libraries].sort(byPathname)) }))
    .sort((a, b) => {
      if (a.label === 'Workspace') return -1;
      if (b.label === 'Workspace') return 1;
      return a.label.localeCompare(b.label);
    });
};

const FlowSidebarSection = () => {
  const dispatch = useDispatch();
  const flows = useSelector((state) => state.flows.flows);
  const runs = useSelector((state) => state.flows.runs);
  const collections = useSelector((state) => state.collections.collections);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);

  // The default workspace is the fallback upstream's collection list uses when the active uid names
  // a workspace that is no longer loaded.
  const activeWorkspace
    = workspaces.find((workspace) => workspace.uid === activeWorkspaceUid)
      || workspaces.find((workspace) => workspace.type === 'default');

  /**
   * The default location the form opens with, resolved before the form mounts rather than fetched
   * from inside it. `renderer:flow-folder` is a path join, so it settles in the same tick the click
   * does — and asking for it here is what keeps the form a plain controlled component with no
   * loading state of its own.
   *
   * `null` while closed, so the modal is not mounted; a directory string once it is.
   */
  const [newFlowDirectory, setNewFlowDirectory] = useState(null);

  const openCreateFlow = async () => {
    try {
      // A workspace with no path on record leaves the location blank, and Browse is the way in.
      setNewFlowDirectory(activeWorkspace?.pathname ? await dispatch(flowsFolderFor(activeWorkspace.pathname)) : '');
    } catch (error) {
      console.error(error);
      toast.error('An error occurred while resolving the flows folder');
    }
  };

  const sectionActions = (
    <MenuDropdown
      data-testid="flows-header-add-menu"
      items={[{ id: 'create-flow', leftSection: IconPlus, label: 'Create API Flow', onClick: openCreateFlow }]}
      placement="bottom-end"
    >
      <ActionIcon label="Add new Flow" data-testid="flows-header-add">
        <IconPlus size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
    </MenuDropdown>
  );

  const groups = useMemo(() => groupFlows(flowsInWorkspace(flows, activeWorkspace)), [flows, activeWorkspace]);

  /**
   * The tab strip renders per active collection, `findTabByPathname` bails without a
   * `collectionUid`, and the snapshot middleware groups tabs by collection — so a tab without one is
   * outside the model rather than merely unusual. `collectionScope` is where that resolution lives,
   * shared with §8.5's network rows, which need a collection for the same kind of reason.
   *
   * The flow names its own workspace rather than the fallback reading the *active* one. The two agree
   * for everything this section lists, and the resolution is shared with surfaces where they need
   * not: §8.5's network rows outlive the workspace switch that follows the run.
   */
  const openFlow = (flow, type) => {
    dispatch(
      addTab({
        uid: uuid(),
        type,
        pathname: flow.pathname,
        // §4.3's raw editor is a view of the file and is labelled with it; the run view is a view of
        // the flow, so its tab reads the way the sidebar row that opened it does.
        tabName: type === 'flow' ? flowLabel(flow) : flow.filename,
        collectionUid: collectionUidForScope({
          collectionRoot: flow.collectionRoot,
          workspaceRoot: flow.workspaceRoot,
          collections,
          workspaces
        }),
        // Permanent rather than a preview tab. Upstream gets this from `nonReplaceableTabTypes`,
        // which flows must stay out of: that list is singleton *per type*, and it would collapse
        // every flow in a collection into one tab. Pathname dedupe is what a flow wants.
        preview: false
      })
    );
  };

  return (
    <>
      {newFlowDirectory === null ? null : (
        <CreateFlow defaultDirectory={newFlowDirectory} onClose={() => setNewFlowDirectory(null)} />
      )}
      <SidebarSection
        id="flows"
        title="API Flows"
        icon={IconSitemap}
        actions={sectionActions}
        className="flows-section"
      >
        <StyledWrapper>
          {groups.length === 0 ? <div className="flows-empty">No flows found</div> : null}

          {groups.map((group) => (
            <div key={group.root} className="flow-group">
              <div className="flow-group-label">{group.label}</div>
              {group.sections.map((section) => (
                <div key={section.key} className="flow-subgroup">
                  {section.label ? (
                    <div className="flow-subgroup-label" data-testid={`flow-subgroup-${section.key}`}>
                      {section.label}
                    </div>
                  ) : null}
                  {section.flows.map((flow) => {
                    const run = runs[flow.pathname];

                    return (
                      <div
                        key={flow.pathname}
                        className="flow-row"
                        data-testid={`flow-row-${flow.filename}`}
                        data-run-state={run?.state}
                        onClick={() => openFlow(flow, 'flow')}
                      >
                        <span className="flow-name">{flowLabel(flow)}</span>
                        <div className="flow-row-actions">
                          {run ? <span className={`flow-run-mark ${run.status || run.state}`} /> : null}
                          <FlowMenu flow={flow} onEditYaml={() => openFlow(flow, 'flow-yaml')} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </StyledWrapper>
      </SidebarSection>
    </>
  );
};

export default FlowSidebarSection;
