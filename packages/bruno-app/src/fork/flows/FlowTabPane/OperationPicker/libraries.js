import { isPathExternalToBasePath } from 'utils/common/path';

/**
 * 005 §5.1 — the libraries a flow may `uses:`, from the watcher's tree.
 *
 * A library is a flow that declares `meta.library: true` (001 §12.5), and the tree entry carries the
 * flag for the same reason the sidebar reads it there: it is known for every flow without opening
 * one. Offered are the ones a run could resolve (001 §12.2): a file under the flow's own scope root
 * is reached by a relative path, one under the workspace root by a `workspace:` path, and one
 * anywhere else is not reachable and so not offered. A flow is never offered to itself — a step
 * that invokes its own file is the cycle 001 §12.4 refuses.
 */
/**
 * 005 §6.2 — the shared scripts a flow may `functions.use:` (001 §8.6), from the same tree: 002
 * §4.5's `.js` files under `flows/scripts/`, marked `script` by the watcher, and reachable only
 * under the flow's own scope root, since a `use:` entry resolves against the flow's directory and
 * is refused past that root (001 §7.4).
 */
export const reachableScripts = (flows, flow) => {
  if (!flow) {
    return [];
  }
  const scopeRoot = flow.collectionRoot || flow.workspaceRoot;

  return flows
    .filter((entry) => entry.script && !isPathExternalToBasePath(scopeRoot, entry.pathname))
    .sort((left, right) => left.filename.localeCompare(right.filename));
};

export const reachableLibraries = (flows, flow) => {
  if (!flow) {
    return [];
  }
  const scopeRoot = flow.collectionRoot || flow.workspaceRoot;
  const reachable = (pathname) =>
    !isPathExternalToBasePath(scopeRoot, pathname) || !isPathExternalToBasePath(flow.workspaceRoot, pathname);

  return flows
    .filter((entry) => entry.library && entry.pathname !== flow.pathname && reachable(entry.pathname))
    .sort((left, right) => (left.name || left.filename).localeCompare(right.name || right.filename));
};
