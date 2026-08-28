import yaml from 'js-yaml';
import { aliasFor, buildFlowDocument } from './flowDocument';

/**
 * 002 §4.1's Create Flow form writes a file the CLI has to be able to read, so what is asserted here
 * is the text — not a shape the form happened to hold in memory.
 */

const parse = (text) => yaml.load(text);

const spec = (filename, pathname, name) => ({ uid: filename, filename, pathname, name });

describe('the document a new flow is created with', () => {
  it('writes the version, the name and the description', () => {
    const text = buildFlowDocument({
      name: 'Checkout',
      description: '  a happy path through checkout  ',
      directory: '/home/dev/workspace/flows'
    });

    expect(parse(text)).toEqual({
      version: 1,
      meta: { name: 'Checkout', description: 'a happy path through checkout' }
    });
  });

  /** An empty `description:` says the author declined to describe the flow; the absent key says it. */
  it('omits a description that was left blank', () => {
    const text = buildFlowDocument({ name: 'Checkout', description: '   ', directory: '/home/dev/workspace/flows' });

    expect(parse(text).meta).toEqual({ name: 'Checkout' });
    expect(text).not.toContain('description');
  });

  /**
   * 001 §12.5's flag, and the reason it is a checkbox rather than something inferred: a flow is a
   * library because its author says so, not because it happens to declare `params:`.
   */
  it('marks a library when the box is checked', () => {
    const text = buildFlowDocument({ name: 'Login', library: true, directory: '/home/dev/ws/flows' });

    expect(parse(text).meta).toEqual({ name: 'Login', library: true });
  });

  /** `library: false` and an absent key are the same flow, so only one of them is ever written. */
  it('writes no library key when the box is left alone', () => {
    const text = buildFlowDocument({ name: 'Checkout', library: false, directory: '/home/dev/ws/flows' });

    expect(parse(text).meta).toEqual({ name: 'Checkout' });
    expect(text).not.toContain('library');
  });

  it('omits apis entirely when nothing was selected', () => {
    const text = buildFlowDocument({ name: 'Checkout', directory: '/home/dev/workspace/flows', apiSpecs: [] });

    expect(parse(text).apis).toBeUndefined();
  });

  /**
   * §12.3 resolves a binding's source against the flow's own directory, so the path is written
   * relative to where the file is about to land rather than to the workspace.
   */
  it('binds each spec by a path relative to the flow', () => {
    const text = buildFlowDocument({
      name: 'Checkout',
      directory: '/home/dev/workspace/flows',
      apiSpecs: [
        spec('auth-v2.yaml', '/home/dev/workspace/apispec/auth-v2.yaml'),
        spec('payments.yaml', '/home/dev/workspace/flows/payments.yaml')
      ]
    });

    expect(parse(text).apis).toEqual({
      'auth-v2': '../apispec/auth-v2.yaml',
      'payments': './payments.yaml'
    });
  });

  /** `apis:` is a mapping, so two specs that slug alike would otherwise collapse into one binding. */
  it('keeps two specs whose filenames slug alike apart', () => {
    const text = buildFlowDocument({
      name: 'Checkout',
      directory: '/home/dev/ws/flows',
      apiSpecs: [
        spec('auth v2.yaml', '/home/dev/ws/a/auth v2.yaml'),
        spec('auth-v2.json', '/home/dev/ws/b/auth-v2.json')
      ]
    });

    expect(Object.keys(parse(text).apis)).toEqual(['auth-v2', 'auth-v2-2']);
  });

  /** A name with a colon in it is the case a hand-written template gets wrong. */
  it('quotes a name YAML would otherwise read as a mapping', () => {
    const text = buildFlowDocument({ name: 'checkout: v2', directory: '/home/dev/ws/flows' });

    expect(parse(text).meta.name).toBe('checkout: v2');
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
});
