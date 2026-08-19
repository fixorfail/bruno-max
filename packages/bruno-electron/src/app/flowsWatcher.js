const fs = require('fs/promises');
const { readFileSync } = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { readFlowMeta } = require('@bruno-max/flow');

const FLOW_SUFFIX = '.flow.yml';
const IGNORED_DIRECTORIES = ['node_modules', '.git'];

const isFlowFile = (pathname) => pathname.endsWith(FLOW_SUFFIX);

/** A collection-scoped flow lives under the collection, a workspace-scoped one under the workspace (001 §5.1). */
const flowsDirectoryFor = ({ workspaceRoot, collectionRoot }) => path.join(collectionRoot || workspaceRoot, 'flows');

/**
 * 002 §4.1's display name and library flag — `meta.name` and `meta.library`, and nothing else the
 * file says.
 *
 * Read here rather than from `describeFlow` because the sidebar names every flow it lists and
 * describing one resolves its sub-flows and its OpenAPI documents, which `readSpec` will fetch over
 * the network: listing a directory is not a reason to do that once per flow.
 *
 * **The engine reads it, rather than this file parsing YAML itself.** 001 §5.4 gives the format local
 * tags, and a plain parser rejects `!file` as an unknown tag — so a watcher with its own parser would
 * report every flow using one as unreadable and quietly name it after its file. Failure stays
 * ordinary either way: a document that does not parse, or a file already gone by the time this runs,
 * still reports as an entry and is named by its filename.
 *
 * Synchronous so that a rapid add/change/unlink sequence reaches the renderer in the order chokidar
 * observed it; these are small documents in a directory the app is already watching.
 */
const declaredMetaOf = (pathname) => {
  try {
    return readFlowMeta(readFileSync(pathname, 'utf8'));
  } catch (error) {
    return {};
  }
};

const buildEntry = (pathname, { workspaceRoot, collectionRoot }) => {
  const entry = { pathname, filename: path.basename(pathname), workspaceRoot };
  const { name, library } = declaredMetaOf(pathname);
  if (name) {
    entry.name = name;
  }
  // 002 §4.1 groups the sidebar by it, so it has to be known for a flow nobody has opened — which is
  // every flow in the list. Absent rather than `false` when undeclared, like the fields around it.
  if (library) {
    entry.library = true;
  }
  if (collectionRoot) {
    entry.collectionRoot = collectionRoot;
  }
  return entry;
};

const scanFlows = async (directory) => {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A scope with no flows/ directory yet is the ordinary case, not a failure.
    return [];
  }

  const found = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.includes(entry.name)) {
        found.push(...(await scanFlows(target)));
      }
    } else if (isFlowFile(entry.name)) {
      found.push(target);
    }
  }
  return found;
};

/**
 * The flow tree behind the sidebar section — 002 §4.1, emitting 002 §11.3's `main:flow-tree-updated`.
 *
 * **It reads `meta.name` and `meta.library`, and nothing else.** A flow that does not parse must
 * still reach the sidebar so it can be opened and its diagnostics read (002 §6), so both are
 * best-effort and their absence is ordinary; everything else the app draws still comes from
 * `describeFlow` when the flow is opened.
 *
 * Unlike `apiSpecsWatcher`, this watches a *directory* per scope rather than a file per artifact,
 * because a flow appearing on disk has to appear in the sidebar without anyone having opened it.
 */
class FlowsWatcher {
  constructor() {
    this.watchers = {};
  }

  addWatcher(win, scope) {
    const watchDirectory = flowsDirectoryFor(scope);

    // The renderer calls this per open workspace and collection, so a repeat for a directory
    // already watched is ordinary — restarting would replay the whole tree as fresh additions.
    if (this.watchers[watchDirectory]) {
      return;
    }

    const watcher = chokidar.watch(watchDirectory, {
      ignoreInitial: false,
      usePolling: watchDirectory.startsWith('\\\\'),
      ignored: (pathname) => path.basename(pathname).startsWith('.') || IGNORED_DIRECTORIES.includes(path.basename(pathname)),
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 10
      },
      depth: 20
    });

    const report = (event) => (pathname) => {
      if (isFlowFile(pathname)) {
        win.webContents.send('main:flow-tree-updated', event, buildEntry(pathname, scope));
      }
    };

    watcher.on('add', report('addFile')).on('change', report('changeFile')).on('unlink', report('unlinkFile'));

    this.watchers[watchDirectory] = watcher;
  }

  /**
   * What is already on disk, so the slice has a defined moment at which the section is complete
   * rather than accumulating the watcher's initial `add` burst forever (002 §11.3).
   */
  async listFlows(scope) {
    const pathnames = await scanFlows(flowsDirectoryFor(scope));
    // Path order rather than directory-read order, so the sidebar reads the same on every machine.
    return pathnames.sort().map((pathname) => buildEntry(pathname, scope));
  }

  removeWatcher(scope) {
    const watchDirectory = flowsDirectoryFor(scope);
    const watcher = this.watchers[watchDirectory];
    if (!watcher) {
      return;
    }

    watcher.close();
    delete this.watchers[watchDirectory];
  }

  closeAllWatchers() {
    const closing = Object.values(this.watchers).map((watcher) => watcher.close());
    this.watchers = {};
    return Promise.allSettled(closing);
  }
}

module.exports = FlowsWatcher;
