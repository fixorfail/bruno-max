const fs = require('fs');
const path = require('path');
const { parseDotEnv } = require('@usebruno/filestore');
const { getEnvVars } = require('../../utils/collection');

/**
 * 002 §7.2's variable tiers, flattened but **never merged**.
 *
 * 001 §13.2 hands the engine tiers rather than a map because §7.3's precedence chain is a flow
 * semantic: a host that merged would let the app and the CLI disagree about which scope wins. What
 * this module does is the part that *is* the host's — turning each tier's variable entries into the
 * `Vars` the engine names, and finding the `.env` the renderer never had.
 */

/**
 * `getEnvVars` appends `__name__` for `bru.getEnvName()`. It is a request-path convention rather
 * than a variable an author declared, and leaving it in would make `{{__name__}}` resolve in the app
 * and not in `bru`.
 */
const flatten = (variables) => {
  if (!variables || !variables.length) {
    return undefined;
  }

  const vars = getEnvVars({ variables });
  delete vars.__name__;
  return vars;
};

const dotEnvAt = (root) => {
  if (!root) {
    return {};
  }

  try {
    return parseDotEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch (error) {
    // A scope with no .env is the ordinary case.
    return {};
  }
};

/** Collection `.env` over workspace `.env` over the OS, matching `store/process-env.js`. */
const processEnvFor = ({ workspaceRoot, collectionRoot }) => ({
  ...process.env,
  ...dotEnvAt(workspaceRoot),
  ...dotEnvAt(collectionRoot)
});

const buildVariables = ({ tiers = {}, scope }) => ({
  globalEnvironment: flatten(tiers.globalEnvironment?.variables),
  collectionVars: flatten(tiers.collectionVars),
  environment: flatten(tiers.environment?.variables),
  envVarOverrides: tiers.envVarOverrides,
  processEnv: processEnvFor(scope)
});

module.exports = { buildVariables };
