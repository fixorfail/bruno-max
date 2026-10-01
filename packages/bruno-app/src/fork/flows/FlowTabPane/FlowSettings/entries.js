import { heldByName, repeats } from '../StepEditor/rows';
import { structured } from '../StepEditor/values';

/**
 * The rules that the settings tables share. Each table edits one block of named entries — `params:`,
 * `exports:` or `vars:` — and one `*.define` edit writes the full block.
 */

/** The text of a value in a cell. A cell has one line, so a mapping shows as compact JSON. */
export const textOf = (value) => {
  if (value === undefined || value === null) return '';
  return structured(value) ? JSON.stringify(value) : String(value);
};

/**
 * A row that the block cannot hold yet. This is a row with content but no name, a row with the name
 * of a different row, or a row with the name of an opaque entry. A table must not write over an
 * opaque entry. `hasContent` tells if a row without a name holds something.
 */
export const unfinishedAmong = (entries, hasContent) => (row, index, rows) =>
  (!row.name.trim() && hasContent(row))
  || repeats(row, index, rows)
  || entries.some((entry) => entry.opaque && entry.name === row.name.trim());

/**
 * The draft of the full block. The named rows come in table order. Each opaque entry goes back by
 * name, after the nearest earlier entry that is still in the draft, or first if there is none. Thus
 * an opaque entry does not move when a row before it is removed. The engine keeps an opaque entry
 * unchanged, so its draft value is only a placeholder.
 */
export const blockOf = (rows, entries, entryOf, opaqueValue) => {
  const opaqueNames = entries.filter((entry) => entry.opaque).map((entry) => entry.name);
  const block = heldByName(rows)
    .filter((row) => !opaqueNames.includes(row.name.trim()))
    .map((row) => [row.name.trim(), entryOf(row)]);
  const positionOf = (name) => block.findIndex(([held]) => held === name);

  entries.forEach((entry, index) => {
    if (!entry.opaque) return;
    const anchor = entries
      .slice(0, index)
      .reverse()
      .find((earlier) => positionOf(earlier.name) !== -1);
    block.splice(anchor ? positionOf(anchor.name) + 1 : 0, 0, [entry.name, opaqueValue]);
  });
  return Object.fromEntries(block);
};
