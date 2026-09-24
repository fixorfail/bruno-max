/**
 * The rows a table draws: what the document holds, and the ones being filled in that it cannot.
 *
 * Every block edited as a table publishes its entries under a name — an output's (001 §8.1), a
 * header's (§7.2), an assertion's expression (§10.2), a condition's text (§9.3) — so a row without
 * one is not an entry and is left out of what is written. The model is read back from what was
 * written, so it cannot hold the row either.
 *
 * That is the whole bug this exists to prevent: a commit runs on every blur inside a section and
 * after every pause in typing, so a row the document cannot hold yet is deleted by the next thing
 * the author does — taking whatever was typed into it. A script written before its output was named
 * is the expensive case, and the one that found this.
 *
 * The carried rows keep their place, because a row that moved to the end while it was being typed
 * into is its own small surprise on top of the one this prevents. `settled` is handed to the caller
 * so its own uid reuse counts only the rows the document holds.
 */
export const withUnfinished = (previous, unfinished, rowsOf) => {
  const held = (row, index) => !unfinished(row, index, previous);
  const settled = previous.filter(held);
  const merged = rowsOf(settled);

  previous.forEach((row, index) => {
    if (!held(row, index)) merged.splice(Math.min(index, merged.length), 0, row);
  });

  return merged;
};

/**
 * A row whose name another row holds.
 *
 * A block written as a mapping has one entry per name, so two rows under one name are one entry,
 * and one of them wins. An author typing a name that another row already holds would therefore
 * erase that row on the way to a name that is free: `id` typed towards `identity` deletes `id`,
 * with what it published, at the first pause in the typing. So the row that loses the name is not
 * written at all until its name is its own, and is carried like any other row the document cannot
 * hold — nothing typed into it is lost, and it is written as soon as the name is free.
 *
 * **The row the document already holds under the name wins**, whichever way round the two are. The
 * loser is the row whose name is still moving, and `heldAs` is how a row says which it is: the name
 * the document was read with, against the name the row carries now. Position decides only between
 * two rows the document holds neither of, which is two rows still being named.
 *
 * Position alone is not enough, and the difference is a write to the file: a name typed onto an
 * *earlier* row — `id` renamed towards `names`, past the `name` below it — makes the earlier row
 * the one to keep by position, and the entry below it disappears from the file until the name is
 * free again. Read by `heldAs`, the row below keeps the name it is published under and the file is
 * never written without it.
 */
export const repeats = (row, index, rows) => {
  const name = row.name.trim();
  if (name === '') return false;

  const carries = (other) => other.name.trim() === name;
  const holds = rows.findIndex((other) => carries(other) && other.heldAs === name);
  return (holds === -1 ? rows.findIndex(carries) : holds) !== index;
};

/** The rows a mapping can hold: the named ones, each the one to keep its name. */
export const heldByName = (rows) => rows.filter((row, index, all) => row.name.trim() && !repeats(row, index, all));
