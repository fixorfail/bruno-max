import { useEffect, useState } from 'react';

/**
 * A box sized to the document CodeMirror drew in it — 005 §6.7.
 *
 * An editor is the one control on these tabs with no natural height: a body or a script is however
 * many lines it is, and a box fixed at twelve of them shows six of a twenty-line value while
 * reserving twelve for a two-line one.
 *
 * **Measured from what was drawn, not from the text.** The editor wraps, so a minified payload
 * pasted on one line is one `\n`-delimited line and several rows on screen — the case a line count
 * gets most wrong, and the one most likely to arrive by paste. `.CodeMirror-sizer` is the node
 * CodeMirror sizes to the document, so observing it answers for wrapping, folds and the font the
 * preferences chose, none of which a caller can compute.
 *
 * `key` is what the editor is keyed by. CodeMirror is remounted when it changes, and an observer
 * still watching the old sizer would report the height of a node nothing is drawing into.
 *
 * `null` until something has been drawn, and on a host with no `ResizeObserver` — the caller's
 * stylesheet is the answer in both cases.
 */
export function useContentHeight({ boxRef, key, min, max, chrome = 8 }) {
  const [height, setHeight] = useState(null);

  useEffect(() => {
    const sizer = boxRef.current?.querySelector('.CodeMirror-sizer');
    if (!sizer || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[entries.length - 1]?.contentRect?.height;
      if (measured === undefined) return;
      setHeight((current) => {
        const next = Math.max(min, Math.min(Math.round(measured) + chrome, max));
        /**
         * Sizing the box resizes the editor inside it, which is a resize this observer sees. A
         * target that has not moved is not applied, so the second pass settles instead of ringing.
         */
        return current !== null && Math.abs(next - current) <= 1 ? current : next;
      });
    });

    observer.observe(sizer);
    return () => observer.disconnect();
  }, [boxRef, key, min, max, chrome]);

  return height;
}
