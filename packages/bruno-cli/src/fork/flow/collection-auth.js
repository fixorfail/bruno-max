/**
 * 001 §6.4's implicit `collection` profile, as `bru flow run` supplies it.
 *
 * **The host's to supply, because only a host knows what a collection is.** The engine resolves a
 * step's `auth:` against the flow's own `authProfiles:`, then an inherited one, then
 * `RunOptions.authProfiles` (§13.2); what it cannot do is open `collection.bru` and decide that the
 * auth block inside it is a profile named `collection`. That is the same division `bru run` already
 * makes for a single request, where `mode: 'inherit'` means "the collection's" and
 * `prepare-request.js` is what reads the collection root to find it.
 *
 * Read from disk rather than from a loaded collection: `bru flow run` is handed a flow path and
 * derives its scope from the directories above it (§7.4), and building the whole collection tree
 * `createCollectionJsonFromPathname` returns — every request file parsed — to read one auth block
 * would make a flow run wait on files it never sends.
 *
 * **Nothing here fails a run.** A collection whose root file is missing, unreadable or malformed
 * yields the `none` profile rather than an exception: a flow that never mentions `auth: collection`
 * is the common case, and it must not start caring whether `collection.bru` parses.
 */
const fs = require('fs');
const path = require('path');
const { get } = require('lodash');
const { parseCollection } = require('@usebruno/filestore');
// The stored-auth → `AuthProfile` mapping is the engine's, so this host and the app cannot disagree
// about it (§13.1); aliased because the function below is the same profile, read off a collection.
const { collectionAuthProfile: toAuthProfile } = require('@bruno-max/flow');
const { getCollectionFormat } = require('../../utils/collection');

/** Both formats keep the collection's own auth in one root file beside the config. */
const collectionRootFile = (collectionPath, format) =>
  path.join(collectionPath, format === 'yml' ? 'opencollection.yml' : 'collection.bru');

/**
 * `parseCollection` answers `{ collectionRoot, brunoConfig }` for a `yml` collection — which carries
 * both in one file — and the root alone for a `bru` one, whose config is `bruno.json`. Awaited
 * rather than read synchronously because the parsers report a malformed file as a rejected promise
 * as well as by throwing, and an unawaited rejection is an unhandled one.
 */
const parseCollectionRoot = async (collectionPath) => {
  const format = getCollectionFormat(collectionPath);
  const content = fs.readFileSync(collectionRootFile(collectionPath, format), 'utf8');
  const parsed = await parseCollection(content, { format });
  return format === 'yml' ? parsed : { collectionRoot: parsed };
};

/**
 * The collection's own auth, as an `AuthProfile`.
 *
 * Finding the block is the host's half — which file holds it, in which format — and turning it into
 * a profile is the engine's, which is why the mapping is imported rather than written here.
 *
 * **Always supplied for a collection-scoped run**, `mode: 'none'` included. §6.4 says a collection
 * flow "declares no `authProfiles` at all and authenticates exactly as the collection does": a
 * collection that authenticates with nothing is still a collection the flow authenticates exactly
 * as, so `auth: collection` resolves for every collection rather than erroring
 * `unknown-auth-profile` depending on whether someone had filled the collection's auth in.
 */
const collectionAuthProfile = async (collectionPath) => {
  let auth;
  try {
    auth = get((await parseCollectionRoot(collectionPath)).collectionRoot, 'request.auth');
  } catch (error) {
    // A collection whose root file cannot be read has no auth to inherit, which the engine's
    // mapping answers as `mode: 'none'` rather than as a run that refuses to start.
    auth = undefined;
  }

  return toAuthProfile(auth);
};

/**
 * What `runFlow` is handed: the implicit profile for a collection-scoped flow, nothing for a
 * workspace-scoped one.
 *
 * A workspace-scoped flow has no collection by construction (§6.2), so it supplies nothing and
 * `auth: collection` is `unknown-auth-profile` there — which is the truthful answer rather than an
 * empty profile that would silently send a step out unauthenticated.
 */
const authProfilesFor = async (scope) =>
  scope.collectionRoot ? { collection: await collectionAuthProfile(scope.collectionRoot) } : undefined;

module.exports = { collectionAuthProfile, authProfilesFor };
