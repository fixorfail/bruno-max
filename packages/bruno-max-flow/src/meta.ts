/**
 * Reading and rewriting a flow's `meta:` block — 001 §5.2, for 002 §4.4's properties dialog.
 *
 * **The writing lives here for the same reason `readFlowMeta` does.** §5.1 buys one parser and one
 * serializer by making flows YAML-only; a host that edited `meta:` with a YAML library of its own
 * would be the second serializer that decision exists to avoid, and it would have to know §5.4's
 * local tags to leave them alone. `serialize.ts` holds the pieces this shares with `edit.ts`, which
 * writes the rest of the document (005 §9.1).
 *
 * **Everything outside `meta:` survives, and that is the requirement rather than a nicety.** A
 * `.flow.yml` is a committed, hand-edited file (§5.1), so a dialog that changed a name and
 * reformatted the steps underneath would make every property edit an unreviewable diff.
 * `parseDocument` + `String(document)` keeps the untouched nodes as they were written — comments,
 * anchors, merge keys, flow-style collections and blank lines included.
 *
 * The one exception is cosmetic and unavoidable: `yaml` re-emits a trailing comment one space after
 * its value, so padding used to align a column of them collapses. Nothing the format carries meaning
 * in is affected, and there is no serializer option that preserves it.
 */
import * as path from 'path';

import * as YAML from 'yaml';

import { asRecord, parseDocument } from './document';
import { CURRENT_FLOW_VERSION } from './schema';
import { PARSE_OPTIONS, ensureBlock, isMeaningful } from './serialize';
import type { FlowIdentity } from './types/reporter';

/** §5.2's `meta:`, as a dialog edits it. */
export type FlowProperties = {
  name?: string;
  description?: string;
  /** §5.2's flow-level case id, carried into reports (§14.8.1b) and read by nothing else. */
  testId?: string;
  tags: string[];
  library: boolean;
};

const asStringArray = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
    .map((entry) => String(entry).trim())
    .filter(Boolean);

/**
 * A flow's `meta:`, from its text and nothing else.
 *
 * Wider than `readFlowMeta`, and separate from it on purpose: that one is the *watcher's* read, run
 * over every flow in a scope on every tree change, and it answers the two questions a sidebar row
 * asks. This one is opened by a dialog, for one flow, and answers all four.
 *
 * Tolerant in the same way: text that does not parse has no properties, which is the same answer as
 * a flow that declares none. The dialog reports the file as unreadable rather than offering to edit
 * a document it could not read (002 §6 makes an unparseable flow ordinary).
 */
export const readFlowProperties = (text: string): FlowProperties | undefined => {
  const document = YAML.parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length) return undefined;

  const meta = document.getIn(['meta']);
  const model = YAML.isMap(meta) ? (meta.toJSON() as Record<string, unknown>) : {};
  const name = model.name;
  const description = model.description;
  // `document.ts` coerces this one, because §5.2 fixes its type and YAML reads a bare `1000` as a
  // number; the dialog edits text, so it reads back the same string the engine would normalize to.
  const testId = model.testId === undefined || model.testId === null ? '' : String(model.testId).trim();

  return {
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
    ...(testId ? { testId } : {}),
    tags: asStringArray(model.tags),
    // §12.5's flag as the engine reads it — `Boolean(meta.library)` in `document.ts`. Anything else
    // would let the dialog disagree with the run about which flows `bru flow run .` executes.
    library: model.library === true
  };
};

/** The edit itself, on a parsed document. `false` means nothing was written and the text stands. */
const writeProperties = (document: YAML.Document, properties: FlowProperties): boolean => {
  const entries: [string, unknown][] = [
    ['name', typeof properties.name === 'string' ? properties.name.trim() : ''],
    ['description', typeof properties.description === 'string' ? properties.description.trim() : ''],
    ['testId', typeof properties.testId === 'string' ? properties.testId.trim() : ''],
    ['tags', asStringArray(properties.tags)],
    ['library', properties.library === true]
  ];

  if (!YAML.isMap(document.getIn(['meta']))) {
    if (!entries.some(([, value]) => isMeaningful(value))) {
      // Nothing to say, and no block to say it in. Creating an empty `meta:` would be an edit to a
      // file the author changed nothing about.
      return false;
    }
    ensureBlock(document, 'meta', {}, ['version']);
  }

  for (const [key, value] of entries) {
    if (isMeaningful(value)) {
      document.setIn(['meta', key], value);
    } else {
      document.deleteIn(['meta', key]);
    }
  }

  return true;
};

/**
 * The same block, written back — 002 §4.4.
 *
 * **A default is written as an absence.** `description: ''`, `tags: []` and `library: false` all
 * mean to the engine exactly what the missing key means, so clearing a field deletes it rather than
 * spelling out the default. `CreateFlow`'s `buildFlowDocument` already writes a new flow that way,
 * and a properties dialog that wrote the other one would make an edit-and-undo leave a file that no
 * longer matches the one it started as.
 *
 * Returns `undefined` for text that does not parse, for `readFlowProperties`' reason: there is no
 * document to edit, and writing one built from scratch would silently discard the file.
 */
