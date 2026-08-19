/**
 * What the engine hands a host to send, and what it expects back — 001 §13.2.
 *
 * A `MaterializedRequest` is the output of §7's five-stage pipeline. It carries live secrets:
 * redaction (§14.4) applies to what is *reported*, and the engine redacts copies. A host must not
 * log this object.
 */
import type { Auth } from '@usebruno/schema-types/common/auth';

export type FilePayload = {
  /** Already read through the ReadFile port (§7.4). */
  bytes: Buffer;
  /** §7.5's basename-or-override. */
  filename: string;
  /** §7.5's four-step resolution, decided by the engine. */
  contentType: string;
  /** For capture-by-reference only (§14.5) — never sent. */
  sourcePath: string;
};

export type MultipartPart
  = | { name: string; kind: 'field'; value: string; contentType?: string }
    | { name: string; kind: 'file'; file: FilePayload };

/**
 * Tagged so §7.5's media-type decision is made once, by the engine. Handing hosts a bare object
 * would leave each of them re-deriving "is this multipart?" from the body's shape, which §7.5
 * rejects by name.
 */
export type RequestBody
  = | { kind: 'none' }
    | { kind: 'json'; value: unknown }
    | { kind: 'text'; value: string; contentType: string }
    | { kind: 'urlencoded'; fields: { name: string; value: string }[] }
    | { kind: 'multipart'; parts: MultipartPart[] }
    | { kind: 'binary'; file: FilePayload };

export type MaterializedRequest = {
  /** Upper-case. */
  method: string;
  /** Absolute, resolved (§6.3), path params substituted, no query string. */
  url: string;
  /** A list, so repeated keys survive. */
  query: { name: string; value: string }[];
  headers: Record<string, string>;
  body: RequestBody;
  /** The resolved profile (§6.4), in Bruno's own Auth shape — hosts keep their auth mechanics. */
  auth: Auth;
  operation?: { api: string; operationId?: string; method: string; path: string };
};

export type ExecutedResponse = {
  status: number;
  statusText?: string;
  /** `string[]` because Set-Cookie genuinely repeats and §7.6 depends on it. */
  headers: Record<string, string | string[]>;
  /** Parsed when the host could parse it, else the decoded string. */
  body: unknown;
  /** Raw, for binary capture (§14.5) and byte assertions. */
  bytes?: Buffer;
  /** What §10.2's `res.responseTime` reads. */
  responseTimeMs: number;
  size?: { body: number; headers: number };
  /**
   * The headers the host actually put on the wire, if it can say — the step's own, plus whatever it
   * added applying `MaterializedRequest.auth`, the body's content type, and its cookie jar. §13.2
   * leaves all four to the host, so the engine cannot derive them and §14.5's capture would
   * otherwise record a request that is not the one that was sent. Absent means the capture falls
   * back to the declared headers, which is what a host that does not report them leaves it with.
   */
  requestHeaders?: Record<string, string>;
};

/** `code` is advisory: it reaches the failure message and the capture, and nothing branches on it. */
export type TransportError = Error & { code?: string };
