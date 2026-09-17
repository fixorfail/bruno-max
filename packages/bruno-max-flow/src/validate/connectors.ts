/**
 * A connector file checked against the documents it binds — 001 §8.5 and §14.3.
 *
 * Every entry resolves to a real operation, and every path is checked against that operation's
 * response schema. Both matter more here than for an inline output: an inline path that selects
 * nothing leaves one step's output unset, and a connector path that selects nothing leaves it unset
 * in *every* flow that targets the operation — reported, if at all, as `unresolved-dependency`
 * against a consuming step three flows away from the file that is wrong.
 *
 * Diagnostics anchor to the connector file and its own lines, not to the flow being validated: the
 * thing to fix is in the file the diagnostic names.
 */
import type { Connectors, ConnectorEntry, ConnectorFile } from '../connectors';
import { AUTH_MODES } from '../schema/v1';
import { deref, resolveSpecSource, type ResolvedOperation } from '../openapi';
import type { Diagnostic } from '../types/result';
import { propertiesOf, type Schema } from './operation';
import { suggest } from './report';

/**
 * The paths this can hold a schema to: a property chain, with a numeric index where an array is
 * stepped into. bruno-query's filters and wildcards select by value, which no schema decides.
 */
const CHECKABLE_PATH = /^[A-Za-z_$][\w$]*(\[\d+\])?(\.[A-Za-z_$][\w$]*(\[\d+\])?)*$/;

/** The schemas a success can arrive with; an error body is not what an output is written for. */
const successSchemas = (resolved: ResolvedOperation): Schema[] =>
  Object.entries<Record<string, any>>(resolved.operation.responses || {})
    .filter(([status]) => /^2(\d\d|XX)$/.test(status))
    .flatMap(([, response]) => {
      const content = response?.content || {};
      const json = Object.entries<Record<string, any>>(content).find(([type]) => type.includes('json'));
      return json?.[1]?.schema ? [json[1].schema] : [];
    });

type Walk = { verdict: 'found' | 'silent' } | { verdict: 'missing'; segment: string; among: string[] };

/**
 * One schema, one path. `silent` wherever the schema stops being specific about its keys — a
 * free-form object, a `$ref` out of reach — for `checkFields`' reason: the check exists to catch a
 * typo, and a schema that documents nothing about its keys cannot tell one from a field it omits.
 */
const walk = (schema: Schema, path: string, definitions: Schema): Walk => {
  let current: Schema | undefined = deref(schema, definitions);

  for (const segment of path.split('.')) {
    const bracket = segment.indexOf('[');
    const name = bracket === -1 ? segment : segment.slice(0, bracket);
    const properties = propertiesOf(current, definitions);
    if (!properties) return { verdict: 'silent' };
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      return { verdict: 'missing', segment: name, among: Object.keys(properties) };
    }
    current = deref(properties[name], definitions);
    // Stepped into by index, or an array read whole — bruno-query maps the rest of the path over
    // its items either way, so the items' schema is what the next segment is held to.
    if (current && (bracket !== -1 || current.type === 'array')) current = deref(current.items, definitions);
    if (!current) return { verdict: 'silent' };
  }
  return { verdict: 'found' };
};

const checkEntry = (
  file: ConnectorFile,
  entry: ConnectorEntry,
  resolved: ResolvedOperation,
  error: (code: string, message: string, node: (string | number)[]) => void
) => {
  const schemas = successSchemas(resolved);

  for (const output of entry.outputs) {
    if (output.from !== 'body' || output.script || !output.path || !CHECKABLE_PATH.test(output.path)) continue;
    if (!schemas.length) continue;

    const walked = schemas.map((schema) => walk(schema, output.path as string, resolved.definitions));
    // A path is wrong only when every success schema is specific and none of them has it: an
    // operation whose 200 and 201 differ may legitimately carry a field in one and not the other.
    if (walked.some((result) => result.verdict !== 'missing')) continue;

    const [first] = walked as Extract<Walk, { verdict: 'missing' }>[];
    error(
      'unknown-output-path',
      `${entry.key}: ${output.name} takes ${output.path}, and ${first.segment} is not in the operation's response `
      + `schema${suggest(first.segment, first.among)}`,
      ['connectors', entry.key, output.name]
    );
  }
};

/** The keys §6.2 gives a binding. A connector file's `apis:` is the same block, read by one rule. */
const BINDING_KEYS = [
  'source', 'baseUrl', 'auth', 'defaultHeaders', 'defaultQuery', 'color', 'rateLimit', 'strictNulls'
];

/**
 * §8.5's `apis:` block, which exists so an entry has an alias to hang on — and which 004 §5 gave a
 * second job: a service's `rateLimit:` declared once for every flow that calls it.
 *
 * Nothing else checks this block. A flow's is covered by §5.4's schema, and a connector file never
 * meets that schema, so a key misspelt here is a limit that silently never applied — the run goes at
 * full speed and nothing says why. That is the failure this file exists to prevent one layer down.
 */
type Report = (code: string, message: string, node: (string | number)[]) => void;

