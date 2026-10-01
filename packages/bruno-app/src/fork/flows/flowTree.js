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

/** A scope's `flows/` directory, from its root — where §4.1d's group label creates and reveals. */
export const flowsDirectoryOf = (root) => `${toPosix(root)}/flows`;

/** The directories between `base` and `pathname`, `pathname` itself included. */
const segmentsBelow = (base, pathname) =>
  base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split('/').filter(Boolean) : [];

/**
 * §4.1d: which bucket's tree a folder is drawn in — the scripts' or the fixtures' when it sits under
 * their directory, and otherwise the libraries' when it is in or under one of `libraryFolders`, and
 * the flows' when it is not.
 *
 * Libraries and flows share `flows/`, so the disk cannot say which of the two an empty folder is for.
 * `libraryFolders` is the session's answer: the folders made from the `Libraries` label.
 */
export const folderBucketOf = (folder, libraryFolders = []) => {
  const pathname = toPosix(folder.pathname);
  const [first] = segmentsBelow(flowsDirectoryOf(folder.collectionRoot || folder.workspaceRoot), pathname);
  if (first === 'scripts') return 'scripts';
  if (first === 'fixtures') return 'fixtures';

  const inLibraryFolder = libraryFolders.some((directory) => {
    const chosen = toPosix(directory);
    return pathname === chosen || pathname.startsWith(`${chosen}/`);
  });
  return inLibraryFolder ? 'libraries' : 'flows';
};

/**
 * The directory a bucket's folders are counted from, for a folder rather than a file. The libraries
 * count from `flows/`, as the flows do, so the disk's answer is the whole of it.
 */
const folderBaseOf = (folder) => {
  const bucket = folderBucketOf(folder);
  const base = flowsDirectoryOf(folder.collectionRoot || folder.workspaceRoot);
  return bucket === 'flows' ? base : `${base}/${bucket}`;
};

/**
 * §4.1d: the folders no listed file sits under — the ones only a folder entry can place.
 *
 * A folder holding a file is drawn wherever that file is, and drawing it from its folder entry as well
 * would put a folder of libraries into the flows' tree as an empty row beside the `Libraries` one.
 */
export const emptyFoldersOf = (folders, entries) => {
  const files = entries.map((entry) => toPosix(entry.pathname));
  return folders.filter((folder) => {
    const directory = `${toPosix(folder.pathname)}/`;
    return !files.some((file) => file.startsWith(directory));
  });
};

/**
 * The directories between a bucket's base and the file — `[]` for a flow sitting directly in it.
 *
 * An entry that does not sit under its own base is listed at the base rather than dropped. That is
 * not reachable through the watcher, which builds both from the same scope, but a flow vanishing
 * from the sidebar is the one outcome a grouping rule must never produce on its own.
 */
export const folderSegmentsOf = (flow) => segmentsBelow(baseDirectoryOf(flow), toPosix(flow.pathname)).slice(0, -1);

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
 * writing a selector would think to type. `directory` is the absolute path alone, which §4.1d's
 * menu and drop target act on.
 */
const emptyNode = (key, name, path, directory) => ({ key, name, path, directory, folders: [], flows: [] });

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
const keyPrefixOf = (bucket, base) => `${bucket}:${base}`;

/** The folder node at `segments` below `root`, created on the way down as needed. */
const folderAt = (root, bucket, base, segments) => {
  let node = root;
  let directory = base;
  let relative = '';

  for (const segment of segments) {
    directory = `${directory}/${segment}`;
    relative = relative ? `${relative}/${segment}` : segment;
    const key = keyPrefixOf(bucket, directory);
    let child = node.folders.find((folder) => folder.key === key);
    if (!child) {
      child = emptyNode(key, segment, relative, directory);
      node.folders.push(child);
    }
    node = child;
  }

  return node;
};

/**
 * `folders` are §4.1d's folder entries for this bucket that no file places — `emptyFoldersOf` — so
 * a folder made a moment ago is a row before anything is put in it.
 */
export const buildFlowTree = (flows, bucket, folders = []) => {
  const root = emptyNode('', '', '', '');

  for (const flow of flows) {
    const base = baseDirectoryOf(flow);
    folderAt(root, bucket, base, folderSegmentsOf(flow)).flows.push(flow);
  }

  for (const folder of folders) {
    const base = folderBaseOf(folder);
    folderAt(root, bucket, base, segmentsBelow(base, toPosix(folder.pathname)));
  }

  return sortNode(root);
};

/**
 * §4.1d: the keys of the folders an entry sits in, outermost first — what the section opens so the
 * row of the active tab can be seen.
 */
export const ancestorFolderKeysOf = (entry, bucket) => {
  const base = baseDirectoryOf(entry);
  let directory = base;
  return folderSegmentsOf(entry).map((segment) => {
    directory = `${directory}/${segment}`;
    return keyPrefixOf(bucket, directory);
  });
};

/**
 * §4.1d: whether `entry` may be dropped into `directory` — the renderer's half of the host's rule, so
 * a folder that would refuse the drop does not light up for it.
 *
 * Inside the entry's own bucket and nowhere else (a move never changes what a file is), never the
 * folder it is already in, and never the connector file, which the engine finds by its exact path.
 */
export const canMoveInto = (entry, directory) => {
  if (entry.connectors) {
    return false;
  }

  const base = baseDirectoryOf(entry);
  const target = toPosix(directory);
  const pathname = toPosix(entry.pathname);
  if (!base || (target !== base && !target.startsWith(`${base}/`))) {
    return false;
  }
  if (pathname.slice(0, pathname.lastIndexOf('/')) === target) {
    return false;
  }
  if (entry.script || entry.fixture) {
    return true;
  }
  return ![`${base}/scripts`, `${base}/fixtures`].some((inside) => target === inside || target.startsWith(`${inside}/`));
};

/** Every folder key in a tree, for the header's expand and collapse actions. */
export const folderKeysOf = (node) =>
  node.folders.flatMap((folder) => [folder.key, ...folderKeysOf(folder)]);
