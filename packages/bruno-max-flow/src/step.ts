/**
 * One step's lifecycle — 001 §10 and §11.1.
 *
 * The order the checks run in is the contract: request validation, then status, then response
 * schema, then assertions, with the three script positions slotting in where they actually run
 * (§14.6). A step carries exactly one reason — the **first** check to fail — because a 500 that
 * also fails four assertions is one problem, not five. Assertions are still evaluated and recorded
 * when an earlier check failed: the reason names what to fix, the array is what happened.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { get } from '@usebruno/query';

import type { NormalizedStep, OutputSpec, RetryPolicy } from './document';
import { evaluateAssertion, evaluationContext, type EvaluationContext } from './expression';
import type { Scope } from './interpolate';
import { requestSchema, responseSchema, type ResolvedOperation } from './openapi';
import type { Materialized } from './materialize';
import type { Clock } from './types/ports';
import type { ExecutedResponse } from './types/request';
import type { AssertionResult, SchemaResult, StepReason } from './types/result';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateAgainst = (schema: Record<string, any> | undefined, value: unknown): SchemaResult => {
  if (!schema) return { valid: true, errors: [] };
  const validate = ajv.compile(schema);
  const valid = validate(value) as boolean;
  return {
    valid,
    errors: (validate.errors || []).map((error) => ({
      path: error.instancePath || '/',
      message: error.message || 'invalid',
      keyword: error.keyword
    }))
  };
};

export type ScriptRunner = (source: string, args: unknown[]) => Promise<unknown>;

export class ScriptError extends Error {
  constructor(readonly position: string, cause: unknown) {
    super(`${position} threw: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * §8.1. A path that selects nothing, or a script returning `undefined`, means the output is **not
 * produced** — an answer the flow has a designed response to, and deliberately not the same thing
 * as a throw (§8.2).
 */
const extractOutputs = async (
  outputs: OutputSpec[],
  response: ExecutedResponse,
  context: EvaluationContext,
  runScript: ScriptRunner
): Promise<{ values: Record<string, unknown>; error?: ScriptError }> => {
  const values: Record<string, unknown> = {};
  let error: ScriptError | undefined;

  for (const output of outputs) {
    try {
      const value = output.script
        ? await runScript(output.script, [context.res, context])
        : output.from === 'status'
          ? response.status
          : get((output.from === 'headers' ? response.headers : response.body) as Record<string, unknown>, output.path || '');
      if (value !== undefined) values[output.name] = value;
    } catch (cause) {
      // The remaining outputs are still extracted: diagnosing a script that threw needs the
      // response it threw on (§8.2).
      error = error || new ScriptError(`outputs.${output.name}`, cause);
    }
  }

  return { values, error };
};

/** §11.1: `delay` is the wait *before* each retry, so `maxAttempts: n` waits `n - 1` times. */
export const retryDelay = (policy: RetryPolicy, attempt: number): number => {
  const base = policy.backoff === 'exponential' ? policy.delay * 2 ** (attempt - 1) : policy.delay;
  const capped = Math.min(base, policy.maxDelay);
  return policy.jitter === 'full' ? Math.random() * capped : capped;
};

export type AttemptOutcome = {
  response?: ExecutedResponse;
  assertions: AssertionResult[];
  outputs: Record<string, unknown>;
  validation?: { request?: SchemaResult; response?: SchemaResult };
  reason?: StepReason;
  message?: string;
};

export type AttemptInput = {
  step: NormalizedStep;
  resolved: ResolvedOperation;
  materialized: Materialized;
  scope: Scope;
  dispatch: () => Promise<ExecutedResponse>;
  runScript: ScriptRunner;
};

