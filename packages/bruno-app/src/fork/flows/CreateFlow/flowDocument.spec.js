import { aliasFor, apiBindingsFor } from './flowDocument';

/**
 * 002 §4.1c's form supplies the bindings; the host writes the document (002-C R4) and
 * `bruno-electron/src/ipc/flow/index.spec.js` asserts the text that comes out of it. What is left
 * here is the naming, which is string work over an OpenAPI document only the renderer holds.
 */

const spec = (filename, pathname, name) => ({ uid: filename, filename, pathname, name });

describe('the apis: a new flow is created with', () => {
  it('is empty when nothing was selected', () => {
    expect(apiBindingsFor([])).toEqual([]);
  });

  /**
   * The **absolute** path, because §6.2 resolves a binding against the flow's own directory and the
   * host is the side that owns paths — the renderer's `path` is a POSIX shim, and a Windows flow
   * written with a POSIX relative path is one the engine cannot resolve.
   */
  it('names each spec by the path the host will relativize', () => {
    expect(apiBindingsFor([spec('auth-v2.yaml', '/home/dev/ws/apispec/auth-v2.yaml')])).toEqual([
      { alias: 'auth-v2', source: '/home/dev/ws/apispec/auth-v2.yaml' }
    ]);
  });

  /** `apis:` is a mapping, so two specs that slug alike would otherwise collapse into one binding. */
  it('keeps two specs whose filenames slug alike apart', () => {
    const bindings = apiBindingsFor([
      spec('auth v2.yaml', '/home/dev/ws/a/auth v2.yaml'),
      spec('auth-v2.json', '/home/dev/ws/b/auth-v2.json')
    ]);

    expect(bindings.map((binding) => binding.alias)).toEqual(['auth-v2', 'auth-v2-2']);
  });
});

describe('the alias a spec is bound under', () => {
  /** It is typed in every step that uses it (`alias#operationId`), so it comes from the filename. */
  it('slugs the filename rather than the OpenAPI title', () => {
    expect(aliasFor(spec('Payments API v2.yaml', '/x/Payments API v2.yaml', 'Payments API v2 (beta)')))
      .toBe('payments-api-v2');
  });

  it('drops the extension, whichever one it is', () => {
    expect(aliasFor(spec('auth.yml', '/x/auth.yml'))).toBe('auth');
    expect(aliasFor(spec('auth.json', '/x/auth.json'))).toBe('auth');
  });

  it('falls back to a usable name when nothing survives slugging', () => {
    expect(aliasFor({ filename: '___.yaml', pathname: '/x/___.yaml' })).toBe('api');
  });
});
