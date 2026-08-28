import flowsReducer, { configurationChanged } from './slice';
import { runFlow } from './actions';

/**
 * 002 §7.2's run configuration, and the two things that made a library flow's params vanish between
 * being typed and being run.
 */

const pathname = '/workspace/flows/login.flow.yml';
const flow = { pathname, workspaceRoot: '/workspace' };

const stateWith = (configuration) =>
  flowsReducer(undefined, configurationChanged({ pathname, configuration }));

describe('the run configuration', () => {
  /**
   * `RequestTabPanel` renders only the focused tab, so a configuration held in the pane's own state
   * is discarded by every tab switch — and a param typed and then silently dropped is worse than one
   * never typed, because the box looks the same either way.
   */
  it('outlives the pane that was showing it', () => {
    const state = stateWith({ params: { email: 'qa@example.com' } });

    expect(state.configurations[pathname]).toEqual({ params: { email: 'qa@example.com' } });
  });

  it('keeps one flow\'s configuration out of another\'s', () => {
    const first = stateWith({ params: { email: 'qa@example.com' } });
    const both = flowsReducer(
      first,
      configurationChanged({ pathname: '/workspace/flows/other.flow.yml', configuration: { params: {} } })
    );

    expect(both.configurations[pathname]).toEqual({ params: { email: 'qa@example.com' } });
  });
});

describe('the params a run is started with', () => {
  const runWith = async (params) => {
    const invoke = jest.fn().mockResolvedValue({ runId: 'run-1' });
    window.ipcRenderer = { invoke };
    const getState = () => ({
      collections: { collections: [] },
      globalEnvironments: { globalEnvironments: [], activeGlobalEnvironmentUid: undefined }
    });

    await runFlow({ flow, configuration: { params } })(jest.fn(), getState);
    return invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-run')[1];
  };

  it('sends what was typed', async () => {
    const request = await runWith({ email: 'qa@example.com' });

    expect(request.params).toEqual({ email: 'qa@example.com' });
  });

  /**
   * A box typed into and then cleared holds `''`; one never touched has no key at all. The author
   * made no such distinction, so neither does this — and 001 §12.5 treats *absent* as missing, which
   * is what turns an empty required box into a refused run rather than `{{params.x}}` on the wire.
   */
  it('drops a box that was cleared, so the engine sees it as unsupplied', async () => {
    const request = await runWith({ email: '', password: '   ', namespace: 'acme' });

    expect(request.params).toEqual({ namespace: 'acme' });
  });

  it('survives a configuration that has no params at all', async () => {
    const request = await runWith(undefined);

    expect(request.params).toEqual({});
  });
});
