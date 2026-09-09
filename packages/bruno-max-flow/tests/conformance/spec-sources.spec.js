/**
 * The documents a flow binds, as paths — 001 §6.2's `apis:`, read as text.
 *
 * These run against `openapi.ts` directly, for `search.spec.js`' reason: this is a property of
 * reading the file, and nothing about a run would make it more true.
 *
 * The reader is the app's watcher (002 §6). Its problem is that a flow's diagnostics depend on files
 * outside the directory it watches, so the assertions that carry weight are the ones a host could not
 * restate for itself: that a path resolves against the flow rather than the process, that a remote
 * document yields nothing to watch, and that a flow mid-edit yields nothing rather than throwing.
 */
const path = require('path');

const { flowSpecSources } = require('../../src/openapi');

const FILE = path.resolve('/workspace/collections/payments/flows/checkout.flow.yml');

const flow = (...lines) => lines.join('\n');

describe('the local documents a flow binds', () => {
  it('resolves a relative source against the flow that named it', () => {
    const text = flow('version: 1', 'apis:', '  payments-api: ../../apispec/payments-v1.yml', '');

    expect(flowSpecSources(FILE, text)).toEqual([
      path.resolve('/workspace/collections/apispec/payments-v1.yml')
    ]);
  });

  /** §6.2's long form. The alias may carry a base URL, an auth profile and a colour; the path is the same. */
  it('reads the mapping form as well as the string one', () => {
    const text = flow(
      'version: 1',
      'apis:',
      '  short: ./short.yml',
      '  long:',
      '    source: ./long.yml',
      '    baseUrl: "{{host}}"',
      '    color: "#0af"',
      ''
    );

    expect(flowSpecSources(FILE, text)).toEqual([
      path.resolve('/workspace/collections/payments/flows/short.yml'),
      path.resolve('/workspace/collections/payments/flows/long.yml')
    ]);
  });

  /** `readSpec` fetches a URL, so there is no file a watcher could put a handle on. */
  it('omits a remote document', () => {
    const text = flow(
      'version: 1',
      'apis:',
      '  remote: https://api.example.com/openapi.yml',
      '  local: ./local.yml',
      ''
    );

    expect(flowSpecSources(FILE, text)).toEqual([
      path.resolve('/workspace/collections/payments/flows/local.yml')
    ]);
  });

  it('yields nothing for a flow that binds no document', () => {
    expect(flowSpecSources(FILE, flow('version: 1', 'meta:', '  name: No bindings', ''))).toEqual([]);
  });

  /**
   * The watcher runs this on every change, which includes the keystroke that left the document
   * unparseable. Reporting a syntax error is §6's job and the editor is already doing it.
   */
  it('yields nothing for a document that does not parse, rather than throwing', () => {
    expect(flowSpecSources(FILE, flow('version: 1', 'apis:', '  broken: [unclosed', ''))).toEqual([]);
  });

  /** §5.4's local tags are the reason a host cannot use a plain YAML parser here (§5.1). */
  it('reads a document whose steps carry local tags', () => {
    const text = flow(
      'version: 1',
      'apis:',
      '  api: ./api.yml',
      'steps:',
      '  - id: create',
      '    operation: api#createThing',
      '    body: !file ./fixtures/thing.json',
      ''
    );

    expect(flowSpecSources(FILE, text)).toEqual([path.resolve('/workspace/collections/payments/flows/api.yml')]);
  });
});
