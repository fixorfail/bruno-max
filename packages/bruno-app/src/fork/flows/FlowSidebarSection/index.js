import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import path from 'path';
import { useDispatch, useSelector } from 'react-redux';
import {
  IconChevronDown,
  IconChevronRight,
  IconCursorText,
  IconDots,
  IconDotsVertical,
  IconCopy,
  IconEdit,
  IconFoldDown,
  IconFoldUp,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSitemap
} from '@tabler/icons';
import toast from 'react-hot-toast';
import Dropdown from 'components/Dropdown';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { uuid } from 'utils/common';
import { normalizePath } from 'utils/common/path';
import { collectionUidForScope } from '../collectionScope';
import { cancelSuiteRun, flowsFolderFor, listFlowSuites, readFlowProperties, rerunFailedFlows } from '../actions';
import { buildFlowTree, flowLabel, folderKeysOf, relativePathOf } from '../flowTree';
import { folderToggled, foldersCollapsed, foldersExpanded } from '../slice';
import CreateFlow from '../CreateFlow';
import FlowProperties from '../FlowProperties';
import RenameScript from '../RenameScript';
import StyledWrapper, { SuiteProgress } from './StyledWrapper';

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
 * 002 §4.3's row menu — the way into raw YAML editing, §4.4's properties beside it, and §4.5's rename
 * on a script's own row.
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

const RowMenu = ({ items }) => {
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
        {items.map((item) => (
          <div
            key={item.testId}
            className="dropdown-item"
            data-testid={item.testId}
            onClick={() => {
              dropdownRef.current.hide();
              item.onClick();
            }}
          >
            <span className="dropdown-icon">
              <item.icon size={16} strokeWidth={1.5} />
            </span>
            {item.label}
          </div>
        ))}
      </Dropdown>
    </div>
  );
};

/**
 * Menu items are identified by the flow's bucket-relative path rather than its filename, for the
 * reason the row itself is (`relativePathOf`): two folders may hold a `create.flow.yml`, and a
 * duplicate `data-testid` fails in whichever test reaches for it second. A flow at the top of its
 * bucket has no folders, so the ids there are the filename ones that existed before folders did.
 */
const FlowMenu = ({ relativePath, onEditYaml, onEditProperties, onDuplicate }) => (
  <RowMenu
    items={[
      { testId: `flow-edit-yaml-${relativePath}`, icon: IconEdit, label: 'Edit Yaml', onClick: onEditYaml },
      {
        testId: `flow-properties-${relativePath}`,
        icon: IconSettings,
        label: 'Flow Properties',
        onClick: onEditProperties
      },
      { testId: `flow-duplicate-${relativePath}`, icon: IconCopy, label: 'Duplicate', onClick: onDuplicate }
    ]}
  />
);

/**
 * §4.5's row menu. One item, because a `.js` file has one thing about it to change: what it is
 * called. §4.3's `Edit Yaml` and §4.4's properties both act on a flow's `meta:`, which a script does
 * not have — and opening the script is what the row itself already does.
 */
const ScriptMenu = ({ relativePath, onRename }) => (
  <RowMenu
    items={[{ testId: `script-rename-${relativePath}`, icon: IconCursorText, label: 'Rename', onClick: onRename }]}
  />
);

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

/**
 * §4.5: the `.js` helpers in `flows/scripts/`, listed last and under their own label.
 *
 * Below the libraries for the same reason those sit below the flows: the list answers "what can I
 * run here" from the top down, and a script is the furthest thing from an answer to it — 001 §8.6
 * makes it source composed into flows rather than anything that runs on its own. They are listed at
 * all because `use:` is explicit and a helper nobody can see is a helper nobody names.
 */
const SCRIPT_LABEL = 'Scripts';

/**
 * §4.6: the data files in `flows/fixtures/`, listed last and under their own label.
 *
 * Below the scripts because the list answers "what can I run here" from the top down and a fixture is
 * the furthest thing from an answer to it — 001 §7.4 makes one an input a flow reads, which does not
 * run and is not composed into anything that does. They are listed for the reason scripts are: a
 * `!file` path is explicit, and a corpus nobody can see is a corpus nobody reuses.
 */
const FIXTURE_LABEL = 'Fixtures';

