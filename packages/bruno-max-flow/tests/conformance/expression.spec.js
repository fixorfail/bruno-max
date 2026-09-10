/**
 * §10.2's operator table, asserted directly.
 *
 * `expression.ts` says of this table that it "is restated, not reused" — a second implementation of
 * names `AssertRuntime` also defines, kept honest only by being tested, and it asks that "an
 * operator added here belongs in that table too". R4c2 covers the *operand* rule and does it
 * through flows; the operators themselves reach the corpus only where a fixture happens to use one,
 * which is eight of the thirty-one. The rest were unasserted, and a negation operator that silently
 * agrees with its positive twin is exactly the failure a flow-shaped test cannot see.
 *
 * So every operator gets a passing case and a failing one. The pair is the point: an operator
 * hard-wired to `true` satisfies half of it, and half is what an assertion built out of one would
 * report forever.
 */
const { evaluateAssertion, evaluationContext, resolveOperand } = require('../../src/expression');

const scope = { vars: {}, namespaces: {} };
const context = (values = {}) => evaluationContext({ vars: values, namespaces: {} });

/** `source` is what a result echoes back; the dialect never reads it. */
const check = (expr, op, value, values) =>
  evaluateAssertion({ expr, op, value, source: `${expr} ${op} ${value ?? ''}`.trim() }, context(values), scope).passed;

describe('§10.2 operator table — equality and ordering', () => {
  it.each([
    ['eq', 'n', '1', true],
    ['eq', 'n', '2', false],
    ['==', 'n', '1', true],
    ['==', 'n', '2', false],
    ['neq', 'n', '2', true],
    ['neq', 'n', '1', false],
    ['!=', 'n', '2', true],
    ['!=', 'n', '1', false],
    ['gt', 'n', '0', true],
    ['gt', 'n', '1', false],
    ['gte', 'n', '1', true],
    ['gte', 'n', '2', false],
    ['lt', 'n', '2', true],
    ['lt', 'n', '1', false],
    ['lte', 'n', '1', true],
    ['lte', 'n', '0', false]
  ])('%s %s %s → %s', (op, expr, value, expected) => {
    expect(check(expr, op, value, { n: 1 })).toBe(expected);
  });

  it('compares eq by identity, so a number and its string spelling differ', () => {
    expect(check('n', 'eq', '\'1\'', { n: 1 })).toBe(false);
  });

  it('coerces for an ordering operator, which is what makes a numeric header comparable', () => {
    expect(check('n', 'gt', '1', { n: '2' })).toBe(true);
  });
});

describe('§10.2 operator table — membership and substrings', () => {
  it.each([
    ['in', 'role', '[admin, viewer]', 'admin', true],
    ['in', 'role', '[admin, viewer]', 'editor', false],
    ['notIn', 'role', '[admin, viewer]', 'editor', true],
    ['notIn', 'role', '[admin, viewer]', 'admin', false],
    ['contains', 'role', 'dmi', 'admin', true],
    ['contains', 'role', 'zzz', 'admin', false],
    ['notContains', 'role', 'zzz', 'admin', true],
    ['notContains', 'role', 'dmi', 'admin', false],
    ['startsWith', 'role', 'adm', 'admin', true],
    ['startsWith', 'role', 'min', 'admin', false],
    ['endsWith', 'role', 'min', 'admin', true],
    ['endsWith', 'role', 'adm', 'admin', false],
    ['matches', 'role', '^adm', 'admin', true],
    ['matches', 'role', '^min', 'admin', false],
    ['notMatches', 'role', '^min', 'admin', true],
    ['notMatches', 'role', '^adm', 'admin', false]
  ])('%s %s %s over %s → %s', (op, expr, value, role, expected) => {
    expect(check(expr, op, value, { role })).toBe(expected);
  });

  it('reads `contains` over an array as membership rather than as a substring', () => {
    expect(check('roles', 'contains', 'admin', { roles: ['admin', 'viewer'] })).toBe(true);
    expect(check('roles', 'contains', 'dmi', { roles: ['admin'] })).toBe(false);
  });

  it('accepts an unbracketed list, since a dataset cell carries no brackets', () => {
    expect(check('role', 'in', 'admin, viewer', { role: 'viewer' })).toBe(true);
  });
});

