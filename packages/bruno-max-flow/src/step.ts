/**
 * One step's lifecycle — 001 §10 and §11.1.
 *
 * The order the checks run in is the contract: request validation, then status, then response
 * schema, then assertions, with the three script positions slotting in where they actually run
 * (§14.6). A step carries exactly one reason — the **first** check to fail — because a 500 that
 * also fails four assertions is one problem, not five. Assertions are still evaluated and recorded
 * when an earlier check failed: the reason names what to fix, the array is what happened.
 */
import Ajv, { type ErrorObject } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { get } from '@usebruno/query';

import type { NormalizedStep, OutputSpec, PreSpec, RetryPolicy } from './document';
import { evaluateAssertion, evaluationContext, type EvaluationContext } from './expression';
import type { Scope } from './interpolate';
import { requestSchema, responseSchema, type ResolvedOperation, type SchemaDialect } from './openapi';
import type { Materialized } from './materialize';
import type { Clock } from './types/ports';
import type { ExecutedResponse, MaterializedRequest } from './types/request';
import type { AssertionResult, SchemaResult, StepReason } from './types/result';

/**
 * One validator per dialect — §10.1.
 *
 * `Ajv` reads draft-07, which is what an OpenAPI 3.0 document's schemas are close enough to; 3.1's
 * are JSON Schema 2020-12 and need the reader built for them. Handing a 2020-12 schema to the
 * draft-07 instance does not fail loudly: `prefixItems` is an unknown keyword there and is
 * *ignored*, so a tuple schema silently checks nothing. Which one a document takes is decided once,
 * where the document is read — `ResolvedOperation.dialect`.
 *
 * Both are long-lived because Ajv caches compiled validators by schema identity, and `rooted()`
 * hands back the same object for the same fragment every time.
 */
const validators: Record<SchemaDialect, Ajv> = {
  'draft-07': new Ajv({ allErrors: true, strict: false, verbose: true }),
  '2020-12': new Ajv2020({ allErrors: true, strict: false, verbose: true })
};
addFormats(validators['draft-07']);
addFormats(validators['2020-12']);

/** A throwaway instance of the right reader, for the compile that is *expected* to fail. */
const freshValidator = (dialect: SchemaDialect): Ajv =>
  dialect === '2020-12'
    ? new Ajv2020({ allErrors: true, strict: false })
    : new Ajv({ allErrors: true, strict: false });

/**
 * A validator's message, made actionable where it is not.
 *
 * `oneOf` fails in two opposite ways and says the same sentence for both: nothing matched, or more
 * than one did. The second is a statement about the *document* — two branches that both accept the
 * payload, which is what happens when neither declares `required` and both allow extra properties —
 * and a reader told only "must match exactly one" goes looking for the fault in their response. The
 * count is in the error and nowhere in its text, so it is put there.
 */
const explain = (error: ErrorObject): string => {
  const message = error.message || 'invalid';
  const passing = error.keyword === 'oneOf' ? (error.params as { passingSchemas?: number[] })?.passingSchemas : undefined;
  return passing && passing.length > 1
    ? `${message} — ${passing.length} of them matched, so the document does not say which applies`
    : message;
};

/**
 * Where in the schema a compile failure actually is.
 *
 * Ajv reports the *rule* that was broken — `"nullable" cannot be used without "type"` — and nothing
 * about where, which for a bundled OpenAPI document is a message that sends the reader grepping
 * through tens of thousands of lines for a keyword that is legal almost everywhere it appears.
 *
 * The location is recovered by compiling each subschema on its own and keeping the ones that fail
 * the same way. It works because Ajv checks keyword *shape* before it resolves references: a node
 * lifted out of the document still carries its fault, while its unresolvable `$ref`s fail
 * differently and are told apart by the message not matching.
 *
 * Only the deepest offenders are reported. Every ancestor of a bad node fails identically — the root
 * included, which is what makes the unhelpful message unhelpful — so a parent that has a reporting
 * descendant is the same fault said less precisely.
 */
