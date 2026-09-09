/**
 * Proxy and certificates for a flow's requests.
 *
 * 001 §7.6 calls these ambient configuration of the transport rather than flow data, so a flow
 * carries none of it and the collection it belongs to supplies all of it, exactly as it does for a
 * request `bru run` sends. `getHttpHttpsAgents` is that resolution — the CA bundle, the first client
 * certificate whose domain matches the URL, then the collection's proxy or the system's — so the two
 * commands cannot end up reaching a host through different routes.
 */
const fs = require('fs');
const path = require('path');
const { parseCollection } = require('@usebruno/filestore');
const { getHttpHttpsAgents, getSystemProxy, transformProxyConfig } = require('@usebruno/requests');
const { getCollectionFormat } = require('../../../utils/collection');
const { getOptions } = require('../../../utils/bru');
const { interpolateObject } = require('../../../runner/interpolate-string');

/**
 * A workspace-scoped flow (§6.2) has no collection under it, and returns the empty config a
 * collection with nothing configured would.
 */
const collectionConfig = (collectionPath) => {
  const format = getCollectionFormat(collectionPath);

  if (format === 'yml') {
    const content = fs.readFileSync(path.join(collectionPath, 'opencollection.yml'), 'utf8');
    return parseCollection(content, { format: 'yml' }).brunoConfig || {};
  }
  if (format === 'bru') return JSON.parse(fs.readFileSync(path.join(collectionPath, 'bruno.json'), 'utf8'));
  return {};
};

/**
 * The CLI's own options store, which is what `run-single-request` derives the same six fields from.
 * §14.1 gives `bru flow run` no flag that writes to it, so a flow run reads the defaults — TLS
 * verified against the system truststore, no custom CA, no SSL session cache.
 */
const agentOptions = () => {
  const options = getOptions();
  return {
    noproxy: Boolean(options.noproxy),
    shouldVerifyTls: !options.insecure,
    shouldUseCustomCaCertificate: Boolean(options.cacert),
    customCaCertificateFilePath: options.cacert,
    shouldKeepDefaultCaCertificates: !options.ignoreTruststore,
    cacheSslSession: Boolean(options.cacheSslSession)
  };
};

/**
 * Detection spawns an OS command, so it is resolved once for the process and only when a collection
 * proxy that inherits could actually reach it — a collection pinning or disabling its own proxy
 * never consults the system's.
 */
let detected;
const systemProxyFor = (proxy) => {
  const collectionProxy = transformProxyConfig(proxy || {});
  if (collectionProxy.disabled || collectionProxy.inherit === false) return Promise.resolve(undefined);

  detected = detected || getSystemProxy().catch(() => undefined);
  return detected;
};

/**
 * A proxy host, a certificate path or a passphrase may be written as `{{variables}}` in the
 * collection's config, and each is resolved against the request that is about to go out — the same
 * `interpolateObject` over the same two fields that `bru run` resolves them with
 * (`runner/run-single-request.js`), so a flow and a request in one collection cannot reach an API by
 * different routes because only one of them expanded a placeholder.
 *
 * Per request rather than once per run, because that is what makes the values a flow's own: §7.3's
 * chain is already flattened into one map by the time a step dispatches, which is why the tiers
 * `bru run` assembles collapse to a single one here. `process.env` rides beside it because
 * `{{process.env.*}}` is a namespace rather than a variable (§7.3), and a proxy naming one is how CI
 * usually spells it.
 */
const interpolated = (value, variables) =>
  interpolateObject(value, { runtimeVariables: variables, processEnvVars: process.env });

const agentsFor = async (requestUrl, collectionPath, config, variables) => {
  const proxy = interpolated(config.proxy, variables);

  return getHttpHttpsAgents({
    requestUrl,
    collectionPath,
    options: agentOptions(),
    clientCertificates: interpolated(config.clientCertificates, variables),
    collectionLevelProxy: proxy,
    systemProxyConfig: await systemProxyFor(proxy)
  });
};

module.exports = { collectionConfig, agentOptions, agentsFor };
