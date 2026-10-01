/**
 * The scope every flow channel names — 002 §11.3. The preload has no channel allowlist, so each
 * handler checks the shape it was sent before it resolves a path against it.
 */
const requireScope = (scope) => {
  if (!scope || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot) {
    throw new Error('a flow scope needs a workspaceRoot');
  }
  return scope;
};

module.exports = { requireScope };
