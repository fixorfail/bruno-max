/**
 * §5.4's document schema, and the pass that runs it — the first pass of `bru flow validate` (§14.3).
 *
 * Three things live here: the schema for each format version, the **projection** that turns the
 * parsed model into the document the schema describes, and the check that reports what ajv found.
 * They belong together because the projection is the reason the schema is writable at all — JSON
 * Schema has no vocabulary for a YAML local tag, so §5.4 strips each tag to the node beneath it and
 * the schema, ajv and the YAML language server all read the same document.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

import { DROP, FileRef } from '../document';
import { suggest } from '../validate/report';
import { V1, type JsonSchema } from './v1';

/** The format version `bru flow schema` emits, and the one a flow written today declares. */
export const CURRENT_FLOW_VERSION = 1;

/** One schema per format version (§5.4): a prior version's golden fixture stays checkable. */
const SCHEMAS: Record<number, JsonSchema> = { 1: V1 };

export const FLOW_VERSIONS = Object.keys(SCHEMAS).map(Number);

/** The schema for a format version, or `undefined` for one this build does not ship. */
export const flowSchema = (version: number = CURRENT_FLOW_VERSION): JsonSchema | undefined => SCHEMAS[version];

/**
 * §5.4's projected form: strip the tag, keep the node.
 *
 * Chosen for one property — it is exactly what a tag-unaware reader already sees, so the schema and
 * the editor converge on the same document without either being told that tags exist. What it
 * discards is the tag's *identity*, which is why the checks that need it (a `!file` where the media
 * type accepts none, a `null` that is not the removal token) work on the resolved model instead.
 *
 * A `FileRef` carrying only a path projects to that path, and one carrying an option to the mapping
 * it was written as. The class keeps no record of which spelling produced it — R4p pins that a step
 * cannot tell them apart — so the fields it carries are all the projection has to read, and both
 * forms are valid wherever a tag is legal either way.
 */
export const project = (value: unknown): unknown => {
  if (value === DROP) return null;
  if (value instanceof FileRef) {
    if (value.filename === undefined && value.contentType === undefined) return value.path;
    return {
      path: value.path,
      ...(value.filename === undefined ? {} : { filename: value.filename }),
      ...(value.contentType === undefined ? {} : { contentType: value.contentType })
    };
  }
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      project(entry)
    ]));
  }
  return value;
};

export type SchemaIssue = {
  code: 'schema-violation' | 'unknown-property';
  severity: 'error' | 'warning';
  message: string;
  /** The path through the projected document, which is what `Positions.at` addresses (§13.2). */
  node: (string | number)[];
  /**
   * Set to the §14.3 code that owns this rule, when one does. The schema states such a rule so an
   * editor catches it, and the check named for it reports it — a caller running both drops these.
   */
  named?: string;
};

/**
 * `ajv` reads the *shape* of what it is given, so one instance compiled per version is enough and
 * `strict: false` matches the rest of the engine (`step.ts` validates responses the same way).
 * `verbose` is what carries `parentSchema` into an error, which is where the properties a mistyped
 * key was measured against come from.
 */
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
const compiled = new Map<number, ValidateFunction>();

const validatorFor = (version: number): ValidateFunction | undefined => {
  const cached = compiled.get(version);
  if (cached) return cached;
  const schema = flowSchema(version);
  if (!schema) return undefined;
  const validate = ajv.compile(schema);
  compiled.set(version, validate);
  return validate;
};

const segmentsOf = (instancePath: string): (string | number)[] =>
  instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));

/**
 * Where a violation is, named the way its author wrote it: `steps.create_payment.retry` rather than
 * `steps.3.retry`. An index is what ajv reports and an id is what the file reads as, and a message
 * naming the index sends its reader counting steps.
 */
const describe = (model: Record<string, unknown>, segments: (string | number)[]): string => {
  if (segments.length === 0) return 'the document';
  const steps = Array.isArray(model.steps) ? model.steps : [];
  const named = segments.map((segment, index) => {
    if (index !== 1 || segments[0] !== 'steps' || typeof segment !== 'number') return segment;
    const id = (steps[segment] as Record<string, unknown> | undefined)?.id;
    return typeof id === 'string' && id ? id : segment;
  });
  return named.join('.');
};

/** The rule that owns a violation, for the pointers §5.4 keeps under `$defs/named` (see `v1.ts`). */
const namedRule = (error: ErrorObject): string | undefined =>
  error.schemaPath.match(/^#\/\$defs\/named\/([a-z-]+)\//)?.[1];

/**
 * `if`, `anyOf` and `oneOf` report that a branch did not match, which restates the errors that
 * branch already produced — three lines for one mistyped value. Kept only where nothing more
 * specific was found, so a union that failed for no locatable reason still says something.
 */
const SUMMARY = ['if', 'anyOf', 'oneOf'];

const informative = (errors: ErrorObject[]): ErrorObject[] =>
  errors.filter(
    (error) =>
      !SUMMARY.includes(error.keyword)
      || !errors.some(
        (other) =>
          other !== error && !SUMMARY.includes(other.keyword) && other.instancePath.startsWith(error.instancePath)
      )
  );

const issueFor = (model: Record<string, unknown>, error: ErrorObject): SchemaIssue => {
  const segments = segmentsOf(error.instancePath);

  if (error.keyword === 'additionalProperties') {
    const property = String(error.params.additionalProperty);
    const declared = Object.keys((error.parentSchema as JsonSchema | undefined)?.properties || {});
    return {
      code: 'unknown-property',
      severity: 'warning',
      message: `${describe(model, segments)} has no ${property} property${suggest(property, declared)}`,
      node: [...segments, property]
    };
  }

  return {
    code: 'schema-violation',
    severity: 'error',
    message: `${describe(model, segments)} ${error.message}`,
    node: segments,
    ...(namedRule(error) ? { named: namedRule(error) } : {})
  };
};

/**
 * §14.3's first pass, over the projected document (§5.4).
 *
 * Reported rather than thrown, and never fatal: a document that satisfies YAML but not the schema
 * still has a graph, an `apis:` block and a set of references worth checking, and stopping here
 * would make every mistyped key hide every real one below it. Only a document that did not *parse*
 * has no model to read (§14.3's `parse-error`).
 *
 * An unknown property is a **warning** (§5.4). Flows are committed and shared, so an older Bruno
 * opens files a newer one wrote; refusing a field this build does not implement would make the older
 * CLI reject a valid flow, which is §15's forward-compatibility rule read backwards. The author
 * still gets the squiggle, and `--strict` is there for a team that wants the stricter posture.
 */
export const checkDocumentSchema = (model: Record<string, unknown>): SchemaIssue[] => {
  const version = model.version;
  const validate = typeof version === 'number' ? validatorFor(version) : undefined;

  if (!validate) {
    return [
      {
        code: 'schema-violation',
        severity: 'error',
        message:
          `version: ${version === undefined ? 'is missing' : String(version)} — this build describes format `
          + `version ${FLOW_VERSIONS.join(', ')}, and each version has a schema of its own (§5.4)`,
        node: ['version']
      }
    ];
  }

  if (validate(project(model))) return [];
  return informative(validate.errors || []).map((error) => issueFor(model, error));
};
