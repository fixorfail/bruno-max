jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn(), emit: jest.fn() },
  app: {
    getPath: jest.fn(() => require('node:os').tmpdir()),
    getVersion: jest.fn(() => '0.0.0-test'),
    getName: jest.fn(() => 'bruno')
  }
}));

const { _test } = require('./openapi-sync');

/**
 * 001 §6.1's normalization corpus, this half — 002-C U5.14.
 *
 * §6.1 lets a step address an operation by method and path where the document declares no
 * `operationId`, and normalizes that path "by the same rules `openapi-sync.js` applies when it builds
 * its `METHOD:/path` endpoint identity". The two implementations are deliberately separate —
 * `normalizeUrlPath` is private to this file, which `@bruno-max/flow` may not import (§13.1), and
 * extracting it would edit one of the most-churned files in the app at every upstream merge — so the
 * guarantee is a **committed corpus asserted by both**.
 *
 * The rows below are copied from the engine's half, `R8.10` in
 * `packages/bruno-max-flow/tests/conformance/validation.spec.js`, where each one is asserted to
 * resolve to the same operation as the plain `POST /orders/{orderId}/refund`. Here they are asserted
 * to reduce to the same endpoint identity `openapi-sync` would build. A change to either
 * normalization that the other does not make now fails a test, rather than leaving flows unable to
 * resolve an operation openapi-sync matches fine.
 *
 * Keep the two lists in step: a row added there is a row to add here.
 */
describe('openapi-sync\'s endpoint identity — 001 §6.1\'s shared corpus', () => {
  /** `${METHOD}:${normalizeUrlPath(url)}` — `buildSpecItemsMap`'s key, verbatim. */
  const endpointKey = (method, urlPath) => `${method.toUpperCase()}:${_test.normalizeUrlPath(urlPath)}`;

  /** The engine splits a `METHOD path` reference with this pattern before normalizing either half. */
  const keyForReference = (reference) => {
    const [, method, template] = reference.match(/^([a-zA-Z]+)\s+(\S.*)$/) || [];
    return endpointKey(method, template);
  };

  const CANONICAL = 'POST:/orders/:orderId/refund';

  it('normalizes the plain reference to the identity both sides key on', () => {
    expect(keyForReference('POST /orders/{orderId}/refund')).toBe(CANONICAL);
  });

  it.each([
    ['POST /orders/{orderId}/refund/', 'a trailing slash'],
    ['POST //orders/{orderId}//refund', 'collapsed slashes'],
    ['POST https://validate.example.com/orders/{orderId}/refund', 'an origin'],
    ['POST /orders/{orderId}/refund?dryRun=true', 'a query'],
    ['post /orders/{orderId}/refund', 'a lowercase method']
  ])('resolves %s — %s', (reference) => {
    expect(keyForReference(reference)).toBe(CANONICAL);
  });

  /**
   * The sixth rule, which R8.10's rows do not reach because a flow's `operation:` never carries a
   * Bruno interpolation — but openapi-sync's inputs are request URLs, which always start with one.
   */
  it('strips a leading interpolation, so a request URL and a spec path share an identity', () => {
    expect(endpointKey('POST', '{{baseUrl}}/orders/{orderId}/refund')).toBe(CANONICAL);
  });
});