const MAX_SCHEMA_NODES = 5000;
const MAX_REPORTED_PATHS = 5;

const locateCompileFault = (schema: Record<string, any>, message: string, dialect: SchemaDialect): string[] => {
  const failing: string[] = [];
  let visited = 0;

  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object' || visited >= MAX_SCHEMA_NODES) return;

    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}/${index}`));
      return;
    }

    visited += 1;
    if (path) {
      try {
        // A fresh instance each time: the shared validators above cache by schema identity, and a
        // failed compile there would poison the one every later step shares.
        freshValidator(dialect).compile(node as Record<string, any>);
      } catch (cause) {
        if (cause instanceof Error && cause.message === message) failing.push(path);
      }
    }

    for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`);
  };

  walk(schema, '');

  const deepest = failing.filter((candidate) => !failing.some((other) => other.startsWith(`${candidate}/`)));
  return deepest.length ? deepest : failing;
};

/**
 * §10.1's `strictNulls: false` — a null anywhere a property is declared satisfies that property.
 *
 * An API that serializes an absent value as `"field": null` makes a document that does not say so
 * wrong at nearly every field, and the fix the format offers is `nullable: true` written hundreds of
 * times. The binding says it once instead (§6.2), and the schema is relaxed here on the way to the
 * validator — the document on disk is untouched, and so is the spec every other consumer reads.
 *
 * **Wrapped, not annotated.** `nullable: true` is not a keyword a schema may carry anywhere: Ajv
 * refuses to compile it without a sibling `type`, which is exactly the shape of the nodes that need
 * it most — a bare `$ref`, an `allOf`, an `enum`. It does not rescue an `enum` even where it does
 * compile, because `enum` is checked on its own. `anyOf: [<the schema>, {type: null}]` holds for
 * every node shape and for both dialects, and 3.1's own `type: [..., 'null']` needs no help at all.
 *
 * **Only where a property is declared.** `properties`, `patternProperties` and a schema-valued
 * `additionalProperties` — the positions a *field* of a response object is described in. Array
 * elements are not relaxed: `[null]` is a different claim about an API than `"field": null`, and
 * the objects inside an array have their own properties relaxed by the descent.
 *
 * Recursion follows the schema keywords by name and copies everything else through, so a value that
 * merely looks like a schema — an `example:` with a `properties` key, an `enum` of objects — is
 * carried verbatim.
 */
const INJECTED = 'x-bruno-flow-nullable';

/** Keywords whose value is one schema. */
const SCHEMA_VALUED = [
  'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'additionalItems', 'unevaluatedItems'
];
/** Keywords whose value is a list of schemas — `items` is either, and is handled as both. */
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords whose value is a map of schemas that are *not* properties, so are descended but not relaxed. */
const SCHEMA_MAPS = ['$defs', 'definitions'];
/** The positions a field is declared in, which are the ones that gain the null. */
const PROPERTY_MAPS = ['properties', 'patternProperties'];

/** Already admits a null, so wrapping it would add a branch that changes nothing. */
const admitsNull = (schema: unknown): boolean => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  const node = schema as Record<string, any>;
  if (node.nullable === true || node[INJECTED]) return true;
  return node.type === 'null' || (Array.isArray(node.type) && node.type.includes('null'));
};

const orNull = (schema: unknown): unknown =>
  admitsNull(schema) ? schema : { [INJECTED]: true, anyOf: [schema, { type: 'null' }] };