const checkBindings = (file: ConnectorFile, error: Report, warn: Report): void => {
  /**
   * Two aliases in one file for one document. Harmless while `apis:` only gave an entry something to
   * hang on — an entry names its alias, so both worked — and not harmless now that the block also
   * carries defaults a flow inherits: those are matched on the document, so one alias's fields
   * silently replace the other's. The later declaration is the one that applies.
   */
  const seen = new Map<string, string>();
  for (const [alias, binding] of Object.entries(file.apis)) {
    const identity = resolveSpecSource(binding.source, file.file);
    const first = seen.get(identity);
    if (first) {
      warn(
        'duplicate-binding',
        `apis.${alias} binds the same document as apis.${first}, and only the later one's defaults `
        + 'apply to a flow that inherits them — declare the document once',
        ['apis', alias]
      );
    } else {
      seen.set(identity, alias);
    }
  }

  for (const [alias, raw] of Object.entries(file.rawApis)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (BINDING_KEYS.includes(key)) continue;
      warn(
        'unknown-property',
        `apis.${alias} declares ${key}, which is not a binding property${suggest(key, BINDING_KEYS)}`,
        ['apis', alias, key]
      );
    }

    const binding = file.apis[alias];
    if (!binding) continue;

    // §6.2's colour, checked here for the same reason the rate is: a flow inherits it, and a
    // diagnostic against every flow that binds the document would name none of the files to fix.
    if (binding.color !== undefined && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(binding.color)) {
      warn(
        'invalid-api-color',
        `apis.${alias} declares color: ${binding.color}, which is not a #rgb or #rrggbb colour`,
        ['apis', alias, 'color']
      );
    }

    const limit = binding.rateLimit;
    if (!limit) continue;
    for (const [key, value] of [
      ['requests', limit.requests],
      ['burst', limit.burst]
    ] as const) {
      if (Number.isInteger(value) && value >= 1) continue;
      error(
        'invalid-rate-limit',
        `apis.${alias} declares rateLimit.${key} as ${Number.isNaN(value) ? 'a value that is not a number' : String(value)} — it is a whole number of at least 1`,
        ['apis', alias, 'rateLimit', key]
      );
    }
  }
};

/**
 * §6.4's profiles declared in a connector file (§8.5).
 *
 * `mode` is the one field the engine reads, and §5.4's schema requires it of a flow's profiles —
 * but a connector file meets no schema, so without this a profile with a misspelt or missing mode is
 * a credential that silently authenticates as `none`. Reported here rather than against the flows
 * that use it: the mistake is in this file, and it is one mistake however many flows inherit it.
 */
const checkProfiles = (file: ConnectorFile, error: Report): void => {
  for (const [name, profile] of Object.entries(file.authProfiles)) {
    const mode = profile.mode;
    if (mode === undefined) {
      error('invalid-auth-profile', `authProfiles.${name} declares no mode:`, ['authProfiles', name]);
      continue;
    }
    if (!AUTH_MODES.includes(String(mode))) {
      error(
        'invalid-auth-profile',
        `authProfiles.${name} declares mode: ${String(mode)}${suggest(String(mode), AUTH_MODES)}`,
        ['authProfiles', name, 'mode']
      );
    }
  }
};

export const checkConnectors = (connectors: Connectors): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const file of connectors.files) {
    const report = (severity: Diagnostic['severity']) =>
      (code: string, message: string, node: (string | number)[]) => {
        diagnostics.push({ severity, code, message, file: file.file, ...(file.positions.at(node) || {}) });
      };
    const error = report('error');
    // §6.2's colour and an unrecognized binding key carry the severity the flow document's own
    // schema gives them, so a file that is wrong the same way is wrong to the same degree wherever
    // it is written — and `--strict` still stops on either.
    const warn = report('warning');

    // A file that did not parse has no entries worth checking, for the reason a flow's parse error
    // stops everything else (§14.3) — the model it left is not evidence of what was written.
    if (file.errors.length) {
      for (const parseError of file.errors) {
        diagnostics.push({
          severity: 'error',
          code: 'parse-error',
          message: parseError.message,
          file: file.file,
          line: parseError.line,
          column: parseError.column
        });
      }
      continue;
    }

    checkBindings(file, error, warn);
    checkProfiles(file, error);

    for (const entry of file.entries) {
      if (entry.problem) {
        error(entry.problem.code, entry.problem.message, entry.problem.node);
        continue;
      }
      if (!entry.mapping) {
        error(
          'invalid-connector-entry',
          `${entry.key} is not a mapping of outputs — an entry declares each output by name, as a step's outputs: does (§8.5)`,
          ['connectors', entry.key]
        );
        continue;
      }
      for (const name of entry.nulls) {
        error(
          'null-output',
          `${entry.key}: ${name} is null, which is not the removal token — an inherited entry is dropped with !... (§8.5)`,
          ['connectors', entry.key, name]
        );
      }
      if (entry.resolved) checkEntry(file, entry, entry.resolved.operation, error);
    }
  }

  return diagnostics;
};
