/**
 * The JSON Schema for a **version 1** flow document — 001 §5.4.
 *
 * One file per format version, and this one never changes shape: §5.4 gives a version's schema only
 * optional additions, so a v1 schema shipped today still accepts a v1 file written a year from now
 * and §15's golden fixture for v1 stays checkable against the schema that was current when it was
 * written. A version 2 is a new file beside this one, not an edit to it.
 *
 * It describes the **projected** model (§5.4): the local tags are stripped to the node beneath them,
 * because that is exactly what a tag-unaware reader — the YAML language server, given
 * `yaml.customTags` — already sees. A schema naming a marker shape instead would red-squiggle every
 * valid `!file` in the file.
 *
 * It is the *structural* half of validation. Whether an `operation:` resolves, whether a reference
 * names an ancestor, whether the graph is acyclic — none of that is decidable from one document, and
 * a schema that grew that knowledge could not keep it correct. §14.3 stays the authority.
 */

/** A JSON Schema document, as `ajv` and an editor read it. */
export type JsonSchema = Record<string, unknown>;

/**
 * §6.4: a profile carries the fields of Bruno's existing auth modes — the `mode` union in
 * `@usebruno/schema-types`' `common/auth.ts`.
 */
const AUTH_MODES = [
  'inherit', 'none', 'awsv4', 'basic', 'bearer', 'digest', 'ntlm', 'oauth1', 'oauth2', 'wsse',
  'apikey', 'akamai-edgegrid'
];

/** §9.1's four outcomes, which is the whole of what a `depends.status` may name. */
const STATUSES = ['success', 'failed', 'skipped', 'cancelled'];

/** §12.4's table, error column: the fields addressing one response, which a sub-flow does not have. */
const SUBFLOW_ERRORS = [
  'retry', 'timeout', 'failOnStatusCode', 'validateRequest', 'validateSchema', 'strictSchema',
  'failOnUnresolved', 'body', 'bodyFile', 'query', 'headers', 'pathParams', 'contentType', 'auth'
];

/**
 * A value the format fixes as free text. `null` is permitted because a bare `name:` is the author
 * writing the key and saying nothing, which the parser reads as absent — a schema stricter than the
 * engine reports an error for a document that behaves exactly as written.
 */
const TEXT = { type: ['string', 'null'] };

const BOOLEAN = { type: 'boolean' };
const MILLISECONDS = { type: 'integer', minimum: 0 };

const RETRY_PROPERTIES = {
  maxAttempts: { type: 'integer', minimum: 1 },
  delay: MILLISECONDS,
  backoff: { enum: ['fixed', 'exponential'] },
  maxDelay: MILLISECONDS,
  jitter: { enum: ['none', 'full'] },
  shouldRetry: { type: 'string' }
};

/** §5.3's per-step overrides of §5.2's `config:` flags, which are the same booleans one level down. */
const STEP_FLAGS = {
  failOnStatusCode: BOOLEAN,
  failOnUnresolved: BOOLEAN,
  validateRequest: BOOLEAN,
  validateSchema: BOOLEAN,
  strictSchema: BOOLEAN
};

/**
 * A rule §14.3 names with a code of its own lives under `$defs/named/<code>`.
 *
 * The schema states these because an editor runs the schema and nothing else, so this is the only
 * place they are caught while the mistake is being typed. Inside `bru flow validate` the check that
 * owns each one reports it instead, under the name §14.3 gave it — the pointer is what lets the
 * schema pass recognize its own error as one already spoken for, so a reader gets one diagnostic per
 * mistake rather than two under different names.
 */
const NAMED = {
  'invalid-step-id': {
    $comment: '§5.3: an id is addressed as {{steps.<id>.x}} and becomes a capture directory name.',
    type: 'string',
    pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$'
  },
  'operation-and-uses': {
    $comment: '§5.3: a step declares either operation: or uses:, never both.',
    not: { required: ['operation', 'uses'] }
  },
  'body-and-body-file': {
    $comment: '§7.4: two sources for one value, with no precedence between them.',
    not: { required: ['body', 'bodyFile'] }
  },
  'invalid-subflow-field': {
    $comment: '§12.4: a field addressing one response, on a step whose sub-flow has many or none.',
    if: { required: ['uses'] },
    then: { allOf: SUBFLOW_ERRORS.map((field) => ({ not: { required: [field] } })) }
  },
  /**
   * §9.1: the outcomes a dependency may wait for, written singly or as a list.
   *
   * Branched on the type rather than written as `anyOf`, because `enum` applies to a value whatever
   * its type: under a union a misspelled entry fails the scalar branch *and* the list branch, and
   * one typo squiggles twice in an editor.
   */
  'invalid-dependency-status': {
    $comment: '§9.1: the outcomes a dependency may wait for.',
    if: { type: 'array' },
    then: { items: { enum: STATUSES } },
    else: { enum: STATUSES }
  }
};