describe('§10.2 operator table — size and range', () => {
  it.each([
    ['length', 'items', '2', { items: [1, 2] }, true],
    ['length', 'items', '3', { items: [1, 2] }, false],
    ['between', 'n', '[1, 3]', { n: 2 }, true],
    ['between', 'n', '[1, 3]', { n: 4 }, false]
  ])('%s %s %s → %s', (op, expr, value, values, expected) => {
    expect(check(expr, op, value, values)).toBe(expected);
  });

  it('measures a string with `length` too', () => {
    expect(check('name', 'length', '5', { name: 'admin' })).toBe(true);
  });

  it('includes both ends of `between`', () => {
    expect(check('n', 'between', '[1, 3]', { n: 1 })).toBe(true);
    expect(check('n', 'between', '[1, 3]', { n: 3 })).toBe(true);
  });
});

describe('§10.2 operator table — presence and type', () => {
  it.each([
    ['isDefined', { v: 1 }, true],
    ['isDefined', {}, false],
    ['isUndefined', {}, true],
    ['isUndefined', { v: 1 }, false],
    ['isNull', { v: null }, true],
    ['isNull', { v: 1 }, false],
    ['isTruthy', { v: 1 }, true],
    ['isTruthy', { v: 0 }, false],
    ['isFalsy', { v: 0 }, true],
    ['isFalsy', { v: 1 }, false],
    ['isEmpty', { v: '' }, true],
    ['isEmpty', { v: 'x' }, false],
    ['isNotEmpty', { v: 'x' }, true],
    ['isNotEmpty', { v: '' }, false],
    ['isNumber', { v: 1 }, true],
    ['isNumber', { v: '1' }, false],
    ['isString', { v: '1' }, true],
    ['isString', { v: 1 }, false],
    ['isBoolean', { v: true }, true],
    ['isBoolean', { v: 'true' }, false],
    ['isArray', { v: [] }, true],
    ['isArray', { v: {} }, false],
    ['isJson', { v: {} }, true],
    ['isJson', { v: 'x' }, false]
  ])('%s over %p → %s', (op, values, expected) => {
    expect(check('v', op, undefined, values)).toBe(expected);
  });

  it('reads an empty collection as empty, not only an empty string', () => {
    expect(check('v', 'isEmpty', undefined, { v: [] })).toBe(true);
    expect(check('v', 'isEmpty', undefined, { v: {} })).toBe(true);
    expect(check('v', 'isEmpty', undefined, { v: null })).toBe(true);
  });

  it('reads an array as JSON, `isJson` being a test for a structure rather than for a string', () => {
    expect(check('v', 'isJson', undefined, { v: [] })).toBe(true);
    expect(check('v', 'isJson', undefined, { v: null })).toBe(false);
  });
});

describe('evaluateAssertion', () => {
  it('rejects an operator it does not define rather than passing the assertion', () => {
    expect(() => check('v', 'isProbably', '1', { v: 1 })).toThrow('unknown operator isProbably');
  });

  it('fails an assertion whose expression addresses a value that is not there', () => {
    const result = evaluateAssertion(
      { expr: 'res.body.data.role', op: 'eq', value: 'admin', source: 'res.body.data.role eq admin' },
      context(),
      scope
    );

    expect(result.passed).toBe(false);
    expect(result.actual).toBeUndefined();
  });

  it('reports both sides and the source it was written as', () => {
    const result = evaluateAssertion(
      { expr: 'n', op: 'eq', value: '2', source: 'n eq 2' },
      context({ n: 1 }),
      scope
    );

    expect(result).toEqual({ expr: 'n eq 2', passed: false, expected: 2, actual: 1 });
  });
});

describe('§10.2 operand rule', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['1', 1],
    ['\'1\'', '1'],
    ['admin', 'admin']
  ])('resolves the literal %s', (operand, expected) => {
    expect(resolveOperand(operand, context(), scope)).toBe(expected);
  });

  it('resolves an operand whose first segment is a reserved root as a reference', () => {
    const withRoot = { vars: {}, namespaces: { steps: { login: { token: 't' } } } };

    expect(resolveOperand('steps.login.token', evaluationContext(withRoot), withRoot)).toBe('t');
  });

  it('reads a bare word that is not a reserved root as a string, not as a variable', () => {
    expect(resolveOperand('role', context({ role: 'admin' }), scope)).toBe('role');
  });

  it('reaches a variable through `{{...}}`, which stays available in every operand position', () => {
    const withVar = { vars: { role: 'admin' }, namespaces: {} };

    expect(resolveOperand('{{role}}', evaluationContext(withVar), withVar)).toBe('admin');
  });

  it('has no operand at all when the operator takes none', () => {
    expect(resolveOperand(undefined, context(), scope)).toBeUndefined();
  });
});
