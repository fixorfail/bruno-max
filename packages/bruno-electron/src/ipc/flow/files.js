const fs = require('fs');
const path = require('path');
const { ipcMain, shell } = require('electron');
const { rebaseFlowPaths } = require('@bruno-max/flow');
const {
  flowsDirectoryFor,
  SCRIPTS_DIRECTORY,
  FIXTURES_DIRECTORY,
  CONNECTOR_FILENAME,
  IGNORED_DIRECTORIES
} = require('../../app/flowsWatcher');
const { requireScope } = require('./scope');

/**
 * 002 §4.1d — the sidebar's file management: a new folder, a move into or out of one, and a reveal
 * in the platform's file manager.
 *
 * All three act only inside the `flows/` directory of the scope they name. The preload forwards any
 * channel string, so that containment is the handler's to enforce, as §4.3's is.
 */

/** `path.relative` rather than a prefix test: `/a/flows-two` starts with `/a/flows` and is not inside it. */
const isWithin = (target, directory) => {
  const relative = path.relative(directory, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * A rename that refuses to land on a file already there.
 *
 * `rename` overwrites its target silently on POSIX, so the check is the only thing standing between
 * a rename and somebody else's file. It is not atomic with the rename that follows — the window is a
 * directory nobody else is writing to, and losing the race is what `wx` guards against in
 * `createFlowHandler`, for which a rename has no equivalent flag.
 */
const renameWithin = async (pathname, target, kind) => {
  if (target === pathname) {
    return pathname;
  }

  const clash = await fs.promises.access(target).then(() => true, () => false);
  if (clash) {
    throw new Error(`a ${kind} already exists at ${target}`);
  }

  await fs.promises.rename(pathname, target);
  return target;
};

/**
 * The directory a listed file may move within, and the ones inside it that it may not move into.
 *
 * **A move never changes what a file is.** §4.5 and §4.6 make the directory what makes a `.js` a
 * listed script and a data file a listed fixture, so a script moved out of `flows/scripts/` would
 * leave the sidebar as the result of a drag. A flow stays out of both for the mirror reason: filed
 * there, it would be listed as a flow in a folder named after the thing it is not.
 */
const bucketOf = (pathname, scope) => {
  const flows = flowsDirectoryFor(scope);
  const scripts = path.join(flows, SCRIPTS_DIRECTORY);
  const fixtures = path.join(flows, FIXTURES_DIRECTORY);

  if (!isWithin(pathname, flows) || pathname === flows) {
    throw new Error('the file is outside the scope flows directory');
  }
  // §8.5: the engine finds the connector file at exactly this path, so a moved one is a file the run
  // no longer reads.
  if (pathname === path.join(flows, CONNECTOR_FILENAME)) {
    throw new Error(`${CONNECTOR_FILENAME} cannot be moved — flows read it from flows/${CONNECTOR_FILENAME}`);
  }
  if (pathname.endsWith('.flow.yml')) {
    return { base: flows, excluded: [scripts, fixtures], kind: 'flow' };
  }
  if (isWithin(pathname, scripts)) {
    return { base: scripts, excluded: [], kind: 'script' };
  }
  if (isWithin(pathname, fixtures)) {
    return { base: fixtures, excluded: [], kind: 'fixture' };
  }
  throw new Error('the file is not a flow, a script or a fixture');
};

const requireDirectory = async (directory) => {
  const stats = await fs.promises.stat(directory).catch(() => undefined);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`${directory} is not a folder`);
  }
};

/**
 * `renderer:flow-move` — one listed file into another folder of its bucket. Returns where it went.
 *
 * **A flow's own relative paths move with it** (`rebaseFlowPaths`). Renamed first and rewritten
 * after, so a failure between the two leaves one file with its old paths rather than two files or
 * none. Paths *to* the moved file are not followed, for §4.5's reason: `bru flow validate` reports
 * each one.
 *
 * A flow whose text does not parse is refused rather than moved as it is: its paths cannot be found,
 * and moving it would break them without a word.
 */