/**
 * §9.1's dependency: a step id, or the expanded form naming the outcomes it accepts.
 *
 * Written as one schema over both types rather than as a union, because `properties`, `required` and
 * `additionalProperties` apply only to objects and are ignored for the string form — so a value that
 * is neither reports *one* error naming both types instead of one per branch plus a summary.
 */
const DEPENDENCY = {
  type: ['string', 'object'],
  properties: {
    on: { type: 'string' },
    status: { $ref: '#/$defs/named/invalid-dependency-status' }
  },
  required: ['on'],
  additionalProperties: false
};

/** §9.3: an expression, or the script form, with a list of either meaning implicit AND. */
const CONDITION = {
  type: ['string', 'object'],
  properties: { script: { type: 'string' } },
  required: ['script'],
  additionalProperties: false
};

/** §10.2's triple, written as a line or as its parts. */
const ASSERTION = {
  type: ['string', 'object'],
  properties: {
    expr: { type: 'string' },
    op: { type: 'string' },
    value: {}
  },
  required: ['expr', 'op'],
  additionalProperties: false
};

/**
 * §8.1's connector. The string form is a path into the response; the mapping form names another
 * source or a script.
 *
 * `null` is valid and is the one place the projection's cost is visible: `!...` suppresses an
 * inherited connector entry (§8.5) and projects to `null`, which the schema cannot tell from a key
 * left empty by accident. §14.3 has the identity the projection dropped and errors on the second.
 */
const OUTPUT = {
  type: ['string', 'object', 'null'],
  properties: {
    from: { enum: ['body', 'headers', 'status', 'pre'] },
    path: { type: 'string' },
    script: { type: 'string' }
  },
  additionalProperties: false
};

/** §7's merge layers: open mappings, since their keys are the operation's fields. */
const OVERRIDES = { type: 'object' };

const STEP = {
  type: 'object',
  allOf: [
    { $ref: '#/$defs/named/operation-and-uses' },
    { $ref: '#/$defs/named/body-and-body-file' },
    { $ref: '#/$defs/named/invalid-subflow-field' },
    // §5.3: a step targets an operation or invokes a sub-flow. One that names neither sends nothing
    // and is not a step; the named rule above refuses the other half, which is naming both. Written
    // as a condition rather than as `anyOf`, so a step with neither reports the field it is missing
    // instead of one error per branch.
    { if: { not: { required: ['uses'] } }, then: { required: ['operation'] } }
  ],
  properties: {
    id: { $ref: '#/$defs/named/invalid-step-id' },
    name: TEXT,
    /** §5.3's open metadata block: the engine reads no key of it, a reporter does (§14.8.4). */
    meta: { type: 'object' },
    operation: { type: 'string' },
    uses: { type: 'string' },
    with: { type: 'object' },
    auth: { type: 'string' },
    depends: {
      type: ['array', 'object'],
      items: DEPENDENCY,
      properties: {
        all: { type: 'array', items: DEPENDENCY },
        any: { type: 'array', items: DEPENDENCY }
      },
      additionalProperties: false
    },
    when: {
      type: ['string', 'object', 'array'],
      items: CONDITION,
      properties: CONDITION.properties,
      required: CONDITION.required,
      additionalProperties: false
    },
    body: {},
    bodyFile: { type: 'string' },
    query: OVERRIDES,
    headers: OVERRIDES,
    pathParams: OVERRIDES,
    contentType: { type: 'string' },
    /** §8.7: a name and the script computing it, evaluated before the request is materialized. */
    pre: { type: 'object', additionalProperties: { type: 'string' } },
    outputs: { type: 'object', additionalProperties: OUTPUT },
    /** §9.1's write side: a slot, and the output published into it. */
    shared: {
      type: ['array', 'object'],
      items: { type: 'string' },
      additionalProperties: { type: 'string' }
    },
    assert: { type: 'array', items: ASSERTION },
    retry: { type: 'object', properties: RETRY_PROPERTIES, additionalProperties: false },
    ...STEP_FLAGS,
    timeout: MILLISECONDS,
    maxDuration: MILLISECONDS
  },
  required: ['id'],
  additionalProperties: false
};

