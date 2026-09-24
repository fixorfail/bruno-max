import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; `shouldRetry` is a script and gets one,
// so it is stood in for by a textarea that reports its text the way the real one does.
jest.mock('components/CodeEditor', () => ({ value, onEdit }) => (
  <textarea data-testid="retry-script-editor" value={value} onChange={(event) => onEdit(event.target.value)} />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import FlowTab from './index';

const theme = themes.dark || Object.values(themes)[0];

/**
 * 005 §6.2's Flow tab — `when`, `retry` and the limits, each a blank that means inherit.
 */
describe('the flow tab', () => {
  const model = {
    steps: [{ id: 'a' }, { id: 'b' }],
    vocabulary: { statuses: ['success', 'failed', 'skipped', 'cancelled'], backoff: ['fixed', 'exponential'], jitter: ['none', 'full'] }
  };
  const renderTab = (fields, onPatch = jest.fn()) => {
    const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <FlowTab
            step={{ id: 'b', fields, opaque: [] }}
            flow={{ pathname: '/w/flows/checkout.flow.yml' }}
            model={model}
            onPatch={onPatch}
          />
        </ThemeProvider>
      </Provider>
    );
    return onPatch;
  };
  const settle = () =>
    act(async () => {
      jest.advanceTimersByTime(500);
    });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** One key, rewritten whole: a field set is merged in, the last field cleared removes the key. */
  it('rewrites `retry` whole', async () => {
    const onPatch = renderTab({ retry: { maxAttempts: 3 } });

    fireEvent.change(screen.getByTestId('flow-step-field-retry-delay'), { target: { value: '500' } });
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ set: { retry: { maxAttempts: 3, delay: 500 } } });

    fireEvent.change(screen.getByTestId('flow-step-field-retry-backoff'), { target: { value: 'exponential' } });
    expect(onPatch).toHaveBeenLastCalledWith({ set: { retry: { maxAttempts: 3, backoff: 'exponential' } } });

    const other = renderTab({ retry: { maxAttempts: 3 } });
    fireEvent.change(screen.getAllByTestId('flow-step-field-retry-maxAttempts')[1], { target: { value: '' } });
    await settle();
    expect(other).toHaveBeenLastCalledWith({ unset: ['retry'] });
  });

  it('writes a limit as a number, and a blank as the key removed', async () => {
    const onPatch = renderTab({ timeout: 30000 });

    expect(screen.getByTestId('flow-step-field-timeout')).toHaveValue(30000);

    fireEvent.change(screen.getByTestId('flow-step-field-timeout'), { target: { value: '5000' } });
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ set: { timeout: 5000 } });

    fireEvent.change(screen.getByTestId('flow-step-field-timeout'), { target: { value: '' } });
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ unset: ['timeout'] });
  });

  /**
   * B4.15 — the two kinds sit on one tab, and they are not the same place: `shouldRetry` runs
   * through the script runner, `when:` in its written form is evaluated on its own.
   */
  it('marks Retry when as a script and a written condition as an expression', () => {
    renderTab({ when: 'steps.a.status eq 200' });

    expect(screen.getByTestId('flow-code-marker-script')).toBeInTheDocument();
    expect(screen.getByTestId('flow-code-marker-expression')).toBeInTheDocument();
  });

  /**
   * B4.18 — `shouldRetry` is §8.2's script, and gets the editor every other script position gets.
   * A predicate is a function, and a two-row box is where one stops being readable.
   */
  it('edits the retry predicate in a script editor', async () => {
    const onPatch = renderTab({ retry: { maxAttempts: 3, shouldRetry: '(res) => res.status === 429' } });

    const editor = screen.getByTestId('retry-script-editor');
    expect(editor).toHaveValue('(res) => res.status === 429');

    fireEvent.change(editor, { target: { value: '(res) => res.status >= 500' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenCalledWith({ set: { retry: { maxAttempts: 3, shouldRetry: '(res) => res.status >= 500' } } });
  });
});
