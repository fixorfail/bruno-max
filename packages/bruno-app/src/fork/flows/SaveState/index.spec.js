import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import SaveState from './index';

/**
 * 002 §4.3's save state, and 005 §7.4's revert beside it.
 *
 * One component for both surfaces that edit the draft, so the YAML tab and the designer can never
 * say two different things about one buffer — which is also why the revert is here and not in each
 * of them.
 */

const theme = themes.dark || Object.values(themes)[0];

const sourceOf = (fields) => ({ content: 'a\n', saved: 'a\n', opened: 'a\n', saving: false, ...fields });

const show = (fields, props = {}) =>
  render(
    <ThemeProvider theme={theme}>
      <SaveState
        source={sourceOf(fields)}
        name="checkout.flow.yml"
        testId="state"
        divergedTestId="diverged"
        revertTestId="revert"
        {...props}
      />
    </ThemeProvider>
  );

describe('what the buffer is doing', () => {
  it.each([
    ['saved', {}, 'state', 'Saved'],
    ['saving', { saving: true }, 'state', 'Saving…'],
    ['unsaved', { content: 'b\n' }, 'state', 'Unsaved changes'],
    ['diverged', { content: 'b\n', staleOnDisk: true }, 'diverged', 'the file also changed on disk'],
    ['failed', { error: 'EACCES' }, 'state', 'Not saved — EACCES']
  ])('says it is %s', (name, fields, testId, text) => {
    show(fields);

    expect(screen.getByTestId(testId)).toHaveTextContent(text);
  });
});

describe('B5.9 — the revert beside it', () => {
  it('is offered only when the draft differs from the text the session started from', () => {
    show({}, { onRevert: jest.fn() });
    expect(screen.queryByTestId('revert')).not.toBeInTheDocument();

    show({ content: 'b\n' }, { onRevert: jest.fn() });
    expect(screen.getByTestId('revert')).toBeInTheDocument();
  });

  /** The edits reached disk, so the buffer is clean — and they are still the edits to discard. */
  it('is offered under Saved, once auto-save has written the edits', () => {
    show({ content: 'b\n', saved: 'b\n' }, { onRevert: jest.fn() });

    expect(screen.getByTestId('state')).toHaveTextContent('Saved');
    expect(screen.getByTestId('revert')).toBeInTheDocument();
  });

  it('is not offered where the surface passes no handler', () => {
    show({ content: 'b\n' });

    expect(screen.queryByTestId('revert')).not.toBeInTheDocument();
  });

  it('asks before discarding, and does nothing until the answer', () => {
    const onRevert = jest.fn();
    show({ content: 'b\n' }, { onRevert });

    fireEvent.click(screen.getByTestId('revert'));

    expect(screen.getByTestId('confirm-flow-revert')).toHaveTextContent('checkout.flow.yml');
    expect(onRevert).not.toHaveBeenCalled();
  });

  it('reverts on the answer', () => {
    const onRevert = jest.fn();
    show({ content: 'b\n' }, { onRevert });

    fireEvent.click(screen.getByTestId('revert'));
    fireEvent.click(screen.getByTestId('confirm-flow-revert-discard'));

    expect(onRevert).toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-flow-revert')).not.toBeInTheDocument();
  });
});
