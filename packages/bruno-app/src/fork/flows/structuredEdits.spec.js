import reducer, { sourceLoaded, sourceEdited, sourceRefreshed, sourceSaved, sourceReverted, editUndone, editRedone } from './slice';
import { applyFlowEdit, readFlowEditModel } from './actions';

/**
 * 005 §7 — a structured edit is a transform of the draft, applied by the engine and landing where a
 * keystroke would.
 *
 * What these pin is the discipline around the round trip rather than any edit's meaning (the engine's
 * own suite owns that): the buffer is re-checked when the answer lands, a no-op edit dirties nothing,
 * a refusal leaves the text alone, and the history behaves like an editor's.
 */

const pathname = '/workspace/flows/checkout.flow.yml';
const flow = { pathname, workspaceRoot: '/workspace' };
const edits = [{ kind: 'step.remove', id: 'b' }];

const loaded = (content) => reducer(undefined, sourceLoaded({ pathname, content }));

/** Drives the thunk against a hand-held reducer, with the host answering as `reply` says. */
const run = async (state, reply) => {
  const invoke = jest.fn(async () => (typeof reply === 'function' ? reply() : reply));
  window.ipcRenderer = { invoke };
  let current = state;
  const dispatch = (action) => {
    current = reducer(current, action);
    return action;
  };

  const result = await applyFlowEdit(flow, edits)(dispatch, () => ({ flows: current }));
  return { state: current, invoke, result };
};