const sectionsOf = ({ flows, libraries, scripts, fixtures }) =>
  [
    { key: 'flows', label: undefined, flows },
    { key: 'libraries', label: LIBRARY_LABEL, flows: libraries },
    { key: 'scripts', label: SCRIPT_LABEL, flows: scripts },
    { key: 'fixtures', label: FIXTURE_LABEL, flows: fixtures }
  ]
    .filter((section) => section.flows.length)
    // §4.1a: each bucket is a tree of its own, counted from its own base — so a helper in
    // `flows/scripts/auth/` reads by where it sits among the helpers rather than repeating the
    // `Scripts` label as a `scripts` folder row directly beneath it.
    .map((section) => ({
      key: section.key,
      label: section.label,
      tree: buildFlowTree(section.flows, section.key)
    }));

/** Which of a group's three lists an entry belongs to — the watcher's flags, in precedence order. */
const bucketOf = (entry) => {
  if (entry.script) return 'scripts';
  if (entry.fixture) return 'fixtures';
  // The flag rides the watcher's tree entry (§11.3): the section lists flows nobody has opened, and
  // `describeFlow` — the only other source of it — resolves each flow's OpenAPI documents.
  return entry.library ? 'libraries' : 'flows';
};

const groupFlows = (flows) => {
  const groups = new Map();

  for (const flow of flows) {
    const root = flow.collectionRoot || flow.workspaceRoot;
    const label = flow.collectionRoot ? path.basename(flow.collectionRoot) : 'Workspace';
    const group = groups.get(root) || { root, label, flows: [], libraries: [], scripts: [], fixtures: [] };
    group[bucketOf(flow)].push(flow);
    groups.set(root, group);
  }

  // Workspace first, then collections by name — a stable order that does not depend on which
  // watcher reported first. Within a group, `buildFlowTree` orders each bucket.
  return [...groups.values()]
    .map((group) => ({ ...group, sections: sectionsOf(group) }))
    .sort((a, b) => {
      if (a.label === 'Workspace') return -1;
      if (b.label === 'Workspace') return 1;
      return a.label.localeCompare(b.label);
    });
};

/**
 * 002 §10: the newest suite of all the scopes the section is showing, with the scope it belongs to.
 *
 * Compared as strings because `startedAt` is ISO-8601, which sorts chronologically that way — the
 * same reason `listSuites` orders on the field rather than on the directory name.
 */
const newestOf = (listed) =>
  listed.reduce(
    (newest, candidate) => (!newest || candidate.suite.startedAt > newest.suite.startedAt ? candidate : newest),
    null
  );

/**
 * §4.1a: one folder of a bucket, and what is inside it when it is open.
 *
 * A closed folder renders none of its children, which is what upstream's collection tree does and is
 * more than cosmetic: the rows below carry the run marks and hover menus of flows the reader has
 * chosen not to look at.
 */
