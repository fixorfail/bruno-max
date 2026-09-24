import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the
// editor writes, so a script is a textarea that reports its text the way the real one does.
jest.mock('components/CodeEditor', () => ({ value, onEdit }) => (
  <textarea data-testid="when-script-editor" value={value} onChange={(event) => onEdit(event.target.value)} />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import WhenEditor from './index';

/**
 * B4.20 — 001 §9.3's conditions, one row each and an implicit AND between them.
 *
 * A condition is written two ways and they are not the same kind of thing: an expression evaluated
 * on its own, and a script run through the engine's runner with the flow's shared functions in
 * scope. Held in one text field the second was reachable only by typing its JSON — the trap
 * `outputs:` had, in a different block.
 */
const theme = themes.dark || Object.values(themes)[0];

const renderEditor = (when, onPatch = jest.fn()) => {
  const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <WhenEditor
          step={{ id: 'charge', fields: when === undefined ? {} : { when }, opaque: [] }}
          flow={{ pathname: '/w/flows/checkout.flow.yml' }}
          onPatch={onPatch}
        />
      </ThemeProvider>
    </Provider>
  );
  return onPatch;
};

const commit = (element) =>
  act(async () => {
    fireEvent.blur(element);
  });

describe('the when editor', () => {
  it('reads a bare condition as the list of one it means', () => {
    renderEditor('steps.a.status eq 200');

    expect(screen.getByTestId('flow-step-when-kind-0')).toHaveValue('expression');
    expect(screen.getByTestId('flow-step-when-value-0')).toHaveValue('steps.a.status eq 200');
  });

  it('reads the script form as a script, in an editor', () => {
    renderEditor([{ script: '(ctx) => ctx.vars.ready' }]);

    expect(screen.getByTestId('flow-step-when-kind-0')).toHaveValue('script');
    expect(screen.getByTestId('when-script-editor')).toHaveValue('(ctx) => ctx.vars.ready');
  });

  it('writes a lone expression as the bare string, not a list of one', async () => {
    const onPatch = renderEditor('steps.a.status eq 200');

    const field = screen.getByTestId('flow-step-when-value-0');
    fireEvent.change(field, { target: { value: 'steps.a.status eq 201' } });
    await commit(field);

    expect(onPatch).toHaveBeenLastCalledWith({ set: { when: 'steps.a.status eq 201' } });
  });

  /** The case the one text field could not reach without typing JSON. */
  it('writes a script as the mapping form when the kind says script', async () => {
    const onPatch = renderEditor('steps.a.status eq 200');

    fireEvent.change(screen.getByTestId('flow-step-when-kind-0'), { target: { value: 'script' } });
    const editor = screen.getByTestId('when-script-editor');
    fireEvent.change(editor, { target: { value: '(ctx) => ctx.vars.ready' } });
    await commit(editor);

    expect(onPatch).toHaveBeenLastCalledWith({ set: { when: [{ script: '(ctx) => ctx.vars.ready' }] } });
  });

  it('keeps a condition nobody touched in the form the file wrote it', async () => {
    const written = { script: '(ctx) => ctx.vars.ready' };
    const onPatch = renderEditor(['steps.a.status eq 200', written]);

    const field = screen.getByTestId('flow-step-when-value-0');
    fireEvent.change(field, { target: { value: 'steps.a.status eq 201' } });
    await commit(field);

    expect(onPatch).toHaveBeenLastCalledWith({ set: { when: ['steps.a.status eq 201', written] } });
  });

  it('unsets the key when the last condition goes', async () => {
    const onPatch = renderEditor('steps.a.status eq 200');

    const field = screen.getByTestId('flow-step-when-value-0');
    fireEvent.change(field, { target: { value: '' } });
    await commit(field);

    expect(onPatch).toHaveBeenLastCalledWith({ unset: ['when'] });
  });

  it('says the step always runs when it declares none', () => {
    renderEditor(undefined);

    expect(screen.getByTestId('flow-step-when')).toHaveTextContent('This step always runs.');
  });

  /** Each row says which of the two it is, and the marker says what that means for scope. */
  it('marks each row for the kind it is', () => {
    renderEditor(['steps.a.status eq 200', { script: '(ctx) => true' }]);

    expect(screen.getByTestId('flow-code-marker-expression')).toBeInTheDocument();
    expect(screen.getByTestId('flow-code-marker-script')).toBeInTheDocument();
  });
});

/**
 * A condition added and not yet typed into is the author's working state — the document has nothing
 * to write for it, and every blur in the pane commits.
 */
describe('a condition that is still being filled in', () => {
  const renderWith = (when, onPatch = jest.fn()) => {
    const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
    const tree = (held) => (
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <WhenEditor
            step={{ id: 'charge', fields: held === undefined ? {} : { when: held }, opaque: [] }}
            flow={{ pathname: '/w/flows/checkout.flow.yml' }}
            onPatch={onPatch}
          />
        </ThemeProvider>
      </Provider>
    );
    const utils = render(tree(when));
    return { onPatch, reseed: (next) => utils.rerender(tree(next)) };
  };

  it('keeps a row added and pointed at a script before anything is typed', async () => {
    const { onPatch, reseed } = renderWith('steps.a.status eq 200');

    fireEvent.click(screen.getByTestId('flow-step-when-add'));
    fireEvent.change(screen.getByTestId('flow-step-when-kind-1'), { target: { value: 'script' } });
    await act(async () => {
      fireEvent.blur(screen.getByTestId('flow-step-when-kind-1'));
    });

    expect(onPatch).toHaveBeenLastCalledWith({ set: { when: 'steps.a.status eq 200' } });

    reseed('steps.a.status eq 200');

    expect(screen.getByTestId('flow-step-when-kind-1')).toHaveValue('script');
    expect(screen.getByTestId('when-script-editor')).toBeInTheDocument();
  });
});