const relaxSchema = (node: unknown): unknown => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;

  const source = node as Record<string, any>;
  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(source)) {
    if (PROPERTY_MAPS.includes(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, any>).map(([name, entry]) => [name, orNull(relaxSchema(entry))])
      );
    } else if (SCHEMA_MAPS.includes(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, any>).map(([name, entry]) => [name, relaxSchema(entry)])
      );
    } else if (key === 'additionalProperties' || key === 'unevaluatedProperties') {
      // `true`/`false` say what may appear, not what shape it takes, and are carried through.
      out[key] = typeof value === 'object' ? orNull(relaxSchema(value)) : value;
    } else if (SCHEMA_LISTS.includes(key) || key === 'items') {
      out[key] = Array.isArray(value) ? value.map(relaxSchema) : relaxSchema(value);
    } else if (SCHEMA_VALUED.includes(key)) {
      out[key] = relaxSchema(value);
    } else if (key === 'components' && value && typeof value === 'object') {
      // `rooted()` carries the document's definition sections along, and `$ref`s inside a response
      // schema resolve into `components.schemas` — so relaxing only the fragment would relax
      // nothing at all for the documents that write their schemas once and reference them.
      const components = value as Record<string, any>;
      out[key] = components.schemas
        ? {
            ...components,
            schemas: Object.fromEntries(
              Object.entries(components.schemas as Record<string, any>).map(([name, entry]) => [name, relaxSchema(entry)])
            )
          }
        : components;
    } else {
      out[key] = value;
    }
  }

  return out;
};

/**
 * The relaxed form of a rooted schema, memoized on it — `rooted()` returns the same object for the
 * same fragment, so this walk and the compile behind it happen once per document, not per step.
 */
const relaxed = new WeakMap<Record<string, any>, Record<string, any>>();

const withNullsRelaxed = (schema: Record<string, any>): Record<string, any> => {
  const cached = relaxed.get(schema);
  if (cached) return cached;
  const result = relaxSchema(schema) as Record<string, any>;
  relaxed.set(schema, result);
  return result;
};

/**
 * The errors that exist only because of a wrapper this engine injected.
 *
 * A wrapped node that fails for a real reason reports three times at one path: the original schema's
 * complaint, `must be null` from the injected branch, and the wrapper's own `must match a schema in
 * anyOf`. The first is the message the author would have seen without the flag, and the other two
 * describe machinery they did not write — so they go, and what is reported is byte-identical to what
 * a strict run would have said.
 *
 * The wrapper is recognized by the marker on the node the error came from (`verbose`), never by its
 * message or its path: an `anyOf` the *document* declares keeps every error it produces, and a
 * `schemaPath` is relative to whichever `$ref`'d resource the failure was inside, which is not a
 * pointer into the schema that was compiled.
 */
const withoutWrapperNoise = (errors: ErrorObject[]): ErrorObject[] => {
  const noise = new Set<string>();

  for (const error of errors) {
    if (error.keyword !== 'anyOf') continue;
    if (!(error.parentSchema as Record<string, any> | undefined)?.[INJECTED]) continue;
    noise.add(error.schemaPath);
    // The injected branch is always the second, and always `{type: 'null'}`.
    noise.add(`${error.schemaPath}/1/type`);
  }

  return noise.size ? errors.filter((error) => !noise.has(error.schemaPath)) : errors;
};

const validateAgainst = (
  schema: Record<string, any> | undefined,
  value: unknown,
  dialect: SchemaDialect,
  relaxNulls = false
): SchemaResult => {
  if (!schema) return { valid: true, errors: [] };

  const effective = relaxNulls ? withNullsRelaxed(schema) : schema;
  let validate;
  try {
    validate = validators[dialect].compile(effective);
  } catch (cause) {
    /**
     * A schema the validator will not compile is a statement about the *document*, not about the
     * response — so it is reported as a failed check on the step rather than thrown past it. Left to
     * propagate it takes the run with it (§13.2), which is how a spec the engine could not read
     * became a run that ended with nothing to say about any step.
     */
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Located in the schema as *authored*: a relaxed copy cannot introduce a compile fault, and a
    // path through it would be offset by wrapper segments the document does not contain.
    const at = locateCompileFault(schema, reason, dialect);
    const where = at.length
      ? ` — at ${at.slice(0, MAX_REPORTED_PATHS).join(', ')}${
        at.length > MAX_REPORTED_PATHS ? `, and ${at.length - MAX_REPORTED_PATHS} more` : ''}`
      : '';

    return {
      valid: false,
      errors: [{ path: '/', message: `the schema could not be compiled: ${reason}${where}`, keyword: 'schema' }]
    };
  }

  const valid = validate(value) as boolean;
  const raw = validate.errors || [];
  const reported = relaxNulls ? withoutWrapperNoise(raw) : raw;

  return {
    valid,
    // Validity is Ajv's answer and is never recomputed from what is left: the filter decides what a
    // reader is shown, not what passed. Where it would leave a failure with nothing to say — which
    // takes a wrapper failing with no complaint of its own — the unfiltered set is shown instead.
    errors: (reported.length || valid ? reported : raw).map((error) => ({
      path: error.instancePath || '/',
      message: explain(error),
      keyword: error.keyword
    }))
  };
};

