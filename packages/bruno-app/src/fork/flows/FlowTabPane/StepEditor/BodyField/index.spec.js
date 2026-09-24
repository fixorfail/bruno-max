import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the
// field writes, so the editor is a textarea that reports its text the way the real one does.
jest.mock('components/CodeEditor', () => ({ value, onEdit, mode }) => (
  <div className="CodeMirror">
    {/* The node CodeMirror sizes to the document, which is what the box measures (005 §6.7). */}
    <div className="CodeMirror-sizer">
      <textarea data-testid="body-editor" data-mode={mode} value={value} onChange={(event) => onEdit(event.target.value)} />
    </div>
  </div>
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import BodyField from './index';

/**
 * 005 §6.7 — a body is shown as what it will be sent as, and written back in the form the file
 * gave it.
 */

const theme = themes.dark || Object.values(themes)[0];

const renderField = (fields, onPatch = jest.fn(), { flow = { pathname: '/w/checkout.flow.yml' }, content } = {}) => {
  const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <BodyField step={{ id: 'a', fields, opaque: [] }} flow={flow} content={content} onPatch={onPatch} />
      </ThemeProvider>
    </Provider>
  );
  return onPatch;
};

const editor = () => screen.getByTestId('body-editor');
const typeBody = (text) => fireEvent.change(editor(), { target: { value: text } });
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(500);
  });

describe('the body field', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a mapping as the JSON it will be sent as, and writes it back as a mapping', async () => {
    const onPatch = renderField({ body: { amount: 9900, currency: 'USD' } });

    expect(editor()).toHaveValue('{\n  "amount": 9900,\n  "currency": "USD"\n}');
    expect(editor()).toHaveAttribute('data-mode', 'application/ld+json');

    typeBody('{"amount": 100}');
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { body: { amount: 100 } }, unset: [] });
  });

  it('shows a string as the string, and writes it back as one', async () => {
    const onPatch = renderField({ body: '{"raw": true}' });

    expect(editor()).toHaveValue('{"raw": true}');
    expect(editor()).toHaveAttribute('data-mode', 'text/plain');

    typeBody('plain text');
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { body: 'plain text' }, unset: [] });
  });

  /** The one refusal the editor makes on its own: a mapping half-typed is not written as a string. */
  it('refuses invalid JSON where the body is a mapping, and says so', async () => {
    const onPatch = renderField({ body: { amount: 1 } });

    typeBody('{"amount": ');
    await settle();

    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('flow-step-body-error')).toBeInTheDocument();
  });

  it('takes the form of the text where there was no body', async () => {
    const onPatch = renderField({});

    typeBody('{"a": 1}');
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ set: { body: { a: 1 } }, unset: [] });

    typeBody('not json');
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ set: { body: 'not json' }, unset: [] });
  });

  it('unsets a body that is cleared', async () => {
    const onPatch = renderField({ body: { a: 1 } });

    typeBody('');
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ unset: ['body'] });
  });

  /** 001 §5.3: `body:` and `bodyFile:` are exclusive — writing one removes the other. */
  it('replaces a body with a body file, and a body file with a body', async () => {
    const onPatch = renderField({ body: { a: 1 } });

    fireEvent.change(screen.getByTestId('flow-step-field-bodyFile'), { target: { value: './payload.json' } });
    await act(async () => {
      fireEvent.blur(screen.getByTestId('flow-step-field-bodyFile'));
    });
    expect(onPatch).toHaveBeenCalledWith({ set: { bodyFile: './payload.json' }, unset: ['body'] });

    const other = renderField({ bodyFile: './payload.json' });
    fireEvent.change(screen.getAllByTestId('body-editor')[1], { target: { value: 'text' } });
    await settle();
    expect(other).toHaveBeenCalledWith({ set: { body: 'text' }, unset: ['bodyFile'] });
  });

  it('writes the content type on Enter', async () => {
    const onPatch = renderField({});
    const field = screen.getByTestId('flow-step-field-contentType');

    fireEvent.change(field, { target: { value: 'multipart/form-data' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });

    expect(onPatch).toHaveBeenCalledWith({ set: { contentType: 'multipart/form-data' } });
  });

  it('unsets a content type that is cleared', async () => {
    const onPatch = renderField({ contentType: 'multipart/form-data' });

    fireEvent.change(screen.getByTestId('flow-step-field-contentType'), { target: { value: '' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ unset: ['contentType'] });
  });
});

