import React from 'react';

// Upstream's table virtualises its rows, which jsdom cannot lay out; what these scenarios are about
// is what the section does with the rows, so the table is stood in for by one that shows them all.
jest.mock('components/EditableTable', () => ({ rows, onChange, testId }) => (
  <table data-testid={testId}>
    <tbody>
      {rows.map((row) => (
        <tr key={row.uid} data-testid={`${testId}-row-${row.uid}`}>
          <td>
            <input
              aria-label="name"
              value={row.name}
              onChange={(event) => onChange(rows.map((entry) => (entry === row ? { ...entry, name: event.target.value } : entry)))}
            />
          </td>
          <td>
            <input
              aria-label="value"
              value={row.value}
              onChange={(event) => onChange(rows.map((entry) => (entry === row ? { ...entry, value: event.target.value } : entry)))}
            />
          </td>
        </tr>
      ))}
      <tr>
        <td>
          <button type="button" onClick={() => onChange([...rows, { uid: `added-${rows.length}`, name: '', value: '' }])}>
            add
          </button>
        </td>
      </tr>
    </tbody>
  </table>
));

import { act, fireEvent, render, screen } from '@testing-library/react';
import KeyValueSection from './index';

/**
 * 005 §6.2, §6.3 — a mapping of the step as a table, committed whole when the typing stops.
 */

const renderSection = (value, onPatch = jest.fn()) => {
  render(<KeyValueSection label="Headers" field="headers" value={value} testId="flow-step-headers" onPatch={onPatch} />);
  return onPatch;
};

const inputs = (label) => screen.getAllByLabelText(label);

