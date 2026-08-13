/**
 * Redaction — 001 §14.4.
 *
 * The policy governs everything the runner emits, and the engine applies it to *copies*: the
 * `MaterializedRequest` handed to `ExecuteRequest` is the real request, token included, because it
 * has to be sendable (§13.2). Anything derived from it for reporting goes through here first, and
 * §14.5 requires that to happen **before serialization** so a secret is never written into a file
 * buffer and then removed from it.
 *
 * §14.4 specifies two mechanisms. This is the second — the header-name denylist — which catches the
 * case the first cannot: a credential written directly into a flow file, with no secret-variable
 * origin to trace. Provenance tracking is the primary one and is not here yet; it needs a host that
 * knows which environment entries are `secret: true`, and neither host loads environments for flows
 * so far.
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