export const runAttempt = async (input: AttemptInput): Promise<AttemptOutcome> => {
  const { step, resolved, materialized, scope, dispatch, runScript } = input;
  const assertions: AssertionResult[] = [];
  const validation: { request?: SchemaResult; response?: SchemaResult } = {};

  // Request validation leads because it runs *before* dispatch: a step that fails it never sends,
  // so it has no status to be judged on (§10.1).
  if (step.flags.validateRequest && materialized.mediaType && materialized.request.body.kind === 'json') {
    validation.request = validateAgainst(
      requestSchema(resolved.operation, materialized.mediaType),
      materialized.request.body.value
    );
    if (!validation.request.valid) {
      return {
        assertions,
        outputs: {},
        validation,
        reason: 'invalid-request',
        message: `request body does not match the schema: ${validation.request.errors
          .map((error) => `${error.path} ${error.message}`)
          .join(', ')}`
      };
    }
  }

  let response: ExecutedResponse;
  try {
    response = await dispatch();
  } catch (cause) {
    return {
      assertions,
      outputs: {},
      reason: 'transport-error',
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }

  const context = evaluationContext(scope, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    responseTime: response.responseTimeMs
  });

  // Outputs are extracted whenever a response arrived, even when a check below then fails — which
  // is precisely what makes cleanup work (§11.2).
  const extracted = await extractOutputs(step.outputs, response, context, runScript);
  const outputs = extracted.values;

  const selfScope: Scope = {
    ...scope,
    namespaces: {
      ...scope.namespaces,
      steps: {
        ...(scope.namespaces.steps as Record<string, unknown>),
        [step.id]: { ...outputs, status: response.status }
      }
    }
  };
  const assertionContext = { ...context, ...selfScope.namespaces };

  for (const assertion of step.assert) {
    assertions.push(evaluateAssertion(assertion, assertionContext, selfScope));
  }

  if (step.flags.failOnStatusCode && response.status >= 400) {
    return {
      response,
      assertions,
      outputs,
      validation,
      reason: 'unexpected-status',
      message: `expected a successful status, got ${response.status}`
    };
  }

  if (step.flags.validateSchema) {
    const declared = responseSchema(resolved.operation, response.status);
    if (!declared.documented && step.flags.strictSchema) {
      return {
        response,
        assertions,
        outputs,
        validation,
        reason: 'schema-validation-failed',
        message: `the spec documents no ${response.status} response`
      };
    }
    if (declared.schema) {
      validation.response = validateAgainst(declared.schema, response.body);
      if (!validation.response.valid) {
        return {
          response,
          assertions,
          outputs,
          validation,
          reason: 'schema-validation-failed',
          message: `response does not match the ${response.status} schema: ${validation.response.errors
            .map((error) => `${error.path} ${error.message}`)
            .join(', ')}`
        };
      }
    }
  }

  // An output script runs between response-schema validation and assertions, so its throw is
  // reported here rather than overriding an earlier failure (§14.6).
  if (extracted.error) {
    return { response, assertions, outputs, validation, reason: 'script-error', message: extracted.error.message };
  }

  const failed = assertions.filter((assertion) => !assertion.passed);
  if (failed.length) {
    return {
      response,
      assertions,
      outputs,
      validation,
      reason: 'assertion-failed',
      message: failed
        .map((assertion) => `${assertion.expr} — expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}`)
        .join('; ')
    };
  }

  return { response, assertions, outputs, validation };
};

/**
 * §11.1's default predicate: with no `shouldRetry`, retry fires only on a transport error or a
 * 5xx — never on an assertion or schema failure, which say the server answered and the answer was
 * wrong. This is what keeps a flow-level `config.retry` safe to set on a non-idempotent step.
 */
export const shouldRetryByDefault = (outcome: AttemptOutcome): boolean =>
  outcome.reason === 'transport-error' || (outcome.response?.status ?? 0) >= 500;

export const wantsRetry = async (
  policy: RetryPolicy,
  outcome: AttemptOutcome,
  attempt: number,
  context: EvaluationContext,
  runScript: ScriptRunner
): Promise<boolean> => {
  if (!policy.shouldRetry) return shouldRetryByDefault(outcome);
  const failures = outcome.assertions.filter((assertion) => !assertion.passed);
  return Boolean(
    await runScript(policy.shouldRetry, [
      outcome.response
        ? {
            status: outcome.response.status,
            headers: outcome.response.headers,
            body: outcome.response.body,
            responseTime: outcome.response.responseTimeMs
          }
        : undefined,
      attempt,
      { ...context, failures }
    ])
  );
};

export const sleepFor = async (clock: Clock, ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms > 0) await clock.sleep(ms, signal);
};
