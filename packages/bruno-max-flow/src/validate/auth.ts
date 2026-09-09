/**
 * §6.4's signing modes, and the one thing a step can do to break one — 001 §14.3.
 *
 * A signing mode computes a header across several request fields, so a step that writes that header
 * itself and a profile that computes it are two answers to one question. Which of them wins is the
 * *host's* and not the flow's, and the two hosts do not even agree with each other: `aws4` deletes
 * any `Authorization` it finds and signs over what is left, while Bruno's digest interceptor does
 * the opposite and skips the challenge entirely for a request that already carries one. Either way
 * the request goes out as something nobody wrote, and the API answers 401 — which reads as a
 * credentials problem rather than as the configuration one it is.
 *
 * A warning rather than a refusal, because §6.4's per-field override is legitimate for every mode
 * that computes nothing: a step setting `Authorization` beside a `bearer` profile is the documented
 * way to hand one call a pre-signed token. Only the modes below collide with it.
 */
import { DROP, type NormalizedStep } from '../document';
import type { Report } from './report';

/**
 * What each signing mode computes, and what it does to a header written beside it. Only headers a
 * signer actually writes are listed — an `X-Request-Id` on an `awsv4` step is not part of the
 * signature and is not this check's business.
 *
 * - `awsv4` — `aws4` deletes `Authorization` before signing, sets `X-Amz-Date`, adds
 *   `X-Amz-Security-Token` for session credentials and `X-Amz-Content-Sha256` for S3
 *   (`aws4/aws4.js`, reached through `bruno-electron/src/ipc/network/awsv4auth-helper.js`).
 * - `digest` — the interceptor answers a 401 challenge by setting `Authorization`, and answers none
 *   at all when the request already carries that header
 *   (`bruno-requests/src/auth/digestauth-helper.js`).
 * - `ntlm` — the handshake is carried in `Authorization` (`bruno-requests/src/auth/ntlm.ts`).
 * - `oauth1` — the signature goes into `Authorization`, unless `placement:` sends the parameters to
 *   the query or the body instead (`bruno-requests/src/auth/oauth1-request-authorization.ts`).
 * - `akamai-edgegrid` — `Authorization` (`bruno-requests/src/auth/edgegrid-helper.js`).
 * - `wsse` — `X-WSSE`, and not `Authorization`
 *   (`bruno-electron/src/ipc/network/prepare-request.js`).
 */
const SIGNING_MODES: Record<string, { headers: string[]; effect: string }> = {
  'awsv4': {
    headers: ['Authorization', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
    effect: 'the signer replaces it, so the value written here never reaches the wire'
  },
  'digest': {
    headers: ['Authorization'],
    effect: 'a request already carrying it skips the challenge handshake, so the profile authenticates nothing'
  },
  'ntlm': {
    headers: ['Authorization'],
    effect: 'the negotiated handshake replaces it, so the value written here never reaches the wire'
  },
  'oauth1': {
    headers: ['Authorization'],
    effect: 'the signature replaces it, so the value written here never reaches the wire'
  },
  'akamai-edgegrid': {
    headers: ['Authorization'],
    effect: 'the signature replaces it, so the value written here never reaches the wire'
  },
  'wsse': {
    headers: ['X-WSSE'],
    effect: 'the computed token replaces it, so the value written here never reaches the wire'
  }
};

/** `oauth1` is the one mode whose header is conditional — its parameters can go elsewhere entirely. */
const computedHeaders = (mode: string, profile: Record<string, unknown>): string[] => {
  const signing = SIGNING_MODES[mode];
  if (!signing) return [];
  if (mode === 'oauth1' && (profile.placement === 'query' || profile.placement === 'body')) return [];
  return signing.headers;
};

/** The step's own `headers:` against its resolved profile. A binding's defaults are not a step's claim. */
export const checkSignedHeaders = (
  step: NormalizedStep,
  profileName: string,
  profile: Record<string, unknown>,
  report: Report
) => {
  const mode = typeof profile.mode === 'string' ? profile.mode : '';
  for (const computed of computedHeaders(mode, profile)) {
    const written = Object.keys(step.headers).find((name) => name.toLowerCase() === computed.toLowerCase());
    // §7.2's removal token declares nothing — it takes a header a seed introduced back out.
    if (written === undefined || step.headers[written] === DROP) continue;
    report.warn(
      'signed-header-override',
      `${step.id} sets ${written}, which its ${mode} profile ${profileName} computes — `
      + `${SIGNING_MODES[mode].effect} (§6.4)`,
      step.id
    );
  }
};
