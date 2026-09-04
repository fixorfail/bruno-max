const fs = require('fs/promises');
const { readFileSync } = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { readFlowMeta, flowSearchTerms } = require('@bruno-max/flow');

const FLOW_SUFFIX = '.flow.yml';
const IGNORED_DIRECTORIES = ['node_modules', '.git'];

/**
 * 002 §4.5's conventional home for 001 §8.6's raw-source helpers, directly inside the directory
 * already watched — so a script needs no second watcher and no second scope rule.
 */
const SCRIPTS_DIRECTORY = 'scripts';

/**
 * 002 §4.6's home for 001 §7.4's file sources — the JSON, YAML and CSV a flow reads through `!file`,
 * `bodyFile` and `dataset:`.
 *
 * A convention with meaning, exactly as `scripts/` is: `!file` resolves an ordinary relative path
 * from the flow, so a fixture may live anywhere, and it is the directory that makes one a *listed*
 * fixture. Listing every non-flow file under `flows/` instead would make the section a file browser.
 */
const FIXTURES_DIRECTORY = 'fixtures';

const isFlowFile = (pathname) => pathname.endsWith(FLOW_SUFFIX);

/** A collection-scoped flow lives under the collection, a workspace-scoped one under the workspace (001 §5.1). */
const scopeRootOf = ({ workspaceRoot, collectionRoot }) => collectionRoot || workspaceRoot;

const flowsDirectoryFor = (scope) => path.join(scopeRootOf(scope), 'flows');

/** Whether a path is inside one of `flows/`'s conventional subdirectories, at any depth. */
const isInFlowsSubdirectory = (pathname, scope, directory) => {
  const relative = path.relative(flowsDirectoryFor(scope), pathname);
  const [first] = relative.split(path.sep);
  return first === directory && !relative.startsWith('..');
};

/**
 * §4.5: a `.js` file under `flows/scripts/`, at any depth.
 *
 * **Only under that directory.** A `.js` beside a flow is an ordinary `use:` target and always was
 * (001 §8.6 takes any extension), and listing every one of them would make the section a file
 * browser rather than a place helpers are kept. The convention is what gives the section a meaning
 * to state.
 *
 * Nothing here reads the file. A script declares no name and no flag — it is source, and the only
 * thing the sidebar can honestly say about one is what it is called.
 */
const isScriptFile = (pathname, scope) =>
  path.extname(pathname).toLowerCase() === '.js' && isInFlowsSubdirectory(pathname, scope, SCRIPTS_DIRECTORY);

/**
 * §4.6: anything under `flows/fixtures/`, at any depth and whatever its extension.
 *
 * **Any extension, because a fixture has no single one.** 001 §7.4 reads JSON, YAML and CSV through
 * `!file`, takes a request body from a file of whatever type the operation wants, and attaches
 * documents — the `.pdf` in that section's own example included. An extension list would decide what
 * counts as data, which is the author's decision and not this file's.
 *
 * **A `.flow.yml` is a flow wherever it sits**, so a flow filed under `fixtures/` is still listed and
 * run as one rather than turning into an opaque data file because of where it was put.
 *
 * Nothing here reads the file. A fixture declares no name and no flag; whether its bytes are text at
 * all is decided when someone asks to open it, by the read that would have to succeed anyway.
 */
const isFixtureFile = (pathname, scope) =>
  !isFlowFile(pathname) && isInFlowsSubdirectory(pathname, scope, FIXTURES_DIRECTORY);

const isListedFile = (pathname, scope) =>
  isFlowFile(pathname) || isScriptFile(pathname, scope) || isFixtureFile(pathname, scope);

/**
 * What the sidebar knows about a flow nobody has opened: 002 §4.1's display name and library flag —
 * `meta.name` and `meta.library` — and the strings its search box matches the flow on. Nothing else
 * the file says.
 *
 * Read here rather than from `describeFlow` because the sidebar names every flow it lists and
 * describing one resolves its sub-flows and its OpenAPI documents, which `readSpec` will fetch over
 * the network: listing a directory is not a reason to do that once per flow.
 *
 * **The engine reads it, rather than this file parsing YAML itself.** 001 §5.4 gives the format local
 * tags, and a plain parser rejects `!file` as an unknown tag — so a watcher with its own parser would
 * report every flow using one as unreadable and quietly name it after its file. Failure stays
 * ordinary either way: a document that does not parse, or a file already gone by the time this runs,
 * still reports as an entry, named by its filename and matched by its path alone.
 *
 * **One read for both.** The terms are extracted from the text this already has rather than by a
 * second pass over the directory — the extraction is a parse rather than a describe precisely so a
 * listing can afford it, and a watcher reading every flow twice would spend that saving again.
 *
 * Synchronous so that a rapid add/change/unlink sequence reaches the renderer in the order chokidar
 * observed it; these are small documents in a directory the app is already watching.
 */
const flowFieldsOf = (pathname, scope) => {
  const scopeRoot = scopeRootOf(scope);
  try {
    const source = readFileSync(pathname, 'utf8');
    return { ...readFlowMeta(source), terms: flowSearchTerms(scopeRoot, pathname, source) };
  } catch (error) {
    return { terms: flowSearchTerms(scopeRoot, pathname) };
  }
};

const buildEntry = (pathname, scope) => {
  const { workspaceRoot, collectionRoot } = scope;
  const entry = { pathname, filename: path.basename(pathname), workspaceRoot };
  if (collectionRoot) {
    entry.collectionRoot = collectionRoot;
  }

  // §4.5 and §4.6: source and data, not documents — there is no `meta:` to read, and reading one
  // would be a file read per entry on every tree change for a field neither kind has. No search
  // terms either, for the same reason: a script and a fixture are matched on their filename, which
  // the entry already carries.
  if (!isFlowFile(pathname)) {
    if (isFixtureFile(pathname, scope)) {
      entry.fixture = true;
    } else {
      entry.script = true;
    }
    return entry;
  }

  const { name, library, terms } = flowFieldsOf(pathname, scope);
  if (name) {
    entry.name = name;
  }
  // 002 §4.1 groups the sidebar by it, so it has to be known for a flow nobody has opened — which is
  // every flow in the list. Absent rather than `false` when undeclared, like the fields around it.
  if (library) {
    entry.library = true;
  }
  // 001 §5.2's identity and `meta:`, plus each step's name and the scalars in its own `meta:`. The
  // list is what the sidebar's search box filters on, and it is the engine's extraction rather than
  // the sidebar's so that the box and `bru flow run --grep` agree about what a flow contains — which
  // is why a flow may match on a tag or a step name no row displays.
  entry.terms = terms;
  return entry;
};

const scanFlows = async (directory, scope) => {
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
        found.push(...(await scanFlows(target, scope)));
      }
    } else if (isListedFile(target, scope)) {
      found.push(target);
    }
  }
  return found;
};

/**
 * The flow tree behind the sidebar section — 002 §4.1, emitting 002 §11.3's `main:flow-tree-updated`.
 *
 * **It reads `meta.name` and `meta.library`, and indexes what a flow is searchable on.** A flow that
 * does not parse must still reach the sidebar so it can be opened and its diagnostics read (002 §6),
 * so all of it is best-effort and absence is ordinary; everything else the app draws still comes from
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
      if (isListedFile(pathname, scope)) {
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
    const pathnames = await scanFlows(flowsDirectoryFor(scope), scope);
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
