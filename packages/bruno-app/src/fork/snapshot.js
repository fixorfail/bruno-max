/**
 * What the fork adds to the app's snapshot — 002 §7.2 and §4.2.
 *
 * **A leaf that imports nothing**, for `tabTypes.js`'s reason: it is called from upstream's
 * `middlewares/snapshot/serializeSnapshot.js`, and a fork module reached from there that pulled in
 * the component tree would close a loop through the store.
 *
 * It lives under `extras`, which is where upstream already keeps state that belongs to no collection
 * (`extras.devTools`, `extras.sidebar`). A key of its own at the top level would be a shape upstream
 * does not know about sitting beside the ones it does.
 */

/**
 * §7.2: *configuration is per flow and remembered across app restarts through the existing snapshot
 * middleware*.
 *
 * **Params and variable overrides are deliberately not written**, and that is a narrowing of §7.2
 * rather than a detail. The snapshot is a plaintext file under `userData`; a library flow's params
 * routinely hold a password (001 §12.5 marks them `secret:` for exactly that reason) and an
 * `--env-var` override is the app's equivalent of typing one on a command line. Everything Bruno
 * persists that can hold a secret goes through the `secrets` electron-store instead, and this file
 * is not that. What is left is what a run configuration is otherwise made of, and neither field can
 * carry a credential: how many steps run at once, and which dataset file to read.
 */
const persistableConfiguration = (configuration) => {
  const persisted = {};
  if (typeof configuration.concurrency === 'number') {
    persisted.concurrency = configuration.concurrency;
  }
  if (typeof configuration.dataset === 'string' && configuration.dataset) {
    persisted.dataset = configuration.dataset;
  }
  return Object.keys(persisted).length ? persisted : undefined;
};

/**
 * §4.2's tabs that upstream's snapshot cannot carry: the **workspace-scoped** ones.
 *
 * A flow tab belongs to a collection like every other tab, and a workspace-scoped flow borrows the
 * workspace's *scratch* collection — which `serializeSnapshot` skips entirely and the workspace's
 * own hydration excludes by uid. So those tabs are serialized here and restored by the fork; a
 * collection-scoped flow tab rides upstream's per-collection list exactly as a request tab does, and
 * writing it here too would restore it twice.
 *
 * The pathname and the type are the whole of a fork tab's identity (`fork/tabTypes.js`). The label
 * is not written, because it is not a property of the tab: `ForkSpecialTab` derives it from the flow
 * the tab is a view of, which is also what keeps the strip and §4.1's sidebar row from disagreeing
 * about a `meta.name` edited since.
 */
const workspaceFlowTabs = ({ tabs, flows, forkTabTypes }) => {
  const scopeOf = new Map(flows.map((flow) => [flow.pathname, flow]));

  return tabs
    .filter((tab) => forkTabTypes.includes(tab.type) && !scopeOf.get(tab.pathname)?.collectionRoot)
    .filter((tab) => scopeOf.has(tab.pathname))
    .map((tab) => ({
      pathname: tab.pathname,
      type: tab.type,
      workspaceRoot: scopeOf.get(tab.pathname).workspaceRoot
    }));
};

/**
 * The fork's section of the snapshot, merged over whatever the file already held.
 *
 * **Merged rather than replaced**, because the store holds only what this session has seen: a flow
 * whose scope was never opened has no configuration in memory, and a serializer that wrote the
 * store's view wholesale would erase the settings of every flow the user did not visit today.
 */
export const serializeFlowsSnapshot = ({ state, tabs, forkTabTypes, existing }) => {
  const configurations = { ...(existing?.configurations || {}) };

  for (const [pathname, configuration] of Object.entries(state?.configurations || {})) {
    const persisted = persistableConfiguration(configuration);
    if (persisted) {
      configurations[pathname] = persisted;
    } else {
      delete configurations[pathname];
    }
  }

  return {
    configurations,
    tabs: workspaceFlowTabs({ tabs: tabs || [], flows: state?.flows || [], forkTabTypes: forkTabTypes || [] })
  };
};

/** The fork's section of a snapshot read back, normalized so a hand-edited file cannot break a restore. */
export const readFlowsSnapshot = (snapshot) => {
  const section = snapshot?.extras?.flows;
  return {
    configurations: section && typeof section.configurations === 'object' ? section.configurations : {},
    tabs: Array.isArray(section?.tabs) ? section.tabs.filter((tab) => tab && tab.pathname && tab.type) : []
  };
};
