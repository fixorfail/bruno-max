const fs = require('fs');
const path = require('path');
const { get } = require('lodash');
const { parseCollection } = require('@usebruno/filestore');
// The stored-auth → `AuthProfile` mapping is the engine's, so this host and the CLI cannot disagree
// about it (001 §13.1); aliased because the function below is the same profile, read off a collection.
const { collectionAuthProfile: toAuthProfile } = require('@bruno-max/flow');
const { getCollectionFormat } = require('../../utils/filesystem');

/**
 * What a flow reads off the collection it lives in — 001 §6.4's implicit profile and §7.4's
 * proxy/certificate configuration.
 *
 * **Read from disk rather than from a loaded collection.** The request path is handed its collection
 * by the renderer, which holds the parsed tree; `setAuthHeaders` and `getCertsAndProxyConfig` both
 * take that object. A flow host is handed a *path* (002 §7.2), and the main process keeps no
 * collection store to look one up in: the one cache it has, `store/bruno-config`, is keyed by the
 * `collectionUid` the renderer mints with `uuid()`, which nothing here can derive. So the two files
 * a flow cares about are read directly, and the shapes below are exactly what those two consumers
 * already expect.
 *
 * **Nothing here fails a run.** A collection whose root file is missing, unreadable or malformed
 * yields the empty answer rather than an exception: a flow that never mentions `auth: collection` and
 * runs against a collection with no proxy is the common case, and it must not start caring whether
 * `collection.bru` parses.
 *
 * **Async for one reason: `parseCollection` reports a parse failure as a rejected promise, not a
 * throw.** It returns the parsed object synchronously and a `Promise.reject` when the grammar
 * refuses, so a caller that does not await gets an unhandled rejection — which under Node 20 takes
 * the whole main process down, from a malformed file that should have been a shrug. The collection
 * watcher awaits it for the same reason.
 */

/** Both formats keep the collection's own auth and scripts in one root file beside the config. */
const collectionRootFile = (collectionPath, format) =>
  path.join(collectionPath, format === 'yml' ? 'opencollection.yml' : 'collection.bru');

/**
 * `parseCollection` answers `{ collectionRoot, brunoConfig }` for a `yml` collection — which carries
 * both in one file — and the root alone for a `bru` one, whose config is `bruno.json`. The collection
 * watcher makes the same split on the same call.
 */
const parseCollectionRoot = async (collectionPath) => {
  const format = getCollectionFormat(collectionPath);
  const content = fs.readFileSync(collectionRootFile(collectionPath, format), 'utf8');
  const parsed = await parseCollection(content, { format });
  return format === 'yml' ? parsed : { collectionRoot: parsed };
};

/**
 * 001 §6.4's implicit `collection` profile — the collection's own auth, as an `AuthProfile`.
 *
 * Finding the block is the host's half — which file holds it, in which format — and turning it into
 * a profile is the engine's, which is why the mapping is imported rather than written here.
 *
 * **Always supplied for a collection-scoped run**, `mode: 'none'` included. `auth: collection` is
 * then a reference that resolves for every collection rather than one that errors with
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
 * The collection's bruno config, which is where §7.4's proxy and client-certificate configuration
 * lives (`network/cert-utils.js` reads both off it).
 */
const readBrunoConfig = async (collectionPath) => {
  try {
    const format = getCollectionFormat(collectionPath);
    if (format === 'yml') {
      return (await parseCollectionRoot(collectionPath)).brunoConfig || {};
    }
    return JSON.parse(fs.readFileSync(path.join(collectionPath, 'bruno.json'), 'utf8'));
  } catch (error) {
    return {};
  }
};

module.exports = { collectionAuthProfile, readBrunoConfig };