/**
 * 005 §6.7 — *Seed from spec*: an explicit act that asks the host for the operation's own request
 * example, rather than a default the insert path already declined to guess (§5.1).
 */
describe('seeding the body from the spec', () => {
  const flow = { pathname: '/workspace/flows/checkout.flow.yml', workspaceRoot: '/workspace' };

  afterEach(() => {
    delete window.ipcRenderer;
  });

  it('replaces the body when the host answers with an example', async () => {
    window.ipcRenderer = {
      invoke: jest.fn((channel, request) => {
        expect(channel).toBe('renderer:flow-step-example');
        expect(request).toMatchObject({ entry: flow.pathname, stepId: 'a', content: 'version: 1\n' });
        return Promise.resolve({ example: { amount: 900 }, mediaType: 'application/json' });
      })
    };
    const onPatch = jest.fn();
    renderField({}, onPatch, { flow, content: 'version: 1\n' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-step-seed-body'));
    });

    expect(onPatch).toHaveBeenCalledWith({ set: { body: { amount: 900 } }, unset: [] });
  });

  it('says so and writes nothing when the host answers with a reason', async () => {
    window.ipcRenderer = { invoke: jest.fn(() => Promise.resolve({ reason: 'no-example' })) };
    const onPatch = jest.fn();
    renderField({}, onPatch, { flow, content: 'version: 1\n' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-step-seed-body'));
    });

    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('flow-step-seed-empty')).toHaveTextContent('The operation declares no example');
  });
});

/**
 * B4.12 — §6.7's box is the size of what is in it. Measured from what CodeMirror *drew* rather than from the
 * text: the editor wraps, so a minified payload on one line is one line of text and several rows on
 * screen — the case a line count gets most wrong and the one most likely to arrive by paste.
 *
 * jsdom lays nothing out, so the observer is driven by hand here: what these pin is the arithmetic
 * and the attachment, not the measurement, which needs a browser.
 */
describe('sizing the body box to its content', () => {
  const box = () => screen.getByTestId('flow-step-field-body');
  let observed;
  let disconnected;

  beforeEach(() => {
    observed = [];
    disconnected = 0;
    global.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }

      observe(node) {
        observed.push({ node, callback: this.callback });
      }

      disconnect() {
        disconnected += 1;
      }
    };
  });

  /** What the observer would report, as the browser reports it. */
  const draw = (height) =>
    act(() => {
      observed[observed.length - 1].callback([{ contentRect: { height } }]);
    });

  it('watches the node the editor sizes to the document', () => {
    renderField({ body: 'hello' });

    expect(observed).toHaveLength(1);
    expect(observed[0].node).toHaveClass('CodeMirror-sizer');
  });

  it('keeps the stylesheet\'s height until something has been drawn', () => {
    renderField({ body: 'hello' });

    expect(box()).not.toHaveAttribute('style', expect.stringContaining('height'));
  });

  it('follows what was drawn, with room for the editor\'s own chrome', () => {
    renderField({ body: 'hello' });

    draw(260);

    expect(box()).toHaveStyle({ height: '268px' });
  });

  it('holds the box between a floor and a ceiling', () => {
    renderField({ body: 'hello' });

    draw(10);
    expect(box()).toHaveStyle({ height: '96px' });

    draw(5000);
    expect(box()).toHaveStyle({ height: '900px' });
  });

  /**
   * Sizing the box resizes the editor inside it, which is a resize the observer sees — so a target
   * that has not moved is not applied, and the second pass settles instead of ringing.
   */
  it('ignores a measurement that has not moved', () => {
    renderField({ body: 'hello' });

    draw(260);
    draw(260.5);

    expect(box()).toHaveStyle({ height: '268px' });
  });

  /** The editor is keyed by step, so a remount leaves the old sizer detached and unobserved. */
  it('re-attaches to the new editor when the step changes', () => {
    const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
    const flow = { pathname: '/w/checkout.flow.yml' };
    const field = (id) => (
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <BodyField step={{ id, fields: { body: 'hello' }, opaque: [] }} flow={flow} onPatch={jest.fn()} />
        </ThemeProvider>
      </Provider>
    );

    const { rerender } = render(field('a'));
    expect(observed).toHaveLength(1);

    rerender(field('b'));

    expect(disconnected).toBe(1);
    expect(observed).toHaveLength(2);
  });
});
