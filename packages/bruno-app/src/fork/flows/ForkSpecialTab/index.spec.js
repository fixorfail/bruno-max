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

const renderTab = ({ type = 'flow-yaml', source }) => {
  const store = configureStore({
    reducer: { flows: flowsReducer },
    preloadedState: {
      flows: { ...initialFlowsState(), flows: [flow], sources: source ? { [pathname]: source } : {} }
    }
  });
  const onClose = jest.fn();

  return {
    store,
    onClose,
    ...render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ForkSpecialTab tab={{ uid: 'tab-1', type, pathname, tabName: 'checkout.flow.yml' }} onClose={onClose} />
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
