/**
 * Interpolation — 001 §7.3.
 *
 * The governing rule is that values a human authored resolve bare, through Bruno's existing scope
 * chain, while structured state the engine produces is namespaced. Two things here are not
 * delegated to `@usebruno/common`'s interpolator, and both are the reason this module exists:
 *
 * - **A whole-value reference keeps its native type.** The shared interpolator returns a string by
 *   construction, so `item_count: "{{steps.x.count}}"` would arrive as `"12"` and nothing typed
 *   could reach a JSON body at all. A scalar that is exactly one `{{...}}` is therefore resolved
 *   here and only embedded references are delegated.
 * - **Engine state the run knows was never written resolves empty, not verbatim.** Leaving
 *   `{{shared.x}}` in place is right for a variable a human may still define and wrong for a slot
 *   (§11.2), where it turns a missing value into a malformed request.
 *
 * Embedded references are resolved here for the same second reason rather than delegated: an
 * unproduced `{{steps.a.b}}` has to be *reported* so its step can be skipped `unresolved-dependency`,
 * and a shared interpolator that leaves the placeholder in place has nowhere to say so.
 */
import { mockDataFunctions } from '@usebruno/common';
import { get } from '@usebruno/query';

/** §7.3's namespaces, plus `process`. A variable with one of these names is shadowed. */
export const RESERVED_ROOTS = ['res', 'req', 'steps', 'row', 'params', 'shared', 'flow', 'process'];

export type Scope = {
  /** The flattened variable chain — what a bare `{{name}}` reads. */
  vars: Record<string, unknown>;
  /** The namespaces, which shadow it. */
  namespaces: Record<string, unknown>;
};

export type Interpolated<T> = {
  value: T;
  /** `steps.*` references naming an output the run never produced (§11.2). */
  unresolved: string[];
};

const WHOLE_VALUE = /^\{\{([^{}]+)\}\}$/;
const MOCK = /^\$(\w+)$/;

const lookup = (reference: string, scope: Scope): { found: boolean; value: unknown } => {
  const [root] = reference.split('.');
  const source = RESERVED_ROOTS.includes(root) ? scope.namespaces : scope.vars;
  const direct = get(source as Record<string, unknown>, reference);
  if (direct !== undefined) return { found: true, value: direct };

  // bruno-query navigates structures; a flat key carrying dots is how a variable tier spells a
  // nested value, and both have to resolve for a chain assembled from several hosts.
  if (Object.prototype.hasOwnProperty.call(source, reference)) {
    return { found: true, value: (source as Record<string, unknown>)[reference] };
  }
  return { found: false, value: undefined };
};

/**
 * A reference the run owns and knows is empty (§11.2): a declared slot nothing wrote. A `steps.*`
 * reference is deliberately not in this set — its absence means the step it names did not do what
 * it was for, which is a skip rather than an empty string.
 */
const resolvesEmpty = (reference: string, scope: Scope): boolean => {
  const [root, name] = reference.split('.');
  if (root !== 'shared') return false;
  const slots = scope.namespaces.shared as Record<string, unknown> | undefined;
  return Boolean(slots) && !Object.prototype.hasOwnProperty.call(slots, name);
};

const resolveReference = (reference: string, scope: Scope, unresolved: string[]): unknown => {
  const trimmed = reference.trim();

  const mock = trimmed.match(MOCK);
  if (mock) {
    const generate = mockDataFunctions[mock[1] as keyof typeof mockDataFunctions];
    if (generate) return generate();
  }

  const { found, value } = lookup(trimmed, scope);
  if (found) return value;
  if (resolvesEmpty(trimmed, scope)) return '';
  if (trimmed.split('.')[0] === 'steps') {
    unresolved.push(trimmed);
    return undefined;
  }
  // An ordinary variable nobody defined keeps Bruno's own behaviour, which is to leave it in place.
  return `{{${trimmed}}}`;
};

const interpolateText = (text: string, scope: Scope, unresolved: string[]): string =>
  text.replace(/\{\{([^{}]+)\}\}/g, (match, reference: string) => {
    const resolved = resolveReference(reference, scope, unresolved);
    if (resolved === undefined) return match;
    if (resolved === null) return '';
    if (typeof resolved === 'object') return JSON.stringify(resolved);
    return String(resolved);
  });

export const interpolateValue = <T>(value: T, scope: Scope): Interpolated<T> => {
  const unresolved: string[] = [];

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = node.match(WHOLE_VALUE);
      if (whole) return resolveReference(whole[1], scope, unresolved);
      return interpolateText(node, scope, unresolved);
    }
    if (Array.isArray(node)) return node.map(walk);
    // Only plain objects are walked. A `!file` reference is a class instance by §5.4's design, and
    // rebuilding it as a plain object here would strip the identity that distinguishes it from a
    // body that happens to carry the same keys.
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      const mapped: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        mapped[key] = walk(item);
      }
      return mapped;
    }
    return node;
  };

  return { value: walk(value) as T, unresolved };
};

/** A scalar whose consumer has no use for the unresolved list — a base URL, an auth field. */
export const interpolateScalar = (text: string, scope: Scope): string =>
  String(interpolateValue(text, scope).value);
