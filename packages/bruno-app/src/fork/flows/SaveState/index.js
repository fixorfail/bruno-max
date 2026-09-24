import React, { useState } from 'react';
import ConfirmRevert from './ConfirmRevert';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.3's save state, in words rather than an icon: a draft is written to a file the rest of the
 * app is watching, so what has and has not reached disk is the one thing no surface editing it may
 * be coy about. One component for both surfaces that edit the draft (005 §7.1), so the YAML tab and
 * the designer can never say two different things about one buffer.
 *
 * 005 §7.4's **Revert** sits here for that same reason, and because this text is what an author
 * reads when they want the edits gone. It offers itself whenever the draft differs from the text the
 * session started from — which is not the same as being unsaved, and is why it is still there under
 * `Saved` once auto-save has written the edits being reverted.
 *
 * `divergedTestId` and `revertTestId` are the caller's, because the two surfaces are reached by
 * different tests and each has a name for this state already.
 */

/** What the buffer is doing, as the sentence for it. */
const stateOf = (source) => {
  if (source.saving) {
    return { text: 'Saving…' };
  }
  if (source.error) {
    return { text: `Not saved — ${source.error}`, tone: 'error' };
  }
  if (source.content !== source.saved) {
    /**
     * The file moved on while there was unsaved work here, so neither side can be taken silently:
     * the editor kept what was typed, and saving from here will overwrite what is on disk. Saying
     * so is the whole of the handling — choosing for the author is what an editor must not do.
     */
    return source.staleOnDisk
      ? { text: 'Unsaved changes — the file also changed on disk', tone: 'error', diverged: true }
      : { text: 'Unsaved changes', tone: 'dirty' };
  }
  return { text: 'Saved' };
};

const SaveState = ({ source, name, testId, divergedTestId, revertTestId, onRevert }) => {
  const [asking, setAsking] = useState(false);
  const state = stateOf(source);
  // A source read before this field existed — a snapshot restored from an older build — has no text
  // to go back to, and offering a revert to nothing is worse than offering none.
  const revertable = Boolean(onRevert) && typeof source.opened === 'string' && source.content !== source.opened;

  const revert = () => {
    setAsking(false);
    onRevert();
  };

  return (
    <StyledWrapper className="save-state">
      <span
        className={state.tone ? `save-state-text ${state.tone}` : 'save-state-text'}
        data-testid={(state.diverged && divergedTestId) || testId}
      >
        {state.text}
      </span>
      {revertable ? (
        <button type="button" className="save-state-revert" onClick={() => setAsking(true)} data-testid={revertTestId}>
          Revert
        </button>
      ) : null}
      {/* The draft can stop being revertable while the prompt is open — an undo, or the file being
          replaced from disk underneath it — and a prompt offering to discard nothing is worse than
          none, so the same test gates both. */}
      {asking && revertable ? <ConfirmRevert name={name} onCancel={() => setAsking(false)} onRevert={revert} /> : null}
    </StyledWrapper>
  );
};

export default SaveState;
