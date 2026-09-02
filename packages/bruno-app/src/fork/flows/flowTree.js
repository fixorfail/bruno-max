/**
 * 002 §4.1a — the folder structure of a scope's `flows/` directory, as a tree the sidebar renders.
 *
 * The watcher already reports a flow at any depth (`flowsWatcher.js` walks the directory and watches
 * it 20 deep), so a flow in `flows/company/` has always reached the sidebar — it simply arrived as a
 * sibling of the top-level ones, with the directory that grouped it on disk saying nothing in the
 * app. Everything here is derivation from the entry's own fields; nothing new is read or watched.
 *
 * **The renderer derives the folder rather than the watcher reporting one.** `FlowTreeEntry` (002
 * §11.3) already carries the pathname and the scope root the folder sits between, so a `directory`
 * field would widen an IPC contract to carry what both ends can compute — and every entry already in
 * the slice would keep its old shape until the scope was listed again.
 */

/**
 * Paths are compared as POSIX text, on every platform.
 *
 * A pathname arrives from the main process with that platform's separators, so a Windows entry
 * carries backslashes; `path` in the renderer is browserify's POSIX build and would read
 * `flows\company\x.flow.yml` as one long filename. Splitting on the text is what makes the segments
 * come out the same on both — and what lets a unit test state a Windows path on any host.
 */
const toPosix = (value) => (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The directory a bucket's folders are counted from: `flows/` for a flow, `flows/scripts/` for
 * §4.5's scripts and `flows/fixtures/` for §4.6's fixtures.
 *
 * Each is measured from its own directory so the `Scripts` and `Fixtures` labels are not immediately
 * followed by a folder row saying the same thing a second time. It also means a nested helper reads by where it
 * sits *among the helpers*, which is the only comparison a reader of that list is making.
 */
export const baseDirectoryOf = (flow) => {
  const root = toPosix(flow.collectionRoot || flow.workspaceRoot);
  if (!root) {
    return '';
  }
  if (flow.script) {
    return `${root}/flows/scripts`;
  }
  return flow.fixture ? `${root}/flows/fixtures` : `${root}/flows`;
};

/**
 * The directories between a bucket's base and the file — `[]` for a flow sitting directly in it.
 *
 * An entry that does not sit under its own base is listed at the base rather than dropped. That is
 * not reachable through the watcher, which builds both from the same scope, but a flow vanishing
 * from the sidebar is the one outcome a grouping rule must never produce on its own.
 */
export const folderSegmentsOf = (flow) => {
  const base = baseDirectoryOf(flow);
  const pathname = toPosix(flow.pathname);
  if (!base || !pathname.startsWith(`${base}/`)) {
    return [];
  }
  return pathname
    .slice(base.length + 1)
    .split('/')
    .slice(0, -1)
    .filter(Boolean);
};

/**
 * What a row is identified by within its bucket — `create_company.flow.yml` at the top,
 * `company/create_company.flow.yml` below a folder.
 *
 * The `data-testid` is built from this rather than from the filename, which two folders may now
 * share: duplicate test ids do not fail loudly, they make `getByTestId` throw somewhere else. A flow
 * at the top of its bucket has no folders, so this *is* its filename and the ids that existed before
 * folders did are unchanged.
 */
export const relativePathOf = (flow) => [...folderSegmentsOf(flow), flow.filename].join('/');

/** §4.1: the author's own sentence about the flow, and its filename when it declares none. */
export const flowLabel = (flow) => flow.name || flow.filename;

/**
 * `key` is the folder's absolute path — what collapse state is stored under. `path` is the same
 * folder relative to its bucket's base, which is what a `data-testid` reads as and what a person
 * writing a selector would think to type.
 */
const emptyNode = (key, name, path) => ({ key, name, path, folders: [], flows: [] });

const sortNode = (node) => {
  // Folders above the flows beside them, each set by name. Upstream's collection tree reads the same
  // way, and a folder holding several rows is the heavier thing to skip past when it is not the one
  // you want.
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.flows.sort((a, b) => flowLabel(a).localeCompare(flowLabel(b)));
  node.folders.forEach(sortNode);
  return node;
};

/**
 * One bucket's flows as a tree.
 *
 * **A folder is keyed by its bucket and its absolute path**, which is what decides whether two folder
 * rows open together. Absolute, so the workspace's own `company` is not `payments/flows/company` —
 * two scopes routinely name their folders alike. And per bucket, because one directory holding both
 * an ordinary flow and a library is drawn as two rows either side of the `Libraries` label (§4.1),
 * and a row that opens when you click a different row is an unexplained jump.
 *
 * Only folders holding something appear: the watcher reports files, so an empty directory on disk is
 * not an entry and never becomes a row.
 */
export const buildFlowTree = (flows, bucket) => {
  const root = emptyNode('', '', '');

  for (const flow of flows) {
    let node = root;
    let key = `${bucket}:${baseDirectoryOf(flow)}`;
    let relative = '';

    for (const segment of folderSegmentsOf(flow)) {
      key = `${key}/${segment}`;
      relative = relative ? `${relative}/${segment}` : segment;
      let child = node.folders.find((folder) => folder.key === key);
      if (!child) {
        child = emptyNode(key, segment, relative);
        node.folders.push(child);
      }
      node = child;
    }

    node.flows.push(flow);
  }

  return sortNode(root);
};

/** Every folder key in a tree, for the header's expand and collapse actions. */
export const folderKeysOf = (node) =>
  node.folders.flatMap((folder) => [folder.key, ...folderKeysOf(folder)]);