const moveFlowEntryHandler = async ({ entry, scope, directory }) => {
  requireScope(scope);
  if (typeof entry !== 'string' || typeof directory !== 'string' || !directory) {
    throw new Error('a move needs a file and a folder');
  }

  const pathname = path.resolve(entry);
  const destination = path.resolve(directory);
  const { base, excluded, kind } = bucketOf(pathname, scope);

  if (!isWithin(destination, base) || excluded.some((inside) => isWithin(destination, inside))) {
    throw new Error(`a ${kind} cannot be moved to ${destination}`);
  }
  await requireDirectory(destination);

  const target = path.join(destination, path.basename(pathname));
  if (target === pathname) {
    return pathname;
  }

  if (kind !== 'flow') {
    return renameWithin(pathname, target, kind);
  }

  const text = await fs.promises.readFile(pathname, 'utf8');
  const rebased = rebaseFlowPaths(text, pathname, target);
  if (rebased === undefined) {
    throw new Error(`${path.basename(pathname)} is not a YAML document — fix it in the YAML editor first`);
  }

  await renameWithin(pathname, target, kind);
  if (rebased !== text) {
    await fs.promises.writeFile(target, rebased, 'utf8');
  }
  return target;
};

/**
 * `renderer:flow-create-folder` — one new, empty folder. Returns its path.
 *
 * `flows/scripts` and `flows/fixtures` are refused at the top of `flows/`: they are §4.5's and §4.6's
 * bucket directories, drawn as labels rather than folders, so the folder the author asked for would
 * never appear. A dot-folder and an ignored name are refused because the watcher never reports them.
 */
const createFlowFolderHandler = async ({ scope, parent, name }) => {
  const flows = flowsDirectoryFor(requireScope(scope));
  const folder = typeof name === 'string' ? name.trim() : '';

  if (!folder || folder !== path.basename(folder) || /[\\/]/.test(folder) || folder.startsWith('.')) {
    throw new Error(`${name} is not a valid folder name`);
  }
  if (IGNORED_DIRECTORIES.includes(folder)) {
    throw new Error(`${folder} is not listed in the sidebar — choose a different name`);
  }
  if (typeof parent !== 'string' || !isWithin(path.resolve(parent), flows)) {
    throw new Error('a folder has to be created inside the scope flows directory');
  }

  const directory = path.resolve(parent);
  if (directory === flows && [SCRIPTS_DIRECTORY, FIXTURES_DIRECTORY].includes(folder)) {
    throw new Error(`flows/${folder} is where the ${folder} are kept — choose a different name`);
  }

  // `recursive` so a new folder can go in a scope that has no `flows/` yet; the existence check is
  // then explicit, because a recursive `mkdir` succeeds on a folder that is already there.
  const pathname = path.join(directory, folder);
  const exists = await fs.promises.access(pathname).then(() => true, () => false);
  if (exists) {
    throw new Error(`a file or folder named ${folder} already exists there`);
  }
  await fs.promises.mkdir(pathname, { recursive: true });
  return pathname;
};

/**
 * `renderer:flow-reveal` — a listed file or folder in the platform's file manager.
 *
 * A channel of its own rather than upstream's `renderer:show-in-folder`: the sidebar holds a folder's
 * path as POSIX text (§4.1a), and resolving it here is what gives Windows its own separators. The
 * scope check keeps it to what the section lists.
 */
const revealFlowPathHandler = ({ scope, pathname }) => {
  const flows = flowsDirectoryFor(requireScope(scope));
  const resolved = typeof pathname === 'string' && pathname ? path.resolve(pathname) : '';
  if (!resolved || !isWithin(resolved, flows)) {
    throw new Error('only a file or folder inside the scope flows directory can be revealed');
  }
  shell.showItemInFolder(resolved);
};

const registerFlowFileIpc = () => {
  ipcMain.handle('renderer:flow-create-folder', (event, request) => createFlowFolderHandler(request));
  ipcMain.handle('renderer:flow-move', (event, request) => moveFlowEntryHandler(request));
  ipcMain.handle('renderer:flow-reveal', (event, request) => revealFlowPathHandler(request));
};

module.exports = {
  registerFlowFileIpc,
  createFlowFolderHandler,
  moveFlowEntryHandler,
  revealFlowPathHandler,
  renameWithin
};