export const V1: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://usebruno.com/schemas/flow/v1.json',
  title: 'Bruno API Flow',
  description: 'A .flow.yml document, format version 1 — docs/specs/001-api-flows.md §5.',
  type: 'object',
  properties: {
    version: { const: 1 },
    meta: {
      type: 'object',
      properties: {
        name: TEXT,
        description: TEXT,
        // §14.8.1b's case id. A bare `C1000` is text and a bare `1000` is a number in YAML, and a
        // report writes it as text either way.
        testId: { type: ['string', 'number', 'null'] },
        tags: { type: ['string', 'array'], items: { type: 'string' } },
        /** §12.5: what excludes a flow from a glob run. */
        library: BOOLEAN
      },
      additionalProperties: false
    },
    /** §6.2: an alias bound to an OpenAPI document, with the defaults every step through it takes. */
    apis: {
      type: 'object',
      additionalProperties: {
        type: ['string', 'object'],
        properties: {
          source: { type: 'string' },
          baseUrl: { type: 'string' },
          auth: { type: 'string' },
          defaultHeaders: OVERRIDES,
          defaultQuery: OVERRIDES,
          /** §6.2's presentation colour; a viewer falls back to its unpainted default. */
          color: { type: 'string' }
        },
        required: ['source'],
        additionalProperties: false
      }
    },
    /** §8.6: the functions every script position in this flow may call. */
    functions: {
      type: 'object',
      properties: { use: { type: ['string', 'array'], items: { type: 'string' } } },
      additionalProperties: { type: 'string' }
    },
    config: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' },
        ...STEP_FLAGS,
        concurrency: { type: 'integer', minimum: 1 },
        maxRunDuration: MILLISECONDS,
        cleanupGrace: MILLISECONDS,
        retry: { type: 'object', properties: RETRY_PROPERTIES, additionalProperties: false },
        /** §14.4's additions to the built-in denylist. */
        redactHeaders: { type: 'array', items: { type: 'string' } },
        /** §14.5's inline preview cap, in bytes. */
        capturePreviewBytes: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    },
    /**
     * §6.4: authored flat and delivered nested. Beyond `mode` a profile carries the fields of the
     * mode it names, which belong to `@usebruno/schema-types`' `Auth` union rather than to this
     * format — copying that list here would flag a valid profile the first time upstream adds a
     * field to a mode, and §5.4 claims the `mode` enum rather than the fields under it.
     */
    authProfiles: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { mode: { enum: AUTH_MODES } },
        required: ['mode']
      }
    },
    /** §7.3: flow-scoped values, evaluated once before any step runs. */
    vars: { type: 'object' },
    /** §9.1's slots: a list of names, or a mapping giving each its own rule for readers. */
    shared: {
      type: ['array', 'object'],
      items: { type: 'string' },
      additionalProperties: {
        type: 'object',
        properties: { writers: { enum: ['all', 'any'] } },
        additionalProperties: false
      }
    },
    /** §9.4: the whole flow runs once per row. */
    dataset: {
      type: ['string', 'object'],
      properties: {
        source: { type: 'string' },
        parallel: { type: 'integer', minimum: 1 }
      },
      required: ['source'],
      additionalProperties: false
    },
    /** §12.1's interface, for a flow another one invokes. */
    params: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          required: BOOLEAN,
          default: {},
          /** §14.4: the author saying this param's value must not be written down. */
          secret: BOOLEAN
        },
        additionalProperties: false
      }
    },
    exports: { type: 'object', additionalProperties: { type: 'string' } },
    /** §5.5: a stage name, and the step whose column the rule is drawn before. */
    stages: { type: 'object', additionalProperties: { type: 'string' } },
    steps: { type: 'array', items: STEP }
  },
  required: ['version', 'steps'],
  additionalProperties: false,
  $defs: { named: NAMED }
};