describe('a key/value section of the step editor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the mapping as written', () => {
    renderSection({ 'X-Trace': '{{flow.runId}}', 'Accept': 'application/json' });

    expect(inputs('name').map((input) => input.value)).toEqual(['X-Trace', 'Accept']);
    expect(inputs('value').map((input) => input.value)).toEqual(['{{flow.runId}}', 'application/json']);
  });

  /** §6.3: a keystroke is local; the pause is what writes, and it writes the whole mapping once. */
  it('commits the whole mapping after a pause, as one edit', async () => {
    const onPatch = renderSection({ Accept: 'application/json' });

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(inputs('name')[1], { target: { value: 'X-Trace' } });
    fireEvent.change(inputs('value')[1], { target: { value: 'abc' } });
    expect(onPatch).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith({ set: { headers: { 'Accept': 'application/json', 'X-Trace': 'abc' } } });
  });

  it('commits on blur', async () => {
    const onPatch = renderSection({ Accept: 'application/json' });

    fireEvent.change(inputs('value')[0], { target: { value: 'text/plain' } });
    await act(async () => {
      fireEvent.blur(inputs('value')[0]);
    });

    expect(onPatch).toHaveBeenCalledWith({ set: { headers: { Accept: 'text/plain' } } });
  });

  /** §9.1: a default is written as an absence — a mapping emptied is a mapping removed. */
  it('unsets the key when every row is cleared', async () => {
    const onPatch = renderSection({ Accept: 'application/json' });

    fireEvent.change(inputs('name')[0], { target: { value: '' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenCalledWith({ unset: ['headers'] });
  });

  it('sends nothing when the typing changed nothing', async () => {
    const onPatch = renderSection({ Accept: 'application/json' });

    fireEvent.change(inputs('value')[0], { target: { value: 'x' } });
    fireEvent.change(inputs('value')[0], { target: { value: 'application/json' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).not.toHaveBeenCalled();
  });

  /** A value the file wrote as something other than a string is shown as its text. */
  it('shows a non-string value as text', () => {
    renderSection({ retries: 3, nested: { a: 1 } });

    expect(inputs('value').map((input) => input.value)).toEqual(['3', '{"a":1}']);
  });

  /** An output written as `{ from, path }` goes back as the mapping while its text still parses as one. */
  it('writes a mapping value back as a mapping, and edited text that is not one as text', async () => {
    const onPatch = renderSection({ code: { from: 'status' }, id: 'data.id' });

    fireEvent.change(inputs('value')[0], { target: { value: '{"from": "status", "path": "x"}' } });
    fireEvent.change(inputs('value')[1], { target: { value: 'data.uid' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(onPatch).toHaveBeenCalledWith({ set: { headers: { code: { from: 'status', path: 'x' }, id: 'data.uid' } } });

    const other = renderSection({ code: { from: 'status' } });
    fireEvent.change(inputs('value')[2], { target: { value: 'not a mapping' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(other).toHaveBeenCalledWith({ set: { headers: { code: 'not a mapping' } } });
  });

  /**
   * §6.3: the moment an edit lands the field reads back from the model the engine returns — and not
   * before. Between the commit and that answer the table keeps what was typed, so a value typed
   * into the row a pause just committed lands in that row and not in a stale one.
   */
  it('keeps the typed rows after a commit until the model catches up', async () => {
    const onPatch = jest.fn();
    const { rerender } = render(<KeyValueSection label="Headers" field="headers" value={undefined} testId="flow-step-headers" onPatch={onPatch} />);

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(inputs('name')[0], { target: { value: 'X-Trace' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Trace': '' } } });

    // The model has not answered yet: the row is still here, and the value goes into it.
    expect(inputs('name')[0]).toHaveValue('X-Trace');
    fireEvent.change(inputs('value')[0], { target: { value: 'abc' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Trace': 'abc' } } });

    // The model answers with what was written, and the table reads it back.
    rerender(<KeyValueSection label="Headers" field="headers" value={{ 'X-Trace': 'abc' }} testId="flow-step-headers" onPatch={onPatch} />);
    expect(inputs('name')[0]).toHaveValue('X-Trace');
    expect(inputs('value')[0]).toHaveValue('abc');
  });

  /** 001 §9.1 lets `shared:` be a list of slot names; it reads as the mapping it means. */
  it('reads a list as the mapping it means', () => {
    renderSection(['quoteId', 'carrierRef']);

    expect(inputs('name').map((input) => input.value)).toEqual(['quoteId', 'carrierRef']);
    expect(inputs('value').map((input) => input.value)).toEqual(['quoteId', 'carrierRef']);
  });
});

/**
 * A row with a value and no key yet is the author's working state. §7.2 writes an entry under its
 * name, so the document cannot hold it — and every blur in the section commits, so a row dropped by
 * one takes what was typed into it.
 */
describe('a row that is still being filled in', () => {
  const renderWith = (value, onPatch = jest.fn()) => {
    const tree = (held) => (
      <KeyValueSection label="Headers" field="headers" value={held} testId="flow-step-headers" onPatch={onPatch} />
    );
    const utils = render(tree(value));
    return { onPatch, reseed: (next) => utils.rerender(tree(next)) };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * A key typed towards one that is free passes through the keys the mapping already holds —
   * `X-Trace` on the way to `X-Trace-Id`. A mapping holds one entry per key, so the row being typed
   * would replace the header that is already there and delete its value.
   */
  it('keeps the entry whose key a row is being typed through', async () => {
    const { onPatch, reseed } = renderWith({ 'X-Trace': 'abc' });

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(inputs('value')[1], { target: { value: 'def' } });
    fireEvent.change(inputs('name')[1], { target: { value: 'X-Trace' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Trace': 'abc' } } });

    reseed({ 'X-Trace': 'abc' });

    expect(inputs('value').map((field) => field.value)).toEqual(['abc', 'def']);

    fireEvent.change(inputs('name')[1], { target: { value: 'X-Trace-Id' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Trace': 'abc', 'X-Trace-Id': 'def' } } });
  });

  /** The same collision the other way round: a key typed onto a row above the entry that holds it. */
  it('keeps the entry below the row a key is being typed onto', async () => {
    const { onPatch, reseed } = renderWith({ 'X-Trace': 'abc', 'X-Tag': 'def' });

    fireEvent.change(inputs('name')[0], { target: { value: 'X-Tag' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Tag': 'def' } } });

    reseed({ 'X-Tag': 'def' });

    expect(inputs('value').map((field) => field.value)).toEqual(['abc', 'def']);
  });

  it('keeps a value typed before its key, while another row is named beside it', async () => {
    const { onPatch, reseed } = renderWith({ 'X-Trace': 'abc' });

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(inputs('value')[1], { target: { value: 'acme' } });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPatch).toHaveBeenLastCalledWith({ set: { headers: { 'X-Trace': 'abc' } } });

    reseed({ 'X-Trace': 'abc' });

    expect(inputs('value').map((field) => field.value)).toEqual(['abc', 'acme']);
  });
});