/**
 * §10.1's `format: binary` carve-out, taken off both sides of the check at once: the part leaves
 * the value, and its name leaves `required`.
 *
 * Bytes are not something a keyword describes — an array of them least of all — and a schema that
 * still required the part would report every upload as a missing property. A binary part that is
 * genuinely absent is caught earlier, while the request is assembled, as `missing-binary-part`.
 */
const withoutBinaryParts = (
  schema: Record<string, any> | undefined,
  value: unknown
): { schema?: Record<string, any>; value: unknown } => {
  const properties: Record<string, any> = schema?.properties || {};
  const binary = Object.keys(properties).filter(
    (name) => properties[name]?.format === 'binary' || properties[name]?.items?.format === 'binary'
  );
  if (!binary.length || !value || typeof value !== 'object' || Array.isArray(value)) return { schema, value };

  return {
    schema: { ...schema, required: (schema?.required || []).filter((name: string) => !binary.includes(name)) },
    value: Object.fromEntries(Object.entries(value).filter(([name]) => !binary.includes(name)))
  };
};

export type ScriptRunner = (source: string, args: unknown[]) => Promise<unknown>;

/**
 * Header names as a flow addresses them — `steps.<id>.headers.<name>` (§8.3) and `req.headers.<name>`
 * (§10.2) — keyed so an author can write one.
 *
 * HTTP header names are case-insensitive and nothing tells a flow which case the server chose, or
 * which the host wrote, so `{{steps.login.headers.x-request-id}}` has to resolve whatever
 * `X-Request-Id` arrived as, and `req.headers.authorization` whatever the host spelled it. Only the
 * keys are touched — a value is reported as it was given, a repeated header included.
 */
export const lowerCasedKeys = <T>(headers: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

/**
 * §10.2's `req.*` — the request as it went out, in the shape Bruno's own `req` gives a script:
 * `url` (query string included), `method`, `headers` and `body`.
 *
 * The headers are the host's report of what it wrote (§13.2's `requestHeaders`) where it made
 * one, for the reason the capture prefers them: auth, the content type and cookies are applied
 * after the engine hands the request over, and an assertion on the declared set alone would be
 * checking a request that was never sent. Their names are lower-cased, as `steps.<id>.headers`
 * are, so one spelling addresses a header whichever side wrote it. `body` is the value for a
 * structured or text body and absent for a multipart or raw one, whose content is a file (§7.5)
 * rather than something an assertion compares.
 */
const requestView = (request: MaterializedRequest, sentHeaders?: Record<string, string>): Record<string, unknown> => {
  const query = new URLSearchParams(request.query.map((entry) => [entry.name, entry.value])).toString();
  const { body } = request;
  return {
    method: request.method,
    url: query ? `${request.url}?${query}` : request.url,
    headers: lowerCasedKeys(sentHeaders || request.headers),
    body: body.kind === 'json' || body.kind === 'text'
      ? body.value
      : body.kind === 'urlencoded'
        ? Object.fromEntries(body.fields.map((field) => [field.name, field.value]))
        : undefined
  };
};

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
  runScript: ScriptRunner,
  pre: Record<string, unknown> = {}
): Promise<{ values: Record<string, unknown>; error?: ScriptError }> => {
  const values: Record<string, unknown> = {};
  let error: ScriptError | undefined;

  for (const output of outputs) {
    try {
      const value = output.script
        ? await runScript(output.script, [context.res, context])
        : output.from === 'status'
          ? response.status
          : output.from === 'pre'
            // §8.7: promoting a value the step computed. Extracted here rather than earlier so
            // there is one rule for when a step has outputs — after a response, or not at all.
            ? pre[output.path as string]
            : get(
                (output.from === 'headers' ? response.headers : response.body) as Record<string, unknown>,
                output.path || ''
              );
      if (value !== undefined) values[output.name] = value;
    } catch (cause) {
      // The remaining outputs are still extracted: diagnosing a script that threw needs the
      // response it threw on (§8.2).
      error = error || new ScriptError(`outputs.${output.name}`, cause);
    }
  }

  return { values, error };
};

