import React from 'react';

// `DraftTabIcon` colours itself from the app's theme provider rather than the styled-components one,
// and the tab under test is upstream's own — so the provider is stubbed rather than mounted.
jest.mock('providers/Theme', () => ({ useTheme: () => ({ theme: { colors: { text: {} } }, displayedTheme: 'dark' }) }));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import flowsReducer from 'fork/flows/slice';
import themes from 'themes/index';
import ForkSpecialTab from './index';

/**
 * 002 §4.3 — closing a raw editor that has unsaved YAML.
 *
 * A dirty flow-yaml tab is the only unsaved state upstream's tab strip cannot see: every other draft
 * hangs off a collection item, and this one lives in the flows slice keyed by path. Closing it does
 * not lose the draft *within a session* — the slice keeps it and reopening the tab restores it — but
 * nothing persists that slice, so a quit after the close loses the edit with nothing having said so.
 */

const theme = themes.dark || Object.values(themes)[0];

const pathname = '/home/dev/workspace-one/flows/checkout.flow.yml';

const flow = { pathname, filename: 'checkout.flow.yml', workspaceRoot: '/home/dev/workspace-one' };

const initialFlowsState = () => flowsReducer(undefined, { type: '@@INIT' });

const renderTab = ({ type = 'flow-yaml', source, run, tabName = 'checkout.flow.yml', flows = [flow] }) => {
  const store = configureStore({
    reducer: { flows: flowsReducer },
    preloadedState: {
      flows: {
        ...initialFlowsState(),
        flows,
        runs: run ? { [pathname]: run } : {},
        sources: source ? { [pathname]: source } : {}
      }
    }
  });
  const onClose = jest.fn();

  return {
    store,
    onClose,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ForkSpecialTab tab={{ uid: 'tab-1', type, pathname, tabName }} onClose={onClose} />
        </ThemeProvider>
      </Provider>
    )
  };
};

const clean = { content: 'version: 1\n', saved: 'version: 1\n' };
const dirty = { content: 'version: 2\n', saved: 'version: 1\n' };

const close = () => fireEvent.click(screen.getByTestId('request-tab-close-icon'));

describe('ForkSpecialTab', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn(async () => undefined) };
  });

  it('marks the tab as having a draft only when the editor is dirty', () => {
    const { container } = renderTab({ source: dirty });

    expect(container.querySelector('.close-gradient')).toHaveClass('has-changes');
  });

  it('closes a clean editor without asking', () => {
    const { onClose } = renderTab({ source: clean });

    close();

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-flow-yaml-close')).not.toBeInTheDocument();
  });

  it('closes a tab whose flow was never opened as text', () => {
    const { onClose } = renderTab({});

    close();

    expect(onClose).toHaveBeenCalled();
  });

  /** §4.2's run view is a view of a file it never edits, so it has nothing to ask about. */
  it('closes the run view without asking, whatever the editor holds', () => {
    const { onClose } = renderTab({ type: 'flow', source: dirty });

    close();

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-flow-yaml-close')).not.toBeInTheDocument();
  });

  describe('with unsaved changes', () => {
    it('asks instead of closing', () => {
      const { onClose } = renderTab({ source: dirty });

      close();

      expect(screen.getByTestId('confirm-flow-yaml-close')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes without saving when that is what was chosen', () => {
      const { onClose } = renderTab({ source: dirty });
      close();

      fireEvent.click(screen.getByTestId('confirm-flow-yaml-close-discard'));

      expect(onClose).toHaveBeenCalled();
      expect(window.ipcRenderer.invoke).not.toHaveBeenCalledWith('renderer:flow-write-source', expect.anything());
    });

    it('writes the draft before closing when asked to save', async () => {
      const { onClose } = renderTab({ source: dirty });
      close();

      fireEvent.click(screen.getByTestId('confirm-flow-yaml-close-save'));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(window.ipcRenderer.invoke).toHaveBeenCalledWith(
        'renderer:flow-write-source',
        expect.objectContaining({ entry: pathname, content: dirty.content })
      );
    });

    /** Closing anyway would discard the edit the dialog had just promised to keep. */
    it('leaves the tab open when the save fails', async () => {
      window.ipcRenderer.invoke = jest.fn(async () => {
        throw new Error('EACCES');
      });
      const { onClose } = renderTab({ source: dirty });
      close();

      fireEvent.click(screen.getByTestId('confirm-flow-yaml-close-save'));

      await waitFor(() => expect(window.ipcRenderer.invoke).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

/**
 * 002 §4.1: *a flow's row carries its run status, and so does its tab label* — a running indicator
 * while the run executes, and a pass/fail mark when it ends, cleared the next time the flow is
 * opened. §4.2 keeps a run alive across a closed tab, so without this a run can be in flight with
 * nothing in the strip saying so.
 */
describe('the run mark on the tab label (§4.1)', () => {
  const mark = () => screen.queryByTestId(`flow-tab-mark-${pathname}`);

  it('shows nothing for a flow that has not been run', () => {
    renderTab({ type: 'flow' });

    expect(mark()).not.toBeInTheDocument();
  });

  it('shows a running indicator while the run executes', () => {
    renderTab({ type: 'flow', run: { runId: 'r', state: 'running', steps: {} } });

    expect(mark()).toHaveAttribute('data-status', 'running');
  });

  it('shows the outcome once the run ends', () => {
    renderTab({ type: 'flow', run: { runId: 'r', state: 'complete', status: 'failed', steps: {} } });

    expect(mark()).toHaveAttribute('data-status', 'failed');
  });

  /** Cleared the next time the flow is opened, which is what `outcomeSeen` records. */
  it('shows nothing once the flow has been opened again', () => {
    renderTab({
      type: 'flow',
      run: { runId: 'r', state: 'complete', status: 'failed', steps: {}, outcomeSeen: true }
    });

    expect(mark()).not.toBeInTheDocument();
  });

  /** §4.3's editor, §4.5's script and §4.6's fixture are views of a file; none can start a run. */
  it('marks no tab but the run view', () => {
    renderTab({ type: 'flow-yaml', run: { runId: 'r', state: 'running', steps: {} } });

    expect(mark()).not.toBeInTheDocument();
  });
});

/**
 * §4.2's tab survives a restart, and `tabName` does not: `addTab` destructures the fields it keeps
 * and upstream's serializer records a tab's `name`, so a restored flow tab arrives with neither.
 * The label is derived from the flow rather than carried, which also keeps the strip agreeing with
 * §4.1's sidebar row about what a flow is called.
 */
describe('the label of a restored tab (§4.2)', () => {
  const named = { ...flow, name: 'Checkout, end to end' };

  // `ForkTabLabel` is lazily loaded (the registry keeps the component tree out of its own eager
  // graph), so the label arrives a tick after the render.
  it('reads by meta.name when the tab came back without one', async () => {
    renderTab({ type: 'flow', tabName: null, flows: [named] });

    expect(await screen.findByText('Checkout, end to end')).toBeInTheDocument();
  });

  /** §4.3's editor is a view of the *file*, so it keeps the filename whatever the flow is called. */
  it('reads by filename for the raw editor', async () => {
    renderTab({ type: 'flow-yaml', tabName: null, flows: [named] });

    expect(await screen.findByText('checkout.flow.yml')).toBeInTheDocument();
  });

  it('leaves a tab that has its own name alone', async () => {
    renderTab({ type: 'flow', tabName: 'as opened', flows: [named] });

    expect(await screen.findByText('as opened')).toBeInTheDocument();
  });
});
