import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';

/**
 * Auto-save on the app's own terms — the `autoSave` preference, its interval, and nothing of its
 * own.
 *
 * Upstream's `autosave` middleware does this for every editable thing in the app, but it does it by
 * *listing* the actions that dirty each one: ~100 collection action types, matched by name. A fork
 * feature cannot join that list without editing the file it lives in, which is the edit
 * `.claude/rules/architecture.md` exists to prevent. A hook is the same behaviour — debounce by the
 * configured interval, save when the timer expires — owned by the feature that needs it.
 *
 * **`trigger` re-arms the timer.** Passing the edited value means every keystroke restarts the
 * countdown, which is what makes this a debounce rather than a repeating save; `armed` is what the
 * caller uses to withhold saves entirely (002 §4.3 never writes YAML that does not parse).
 */
export function useAutoSave({ trigger, armed, onSave }) {
  const autoSave = useSelector((state) => state.app.preferences?.autoSave);

  // The caller's handler is rebuilt every render, and taking it as a dependency would restart the
  // countdown on renders that changed nothing about the draft — including the ones the save itself
  // causes.
  const save = useRef(onSave);
  save.current = onSave;

  const enabled = Boolean(autoSave?.enabled) && armed;
  const interval = autoSave?.interval;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const timer = setTimeout(() => save.current(), interval);
    return () => clearTimeout(timer);
  }, [trigger, enabled, interval]);
}
