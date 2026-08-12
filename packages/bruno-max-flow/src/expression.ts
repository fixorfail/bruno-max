/**
 * The expression dialect — 001 §10.2, shared with `when:` (§9.3).
 *
 * Flows introduce no second assertion dialect: the operand rule *is* Bruno's, reused rather than
 * restated. `evaluateJsTemplateLiteral` is the function §10.2 names by line — `true`, `false`,
 * `null` and `undefined` become those values, a numeric operand a number, a quoted operand a
 * string, anything else a string — and the one addition is that an unquoted operand whose first
 * dot-segment is a reserved root resolves as a reference instead.
 *
 * The helpers are imported from `@usebruno/js/src/utils` rather than through the package index,
 * which loads the QuickJS runtime at import time. Sandbox selection is a host's (§8.2), and the
 * engine reaches nothing here that needs one: both helpers compile a plain function.
 */
import { evaluateJsExpression, evaluateJsTemplateLiteral } from '@usebruno/js/src/utils';

import type { AssertionSpec } from './document';
import { RESERVED_ROOTS, interpolateValue, type Scope } from './interpolate';
import type { AssertionResult } from './types/result';

export type EvaluationContext = Record<string, unknown>;

/** What an assertion or condition addresses: every variable scope, with the namespaces over it. */
export const evaluationContext = (scope: Scope, response?: Record<string, unknown>): EvaluationContext => ({
  ...scope.vars,
  ...scope.namespaces,
  ...(response ? { res: response } : {})
});

const isReference = (operand: string): boolean => RESERVED_ROOTS.includes(operand.trim().split('.')[0]);

/**
 * §10.2's decidable rule: a reader classifies an operand by its first segment and nothing else.
 * `{{...}}` keeps working in every operand position, so a variable is always reachable and the
 * short form stays reserved for the namespaces.
 */
export const resolveOperand = (operand: string | undefined, context: EvaluationContext, scope: Scope): unknown => {
  if (operand === undefined) return undefined;
  if (isReference(operand)) return evaluateJsExpression(operand.trim(), context);
  if (operand.includes('{{')) return evaluateJsTemplateLiteral(String(interpolateValue(operand, scope).value), context);
  return evaluateJsTemplateLiteral(operand, context);
};

const asList = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    return inner.split(',').map((entry) => evaluateJsTemplateLiteral(entry.trim(), {}));
  }
  return [value];
};

const OPERATORS: Record<string, (actual: unknown, expected: unknown) => boolean> = {
  'eq': (actual, expected) => actual === expected,
  '==': (actual, expected) => actual === expected,
  'neq': (actual, expected) => actual !== expected,
  '!=': (actual, expected) => actual !== expected,
  'gt': (actual, expected) => Number(actual) > Number(expected),
  'gte': (actual, expected) => Number(actual) >= Number(expected),
  'lt': (actual, expected) => Number(actual) < Number(expected),
  'lte': (actual, expected) => Number(actual) <= Number(expected),
  'in': (actual, expected) => asList(expected).includes(actual),
  'notIn': (actual, expected) => !asList(expected).includes(actual),
  'contains': (actual, expected) =>
    Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(String(expected)),
  'notContains': (actual, expected) =>
    Array.isArray(actual) ? !actual.includes(expected) : !String(actual).includes(String(expected)),
  'startsWith': (actual, expected) => String(actual).startsWith(String(expected)),
  'endsWith': (actual, expected) => String(actual).endsWith(String(expected)),
  'matches': (actual, expected) => new RegExp(String(expected)).test(String(actual)),
  'notMatches': (actual, expected) => !new RegExp(String(expected)).test(String(actual)),
  'length': (actual, expected) => Number((actual as { length?: number })?.length) === Number(expected),
  'between': (actual, expected) => {
    const [low, high] = asList(expected).map(Number);
    return Number(actual) >= low && Number(actual) <= high;
  },
  'isDefined': (actual) => actual !== undefined,
  'isUndefined': (actual) => actual === undefined,
  'isNull': (actual) => actual === null,
  'isTruthy': (actual) => Boolean(actual),
  'isFalsy': (actual) => !actual,
  'isEmpty': (actual) =>
    actual === null || actual === undefined || (typeof actual === 'object' ? Object.keys(actual).length === 0 : actual === ''),
  'isNotEmpty': (actual) => !OPERATORS.isEmpty(actual, undefined),
  'isNumber': (actual) => typeof actual === 'number',
  'isString': (actual) => typeof actual === 'string',
  'isBoolean': (actual) => typeof actual === 'boolean',
  'isArray': (actual) => Array.isArray(actual),
  'isJson': (actual) => typeof actual === 'object' && actual !== null
};

export const evaluateAssertion = (
  assertion: AssertionSpec,
  context: EvaluationContext,
  scope: Scope
): AssertionResult => {
  const compare = OPERATORS[assertion.op];
  if (!compare) throw new Error(`unknown operator ${assertion.op}`);

  let actual: unknown;
  try {
    actual = evaluateJsExpression(assertion.expr, context);
  } catch {
    // An expression addressing a value that is not there is a failed assertion, not a crashed run:
    // `res.body.data.role` against an error body is the ordinary shape of a test that just failed.
    actual = undefined;
  }
  const expected = resolveOperand(assertion.value, context, scope);

  return { expr: assertion.source, passed: compare(actual, expected), expected, actual };
};

/** A list of conditions is an implicit AND, exactly as a list of assertions is (§9.3). */
export const evaluateCondition = (
  conditions: (string | { script: string })[],
  context: EvaluationContext,
  scope: Scope,
  runScript: (source: string) => Promise<unknown>,
  parse: (raw: string) => AssertionSpec
): Promise<boolean> =>
  conditions.reduce(async (carry: Promise<boolean>, condition) => {
    if (!(await carry)) return false;
    if (typeof condition === 'string') return evaluateAssertion(parse(condition), context, scope).passed;
    return Boolean(await runScript(condition.script));
  }, Promise.resolve(true));
