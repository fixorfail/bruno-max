/**
 * The parts of a step loop that need no run. See 006.
 *
 * The driver is in `run.ts`. Each iteration is the lifecycle of the step, and that lifecycle is in
 * the closure that a flow run builds. This file holds what the driver, the validator and the
 * messages must all agree on. No other file repeats it.
 */
import type { LoopSpec } from './document';
import { WHOLE_VALUE, interpolateValue, scopeVariables, type Interpolated, type Scope } from './interpolate';

/** 006 §2: a loop always has a bound. This is the upper limit of that bound. */
export const MAX_LOOP_ITERATIONS = 1000;

/** The test that `loop-max-missing` makes. The run makes the same test. */
export const isValidLoopMax = (max: unknown): boolean =>
  typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= MAX_LOOP_ITERATIONS;

/**
 * The `loop.*` namespace of one iteration (006 §3).
 * It holds the value under the name from `as:`, `loop.index`, `loop.previous` and `loop.iterations`.
 * `earlier` is the outputs of the iterations that finished, in index order. `loop.iterations` is that
 * list, and `loop.previous` is its last item. On the first iteration the list is empty and
 * `loop.previous` is `undefined`. Iterations that run together have no `earlier`, and both names are
 * `undefined` (006 §6).
 *
 * `index`, `previous` and `iterations` come after the value. If `as:` names one of them, the built-in
 * wins.
 */
export const loopScope = (
  spec: LoopSpec,
  value: unknown,
  index: number,
  earlier?: Record<string, unknown>[]
): Record<string, unknown> => ({
  [spec.as]: value,
  index,
  previous: earlier?.[earlier.length - 1],
  iterations: earlier
});

/**
 * Resolves `over:` or `start:` when the loop starts (006 §2).
 *
 * It is `interpolateValue` with one difference. A reference to a list with no items is a value.
 * `@usebruno/query` returns `undefined` for an empty array, and the interpolator then reports the
 * reference as never produced. A loop over no values runs no iteration. It is not a skipped step.
 * The difference is here, and not in the interpolator, so that no other step changes.
 */
export const interpolateLoopSource = (source: unknown, scope: Scope): Interpolated<unknown> => {
  const resolved = interpolateValue(source, scope);
  const whole = typeof source === 'string' ? WHOLE_VALUE.exec(source) : null;
  if (!whole || resolved.value !== undefined) return resolved;

  let current: unknown = scopeVariables(scope);
  for (const token of whole[1].trim().match(/[^.[\]]+/g) || []) {
    if (current === null || typeof current !== 'object') return resolved;
    current = (current as Record<string, unknown>)[token];
  }
  return Array.isArray(current) && current.length === 0 ? { value: current, unresolved: [] } : resolved;
};

const SHOWN_VALUE_LENGTH = 60;

/**
 * Names an iteration in a message. A reader can find it by `loop.index`, which a capture directory
 * and a script both use, and by the value that the iteration received.
 */
export const describeIteration = (index: number, value: unknown): string => {
  const written = JSON.stringify(value) ?? String(value);
  const shown = written.length > SHOWN_VALUE_LENGTH ? `${written.slice(0, SHOWN_VALUE_LENGTH)}…` : written;
  return `loop.index ${index} (value ${shown})`;
};

/**
 * What `bru flow validate` refuses (§14.3), checked again for a run that nobody validated.
 * The run sends no request in this case. This is the same rule as for every other shape that
 * materialization cannot build. The run has one message for all of these rules.
 */
export const loopShapeError = (spec: LoopSpec): string | undefined => {
  if ((spec.over === undefined) === (spec.start === undefined)) return 'loop: takes exactly one of over: and start:';
  if ((spec.start === undefined) !== (spec.next === undefined)) return 'loop: takes next: with start:, and only with it';
  if (!isValidLoopMax(spec.max)) return `loop.max is not a whole number from 1 to ${MAX_LOOP_ITERATIONS}`;
  if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1) return 'loop.concurrency is not a whole number of at least 1';
  if (spec.concurrency > 1 && (spec.until !== undefined || spec.start !== undefined)) {
    return 'loop.concurrency above 1 needs over: and no until:, because each iteration of the others waits for the one before it';
  }
  return undefined;
};
