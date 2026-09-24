import React from 'react';

// Upstream's table virtualises its rows, which jsdom cannot lay out; the scenarios are about what
// the tab writes, so the table is stood in for by one that draws every row and every column the
// way `EditableTable` does — a key column as an input, and the rest through their `render`.
jest.mock('components/EditableTable', () => ({ rows, columns, onChange, defaultRow }) => {
  const change = (row, key, value) =>
    onChange(rows.map((entry) => (entry === row ? { ...entry, [key]: value } : entry)));

  return (
    <div>
      {rows.map((row) => (
        <div key={row.uid}>
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
      <button type="button" onClick={() => onChange([...rows, { uid: `added-${rows.length}`, ...defaultRow }])}>
        add
      </button>
    </div>
  );
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import AssertTab from './index';

/**
 * B4.14 — 005 §6.2's assertion is an expression, an operator and an operand (001 §10.2), and is
 * edited as those three. What it is written back as is the other half: a row nobody touched goes back as
 * the line or the mapping the file held, because splitting a file's assertions into columns and
 * rejoining them would reformat every one of them the first time any one was edited.
 */

const VOCABULARY = {
  operators: ['eq', 'neq', '==', '!=', 'gt', 'isEmpty', 'isNull', 'isTruthy'],
  unaryOperators: ['isEmpty', 'isNull', 'isTruthy']
};

const renderTab = (assert, onPatch = jest.fn(), vocabulary = VOCABULARY) => {
  render(
    <AssertTab
      step={{ id: 'a', fields: assert === undefined ? {} : { assert }, opaque: [] }}
      model={{ vocabulary }}
      onPatch={onPatch}
    />
  );
  return onPatch;
};

const exprs = () => screen.getAllByLabelText('expr');
const operators = () => screen.getAllByTestId(/flow-step-assert-op-/);
const values = () => screen.getAllByTestId(/flow-step-assert-value-/);
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(500);
  });

describe('the assert tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('splits a line and a mapping into the same three parts', () => {
    renderTab(['res.status eq 201', { expr: 'res.body.data.amount', op: 'gt', value: 9900 }]);

    expect(exprs().map((field) => field.value)).toEqual(['res.status', 'res.body.data.amount']);
    expect(operators().map((field) => field.value)).toEqual(['eq', 'gt']);
    expect(values().map((field) => field.value)).toEqual(['201', '9900']);
  });

  /** A bare expression is §10.2's `isTruthy`, and must not be written back with the word added. */
  it('reads a bare expression as isTruthy, and leaves the line as it was written', async () => {
    const onPatch = renderTab(['res.body.ok', 'res.status eq 201']);

    expect(operators()[0]).toHaveValue('isTruthy');

    fireEvent.change(exprs()[1], { target: { value: 'res.statusText' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { assert: ['res.body.ok', 'res.statusText eq 201'] } });
  });

  it('keeps an untouched mapping as a mapping, and writes an edited row as a line', async () => {
    const mapping = { expr: 'res.body.data.amount', op: 'eq', value: 9900 };
    const onPatch = renderTab(['res.status eq 201', mapping]);

    fireEvent.change(values()[0], { target: { value: '202' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { assert: ['res.status eq 202', mapping] } });
  });

  it('writes a row added through the table', async () => {
    const onPatch = renderTab(['res.status eq 201']);

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(exprs()[1], { target: { value: 'res.body.ok' } });
    fireEvent.change(values()[1], { target: { value: 'true' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ set: { assert: ['res.status eq 201', 'res.body.ok eq true'] } });
  });

  it('unsets the key when every row is cleared', async () => {
    const onPatch = renderTab(['res.status eq 201']);

    fireEvent.change(exprs()[0], { target: { value: '' } });
    await settle();

    expect(onPatch).toHaveBeenCalledWith({ unset: ['assert'] });
  });

  /**
   * B4.15 — these are §10.2's expressions, not §8.2's scripts, and the difference is invisible in a
   * form: a shared function called here resolves to nothing and the assertion just fails.
   */
  it('marks the section as an expression rather than a script', () => {
    renderTab(['res.status eq 201']);

    expect(screen.getByTestId('flow-code-marker-expression')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-code-marker-script')).not.toBeInTheDocument();
  });

  describe('the operator', () => {
    it('offers the engine\'s list, aliases included', () => {
      renderTab(['res.status eq 201']);

      expect([...operators()[0].options].map((option) => option.value)).toEqual(VOCABULARY.operators);
    });

    /** Labels are the two operators whose names are not their meaning; the rest read as written. */
    it('labels eq and neq as they read in the collections pane', () => {
      renderTab(['res.status eq 201']);

      const labels = [...operators()[0].options].map((option) => option.textContent);

      expect(labels.slice(0, 4)).toEqual(['equals', 'notEquals', '==', '!=']);
    });

    /** Otherwise opening the tab would re-point the row at whichever operator the select defaulted to. */
    it('shows an operator the engine does not list rather than dropping it', () => {
      renderTab([{ expr: 'res.status', op: 'approximates', value: '201' }]);

      expect(operators()[0]).toHaveValue('approximates');
    });

    it('writes the line with the operator that was chosen', async () => {
      const onPatch = renderTab(['res.status eq 201']);

      fireEvent.change(operators()[0], { target: { value: 'neq' } });
      await settle();

      expect(onPatch).toHaveBeenCalledWith({ set: { assert: ['res.status neq 201'] } });
    });
  });

  describe('an operator that takes no operand', () => {
    it('leaves the row nothing to type into', () => {
      renderTab(['res.body.items isEmpty']);

      expect(values()[0]).toBeDisabled();
    });

    it('drops the operand when the row becomes unary', async () => {
      const onPatch = renderTab(['res.status eq 201']);

      fireEvent.change(operators()[0], { target: { value: 'isNull' } });
      await settle();

      expect(onPatch).toHaveBeenCalledWith({ set: { assert: ['res.status isNull'] } });
    });
  });
});

/**
 * A row with an operator or an operand and no expression yet is the author's working state. §10.2
 * has no assertion without one, so the document cannot hold the row — and every commit would
 * otherwise delete it.
 */
describe('a row that is still being filled in', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const renderWith = (assert, onPatch = jest.fn()) => {
    const tree = (held) => (
      <AssertTab
        step={{ id: 'a', fields: held === undefined ? {} : { assert: held }, opaque: [] }}
        model={{ vocabulary: VOCABULARY }}
        onPatch={onPatch}
      />
    );
    const utils = render(tree(assert));
    return { onPatch, reseed: (next) => utils.rerender(tree(next)) };
  };

  it('keeps an operand typed before its expression', async () => {
    const { onPatch, reseed } = renderWith(['res.status eq 201']);

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(values()[1], { target: { value: '9900' } });
    await settle();

    expect(onPatch).toHaveBeenLastCalledWith({ set: { assert: ['res.status eq 201'] } });

    reseed(['res.status eq 201']);

    expect(values().map((field) => field.value)).toEqual(['201', '9900']);
  });
});
