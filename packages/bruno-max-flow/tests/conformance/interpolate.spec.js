/**
 * §7.3's interpolation, asserted directly.
 *
 * `interpolate.ts` exists because two of its rules are not `@usebruno/common`'s: a whole-value
 * reference keeps its native type, and engine state the run *knows* was never written resolves
 * empty rather than staying on the wire as a placeholder. Both are decisions about what a request
 * looks like when something is missing, and a flow-shaped test sees them only as a request that
 * happened to be accepted.
 *
 * The sharp cases are the asymmetries. `shared` and `params` both resolve empty, but they ask
 * opposite questions of their namespace and a sub-path miss under either is deliberately *not*
 * empty; a `steps.*` miss is neither, being a skip. Getting any one of those backwards produces a
 * request that is malformed rather than absent, which is the failure §11.2 is written to avoid.
 */
const { interpolateScalar, interpolateValue, scopeVariables } = require('../../src/interpolate');

const scopeOf = (vars = {}, namespaces = {}) => ({ vars, namespaces });
const valueOf = (input, scope) => interpolateValue(input, scope).value;

describe('§7.3 whole-value references keep their type', () => {
  it.each([
    ['a number', 12],
    ['a boolean', true],
    ['null', null],
    ['an object', { id: 'a' }],
    ['an array', [1, 2]]
  ])('resolves %s as itself rather than as its string spelling', (_label, produced) => {
    const scope = scopeOf({}, { steps: { x: { out: produced } } });

    expect(valueOf('{{steps.x.out}}', scope)).toEqual(produced);
  });

  it('resolves a whole-value reference inside a body, so a typed field reaches the wire typed', () => {
    const scope = scopeOf({}, { steps: { x: { count: 12 } } });

    expect(valueOf({ item_count: '{{steps.x.count}}' }, scope)).toEqual({ item_count: 12 });
  });

  it('stringifies the same reference once it is embedded in surrounding text', () => {
    const scope = scopeOf({}, { steps: { x: { count: 12 } } });

    expect(valueOf('n={{steps.x.count}}', scope)).toBe('n=12');
  });

  it('serializes an embedded structure rather than rendering it as [object Object]', () => {
    const scope = scopeOf({}, { steps: { x: { out: { id: 'a' } } } });

    expect(valueOf('body={{steps.x.out}}', scope)).toBe('body={"id":"a"}');
  });

  it('renders an embedded null as empty', () => {
    expect(valueOf('n={{steps.x.out}}', scopeOf({}, { steps: { x: { out: null } } }))).toBe('n=');
  });
});

describe('§11.2 what a missing value resolves to', () => {
  it('reports an unproduced `steps.*` reference rather than resolving it', () => {
    const result = interpolateValue('{{steps.login.token}}', scopeOf({}, { steps: {} }));

    expect(result.unresolved).toEqual(['steps.login.token']);
    expect(result.value).toBeUndefined();
  });

  it('leaves the placeholder in the text of an embedded `steps.*` miss, and still reports it', () => {
    const result = interpolateValue('Bearer {{steps.login.token}}', scopeOf({}, { steps: {} }));

    expect(result.unresolved).toEqual(['steps.login.token']);
    expect(result.value).toBe('Bearer {{steps.login.token}}');
  });

  it('resolves a declared slot nothing wrote to empty', () => {
    expect(valueOf('{{shared.orderId}}', scopeOf({}, { shared: {} }))).toBe('');
  });

  it('resolves a declared param nobody supplied to empty', () => {
    expect(valueOf('{{params.tenant}}', scopeOf({}, { params: { tenant: undefined } }))).toBe('');
  });

  it('leaves a `params` name that was never declared in place, it being a typo not an empty value', () => {
    expect(valueOf('{{params.tenat}}', scopeOf({}, { params: { tenant: 'acme' } }))).toBe('{{params.tenat}}');
  });

  it.each([
    ['shared', { shared: { order: { ref: 'r' } } }, '{{shared.order.id}}'],
    ['params', { params: { profile: { name: 'n' } } }, '{{params.profile.email}}']
  ])('leaves a miss on a `%s` sub-path alone, which is a shape mismatch not an empty value', (_root, namespaces, reference) => {
    expect(valueOf(reference, scopeOf({}, namespaces))).toBe(reference);
  });

  it('leaves an ordinary undefined variable in place, keeping Bruno\'s own behaviour', () => {
    expect(valueOf('{{host}}', scopeOf())).toBe('{{host}}');
  });

  it('reports nothing when everything resolved', () => {
    expect(interpolateValue('{{host}}', scopeOf({ host: 'api' })).unresolved).toEqual([]);
  });
});

describe('§7.3 the scope chain', () => {
  it('reads a bare reference from the variable chain', () => {
    expect(valueOf('{{host}}', scopeOf({ host: 'api' }))).toBe('api');
  });

  it('shadows a variable that shares a namespace name', () => {
    const scope = scopeOf({ steps: 'a variable' }, { steps: { x: { out: 'from the namespace' } } });

    expect(valueOf('{{steps.x.out}}', scope)).toBe('from the namespace');
  });

  it('resolves a flat key that carries dots, which is how a tier spells a nested value', () => {
    expect(valueOf('{{api.host}}', scopeOf({ 'api.host': 'api' }))).toBe('api');
  });

  it('navigates a structured variable by path', () => {
    expect(valueOf('{{api.host}}', scopeOf({ api: { host: 'api' } }))).toBe('api');
  });

  it('generates a value for a mock reference', () => {
    const generated = valueOf('{{$randomUUID}}', scopeOf());

    expect(generated).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('the walk', () => {
  it('descends arrays and nested objects', () => {
    const scope = scopeOf({ id: 'a' });

    expect(valueOf({ items: [{ id: '{{id}}' }] }, scope)).toEqual({ items: [{ id: 'a' }] });
  });

  it('collects every unresolved reference across the walk', () => {
    const result = interpolateValue({ a: '{{steps.x.one}}', b: ['{{steps.y.two}}'] }, scopeOf({}, { steps: {} }));

    expect(result.unresolved.sort()).toEqual(['steps.x.one', 'steps.y.two']);
  });

  it('returns a class instance as it is, so a `!file` keeps the identity that marks it', () => {
    class FileRef {
      constructor(source) {
        this.source = source;
      }
    }
    const ref = new FileRef('{{id}}');

    const walked = valueOf({ body: ref }, scopeOf({ id: 'a' }));

    expect(walked.body).toBe(ref);
    expect(walked.body.source).toBe('{{id}}');
  });

  it('leaves a non-string leaf alone', () => {
    expect(valueOf({ n: 12, flag: false }, scopeOf())).toEqual({ n: 12, flag: false });
  });
});

describe('the flattened scope handed to a host', () => {
  it('puts the namespaces over the variable chain, as `lookup` reads them', () => {
    const flat = scopeVariables(scopeOf({ host: 'api', steps: 'shadowed' }, { steps: { x: {} } }));

    expect(flat).toEqual({ host: 'api', steps: { x: {} } });
  });
});

describe('interpolateScalar', () => {
  it('returns a string for a consumer with no use for the unresolved list', () => {
    expect(interpolateScalar('{{steps.x.port}}', scopeOf({}, { steps: { x: { port: 8080 } } }))).toBe('8080');
  });
});
