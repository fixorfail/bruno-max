import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the tab
// writes, so the editor is a textarea that reports its text the way the real one does.
jest.mock('components/CodeEditor', () => ({ value, knownGlobals, onEdit }) => (
  <textarea
    data-testid="script-editor"
    data-known-globals={(knownGlobals || []).join(',')}
    value={value}
    onChange={(event) => onEdit(event.target.value)}
  />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import ScriptsTab from './index';

/**
 * 005 §6.2's Scripts tab — 001 §8.7's `pre:`, one named editor per value, committed whole.
 */
const theme = themes.dark || Object.values(themes)[0];
const flow = { pathname: '/w/flows/checkout.flow.yml', workspaceRoot: '/w' };

const helpers = { pathname: '/w/flows/scripts/helpers.js', filename: 'helpers.js', script: true, workspaceRoot: '/w' };
const crypto = { pathname: '/w/flows/scripts/crypto.js', filename: 'crypto.js', script: true, workspaceRoot: '/w' };

const renderTab = (
  fields,
  onPatch = jest.fn(),
  { functions = [], definitions = {}, names = [], scripts = [], onEdit = jest.fn() } = {}
) => {
  const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <ScriptsTab step={{ id: 'charge', fields, opaque: [] }} flow={flow} functions={functions} definitions={definitions} names={names} scripts={scripts} onPatch={onPatch} onEdit={onEdit} />
      </ThemeProvider>
    </Provider>
  );
  return onPatch;
};

const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(500);
  });

describe('the scripts tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('B4.10 shows each pre: entry as a named editor, and writes an edit to one back into the mapping', async () => {
    const onPatch = renderTab({ pre: { timestamp: '() => String(Date.now())', nonce: '() => "n"' } });

    expect(screen.getByTestId('flow-step-script-name-0')).toHaveValue('timestamp');
    expect(screen.getAllByTestId('script-editor')[1]).toHaveValue('() => "n"');

    fireEvent.change(screen.getAllByTestId('script-editor')[0], { target: { value: '() => "now"' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { pre: { timestamp: '() => "now"', nonce: '() => "n"' } } });
  });

  it('writes a new entry once it has a name, and unsets the key when the last is removed', async () => {
    const onPatch = renderTab({});
    expect(screen.getByTestId('flow-step-scripts')).toHaveTextContent('computes nothing');

    fireEvent.click(screen.getByTestId('flow-step-script-add'));
    fireEvent.change(screen.getByTestId('script-editor'), { target: { value: '() => 1' } });
    await settle();
    expect(onPatch).not.toHaveBeenCalledWith(expect.objectContaining({ set: expect.anything() }));

    fireEvent.change(screen.getByTestId('flow-step-script-name-0'), { target: { value: 'one' } });
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ set: { pre: { one: '() => 1' } } });
  });

  /** Every script position gets the same list, because §8.6's prelude is composed into all of them. */
  it('tells the linter the names a script may call, in both blocks', () => {
    renderTab({ pre: { nonce: '() => lastFour(1)' } }, jest.fn(), {
      definitions: { label: '(v) => v' },
      names: ['lastFour', 'label']
    });

    const globals = screen.getAllByTestId('script-editor').map((editor) => editor.getAttribute('data-known-globals'));
    expect(globals).toEqual(['lastFour,label', 'lastFour,label']);
  });

  it('unsets the key when the last entry is removed', async () => {
    const onPatch = renderTab({ pre: { one: '() => 1' } });

    fireEvent.click(screen.getByTestId('flow-step-script-remove-0'));
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ unset: ['pre'] });
  });

  /** B4.11 — the flow's `functions.use:`, listed above the step's own scripts and edited through the engine. */
  describe('the shared scripts', () => {
    it('lists what the flow uses, offers what it does not, and adds through functions.use', () => {
      const onEdit = jest.fn();
      renderTab({}, jest.fn(), { functions: ['./scripts/helpers.js'], scripts: [helpers, crypto], onEdit });

      expect(screen.getByTestId('flow-step-shared-script-0')).toHaveTextContent('./scripts/helpers.js');
      const options = [...screen.getByTestId('flow-step-shared-script-add').querySelectorAll('option')].map((option) => option.value);
      expect(options).toEqual(['', crypto.pathname]);

      fireEvent.change(screen.getByTestId('flow-step-shared-script-add'), { target: { value: crypto.pathname } });
      expect(onEdit).toHaveBeenCalledWith([{ kind: 'functions.use', source: crypto.pathname }]);

      fireEvent.click(screen.getByTestId('flow-step-shared-script-remove-0'));
      expect(onEdit).toHaveBeenLastCalledWith([{ kind: 'functions.unuse', source: './scripts/helpers.js' }]);
    });

    it('says when there is nothing to add', () => {
      renderTab({}, jest.fn(), { functions: [], scripts: [] });

      expect(screen.getByTestId('flow-step-shared-scripts')).toHaveTextContent('uses no shared script');
      expect(screen.getByTestId('flow-step-shared-script-add')).toHaveTextContent('No scripts under flows/scripts/');
    });
  });
});

/**
 * B4.19 — §8.6's other half: the functions a flow defines inline, beside the files it reads. They
 * are in scope by name in every script the flow runs, so they sit with the block that lists the
 * files rather than on a tab of their own.
 */
