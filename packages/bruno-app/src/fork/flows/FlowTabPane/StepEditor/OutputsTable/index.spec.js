import React from 'react';

// The real editor is CodeMirror, which jsdom cannot lay out; these scenarios are about what the
// table writes, so the editor is a textarea that reports its text the way the real one does.
jest.mock('components/CodeEditor', () => ({ value, knownGlobals, onEdit }) => (
  <textarea
    data-testid="output-script-editor"
    data-known-globals={(knownGlobals || []).join(',')}
    value={value}
    onChange={(event) => onEdit(event.target.value)}
  />
));
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

// Upstream's table virtualises its rows, which jsdom cannot lay out; these scenarios are about what
// the table writes, so it is stood in for by one that draws every row and every column as
// `EditableTable` does — the key column as an input, the rest through their `render`.
jest.mock('components/EditableTable', () => ({ rows, columns, onChange, defaultRow, rowConfig = {} }) => {
  const change = (row, key, value) =>
    onChange(rows.map((entry) => (entry === row ? { ...entry, [key]: value } : entry)));

  return (
    <div>
      {rows.map((row) => (
        <div key={row.uid} data-testid={rowConfig.testId?.(row)}>
          {columns.map((column) => (
            <span key={column.key}>
              {column.render ? (
                column.render({ row, value: row[column.key], onChange: (value) => change(row, column.key, value) })
              ) : (
                <input
                  aria-label={column.key}
                  value={row[column.key] || ''}
                  onChange={(event) => change(row, column.key, event.target.value)}
                />
              )}
            </span>
          ))}
        </div>
      ))}
      {/* The real table gives every add-row a uuid of its own, which row identity depends on. */}
      <button type="button" onClick={() => onChange([...rows, { uid: `added-${rows.length}`, ...defaultRow }])}>
        add
      </button>
    </div>
  );
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import OutputsTable from './index';

/**
 * B4.16 — 001 §8.1's five kinds of output, one row each.
 *
 * An output is a name and a *source*. Edited as one value column, the format's shorthand for a body
 * path becomes a trap: a script typed into the cell is a string, the engine reads it as a path, the
 * path selects nothing, and every output is undefined with nothing said. The kind is a control.
 */

const VOCABULARY = { outputSources: ['body', 'headers', 'status', 'pre', 'script'] };
const FUNCTION_NAMES = ['lastFour', 'digitsOnly'];

const renderTable = (outputs, onPatch = jest.fn()) => {
  const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
  render(
    <Provider store={store}>
      <OutputsTable
        step={{ id: 'create', fields: outputs === undefined ? {} : { outputs }, opaque: [] }}
        flow={{ pathname: '/w/flows/checkout.flow.yml' }}
        model={{ vocabulary: VOCABULARY, functionNames: FUNCTION_NAMES }}
        onPatch={onPatch}
      />
    </Provider>
  );
  return onPatch;
};

const sources = () => screen.getAllByTestId(/flow-step-output-source-/);
const values = () => screen.getAllByTestId(/flow-step-output-value-/);
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(500);
  });

