/**
 * §6.2's `rateLimit:` — the run's client-side pacing, per bound API document (004).
 *
 * **One bucket per resolved OpenAPI document, not per alias.** An alias is flow-local: a sub-flow
 * binding the same document under another name is talking to the same service, and a limiter keyed
 * on the name would hand it a second allowance. This is `connectors.ts`'s identity argument one
 * layer up — the same reason an operation's default outputs are matched by resolved document rather
 * than by what a flow happened to call it.
 *
 * **The bucket is the run's.** It is shared by every step, sub-flow and dataset iteration of one
 * `runFlow`, and by nothing outside it: `--flows N` runs N of them, and a flow's declared rate
 * therefore means the same thing whichever way it was started (004 §2).
 *
 * The algorithm is a virtual-scheduling leaky bucket (GCRA): one integer per bucket — `tat`, the
 * theoretical arrival time of the next request — rather than a token count refilled from elapsed
 * time. Both describe the same limit, but a token count is a float that accumulates rounding every
 * refill, and this file's entire job is producing sleep durations a test can assert exactly.
 */
import type { RateLimit } from './document';
import type { Clock } from './types/ports';

const WINDOW_MS: Record<RateLimit['per'], number> = { second: 1000, minute: 60_000, hour: 3_600_000 };

type Bucket = {
  /** Emission interval: the spacing one request is entitled to, in ms. */
  interval: number;
  /** Burst tolerance: how far ahead of the schedule a caller may run, in ms. `(burst - 1) * interval`. */
  tolerance: number;
  /** The theoretical arrival time of the next request. Unset until the bucket is first used. */
  tat?: number;
  /** Acquisitions are served in the order they asked, the way §9.2's budget serves its queue. */
  chain: Promise<unknown>;
};

export type Acquisition = {
  /** False when the caller was cancelled or hit `maxWaitMs`; no request may be sent and no token was spent. */
  acquired: boolean;
  waitedMs: number;
};

export type Limiter = {
  /**
   * Declare a document's limit. Called as each flow is loaded rather than at first dispatch, so the
   * bucket a step meets does not depend on which step got there first.
   */
  register(key: string, limit: RateLimit): void;
  paced(key: string): boolean;
  acquire(key: string, signal?: AbortSignal, maxWaitMs?: number): Promise<Acquisition>;
};

const FREE: Acquisition = { acquired: true, waitedMs: 0 };
const ignore = () => {};

/**
 * 004 §6's conflict rule: **the strictest declaration wins**, which is the longer interval, and at
 * equal intervals the smaller burst.
 *
 * The alternative — whichever binding dispatched first — reads the same in a one-flow file and is
 * scheduling-dependent the moment a sub-flow disagrees: two runs of one flow would pace differently
 * depending on which request returned first. `validate` warns about the disagreement either way;
 * this decides what the run does with it, and the answer a politeness limit wants is the polite one.
 */
const stricter = (a: Bucket, interval: number, tolerance: number): boolean =>
  interval > a.interval || (interval === a.interval && tolerance < a.tolerance);

export const createLimiter = (clock: Clock): Limiter => {
  const buckets = new Map<string, Bucket>();

  /**
   * One acquisition's turn, run with the bucket to itself: the waiter computes its wait from a `tat`
   * the previous waiter has already advanced, so N queued callers take N distinct slots instead of
   * all reading the same free one and leaving together.
   */
  const take = async (bucket: Bucket, signal?: AbortSignal, maxWaitMs?: number): Promise<Acquisition> => {
    if (signal?.aborted) return { acquired: false, waitedMs: 0 };

    const now = clock.now();
    const tat = Math.max(bucket.tat ?? now, now);
    const allowedAt = tat - bucket.tolerance;
    const required = Math.max(0, allowedAt - now);

    if (required > 0) {
      /**
       * A wait the run has no time left for. `stopped()` polls the deadline at scheduling points
       * (§11.3), so a `requests: 1, per: hour` bucket would otherwise sleep an hour past
       * `--max-run-duration` with nothing looking. Sleeping what remains and refusing hands the
       * decision back to the caller, which is the side that knows whether the run is still going.
       */
      if (maxWaitMs !== undefined && required > maxWaitMs) {
        const partial = Math.max(0, maxWaitMs);
        if (partial > 0) await clock.sleep(partial, signal);
        return { acquired: false, waitedMs: partial };
      }

      await clock.sleep(required, signal);
      // A cancelled waiter spends nothing: no request goes out, and charging it would push the next
      // one back for a slot nobody used.
      if (signal?.aborted) return { acquired: false, waitedMs: required };
    }

    bucket.tat = Math.max(tat, clock.now()) + bucket.interval;
    return { acquired: true, waitedMs: required };
  };

  return {
    register: (key, limit) => {
      const interval = WINDOW_MS[limit.per] / limit.requests;
      const tolerance = Math.max(0, limit.burst - 1) * interval;
      if (!Number.isFinite(interval) || interval <= 0) return;

      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, { interval, tolerance, chain: Promise.resolve() });
        return;
      }
      if (stricter(existing, interval, tolerance)) {
        existing.interval = interval;
        existing.tolerance = tolerance;
      }
    },

    paced: (key) => buckets.has(key),

    acquire: (key, signal, maxWaitMs) => {
      const bucket = buckets.get(key);
      if (!bucket) return Promise.resolve(FREE);

      const turn = bucket.chain.then(() => take(bucket, signal, maxWaitMs));
      // The chain advances whatever the turn did, rejection included — a throw that stopped it from
      // being handed on would wedge every later request to this API for the rest of the run.
      bucket.chain = turn.then(ignore, ignore);
      return turn;
    }
  };
};