/**
 * §8.7. The values a step computes before its request, in declaration order.
 *
 * **A throw stops the rest**, which is where this differs from `extractOutputs`. An output that
 * throws still lets its siblings extract, because diagnosing it needs the response the step actually
 * got; a `pre:` script that throws means no request is built at all, so the siblings' values have
 * nothing to be for.
 *
 * `undefined` is §8.1's answer here too: the value is simply not produced, and a `{{pre.x}}`
 * naming it interpolates as an ordinary miss rather than failing the step.
 */
export const runPreScripts = async (
  pre: PreSpec[],
  context: EvaluationContext,
  runScript: ScriptRunner
): Promise<{ values: Record<string, unknown>; error?: ScriptError }> => {
  const values: Record<string, unknown> = {};

  for (const entry of pre) {
    try {
      const value = await runScript(entry.script, [context]);
      if (value !== undefined) values[entry.name] = value;
    } catch (cause) {
      return { values, error: new ScriptError(`pre.${entry.name}`, cause) };
    }
  }

  return { values };
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
  /** §8.7's computed values, for the `from: pre` outputs that promote them. */
  pre: Record<string, unknown>;
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
  if (step.flags.validateRequest && materialized.mediaType && materialized.validatableBody !== undefined) {
    const checkable = withoutBinaryParts(
      requestSchema(resolved, materialized.mediaType),
      materialized.validatableBody
    );
    // Requests are not relaxed. A body this flow wrote is not a report of what the API does with
    // nulls, and accepting one the document forbids would hide the bug rather than the divergence.
    validation.request = validateAgainst(checkable.schema, checkable.value, resolved.dialect);
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
    req: requestView(materialized.request, response.requestHeaders),
    res: {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      responseTime: response.responseTimeMs
    }
  });

  // Outputs are extracted whenever a response arrived, even when a check below then fails — which
  // is precisely what makes cleanup work (§11.2).
  const extracted = await extractOutputs(step.outputs, response, context, runScript, input.pre);
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
    const declared = responseSchema(resolved, response.status);
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
      validation.response = validateAgainst(
        declared.schema,
        response.body,
        resolved.dialect,
        step.strictNulls === false
      );
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

/**
 * §11.1's predicate, given this attempt rather than the run's settled state.
 *
 * `failures` and `outputs` are the two things that belong to the attempt being judged and to nothing
 * else: the assertions it failed, and the values its `outputs:` extracted. `outputs` is what lets a
 * poll test a derived value — `ctx.outputs.state !== 'ready'` rather than repeating in the predicate
 * the path already written in `outputs:`, which is the same path twice to keep in step with an API.
 *
 * An output whose path did not match is **absent** rather than `undefined`-valued (`extractOutputs`),
 * so `ctx.outputs.x` reads as undefined exactly the way the missing path would have off `res`. These
 * are the attempt's own values and are not `steps.<id>.*`: only the surviving attempt's are
 * published there (§8.1), and a predicate that retries is judging one about to be discarded.
 */
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
      { ...context, failures, outputs: outcome.outputs }
    ])
  );
};

export const sleepFor = async (clock: Clock, ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms > 0) await clock.sleep(ms, signal);
};