const FlowFolder = ({ folder, depth, expansion, onToggle, renderRow }) => {
  const expanded = Boolean(expansion[folder.key]);

  const toggle = () => onToggle(folder.key);

  return (
    <>
      <div
        className="flow-folder"
        style={{ '--flow-depth': depth }}
        data-testid={`flow-folder-${folder.path}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="flow-folder-chevron">
          {expanded ? <IconChevronDown size={12} stroke={1.5} /> : <IconChevronRight size={12} stroke={1.5} />}
        </span>
        <span className="flow-name">{folder.name}</span>
      </div>
      {expanded ? (
        <FlowNode node={folder} depth={depth + 1} expansion={expansion} onToggle={onToggle} renderRow={renderRow} />
      ) : null}
    </>
  );
};

/**
 * A tree level: its folders, then the flows sitting directly in it.
 *
 * `renderRow` is passed down rather than the handful of things a row needs, because every one of
 * them belongs to the section — the run map, the tab dispatch, the two dialogs — and threading them
 * through each level would make the recursion about the section's state rather than about the tree.
 */
// A function declaration, so the mutual recursion with `FlowFolder` reads in render order — folder
// row, then what is inside it — rather than being inverted to satisfy declaration order.
function FlowNode({ node, depth, expansion, onToggle, renderRow }) {
  return (
    <>
      {node.folders.map((folder) => (
        <FlowFolder
          key={folder.key}
          folder={folder}
          depth={depth}
          expansion={expansion}
          onToggle={onToggle}
          renderRow={renderRow}
        />
      ))}
      {node.flows.map((flow) => renderRow(flow, depth))}
    </>
  );
}

const FlowSidebarSection = () => {
  const dispatch = useDispatch();
  const flows = useSelector((state) => state.flows.flows);
  const runs = useSelector((state) => state.flows.runs);
  const suiteRun = useSelector((state) => state.flows.suiteRun);
  const sources = useSelector((state) => state.flows.sources);
  const folderExpansion = useSelector((state) => state.flows.folderExpansion);
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

  /**
   * §4.4's dialog opens on what the file says, so it is `null` until the read resolves and holds the
   * flow together with its `meta:` from then on. Read on open rather than carried on the tree entry:
   * the watcher reads every flow in a scope on every change, and it reads the two fields a row is
   * drawn from for that reason.
   */
  const [flowProperties, setFlowProperties] = useState(null);

  /** §4.5's rename, which needs no read: a script's only editable name is the one already listed. */
  const [renamingScript, setRenamingScript] = useState(null);

  /** §4.7's duplicate — the source flow and the `meta:` the form opens on, or `null` while closed. */
  const [duplicatingFlow, setDuplicatingFlow] = useState(null);

  /**
   * §4.4 refuses to open over unsaved YAML, and the refusal is the handling rather than a warning.
   *
   * The dialog edits the text **on disk**; a dirty editor means the disk is already behind what the
   * author is looking at, and the next auto-save would write the draft back over the properties they
   * had just set. Nothing on either surface would say that had happened. Saving or discarding first
   * is a decision only the author can make, so it is the one asked for.
   */
  /**
   * A flow's `meta:` as it is **on disk**, or nothing when the editor holds something else.
   *
   * §4.4 refuses to open over unsaved YAML, and the refusal is the handling rather than a warning.
   * The dialog edits the text on disk; a dirty editor means the disk is already behind what the
   * author is looking at, and the next auto-save would write the draft back over the properties they
   * had just set. Nothing on either surface would say that had happened. Saving or discarding first
   * is a decision only the author can make, so it is the one asked for.
   */
  const readSavedProperties = async (flow, doing) => {
    const source = sources[flow.pathname];
    if (source && source.content !== source.saved) {
      toast.error('This flow has unsaved YAML changes — save or discard them first');
      return undefined;
    }

    try {
      return await dispatch(readFlowProperties(flow));
    } catch (error) {
      toast.error(error?.message || `An error occurred while ${doing}`);
      return undefined;
    }
  };

  const openFlowProperties = async (flow) => {
    const properties = await readSavedProperties(flow, 'reading the flow properties');
    if (properties) {
      setFlowProperties({ flow, properties });
    }
  };

  /**
   * §4.7's duplicate opens the create form on the source's own `meta:`, and the copy the host makes
   * is of the file on disk.
   *
   * It refuses over an unsaved editor for §4.4's reason, sharpened: the properties dialog would have
   * written a draft back over the author's edits, and this reads a document the author is looking at
   * a different version of — a duplicate silently missing the last ten minutes of work, in a file
   * they would go on to edit as though it had them.
   */
  const openDuplicateFlow = async (flow) => {
    const properties = await readSavedProperties(flow, 'reading the flow');
    if (properties) {
      setDuplicatingFlow({ flow, properties, directory: path.dirname(flow.pathname) });
    }
  };

  const openCreateFlow = async () => {
    try {
      // A workspace with no path on record leaves the location blank, and Browse is the way in.
      setNewFlowDirectory(activeWorkspace?.pathname ? await dispatch(flowsFolderFor(activeWorkspace.pathname)) : '');
    } catch (error) {
      console.error(error);
      toast.error('An error occurred while resolving the flows folder');
    }
  };

  const groups = useMemo(() => groupFlows(flowsInWorkspace(flows, activeWorkspace)), [flows, activeWorkspace]);

  /**
   * §4.1a's header actions act on the folders the section is currently showing, so the keys are
   * collected from the rendered groups rather than from the store — which holds every scope watched
   * since launch (§4.1).
   */
  const folderKeys = useMemo(
    () => groups.flatMap((group) => group.sections.flatMap((section) => folderKeysOf(section.tree))),
    [groups]
  );

  /**
   * §10's capture roots the section can retry from — the scopes it is showing, which the grouping
   * has already settled. Deriving them a second time from the active workspace would be a second
   * answer to a question `flowsInWorkspace` has answered, and the two would disagree the first time
   * either changed.
   */
  const scopeRoots = useMemo(() => groups.map((group) => group.root), [groups]);

  /** §10's newest suite across those scopes, or `null` while nothing has been run in any of them. */
  const [newestSuite, setNewestSuite] = useState(null);

  useEffect(() => {
    let current = true;

    /**
     * Listed per scope and compared afterwards, rather than assuming the workspace's own: a
     * collection's flows record their runs under the collection's capture root, so "the last thing
     * I ran here" is as likely to be one of those as one of the workspace's.
     */
    Promise.all(
      scopeRoots.map((scopeRoot) =>
        dispatch(listFlowSuites(scopeRoot))
          .then((suites) => (suites || []).map((suite) => ({ scopeRoot, suite })))
          .catch(() => []))
    ).then((listed) => current && setNewestSuite(newestOf(listed.flat())));

    return () => {
      current = false;
    };
    // Re-listed when a suite ends, so a further retry names the suite that just ran rather than the
    // one it replaced.
  }, [dispatch, scopeRoots, suiteRun?.state]);

  const notPassed = newestSuite ? newestSuite.suite.flows.filter((record) => record.outcome !== 'passed') : [];

  /**
   * §10's retry, in the header rather than on a row: it is about the last *suite*, which belongs to
   * the scope and to nothing the reader can point at in the list.
   *
   * Offered only once something has run — with no suite there is nothing a retry could name — and
   * **disabled rather than hidden** when that suite passed entirely, because "nothing to retry" is
   * an answer and an absent control is not one.
   *
   * A roster rebuilt from run directories (`partial`) is offered on the same terms. It can only
   * under-count: what is missing from it are the flows that never ran, and hiding the action would
   * trade a retry of the failures it does name for no retry at all.
   *
   * **While a suite is running the entry is Cancel.** The runner opens one suite directory and works
   * through it in order, so a second suite started over the first is not a state to offer.
   *
   * `MenuDropdown` derives an item's `data-testid` from the menu's own, so the ids §5 names ride the
   * label.
   */
  const suiteActions = () => {
    if (suiteRun && suiteRun.state === 'running') {
      return [
        {
          id: 'cancel-suite',
          leftSection: IconPlayerStop,
          label: <span data-testid="flow-suite-cancel">Cancel</span>,
          onClick: () => dispatch(cancelSuiteRun(suiteRun.suiteId))
        }
      ];
    }

    if (!newestSuite) {
      return [];
    }

    return [
      {
        id: 'rerun-failed',
        leftSection: IconRefresh,
        label: <span data-testid="flow-rerun-failed">{`Rerun failed flows (${notPassed.length})`}</span>,
        disabled: notPassed.length === 0,
        onClick: () =>
          dispatch(rerunFailedFlows({ scopeRoot: newestSuite.scopeRoot, suite: newestSuite.suite }))
      }
    ];
  };

  /**
   * Both actions are offered whenever there are folders at all, rather than one of them switching to
   * the other once everything is open.
   *
   * A menu item that changes meaning between two openings of the same menu is a control you have to
   * read before clicking, and the state it reflects — every folder in every scope — is not one the
   * reader can see. Upstream's own collection menu carries `Collapse` unconditionally for the same
   * reason.
   */
  const folderActions = folderKeys.length
    ? [
        {
          id: 'expand-folders',
          leftSection: IconFoldUp,
          label: 'Expand All Folders',
          onClick: () => dispatch(foldersExpanded({ keys: folderKeys }))
        },
        {
          id: 'collapse-folders',
          leftSection: IconFoldDown,
          label: 'Collapse All Folders',
          onClick: () => dispatch(foldersCollapsed({ keys: folderKeys }))
        }
      ]
    : [];

  const menuActions = [...suiteActions(), ...folderActions];
  const suiteProgress = suiteRun && suiteRun.state === 'running'
    ? `${suiteRun.flows.filter((flow) => flow.state === 'done').length} / ${suiteRun.flows.length}`
    : undefined;

  /**
   * Creating is the section's one *additive* action and the folder actions are about the tree that is
   * already there, so they are two controls rather than one menu: the header reads left to right as
   * add, then act on what is listed, which is the arrangement §4.1a's neighbour sections already use.
   *
   * **The `+` is the action, not a menu of one.** With the folder items moved out it had a single
   * entry left, and a dropdown that exists to be dismissed is a click spent on nothing —
   * `MockServersSection` binds its `+` straight to the thing it creates for the same reason.
   *
   * **The overflow menu is absent rather than empty when there is nothing behind it.** An enabled
   * control that opens onto nothing is a worse answer than no control, and both lists are already
   * empty in exactly that case — no folders to fold, and nothing ever run in the scopes on show.
   *
   * §10's progress sits in the header rather than in the menu holding Cancel: a suite runs for
   * minutes and the whole point of the count is to be readable without opening anything.
   */
  const sectionActions = (
    <>
      {suiteProgress ? <SuiteProgress data-testid="flow-suite-progress">{suiteProgress}</SuiteProgress> : null}

      <ActionIcon label="Add new Flow" onClick={openCreateFlow} data-testid="flows-header-add">
        <IconPlus size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>

      {menuActions.length ? (
        <MenuDropdown data-testid="flows-header-actions-menu" items={menuActions} placement="bottom-end">
          <ActionIcon label="More actions" data-testid="flows-header-actions">
            <IconDotsVertical size={14} stroke={1.5} aria-hidden="true" />
          </ActionIcon>
        </MenuDropdown>
      ) : null}
    </>
  );

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
        // §4.3's raw editor and §4.5's script are views of a file and are labelled with it; the run
        // view is a view of the flow, so its tab reads the way the sidebar row that opened it does.
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

  const toggleFolder = (key) => dispatch(folderToggled({ key }));

  /**
   * One row of a bucket's tree, at the depth the tree put it. §4.5's scripts carry a rename and
   * nothing else, and every other row carries §4.3's editor and §4.4's properties.
   */
  const renderRow = (flow, depth) => {
    const relativePath = relativePathOf(flow);

    /**
     * §4.5: a script row opens the file and carries no flow menu. Neither item on it means anything
     * here — there is no `meta:` to edit and no YAML to edit it as — and a menu holding nothing is
     * worse than no menu.
     */
    if (flow.script) {
      return (
        <div
          key={flow.pathname}
          className="flow-row"
          style={{ '--flow-depth': depth }}
          data-testid={`flow-row-${relativePath}`}
          onClick={() => openFlow(flow, 'flow-script')}
        >
          <span className="flow-name">{flow.filename}</span>
          <div className="flow-row-actions">
            <ScriptMenu relativePath={relativePath} onRename={() => setRenamingScript(flow)} />
          </div>
        </div>
      );
    }

    /**
     * §4.6: a fixture row opens the file as text and carries no menu. Like a script it has no
     * `meta:` to edit and no YAML to edit it as; unlike one it has no rename either, because
     * `!file` and `bodyFile` name a fixture by the path written in each flow that reads it and
     * nothing here would rewrite them.
     */
    if (flow.fixture) {
      return (
        <div
          key={flow.pathname}
          className="flow-row"
          style={{ '--flow-depth': depth }}
          data-testid={`flow-row-${relativePath}`}
          onClick={() => openFlow(flow, 'flow-fixture')}
        >
          <span className="flow-name">{flow.filename}</span>
        </div>
      );
    }

    const run = runs[flow.pathname];

    return (
      <div
        key={flow.pathname}
        className="flow-row"
        style={{ '--flow-depth': depth }}
        data-testid={`flow-row-${relativePath}`}
        data-run-state={run?.state}
        onClick={() => openFlow(flow, 'flow')}
      >
        <span className="flow-name">{flowLabel(flow)}</span>
        <div className="flow-row-actions">
          {run ? <span className={`flow-run-mark ${run.status || run.state}`} /> : null}
          <FlowMenu
            relativePath={relativePath}
            onEditYaml={() => openFlow(flow, 'flow-yaml')}
            onEditProperties={() => openFlowProperties(flow)}
            onDuplicate={() => openDuplicateFlow(flow)}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      {newFlowDirectory === null ? null : (
        <CreateFlow defaultDirectory={newFlowDirectory} onClose={() => setNewFlowDirectory(null)} />
      )}
      {duplicatingFlow === null ? null : (
        <CreateFlow
          defaultDirectory={duplicatingFlow.directory}
          source={duplicatingFlow}
          onClose={() => setDuplicatingFlow(null)}
        />
      )}
      {flowProperties === null ? null : (
        <FlowProperties
          flow={flowProperties.flow}
          properties={flowProperties.properties}
          onClose={() => setFlowProperties(null)}
        />
      )}
      {renamingScript === null ? null : (
        <RenameScript script={renamingScript} onClose={() => setRenamingScript(null)} />
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
                  <FlowNode
                    node={section.tree}
                    depth={0}
                    expansion={folderExpansion}
                    onToggle={toggleFolder}
                    renderRow={renderRow}
                  />
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