describe('the outputs table', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads each of the five forms as its own source', () => {
    renderTable({
      a: 'data.id',
      b: { from: 'headers', path: 'x-request-id' },
      c: { from: 'status' },
      d: { from: 'pre' },
      e: { script: '(res) => res.body.id' }
    });

    expect(sources().map((field) => field.value)).toEqual(['body', 'headers', 'status', 'pre', 'script']);
    expect(values()[0]).toHaveValue('data.id');
    // A script's cell is the line it starts with; the function is in the editor focus opens.
    expect(values()[4]).toHaveTextContent('(res) => res.body.id');
  });

  /** The case that started this: a script has to be writable without knowing the mapping form. */
  it('writes a script as the mapping form when the source says script', async () => {
    const onPatch = renderTable({ companyName: 'data.id' });

    fireEvent.change(sources()[0], { target: { value: 'script' } });
    // The row has to be entered for its editor to be there, which is the whole point of the change.
    fireEvent.focus(values()[0]);
    fireEvent.change(screen.getByTestId('output-script-editor'), {
      target: { value: '(res) => res.body.included[0].attributes.name' }
    });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({
      set: { outputs: { companyName: { script: '(res) => res.body.included[0].attributes.name' } } }
    });
  });

  it('writes a body path as the shorthand, not the long form', async () => {
    const onPatch = renderTable({ id: 'data.id' });

    fireEvent.change(values()[0], { target: { value: 'data.thing.id' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { id: 'data.thing.id' } } });
  });

  it('leaves a status row nothing to type, and writes it without a path', async () => {
    const onPatch = renderTable({ code: 'data.code' });

    expect(values()[0]).not.toBeDisabled();
    fireEvent.change(sources()[0], { target: { value: 'status' } });
    await settle();

    expect(values()[0]).toBeDisabled();
    expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { code: { from: 'status' } } } });
  });

  /** §8.7: a `pre:` value taken under the name it already has is the block's own default. */
  it('omits a pre path that is the output\'s own name', async () => {
    const onPatch = renderTable({ token: 'data.token' });

    fireEvent.change(sources()[0], { target: { value: 'pre' } });
    fireEvent.change(values()[0], { target: { value: 'token' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { token: { from: 'pre' } } } });
  });

  it('keeps a row nobody touched in the form the file wrote it', async () => {
    const written = { from: 'headers', path: 'x-request-id' };
    const onPatch = renderTable({ id: 'data.id', trace: written });

    fireEvent.change(values()[0], { target: { value: 'data.thing.id' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { id: 'data.thing.id', trace: written } } });
  });

  it('unsets the block when every row is cleared', async () => {
    const onPatch = renderTable({ id: 'data.id' });

    fireEvent.change(screen.getAllByLabelText('name')[0], { target: { value: '' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ unset: ['outputs'] });
  });

  it('says how an output is referenced, with this step\'s own id', () => {
    renderTable({ id: 'data.id' });

    expect(screen.getByTestId('flow-step-outputs')).toHaveTextContent('Reference these outputs with steps.create.<output>');
  });

  describe('the script editor under the table', () => {
    /**
     * One editor over the chosen row rather than one per script: four script outputs is a table of
     * four rows and an editor, not four stacked editors.
     */
    it('shows nothing until a script row is entered', () => {
      renderTable({ id: { script: '(res) => res.body.id' } });

      expect(screen.queryByTestId('output-script-editor')).not.toBeInTheDocument();

      fireEvent.focus(values()[0]);

      expect(screen.getByTestId('flow-step-output-script-id')).toHaveTextContent('id');
      expect(screen.getByTestId('output-script-editor')).toHaveValue('(res) => res.body.id');
    });

    it('follows the row focus moves to, one editor at a time', () => {
      renderTable({ id: { script: '(res) => res.body.id' }, tag: { script: '(res) => res.body.tag' } });

      fireEvent.focus(values()[0]);
      expect(screen.getAllByTestId('output-script-editor')).toHaveLength(1);

      fireEvent.focus(values()[1]);

      expect(screen.getByTestId('flow-step-output-script-tag')).toHaveTextContent('tag');
      expect(screen.getByTestId('output-script-editor')).toHaveValue('(res) => res.body.tag');
    });

    /** Focus moving from the row into its own editor is still focus on that row's script. */
    it('stays while focus moves into the editor, and goes when it leaves the section', () => {
      renderTable({ id: { script: '(res) => res.body.id' } });

      fireEvent.focus(values()[0]);
      const editor = screen.getByTestId('output-script-editor');

      fireEvent.blur(values()[0], { relatedTarget: editor });
      expect(screen.getByTestId('output-script-editor')).toBeInTheDocument();

      fireEvent.blur(editor, { relatedTarget: document.body });
      expect(screen.queryByTestId('output-script-editor')).not.toBeInTheDocument();
    });

    /**
     * 001 §8.6's helpers are in scope in a script, and the editor's linter has no way to know that:
     * every one of them lints as *is not defined* until it is told.
     */
    it('tells the linter the names a script may call', () => {
      renderTable({ id: { script: '(res) => lastFour(res.body.id)' } });

      fireEvent.focus(values()[0]);

      expect(screen.getByTestId('output-script-editor')).toHaveAttribute('data-known-globals', 'lastFour,digitsOnly');
    });

    it('shows none for a row that is not a script', () => {
      renderTable({ id: 'data.id' });

      fireEvent.focus(values()[0]);

      expect(screen.queryByTestId('output-script-editor')).not.toBeInTheDocument();
    });

    it('edits the row it belongs to, and nothing else', async () => {
      const onPatch = renderTable({ id: { script: '(res) => res.body.id' }, name: 'data.name' });

      fireEvent.focus(values()[0]);
      fireEvent.change(screen.getByTestId('output-script-editor'), { target: { value: '(res) => res.body.thing.id' } });
      await settle();

      expect(onPatch).toHaveBeenCalledWith({
        set: { outputs: { id: { script: '(res) => res.body.thing.id' }, name: 'data.name' } }
      });
    });

    it('is not written to the document', async () => {
      const onPatch = renderTable({ id: { script: '(res) => res.body.id' } });

      fireEvent.focus(values()[0]);
      fireEvent.change(screen.getAllByLabelText('name')[0], { target: { value: 'thingId' } });
      await settle();

      expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { thingId: { script: '(res) => res.body.id' } } } });
    });
  });
});

