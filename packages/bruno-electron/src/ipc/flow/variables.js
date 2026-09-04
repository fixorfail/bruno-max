const fs = require('fs');
const path = require('path');
const { parseDotEnv } = require('@usebruno/filestore');
const { valueToString } = require('@usebruno/common/utils');
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

/**
 * The values 001 §14.4's provenance redaction follows — masked wherever they later surface.
 *
 * Values rather than names, because §14.4 tracks a secret by its value: one copied into a header, a
 * body or a captured variable stays masked without anything having to model where it went.
 *
 * **Only what a host uniquely knows.** The engine derives the auth-profile credentials and the
 * declared `secret: true` params for itself; which *environment* entries are marked secret is the
 * part it cannot see, so that is the whole of what this contributes.
 *
 * **Beside `buildVariables` rather than on its return.** That function returns exactly the engine's
 * `VariableTiers`, and `secrets` is a sibling of `variables` in `RunOptions` rather than a tier —
 * folding it in would make the returned object something the engine's own shape no longer describes.
 *
 * `collectionVars` has no entries to read: a request variable carries no `secret` flag, and
 * `bruno-schema`'s `varsSchema` is `noUnknown` and would refuse one.
 *
 * The entries hold plaintext by the time they reach here — the collection watcher hydrates an
 * environment's secrets from the encrypted store and decrypts them before the renderer ever sees
 * them, and `globalEnvironmentsStore` decrypts on read.
 */
const collectSecrets = ({ tiers = {} }) => [
  ...new Set(
    [...(tiers.globalEnvironment?.variables || []), ...(tiers.environment?.variables || [])]
      .filter((variable) => variable.secret && variable.enabled)
      .map((variable) => valueToString(variable.value))
      // A secret declared but never filled in would otherwise mask every empty string in the report.
      .filter((value) => value.trim())
  )
];

module.exports = { buildVariables, collectSecrets };
