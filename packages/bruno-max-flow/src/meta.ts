/**
 * Reading and rewriting a flow's `meta:` block — 001 §5.2, for 002 §4.4's properties dialog.
 *
 * **This is the format's only writer, and it lives here for the same reason `readFlowMeta` does.**
 * §5.1 buys one parser and one serializer by making flows YAML-only; a host that edited `meta:` with
 * a YAML library of its own would be the second serializer that decision exists to avoid, and it
 * would have to know §5.4's local tags to leave them alone.
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
import * as YAML from 'yaml';

/** §5.2's `meta:`, as a dialog edits it. */
export type FlowProperties = {
  name?: string;
  description?: string;
  tags: string[];
  library: boolean;
};

/**
 * **Deliberately not `document.ts`'s `TAGS`.** Those resolve `!file` to a `FileRef` and `!...` to a
 * symbol, which is right for a model the engine runs and wrong for a document it intends to write
 * back: the tag has no matching `stringify`, so re-emitting a resolved node yields
 * `catalog: !file "[object Object]"` and a flow's fixtures are destroyed by an edit to its name.
 *
 * Resolving to the node itself keeps the tag *and* its content exactly as parsed. Nothing here needs
 * to know what a tag means — only `meta:` is read, and `meta:` has none — so identity is not a
 * shortcut but the whole of what a serializer wants.
 */
const TAGS: YAML.Tags = [
  { tag: '!file', collection: 'map', resolve: (map: YAML.YAMLMap) => map },
  { tag: '!file', resolve: (value: string) => value },
  { tag: '!...', resolve: (value: string) => value }
] as YAML.Tags;

/** `merge: true` and `logLevel: 'silent'` for `document.ts`'s reasons, which do not change here. */
const OPTIONS: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = {
  merge: true,
  customTags: TAGS,
  logLevel: 'silent'
};

/** A `meta` entry is written when it says something, and omitted when it does not. */
const isMeaningful = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
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
  const document = YAML.parseDocument(text, OPTIONS);
  if (document.errors.length) return undefined;

  const meta = document.getIn(['meta']);
  const model = YAML.isMap(meta) ? (meta.toJSON() as Record<string, unknown>) : {};
  const name = model.name;
  const description = model.description;

  return {
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
    tags: asStringArray(model.tags),
    // §12.5's flag as the engine reads it — `Boolean(meta.library)` in `document.ts`. Anything else
    // would let the dialog disagree with the run about which flows `bru flow run .` executes.
    library: model.library === true
  };
};

/**
 * An empty `meta:` mapping, placed **directly after `version:`** rather than appended.
 *
 * `setIn(['meta', ...])` on a document without the block adds it at the end, which puts a flow's name
 * below its steps — §5.2's structure inverted by an edit that only meant to name the thing. The
 * splice is what keeps a file the dialog touched readable as one somebody wrote.
 */
const ensureMetaBlock = (document: YAML.Document): void => {
  const contents = document.contents;
  const block = document.createNode({});
  const pair = document.createPair('meta', block);

  if (!YAML.isMap(contents)) {
    // No mapping at the root at all — an empty file, or one holding a scalar. `setIn` builds the
    // root the document is missing, and there is no order to preserve.
    document.setIn(['meta'], block);
    return;
  }

  const version = contents.items.findIndex((item) => String(item.key) === 'version');
  contents.items.splice(version + 1, 0, pair as YAML.Pair<unknown, unknown>);
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
  const document = YAML.parseDocument(text, OPTIONS);
  if (document.errors.length) return undefined;

  const entries: [string, unknown][] = [
    ['name', typeof properties.name === 'string' ? properties.name.trim() : ''],
    ['description', typeof properties.description === 'string' ? properties.description.trim() : ''],
    ['tags', asStringArray(properties.tags)],
    ['library', properties.library === true]
  ];

  if (!YAML.isMap(document.getIn(['meta']))) {
    if (!entries.some(([, value]) => isMeaningful(value))) {
      // Nothing to say, and no block to say it in. Creating an empty `meta:` would be an edit to a
      // file the author changed nothing about.
      return text;
    }
    ensureMetaBlock(document);
  }

  for (const [key, value] of entries) {
    if (isMeaningful(value)) {
      document.setIn(['meta', key], value);
    } else {
      document.deleteIn(['meta', key]);
    }
  }

  return String(document);
};