export const writeFlowProperties = (text: string, properties: FlowProperties): string | undefined => {
  const document = YAML.parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length) return undefined;
  return writeProperties(document, properties) ? String(document) : text;
};

/**
 * A flow's opening document — 002 §4.1c — which is the skeleton `writeFlowProperties` splices
 * `meta:` into, built here so no host ever emits one: `version:` for the format written today,
 * `meta:` as the dialog writes it, and an `apis:` binding per selected document.
 *
 * **No `steps:` key**, per §4.1c: the app cannot guess a step, and an empty list would claim to
 * describe a flow rather than the absence of one. `apis:` is written only when there is a binding
 * to write, for the reason a default `meta:` key is an absence.
 *
 * `apis` maps each alias to the source path *as the host resolved it* — relative to the directory
 * the file is about to sit in (§6.2) — because paths are the host's, and the engine has no
 * directory to measure from. An entry with a blank alias or source is nothing to bind and is left
 * out, rather than written as a key the run would then report as an unresolvable binding.
 */
export const writeNewFlowDocument = (input: { properties: FlowProperties; apis: Record<string, string> }): string => {
  const apis = Object.entries(input.apis).filter(([alias, source]) => alias.trim() && source.trim());
  const document = new YAML.Document({
    version: CURRENT_FLOW_VERSION,
    ...(apis.length ? { apis: Object.fromEntries(apis) } : {})
  });
  writeProperties(document, input.properties);
  return String(document);
};

/**
 * What a reader calls a flow — §5.2's identity, and the `meta:` a roster or a report writes beside it.
 *
 * **One spelling, because three readers have to agree on it.** A suite's roster, a report's rows and
 * a rerun's selection are matched to each other by `id`; a host that derived it with a rule of its
 * own would produce a report whose flows could not be found in the roster written next to it. The
 * path transform is the whole of the rule — relative to the scope root, `.flow.yml` removed, posix
 * separators, so an id is the same string on Windows as on the machine that wrote the run.
 *
 * Pure, and `source` is optional, because the hosts read files differently — one synchronously, one
 * through a port — and because a flow that will not parse still needs a row: no text and text that
 * declares no `meta:` give the same answer, which is the file's own stem.
 */
export const flowIdentity = (scopeRoot: string, file: string, source?: string): FlowIdentity => {
  const properties = source === undefined ? undefined : readFlowProperties(source);

  return {
    file,
    id: path.relative(scopeRoot, file).replace(/\.flow\.yml$/, '').split(path.sep).join('/'),
    name: (properties && properties.name) || path.basename(file).replace(/\.flow\.yml$/, ''),
    tags: (properties && properties.tags) || [],
    // Absent rather than empty when the flow declares none: a report writes the property only for a
    // flow a tracker actually has a case for.
    ...(properties && properties.testId ? { testId: properties.testId } : {})
  };
};

/**
 * A flow as a listing shows it — §5.2's identity, plus the two facts a row needs that identity does
 * not carry: §12.5's `library` flag and how many steps the file declares (001 §14.7).
 *
 * **Here rather than at the host, because the host must not parse `.flow.yml`.** §5.1 buys one
 * parser by making flows YAML-only, and `bru flow list` reading the format itself would be the
 * second one — it would have to know §5.4's local tags to see `!file` as a value rather than as a
 * broken file, and it would derive `library` with a rule the run could disagree with.
 *
 * A read in `flowSearchTerms`' sense, and for its reasons: text in, summary out — no ports, no
 * `describeFlow`, no OpenAPI resolution, and no file reads of any kind, since this runs over every
 * flow a listing names. Text that does not parse yields the identity its path carries with no
 * library flag and no steps, so a flow the author is midway through editing is listed rather than
 * dropped (002 §6) — being unreadable is `validateFlow`'s finding to report, not a listing's to
 * settle by omission.
 */
export const readFlowSummary = (
  scopeRoot: string,
  file: string,
  source?: string
): FlowIdentity & { library: boolean; steps: number } => {
  // The engine's own reader, so §5.4's local tags are values rather than errors and a document with
  // errors yields `{}` — the same tolerance every other host-facing read in the package has.
  const { model } = parseDocument(source === undefined ? '' : source);

  return {
    ...flowIdentity(scopeRoot, file, source),
    // `document.ts`'s reading of the flag and nothing looser: a listing that called a flow a library
    // on some other evidence would disagree with the run about which flows a directory selects.
    library: asRecord(model.meta).library === true,
    steps: Array.isArray(model.steps) ? model.steps.length : 0
  };
};
