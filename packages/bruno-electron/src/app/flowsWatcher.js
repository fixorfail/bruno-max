const fs = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');

const FLOW_SUFFIX = '.flow.yml';
const IGNORED_DIRECTORIES = ['node_modules', '.git'];

const isFlowFile = (pathname) => pathname.endsWith(FLOW_SUFFIX);

/** A collection-scoped flow lives under the collection, a workspace-scoped one under the workspace (001 §5.1). */
const flowsDirectoryFor = ({ workspaceRoot, collectionRoot }) => path.join(collectionRoot || workspaceRoot, 'flows');

const buildEntry = (pathname, { workspaceRoot, collectionRoot }) => {
  const entry = { pathname, filename: path.basename(pathname), workspaceRoot };
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
 * **It parses nothing.** A flow that does not parse must still reach the sidebar so it can be opened
 * and its diagnostics read (002 §6); a watcher that read the file would have to invent something to
 * display for one that failed. The display name comes from `describeFlow` when the flow is opened.
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
