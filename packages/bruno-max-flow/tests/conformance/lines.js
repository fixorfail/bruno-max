/**
 * The diff a reviewer would see — 005-C §2's "assertions on the writer are on bytes".
 *
 * 001 §15's `parse(stringify(x)) === x` is a statement about models, and a writer can satisfy it
 * while rewriting every line of the file. What a git-diffed `.flow.yml` needs is a statement about
 * *lines*, so every assertion on `applyFlowEdits` is written as one: where the change starts, which
 * lines went, which arrived. Everything the diff does not name is byte-identical by construction.
 *
 * The minimal enclosing span rather than a real diff algorithm: an edit is one region of the file,
 * and a span that reported more than changed would be a weaker assertion, not a wrong one.
 */
const changedLines = (before, after) => {
  const a = before.split('\n');
  const b = after.split('\n');
  const shortest = Math.min(a.length, b.length);

  let head = 0;
  while (head < shortest && a[head] === b[head]) head += 1;

  let tail = 0;
  while (tail < shortest - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  return {
    at: head + 1,
    removed: a.slice(head, a.length - tail),
    added: b.slice(head, b.length - tail)
  };
};

/** The one-based line a text's first exact match sits on — what a diff's `at` is read against. */
const lineOf = (text, line) => text.split('\n').indexOf(line) + 1;

module.exports = { changedLines, lineOf };
