/**
 * The agents a flow's request is dispatched on — 001-C R7.4.
 *
 * The proxy half is asserted end to end in `transport.integration.spec.js`. A client certificate
 * cannot be observed without a TLS handshake, and a valid key pair is not something to commit, so
 * what is pinned here is the wiring around it: whose config is consulted, which path a relative file
 * resolves against, and the domain match that decides whether a certificate is wanted at all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { agentsFor } = require('../../../src/fork/flow/transport/network');

describe('the flow transport\'s agents', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-certs-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const certs = {
    clientCertificates: {
      certs: [{ domain: '*.example.com', type: 'cert', certFilePath: 'certs/client.crt', keyFilePath: 'certs/client.key' }]
    }
  };

  it('looks for the collection\'s client certificate, relative to the collection', async () => {
    await expect(agentsFor('https://api.example.com/orders', root, certs, {})).rejects.toThrow(
      `Error reading cert/key file: ENOENT: no such file or directory, open '${path.join(root, 'certs/client.crt')}'`
    );
  });

  it('wants no certificate for a host the config does not name', async () => {
    const { httpsAgent } = await agentsFor('https://api.elsewhere.com/orders', root, certs, {});

    expect(httpsAgent.options.cert).toBeUndefined();
  });

  /** A workspace-scoped flow (§6.2) has no collection config, and still has to reach the API. */
  it('produces an agent for a collection that configures nothing', async () => {
    const { httpAgent } = await agentsFor('http://api.example.com/orders', root, {}, {});

    expect(httpAgent).toBeDefined();
  });

  /**
   * §7.4: the collection's config is written once and read per environment, so a certificate path
   * that differs between staging and production is spelled as a `{{variable}}` — resolved against
   * the variables of the request going out, exactly as `bru run` resolves the same field.
   */
  it('resolves a {{variable}} in a certificate path against the request\'s variables', async () => {
    const templated = {
      clientCertificates: {
        certs: [
          {
            domain: '*.example.com',
            type: 'cert',
            certFilePath: '{{certDir}}/client.crt',
            keyFilePath: '{{certDir}}/client.key'
          }
        ]
      }
    };

    await expect(
      agentsFor('https://api.example.com/orders', root, templated, { certDir: 'certs/staging' })
    ).rejects.toThrow(`open '${path.join(root, 'certs/staging/client.crt')}'`);
  });

  // The domain a certificate is matched on is templated as often as its path — a wildcard per
  // environment — and matching on the literal `{{apiHost}}` would silently consult no certificate.
  it('resolves a {{variable}} in the domain the certificate is matched on', async () => {
    const templated = {
      clientCertificates: {
        certs: [
          { domain: '{{apiHost}}', type: 'cert', certFilePath: 'certs/client.crt', keyFilePath: 'certs/client.key' }
        ]
      }
    };

    await expect(
      agentsFor('https://api.example.com/orders', root, templated, { apiHost: 'api.example.com' })
    ).rejects.toThrow(`open '${path.join(root, 'certs/client.crt')}'`);
  });
});