/**
 * A row with no name yet is the author's working state, not an output — 001 §8.1 has nothing to
 * call it, so it is left out of the document. It must not be left out of the *table*: a commit
 * happens on every blur inside the section and after every pause in typing, and a row dropped by one
 * takes whatever was typed into it with it.
 */
describe('a row that is still being filled in', () => {
  const renderWith = (outputs, onPatch = jest.fn()) => {
    const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
    const tree = (fields) => (
      <Provider store={store}>
        <OutputsTable
          step={{ id: 'create', fields, opaque: [] }}
          flow={{ pathname: '/w/flows/checkout.flow.yml' }}
          model={{ vocabulary: VOCABULARY }}
          onPatch={onPatch}
        />
      </Provider>
    );
    const utils = render(tree(outputs === undefined ? {} : { outputs }));
    return { onPatch, reseed: (next) => utils.rerender(tree(next === undefined ? {} : { outputs: next })) };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps a script written before the output was named', async () => {
    const { onPatch, reseed } = renderWith({});

    // The add-row, pointed at a script and typed into before it has a name.
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(sources()[0], { target: { value: 'script' } });
    fireEvent.focus(values()[0]);
    fireEvent.change(screen.getByTestId('output-script-editor'), { target: { value: '(res) => res.body.id' } });
    await settle();

    // Nothing to write: §8.1 has no name to publish it under.
    expect(onPatch).toHaveBeenCalledWith({ unset: ['outputs'] });

    // The document says the step publishes nothing, and the row has to survive that.
    reseed(undefined);

    expect(sources()[0]).toHaveValue('script');
    fireEvent.focus(values()[0]);
    expect(screen.getByTestId('output-script-editor')).toHaveValue('(res) => res.body.id');
  });

  /**
   * A name is typed a letter at a time, so a name on its way to `identity` is `id` for a moment —
   * and `id` is an output the step already publishes. Written as one mapping, the second row under
   * that name replaces the first, which deletes the output the author never touched.
   */
  it('keeps the output whose name a row is being typed through', async () => {
    const { onPatch, reseed } = renderWith({ id: 'data.id' });

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(values()[1], { target: { value: 'data.identity' } });
    fireEvent.change(screen.getAllByLabelText('name')[1], { target: { value: 'id' } });
    await settle();

    // The output already published under that name is left as it is, and the row being typed waits.
    expect(onPatch).toHaveBeenLastCalledWith({ set: { outputs: { id: 'data.id' } } });

    reseed({ id: 'data.id' });

    expect(screen.getAllByLabelText('name').map((field) => field.value)).toEqual(['id', 'id']);
    expect(values()[1]).toHaveValue('data.identity');

    // Once the name is its own, both are written.
    fireEvent.change(screen.getAllByLabelText('name')[1], { target: { value: 'identity' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { outputs: { id: 'data.id', identity: 'data.identity' } } });
  });

  /**
   * The same collision the other way round: a name typed onto a row *above* the output that holds
   * it. The row below is the one the file publishes under that name, so it is the row that keeps
   * it — the file is never written without the output nobody touched.
   */
  it('keeps the output below the row a name is being typed onto', async () => {
    const { onPatch, reseed } = renderWith({ id: 'data.id', name: 'data.name' });

    // `id` renamed towards `names`, through the `name` below it.
    fireEvent.change(screen.getAllByLabelText('name')[0], { target: { value: 'name' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { outputs: { name: 'data.name' } } });

    reseed({ name: 'data.name' });

    expect(screen.getAllByLabelText('name').map((field) => field.value)).toEqual(['name', 'name']);
    expect(values()[0]).toHaveValue('data.id');

    fireEvent.change(screen.getAllByLabelText('name')[0], { target: { value: 'names' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { outputs: { names: 'data.id', name: 'data.name' } } });
  });

  it('keeps it while another output is being named beside it', async () => {
    const { onPatch, reseed } = renderWith({});

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(sources()[0], { target: { value: 'script' } });
    fireEvent.focus(values()[0]);
    fireEvent.change(screen.getByTestId('output-script-editor'), { target: { value: '(res) => res.body.id' } });
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(screen.getAllByLabelText('name')[1], { target: { value: 'tag' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { outputs: { tag: '' } } });

    reseed({ tag: '' });

    expect(screen.getAllByLabelText('name')).toHaveLength(2);
    expect(sources()[0]).toHaveValue('script');
  });
});