describe('the functions a flow defines', () => {
  it('lists each by name, with its source in an editor', () => {
    renderTab({}, jest.fn(), { definitions: { lastFour: '(v) => v.slice(-4)' } });

    expect(screen.getByTestId('flow-step-definition-name-0')).toHaveValue('lastFour');
    expect(screen.getAllByTestId('script-editor')[0]).toHaveValue('(v) => v.slice(-4)');
  });

  it('writes the block whole, leaving the files it reads alone', async () => {
    const onEdit = jest.fn();
    renderTab({}, jest.fn(), { definitions: { lastFour: '(v) => v.slice(-4)' }, onEdit });

    const field = screen.getByTestId('flow-step-definition-name-0');
    fireEvent.change(field, { target: { value: 'tail' } });
    // This block runs on real timers, so the commit is the blur rather than the pause.
    await act(async () => {
      fireEvent.blur(field);
    });

    expect(onEdit).toHaveBeenCalledWith([{ kind: 'functions.define', define: { tail: '(v) => v.slice(-4)' } }]);
  });

  it('says so when the flow defines none', () => {
    renderTab({}, jest.fn(), { definitions: {} });

    expect(screen.getByTestId('flow-step-definitions')).toHaveTextContent('This flow defines none.');
  });
});

/**
 * A script written before the value it computes was named — §8.7 and §8.6 both write an entry under
 * its name, so neither block can hold one without it, and every commit would delete the row.
 */
describe('an entry that is still being filled in', () => {
  const renderWith = (fields, options = {}) => {
    const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
    const onPatch = options.onPatch || jest.fn();
    const onEdit = options.onEdit || jest.fn();
    const tree = (held, definitions) => (
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ScriptsTab
            step={{ id: 'charge', fields: held, opaque: [] }}
            flow={flow}
            functions={[]}
            definitions={definitions}
            scripts={[]}
            onPatch={onPatch}
            onEdit={onEdit}
          />
        </ThemeProvider>
      </Provider>
    );
    const utils = render(tree(fields, options.definitions || {}));
    return {
      onPatch,
      onEdit,
      reseed: (held, definitions = {}) => utils.rerender(tree(held, definitions))
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps a pre: script written before it was named', async () => {
    const { onPatch, reseed } = renderWith({});

    fireEvent.click(screen.getByTestId('flow-step-script-add'));
    fireEvent.change(screen.getAllByTestId('script-editor')[0], { target: { value: '(ctx) => ctx.vars.nonce' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ unset: ['pre'] });

    reseed({});

    expect(screen.getAllByTestId('script-editor')[0]).toHaveValue('(ctx) => ctx.vars.nonce');
  });

  /**
   * Both blocks hold one script per name, so a name typed through one another entry already holds
   * would replace that entry and delete the script in it.
   */
  it('keeps the pre: entry whose name a row is being typed through', async () => {
    const { onPatch, reseed } = renderWith({ pre: { nonce: '() => "n"' } });

    fireEvent.click(screen.getByTestId('flow-step-script-add'));
    fireEvent.change(screen.getAllByTestId('script-editor')[1], { target: { value: '() => "n2"' } });
    fireEvent.change(screen.getByTestId('flow-step-script-name-1'), { target: { value: 'nonce' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { pre: { nonce: '() => "n"' } } });

    reseed({ pre: { nonce: '() => "n"' } });

    expect(screen.getAllByTestId('script-editor')[1]).toHaveValue('() => "n2"');
  });

  it('keeps the function whose name a row is being typed through', async () => {
    const { onEdit, reseed } = renderWith({}, { definitions: { lastFour: '(v) => v.slice(-4)' } });

    fireEvent.click(screen.getByTestId('flow-step-definition-add'));
    const editor = screen.getByTestId('flow-step-definition-editor-1').querySelector('textarea');
    fireEvent.change(editor, { target: { value: '(v) => v.slice(-2)' } });
    const name = screen.getByTestId('flow-step-definition-name-1');
    fireEvent.change(name, { target: { value: 'lastFour' } });
    await act(async () => {
      fireEvent.blur(name);
    });

    expect(onEdit).toHaveBeenLastCalledWith([{ kind: 'functions.define', define: { lastFour: '(v) => v.slice(-4)' } }]);

    reseed({}, { lastFour: '(v) => v.slice(-4)' });

    expect(screen.getByTestId('flow-step-definition-editor-1').querySelector('textarea')).toHaveValue('(v) => v.slice(-2)');
  });

  it('keeps a function written before it was named', async () => {
    const { onEdit, reseed } = renderWith({});

    fireEvent.click(screen.getByTestId('flow-step-definition-add'));
    const editor = screen.getByTestId('flow-step-definition-editor-0').querySelector('textarea');
    fireEvent.change(editor, { target: { value: '(v) => v.slice(-4)' } });
    await act(async () => {
      fireEvent.blur(editor);
    });

    expect(onEdit).toHaveBeenLastCalledWith([{ kind: 'functions.define', define: {} }]);

    reseed({}, {});

    expect(screen.getByTestId('flow-step-definition-editor-0').querySelector('textarea')).toHaveValue('(v) => v.slice(-4)');
  });
});