describe('B5.2 — a structured edit lands where a keystroke would', () => {
  it('replaces the draft with what the engine produced, and keeps what it replaced', async () => {
    const { state, invoke, result } = await run(loaded('a\n'), { ok: true, text: 'b\n', changed: true });

    expect(invoke).toHaveBeenCalledWith('renderer:flow-apply-edit', {
      entry: pathname,
      scope: { workspaceRoot: '/workspace', collectionRoot: undefined },
      content: 'a\n',
      edits
    });
    expect(result.ok).toBe(true);
    expect(state.sources[pathname].content).toBe('b\n');
    expect(state.sources[pathname].saved).toBe('a\n');
    expect(state.sources[pathname].history.past).toEqual(['a\n']);
  });

  it('refuses before the flow has been read', async () => {
    const { invoke, result } = await run(reducer(undefined, { type: 'init' }), { ok: true, text: 'b\n', changed: true });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe('B5.5 — an edit the buffer overtook is discarded and said', () => {
  it('keeps the keystroke and reports the edit as overtaken', async () => {
    let state = loaded('a\n');
    const invoke = jest.fn(async () => {
      state = reducer(state, sourceEdited({ pathname, content: 'typed\n' }));
      return { ok: true, text: 'b\n', changed: true };
    });
    window.ipcRenderer = { invoke };
    const dispatch = (action) => {
      state = reducer(state, action);
      return action;
    };

    const result = await applyFlowEdit(flow, edits)(dispatch, () => ({ flows: state }));

    expect(result).toMatchObject({ ok: false, reason: 'overtaken' });
    expect(state.sources[pathname].content).toBe('typed\n');
    expect(state.sources[pathname].editError).toMatch(/changed while that edit/);
    expect(state.sources[pathname].history).toBeUndefined();
  });
});

describe('B5.8 — `changed: false` dirties nothing', () => {
  it('leaves the draft, the history and the dirty state alone', async () => {
    const { state, result } = await run(loaded('a\n'), { ok: true, text: 'a\n', changed: false });

    expect(result.ok).toBe(true);
    expect(state.sources[pathname].content).toBe('a\n');
    expect(state.sources[pathname].history).toBeUndefined();
  });
});

describe('a refused edit leaves the text alone (005 §6.3, §9.1)', () => {
  it('records the engine\'s reason and changes nothing', async () => {
    const refusal = { ok: false, reason: 'duplicate-step-id', message: 'a step is already called a' };
    const { state, result } = await run(loaded('a\n'), refusal);

    expect(result).toEqual(refusal);
    expect(state.sources[pathname].content).toBe('a\n');
    expect(state.sources[pathname].editError).toBe('a step is already called a');
  });

  it('treats a host failure as a refusal', async () => {
    const { state, result } = await run(loaded('a\n'), () => Promise.reject(new Error('EACCES')));

    expect(result).toMatchObject({ ok: false, reason: 'host-error', message: 'EACCES' });
    expect(state.sources[pathname].content).toBe('a\n');
  });

  it('clears the last refusal when an edit lands', async () => {
    const refused = (await run(loaded('a\n'), { ok: false, reason: 'no-such-step', message: 'nope' })).state;
    const { state } = await run(refused, { ok: true, text: 'b\n', changed: true });

    expect(state.sources[pathname].editError).toBeUndefined();
  });
});

describe('B5.4 — undo is structured, and a text edit ends it', () => {
  const edited = async () => {
    const first = (await run(loaded('a\n'), { ok: true, text: 'b\n', changed: true })).state;
    return (await run(first, { ok: true, text: 'c\n', changed: true })).state;
  };

  it('undoes the last structured edit, and redoes it', async () => {
    let state = await edited();

    state = reducer(state, editUndone({ pathname }));
    expect(state.sources[pathname].content).toBe('b\n');
    state = reducer(state, editUndone({ pathname }));
    expect(state.sources[pathname].content).toBe('a\n');
    state = reducer(state, editUndone({ pathname }));
    expect(state.sources[pathname].content).toBe('a\n');

    state = reducer(state, editRedone({ pathname }));
    expect(state.sources[pathname].content).toBe('b\n');
    state = reducer(state, editRedone({ pathname }));
    expect(state.sources[pathname].content).toBe('c\n');
    state = reducer(state, editRedone({ pathname }));
    expect(state.sources[pathname].content).toBe('c\n');
  });

  it('forgets the redo branch when a new edit lands', async () => {
    let state = await edited();
    state = reducer(state, editUndone({ pathname }));
    state = (await run(state, { ok: true, text: 'd\n', changed: true })).state;

    expect(state.sources[pathname].history.future).toEqual([]);
    state = reducer(state, editRedone({ pathname }));
    expect(state.sources[pathname].content).toBe('d\n');
  });

  it('is cleared by a keystroke in the YAML tab', async () => {
    let state = await edited();
    state = reducer(state, sourceEdited({ pathname, content: 'c\ntyped\n' }));

    expect(state.sources[pathname].history).toBeUndefined();
    state = reducer(state, editUndone({ pathname }));
    expect(state.sources[pathname].content).toBe('c\ntyped\n');
  });

  it('is cleared when the buffer is replaced from disk', async () => {
    let state = await edited();
    state = reducer(state, sourceRefreshed({ pathname, content: 'from disk\n' }));

    expect(state.sources[pathname].history).toBeUndefined();
  });

  /** An undo past a save re-dirties the draft: the author who saved by reflex expects the previous
   *  state back, and the save state says it is unsaved again (005 §7.3). */
  it('survives a save', async () => {
    let state = await edited();
    state = reducer(state, { type: 'flows/sourceSaved', payload: { pathname, content: 'c\n' } });
    state = reducer(state, editUndone({ pathname }));

    expect(state.sources[pathname].content).toBe('b\n');
    expect(state.sources[pathname].saved).toBe('c\n');
  });

  it('keeps a bounded past', async () => {
    let state = loaded('0\n');
    for (let index = 1; index <= 60; index += 1) {
      state = (await run(state, { ok: true, text: `${index}\n`, changed: true })).state;
    }

    expect(state.sources[pathname].history.past).toHaveLength(50);
    expect(state.sources[pathname].history.past[0]).toBe('10\n');
  });
});

describe('the edit model is read about the text on screen (005 §9.2)', () => {
  it('records the model beside the text it was read from', async () => {
    const model = { steps: [], apis: [], authProfiles: [], vocabulary: {} };
    window.ipcRenderer = { invoke: jest.fn().mockResolvedValue(model) };
    let state = loaded('a\n');
    const dispatch = (action) => {
      state = reducer(state, action);
      return action;
    };

    await readFlowEditModel(flow, 'a\n')(dispatch, () => ({ flows: state }));

    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:flow-read-edit-model', {
      entry: pathname,
      scope: { workspaceRoot: '/workspace', collectionRoot: undefined },
      content: 'a\n'
    });
    expect(state.sources[pathname].model).toBe(model);
    expect(state.sources[pathname].modelContent).toBe('a\n');
  });
});

/**
 * B5.9 — 005 §7.4's revert: the draft goes back to the text the session started from.
 *
 * `saved` cannot be that text. It moves at the first save, and auto-save makes that a second after
 * the first edit — a revert to it would then have nothing to discard, which is the whole reason the
 * session keeps a third text.
 */
describe('B5.9 — revert goes back to the text the session started from', () => {
  const reverted = (state) => reducer(state, sourceReverted({ pathname }));

  it('restores the opened text and keeps the discarded draft on the history', () => {
    const edited = reducer(loaded('a\n'), sourceEdited({ pathname, content: 'b\n' }));
    const state = reverted(edited);

    expect(state.sources[pathname].content).toEqual('a\n');
    // A revert is an edit like any other, so undo takes it back — as far as the history reaches.
    expect(reducer(state, editUndone({ pathname })).sources[pathname].content).toEqual('b\n');
  });

  /** The file is not written: §7.3's rule for undoing past a save, over a longer reach. */
  it('re-dirties a draft that was already saved, rather than writing the file', () => {
    const saved = reducer(loaded('a\n'), sourceSaved({ pathname, content: 'b\n' }));
    const state = reverted(reducer(saved, sourceEdited({ pathname, content: 'b\n' })));
    const source = state.sources[pathname];

    expect(source.content).toEqual('a\n');
    expect(source.saved).toEqual('b\n');
    expect(source.content).not.toEqual(source.saved);
  });

  it('does nothing when the draft is already the text it started from', () => {
    const state = loaded('a\n');

    expect(reverted(state).sources[pathname].history).toBeUndefined();
  });

  /**
   * The buffer was replaced from disk, so the session starts again from what the file now says.
   * Reverting to the text it held before would put back a document the file has moved away from.
   */
  it('moves the baseline when the buffer is replaced from disk', () => {
    const refreshed = reducer(loaded('a\n'), sourceRefreshed({ pathname, content: 'c\n' }));
    const state = reverted(reducer(refreshed, sourceEdited({ pathname, content: 'd\n' })));

    expect(state.sources[pathname].content).toEqual('c\n');
  });
});
