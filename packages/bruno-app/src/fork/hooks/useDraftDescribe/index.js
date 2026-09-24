import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { describeFlowDraft } from 'fork/flows/actions';

/**
 * Long enough that a burst of typing is one describe rather than one per character, short enough
 * that the graph reads as following the text. Each keystroke re-arms it, so this is the pause after
 * typing rather than a fixed refresh rate.
 */
export const DESCRIBE_DEBOUNCE_MS = 300;

/**
 * 002 §4.3 and 005 §7.1 — the engine's description of the draft, kept in step with the draft.
 *
 * The draft is one buffer under two surfaces: the YAML tab moves it a keystroke at a time, the
 * designer moves it an edit at a time, and both draw the graph from what the engine says about it.
 * One hook rather than an effect in each pane, so the two cannot disagree about when the engine is
 * asked — and so a pane never asks about text the engine has already answered for. The store
 * records the text each answer was taken from (`describedContent`), and that comparison is the
 * whole of the dedupe: the panes are rendered one at a time, so there is never a second timer to
 * race, and a pane mounting after the answer landed finds nothing to do.
 *
 * `immediate` is the designer's case. A structured edit is one complete document, and the pause the
 * debounce waits for is a pause in *typing*; waiting it out after a click would be a delay with
 * nothing behind it.
 *
 * `valid` is the engine's last verdict on the text in the buffer, which the slice keeps beside it:
 * unknown after a keystroke until the engine answers, known after a structured edit because the
 * engine wrote the text, and kept across a re-describe the watcher asked for — a dependency
 * changing on disk says nothing about whether this text parses, and a verdict that dropped to
 * unknown on every save would take the editor with it.
 */
export function useDraftDescribe({ flow, source, immediate = false }) {
  const dispatch = useDispatch();

  const content = source?.content;
  const loading = source?.loading;
  const answered = Boolean(source) && source.describedContent === content;

  useEffect(() => {
    if (!flow || loading || content === undefined || answered) {
      return undefined;
    }

    if (immediate) {
      dispatch(describeFlowDraft(flow, content));
      return undefined;
    }

    const timer = setTimeout(() => dispatch(describeFlowDraft(flow, content)), DESCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dispatch, flow, content, answered, loading, immediate]);

  return { answered, valid: source?.parses };
}
