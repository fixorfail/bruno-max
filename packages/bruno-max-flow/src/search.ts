/**
 * The strings a flow can be selected by, and the rule that decides whether a pattern picks it —
 * 001 §5.2's identity and §5.3's step metadata, read as text.
 *
 * **Extraction here, patterns at the hosts.** `bru flow run --grep` and the app's sidebar search box
 * must agree about what a flow "contains": a user who finds a flow in the sidebar and cannot select
 * it on the command line has found a bug with no explanation. So what a flow *is matchable on* has
 * one implementation, and only the pattern differs — the CLI compiles the user's regular expression,
 * the app compiles an escaped literal from the search field. That split is why `flowMatches` takes
 * compiled `RegExp`s rather than strings; neither host's spelling is the other's.
 *
 * **A read, not a resolve.** This runs over every flow in a workspace on every listing, so it takes
 * the text the host already has and resolves nothing: no OpenAPI, no `describeFlow`, no file reads of
 * any kind. A `uses:` sub-flow's own steps are therefore not reached — they live in another file,
 * which is itself a flow with terms of its own, and a selection matches whole files.
 */
import { asRecord, parseDocument } from './document';
import { flowIdentity } from './meta';

/**
 * A step's `id` and `name`, and every scalar its open `meta:` carries — §5.3.
 *
 * **Values, never keys.** `meta:` is open, so its keys are vocabulary rather than content: greping
 * `testId` would otherwise match every step that declares one, which is every step in a flow written
 * for a tracker. At any depth for the same reason — an author nesting `meta: { jira: { key: ... } }`
 * has not made the key less searchable by grouping it.
 */
const collectScalars = (value: unknown, into: string[], seen: WeakSet<object>): void => {
  if (value === undefined || value === null) return;

  // §5.4's `!...` resolves to a symbol, which stands for a *removed* value and has no text a reader
  // would search for; `String()` on it would put "Symbol(bruno.flow.drop)" in front of every grep.
  if (typeof value === 'symbol') return;

  if (typeof value === 'object') {
    // An anchor may refer to one of its own ancestors, and the parser hands that back as a cyclic
    // object rather than an error. A listing that walked into it would hang the host. The set spans
    // the whole flow rather than one step: an anchor several steps share is then read once, which is
    // what the deduplication below would have done with it anyway.
    if (seen.has(value)) return;
    seen.add(value);

    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const entry of entries) collectScalars(entry, into, seen);
    return;
  }

  into.push(String(value));
};

/**
 * Every string a flow can be matched on.
 *
 * Identity comes from `flowIdentity` rather than from the document read here: a roster, a report and
 * a selection are matched to each other by `id`, and a second derivation of it is the drift that
 * helper exists to prevent — at the cost of that read's own parse, which is the cheaper half of the
 * trade. The absolute `file` is deliberately not a term — it carries the
 * machine's directory layout, so a pattern could select every flow in a workspace by matching a
 * segment of the user's home directory. `id` is the path a flow is named by (§5.2).
 *
 * Tolerant in `readFlowMeta`'s way, and for its reason (002 §6 makes an unparseable flow ordinary):
 * text that does not parse contributes no step terms rather than throwing, so a flow the author is
 * midway through editing is still findable by the name and path it already has.
 */
export const flowSearchTerms = (scopeRoot: string, file: string, source?: string): string[] => {
  const identity = flowIdentity(scopeRoot, file, source);
  const terms = [identity.id, identity.name, ...identity.tags, ...(identity.testId ? [identity.testId] : [])];

  if (source !== undefined) {
    // The engine's own reader, so §5.4's local tags are values rather than errors and a document
    // with errors yields `{}` — the same tolerance every other host-facing read in the package has.
    const { model } = parseDocument(source);
    const steps = Array.isArray(model.steps) ? model.steps : [];
    const seen = new WeakSet<object>();

    for (const step of steps) {
      const raw = asRecord(step);
      collectScalars(raw.id, terms, seen);
      collectScalars(raw.name, terms, seen);
      collectScalars(raw.meta, terms, seen);
    }
  }

  // Trimmed, emptied and deduplicated because the list ships over IPC once per flow and is then
  // scanned per keystroke: a flow's tag repeated on twenty steps is one term, not twenty.
  const unique = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed) unique.add(trimmed);
  }

  return [...unique];
};

/**
 * `.test()` advances `lastIndex` on a `/g` or `/y` pattern and the next call resumes from there, so
 * a filter compiled once and applied down a list would start matching from the middle of the second
 * flow's terms. `String#search` is specified to save the index and put it back, which keeps this
 * correct whatever flags a host compiled its pattern with — and leaves the caller's regex as it
 * found it, since the pattern belongs to the caller and is reused across every flow in the listing.
 */
const matchesSome = (terms: string[], pattern: RegExp): boolean => terms.some((term) => term.search(pattern) !== -1);

/**
 * True when `grep` matches some term and `grepInvert` matches none.
 *
 * An absent filter matches everything, so the two compose: no filters selects the whole listing,
 * and `--grep-invert` alone excludes from it. Exclusion wins over inclusion — a flow matching both
 * patterns is excluded, which is the only reading under which adding `--grep-invert` can never widen
 * a selection.
 */
export const flowMatches = (terms: string[], filters: { grep?: RegExp; grepInvert?: RegExp }): boolean => {
  if (filters.grep && !matchesSome(terms, filters.grep)) return false;
  if (filters.grepInvert && matchesSome(terms, filters.grepInvert)) return false;
  return true;
};
