/**
 * What every writer of the format needs before it writes anything — 001 §15, 005 §9.1.
 *
 * A `.flow.yml` is a committed, hand-edited file, so a writer's obligation is not "emit a correct
 * flow" but "emit the file that was read, with the one thing the edit named changed". Two writers
 * now have that obligation — `meta.ts`'s properties dialog (002 §4.4) and `edit.ts`'s structured
 * edits — and both stand on the same three pieces: the tag table that keeps §5.4's local tags
 * re-emittable, the parse options that make a merge key and a tagged value ordinary, and the splice
 * that puts a block a file does not yet have where the format reads it rather than at the end.
 */
import * as YAML from 'yaml';

/**
 * **Deliberately not `document.ts`'s `TAGS`.** Those resolve `!file` to a `FileRef` and `!...` to a
 * symbol, which is right for a model the engine runs and wrong for a document it intends to write
 * back: the tag has no matching `stringify`, so re-emitting a resolved node yields
 * `catalog: !file "[object Object]"` and a flow's fixtures are destroyed by an edit to its name.
 *
 * Resolving to the node itself keeps the tag *and* its content exactly as parsed. Nothing a writer
 * does needs to know what a tag means — a tagged value is a value it must not touch (005 §6.4) — so
 * identity is not a shortcut but the whole of what a serializer wants.
 */
export const IDENTITY_TAGS: YAML.Tags = [
  { tag: '!file', collection: 'map', resolve: (map: YAML.YAMLMap) => map },
  { tag: '!file', resolve: (value: string) => value },
  { tag: '!...', resolve: (value: string) => value }
] as YAML.Tags;

/** `merge: true` and `logLevel: 'silent'` for `document.ts`'s reasons, which do not change here. */
export const PARSE_OPTIONS: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = {
  merge: true,
  customTags: IDENTITY_TAGS,
  logLevel: 'silent'
};

/** A key is written when it says something, and omitted when it does not (§5.2's absent defaults). */
export const isMeaningful = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
};

/**
 * A block the file does not have yet, placed after the last of `after` it *does* have rather than
 * appended.
 *
 * `setIn(['meta', ...])` on a document without the block adds it at the end, which puts a flow's name
 * below its steps and a `steps:` above its `meta:` — §5.2's structure inverted by an edit that only
 * meant to name the thing. `after` is the keys the format reads before this one, so the splice lands
 * where a person would have typed it: `meta:` after `version:`, `steps:` after the last block that
 * precedes it, whichever of them the file happens to declare.
 */
export const ensureBlock = (document: YAML.Document, key: string, value: unknown, after: string[]): void => {
  const contents = document.contents;

  if (!YAML.isMap(contents)) {
    // No mapping at the root at all — an empty file, or one holding a scalar. `setIn` builds the
    // root the document is missing, and there is no order to preserve.
    document.setIn([key], value);
    return;
  }

  // The *last* declared one in file order, not the last of `after` that exists: a file whose blocks
  // are out of §5.2's order is still a file somebody wrote, and appending after what it actually
  // reads last keeps the new block next to its neighbours.
  const at = contents.items.reduce(
    (found, item, index) => (after.includes(String(item.key)) ? index : found),
    -1
  );
  contents.items.splice(at + 1, 0, document.createPair(key, value) as YAML.Pair<unknown, unknown>);
};
