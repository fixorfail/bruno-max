import reducer, { sourceLoaded, sourceEdited, sourceSaving } from './slice';
import { refreshFlowSource } from './actions';
import { registerFlowIpcEvents } from './ipcEvents';

/**
 * 002 §4.3 — a flow edited outside Bruno.
 *
 * The raw editor's text lives in the store keyed by path, so an unsaved edit survives a tab switch.
 * The cost of that, until now, was that nothing ever re-read the file: once a flow's text had been
 * read it was frozen against disk for the life of the session, and reopening the tab changed
 * nothing, because the tab was never where the text lived.
 */

const pathname = '/workspace/flows/checkout.flow.yml';
const flow = { pathname, workspaceRoot: '/workspace' };

const loaded = (content) => reducer(undefined, sourceLoaded({ pathname, content }));

const run = async (state, onDisk) => {
  const invoke = jest.fn().mockResolvedValue(onDisk);
  window.ipcRenderer = { invoke };
  const dispatched = [];
  let current = state;
  const dispatch = (action) => {
    dispatched.push(action);
    current = reducer(current, action);
    return action;
  };

  await refreshFlowSource(flow)(dispatch, () => ({ flows: current }));
  return { state: current, invoke, dispatched };
};

describe('a flow changed on disk', () => {
  it('takes the file when the editor has nothing unsaved', async () => {
    const { state } = await run(loaded('version: 1\n'), 'version: 1\nmeta:\n  name: Edited\n');

    expect(state.sources[pathname].content).toBe('version: 1\nmeta:\n  name: Edited\n');
    expect(state.sources[pathname].saved).toBe('version: 1\nmeta:\n  name: Edited\n');
  });

  /** Refreshing must not put the pane back through its loading state — Bruno's own save fires the
   *  same watcher event, so that would flash the editor on every save. */
  it('refreshes without returning to the loading state', async () => {
    const { state } = await run(loaded('version: 1\n'), 'version: 2\n');

    expect(state.sources[pathname].loading).toBe(false);
  });

  /**
   * The dangerous case: Bruno's own write fires the same event as an external edit, and the two are
   * indistinguishable here. Taking the file's text would discard whatever was typed during a save.
   */
  it('never overwrites unsaved work', async () => {
    let state = loaded('version: 1\n');
    state = reducer(state, sourceEdited({ pathname, content: 'version: 1\nsteps: []\n' }));

    const result = await run(state, 'version: 1\nmeta:\n  name: Edited\n');

    expect(result.state.sources[pathname].content).toBe('version: 1\nsteps: []\n');
    expect(result.state.sources[pathname].staleOnDisk).toBe(true);
    expect(result.invoke).not.toHaveBeenCalled();
  });

  it('leaves a save in flight alone', async () => {
    let state = loaded('version: 1\n');
    state = reducer(state, sourceSaving({ pathname }));

    const result = await run(state, 'version: 2\n');

    expect(result.state.sources[pathname].content).toBe('version: 1\n');
    expect(result.invoke).not.toHaveBeenCalled();
  });

  /** The read is asynchronous; a keystroke during it must not be overwritten by text that was
   *  already stale when it arrived. */
  it('drops a refresh that a keystroke overtook', async () => {
    const state = loaded('version: 1\n');
    let current = state;
    const invoke = jest.fn().mockImplementation(async () => {
      current = reducer(current, sourceEdited({ pathname, content: 'typed while reading' }));
      return 'version: 2\n';
    });
    window.ipcRenderer = { invoke };

    await refreshFlowSource(flow)(
      (action) => {
        current = reducer(current, action);
      },
      () => ({ flows: current })
    );

    expect(current.sources[pathname].content).toBe('typed while reading');
    expect(current.sources[pathname].staleOnDisk).toBe(true);
  });

  /** Nothing has read this flow's text, so there is no editor to refresh and nothing to put in the
   *  store for a tab nobody opened. */
  it('does nothing for a flow whose raw editor was never opened', async () => {
    const { state, invoke } = await run(reducer(undefined, { type: 'init' }), 'version: 2\n');

    expect(state.sources[pathname]).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

/**
 * The wiring that makes the refresh reachable at all. Without it the thunk above is dead code, and
 * nothing in the pane would notice — the editor would simply go on showing what it read first.
 */
describe('the watcher listener', () => {
  const listenerFor = (channel) => {
    const handlers = {};
    window.ipcRenderer = {
      on: (name, handler) => {
        handlers[name] = handler;
        return () => {};
      }
    };
    registerFlowIpcEvents(jest.fn());
    return handlers[channel];
  };

  const refreshesOn = (event) => {
    const handlers = {};
    window.ipcRenderer = {
      on: (name, handler) => {
        handlers[name] = handler;
        return () => {};
      }
    };
    const dispatch = jest.fn();
    registerFlowIpcEvents(dispatch);
    handlers['main:flow-tree-updated'](event, { pathname, workspaceRoot: '/workspace' });
    // The thunk is a function; the reducer action is a plain object with a type.
    return dispatch.mock.calls.some(([action]) => typeof action === 'function');
  };

  it('is registered', () => {
    expect(listenerFor('main:flow-tree-updated')).toBeInstanceOf(Function);
  });

  it('refreshes on a change', () => {
    expect(refreshesOn('changeFile')).toBe(true);
  });

  /** An editor that saves atomically renames a temporary file over the original, which chokidar
   *  reports as an unlink followed by an add rather than as a change. */
  it('refreshes on an add, for editors that save by rename', () => {
    expect(refreshesOn('addFile')).toBe(true);
  });

  it('does not refresh a flow that was deleted', () => {
    expect(refreshesOn('unlinkFile')).toBe(false);
  });
});
