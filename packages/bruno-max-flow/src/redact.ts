/**
 * Redaction — 001 §14.4.
 *
 * The policy governs everything the runner emits, and the engine applies it to *copies*: the
 * `MaterializedRequest` handed to `ExecuteRequest` is the real request, token included, because it
 * has to be sendable (§13.2). Anything derived from it for reporting goes through here first, and
 * §14.5 requires that to happen **before serialization** so a secret is never written into a file
 * buffer and then removed from it.
 *
 * §14.4 specifies two mechanisms and both live here. **Provenance by value** is the primary one:
 * every value a run knows to be secret is masked wherever it later surfaces, whatever name it is
 * under by then. The **header-name denylist** is the backstop, and catches the case provenance
 * cannot — a credential written directly into a flow file, with no secret origin to trace.
 */

/** Never length-preserving: a mask that kept the size would leak how long the secret is (§14.4). */
export const MASK = '••••';

const DENYLIST = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key'
];

export type Redactor = {
  headers<T extends string | string[]>(headers: Record<string, T>): Record<string, T>;
};

export const createRedactor = (extra: string[] = []): Redactor => {
  const denied = new Set([...DENYLIST, ...extra.map((name) => name.toLowerCase())]);

  return {
    headers: (headers) =>
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          denied.has(name.toLowerCase())
            ? ((Array.isArray(value) ? value.map(() => MASK) : MASK) as typeof value)
            : value
        ])
      )
  };
};

/**
 * §14.4's primary mechanism: the values a run knows to be secret, masked wherever they subsequently
 * appear — a query string, a request or response body, an extracted output, an error message that
 * echoed one back.
 *
 * **Tracking is by value, not by the name the value is under.** That is what makes it robust: a
 * secret promoted into a shared slot (§9.1) or extracted into an output stays masked for free,
 * because promotion copies the value and nothing here consults where it came from.
 *
 * Mutable across the run because the values are not all known before it: an auth profile's
 * credentials resolve when the step using them materializes, and one of them may itself have come
 * from a step above it.
 */
export type SecretTracker = {
  /**
   * Non-strings and blank values are ignored. A `secret: true` variable that resolved to nothing
   * would otherwise contribute an empty pattern, which matches at every position of every string.
   */
  add(value: unknown): void;
  /**
   * A masked **copy** — strings rebuilt, arrays and plain objects walked. The argument is never
   * mutated: the run's own state has to keep the real value, since a downstream step reading
   * `{{steps.login.token}}` must still be sent the token.
   */
  mask<T>(value: T): T;
};

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const maskWithin = (node: unknown, pattern: RegExp): unknown => {
  if (typeof node === 'string') return node.replace(pattern, MASK);
  if (Array.isArray(node)) return node.map((entry) => maskWithin(entry, pattern));
  // Only what the walk can rebuild faithfully: a Buffer, a Date or a class instance is returned as
  // it is rather than flattened into an object that no longer behaves like one.
  if (node !== null && typeof node === 'object' && isPlainObject(node)) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, maskWithin(value, pattern)]));
  }
  return node;
};

export const createSecretTracker = (initial: Iterable<unknown> = []): SecretTracker => {
  const secrets = new Set<string>();
  /**
   * One alternation over every secret, compiled once and reused for every string of every result —
   * the walk covers each step's outputs, assertions and captured bodies, so a pattern rebuilt per
   * value would recompile it thousands of times per run. Rebuilt only when the set actually grows.
   */
  let pattern: RegExp | undefined;
  let stale = true;

  const compiled = (): RegExp | undefined => {
    if (stale) {
      stale = false;
      // Longest first, so where one secret contains another the longer match wins and no tail of it
      // survives beside the mask.
      const ordered = [...secrets].sort((left, right) => right.length - left.length);
      pattern = ordered.length ? new RegExp(ordered.map(escapeForPattern).join('|'), 'g') : undefined;
    }
    return pattern;
  };

  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '' || secrets.has(value)) return;
    secrets.add(value);
    stale = true;
  };

  for (const value of initial) add(value);

  return {
    add,
    mask: (value) => {
      const active = compiled();
      return active === undefined ? value : (maskWithin(value, active) as typeof value);
    }
  };
};
