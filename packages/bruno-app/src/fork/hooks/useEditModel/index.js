import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { readFlowEditModel } from 'fork/flows/actions';

/**
 * 005 §9.2 — the engine's model of the draft, kept in step with the draft.
 *
 * The step editor renders from this and never from the text: a form over the document's own values
 * needs them as written, and 002-C R4 leaves the renderer no parser to get them with. The store
 * records the text each model was read from, so a model about three edits ago is never mistaken for
 * one about the text on screen — `answered` is that comparison, and a pane treats a model that is
 * not yet answered as one it must not write through.
 *
 * Immediate rather than debounced: a structured edit is one complete document, and the pane below
 * the graph re-seeds from the answer, so waiting would be a delay with nothing behind it.
 *
 * **The last model stands while the next is read.** Every commit moves the text and so asks for a
 * new model; a pane that showed nothing in between would unmount its fields on every keystroke that
 * landed, and the field the author is moving to would be gone when they got there. So the model
 * returned is the last one the engine gave, `answered` says whether it is about the text on screen,
 * and the fields — which keep what was typed until the document moves — read through the gap.
 */
export function useEditModel({ flow, source }) {
  const dispatch = useDispatch();

  const content = source?.content;
  const loading = source?.loading;
  // Answered is about the text, not about there being a model: text that does not parse has none
  // (§9.2), and that is the engine's answer for it rather than a reason to ask again.
  const answered = Boolean(source) && source.modelContent === content;

  useEffect(() => {
    if (!flow || loading || content === undefined || answered) {
      return;
    }
    // A model that could not be read is the engine's answer too — the pane stays read-only, and the
    // describe beside it carries the parse error that explains why.
    dispatch(readFlowEditModel(flow, content)).catch(() => undefined);
  }, [dispatch, flow, content, answered, loading]);

  return { model: source?.model, answered };
}
