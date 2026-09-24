import { useEffect, useRef, useState } from 'react';

/**
 * 005 §6.3 — a field that holds its own value while it is being typed in, and hands it over when the
 * typing stops.
 *
 * Every keystroke in the step editor is a change to the document in principle, and every change to
 * the document is a parse, a mutation, a serialize and a describe; sending thirty a second would put
 * the round trip in the caret. So the field is the one thing in the pane that is optimistic, and only
 * about its own text: it commits on blur, on Enter, or after a pause — whichever comes first — and
 * the moment the edit lands it reads back from the model the engine returns.
 *
 * `value` is what the document says now. While the field is clean it follows it, so an edit made
 * elsewhere (the YAML tab, an undo) shows here; while it is dirty the typed text stands until it is
 * committed, and a commit that changed nothing is not sent. `pause: null` commits on blur and Enter
 * only — the id field wants that, since every intermediate spelling of a rename would otherwise be
 * written and reported as dangling. `equals` is how a value is judged unchanged; a table of rows is
 * a new array on every keystroke and compares by what it holds.
 */
export const COMMIT_PAUSE_MS = 400;

export function useCommittedField({ value, onCommit, pause = COMMIT_PAUSE_MS, equals = Object.is }) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);

  // What a commit reads, held in a ref so the pause timer commits the latest text rather than the
  // text it was armed with, and so the caller's handler need not be stable.
  const latest = useRef({ draft, value, onCommit, equals });
  latest.current = { draft, value, onCommit, equals };

  /**
   * The field follows the document only when the document *moves*. A commit hands the draft over
   * and the model that reflects it arrives a round trip later; re-seeding from `value` in between
   * would snap the field back to what it said before the commit, for as long as the engine takes to
   * answer — and a keystroke landing in that gap would be typed into stale text.
   */
  const seen = useRef(value);
  useEffect(() => {
    const moved = !latest.current.equals(value, seen.current);
    seen.current = value;
    if (!dirty && moved) {
      setDraft(value);
    }
  }, [value, dirty]);

  const flush = () => {
    if (!dirty) {
      return;
    }
    setDirty(false);
    if (!latest.current.equals(latest.current.draft, latest.current.value)) {
      latest.current.onCommit(latest.current.draft);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!dirty || pause === null) {
      return undefined;
    }
    const timer = setTimeout(() => flushRef.current(), pause);
    return () => clearTimeout(timer);
  }, [draft, dirty, pause]);

  return {
    value: draft,
    dirty,
    onChange: (next) => {
      setDraft(next);
      setDirty(true);
    },
    onBlur: flush,
    onKeyDown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        flush();
      }
    }
  };
}
