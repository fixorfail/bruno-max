import React from 'react';

jest.mock('components/EditableTable', () => jest.requireActual('../EditableTableStandIn').default);

import { act, fireEvent, render, screen } from '@testing-library/react';
import VarsSection from './index';

/**
 * 001 §7.3's `vars:` as a table. One `vars.define` commits the full block, and a row that nobody
 * changed goes back as the model read it.
 */

const VARS = [
  { name: 'currency', value: 'USD' },
  { name: 'retries', value: 3 },
  { name: 'catalog', opaque: true },
  { name: 'limits', value: { daily: 100 } }
];

const renderSection = (vars = VARS) => {
  const onEdit = jest.fn();
  render(<VarsSection vars={vars} onEdit={onEdit} />);
  return onEdit;
};

const cells = (label) => screen.getAllByLabelText(label);
const commit = async () => {
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
};
const defined = (onEdit) => onEdit.mock.calls.at(-1)[0][0];

describe('the flow settings\' Vars section', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows each var as written, and an opaque var under the table', () => {
    renderSection();

    expect(cells('name').map((input) => input.value)).toEqual(['currency', 'retries', 'limits']);
    expect(cells('value').map((input) => input.value)).toEqual(['USD', '3', '{"daily":100}']);
    expect(screen.getByTestId('flow-settings-var-opaque-catalog')).toBeInTheDocument();
  });

  it('writes the full block, with unchanged values as the file wrote them and the opaque var in its place', async () => {
    const onEdit = renderSection();

    fireEvent.change(cells('value')[0], { target: { value: 'EUR' } });
    await commit();

    expect(defined(onEdit).kind).toBe('vars.define');
    expect(Object.entries(defined(onEdit).vars)).toEqual([
      ['currency', 'EUR'],
      ['retries', 3],
      ['catalog', null],
      ['limits', { daily: 100 }]
    ]);
  });

  it('keeps a mapping a mapping while its text is JSON', async () => {
    const onEdit = renderSection();

    fireEvent.change(cells('value')[2], { target: { value: '{"daily":200}' } });
    await commit();

    expect(defined(onEdit).vars.limits).toEqual({ daily: 200 });
  });

  it('adds a var once it has a name', async () => {
    const onEdit = renderSection([]);

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(cells('value')[0], { target: { value: 'qa+{{$randomUUID}}@example.com' } });
    fireEvent.change(cells('name')[0], { target: { value: 'testEmail' } });
    await commit();

    expect(defined(onEdit).vars).toEqual({ testEmail: 'qa+{{$randomUUID}}@example.com' });
  });

  it('does not write a row over an opaque var of the same name', async () => {
    const onEdit = renderSection();

    fireEvent.change(cells('name')[0], { target: { value: 'catalog' } });
    await commit();

    expect(Object.keys(defined(onEdit).vars)).toEqual(['retries', 'catalog', 'limits']);
    expect(defined(onEdit).vars.catalog).toBe(null);
  });
});
