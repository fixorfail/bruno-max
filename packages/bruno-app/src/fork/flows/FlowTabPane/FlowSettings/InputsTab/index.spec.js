import React from 'react';

jest.mock('components/EditableTable', () => jest.requireActual('../EditableTableStandIn').default);

import { act, fireEvent, render, screen } from '@testing-library/react';
import InputsTab from './index';

/**
 * 001 §12.1's `params:` as a table. One `params.define` commits the full block, and a row that nobody
 * changed goes back as the model read it.
 */

const PARAMS = [
  { name: 'email', required: true },
  { name: 'password', required: false, default: '{{testUserPassword}}' },
  { name: 'retries', default: 3 }
];

const renderTab = (params = PARAMS, { isLibrary = true } = {}) => {
  const onEdit = jest.fn();
  render(<InputsTab params={params} isLibrary={isLibrary} onEdit={onEdit} />);
  return onEdit;
};

const cells = (label) => screen.getAllByLabelText(label);
const commit = async () => {
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
};
const defined = (onEdit) => onEdit.mock.calls.at(-1)[0][0];

describe('the flow settings\' Inputs tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows each param as written', () => {
    renderTab();

    expect(cells('name').map((input) => input.value)).toEqual(['email', 'password', 'retries']);
    expect(cells('default').map((input) => input.value)).toEqual(['', '{{testUserPassword}}', '3']);
    expect(screen.getAllByRole('checkbox').map((box) => box.checked)).toEqual([true, false, false, false, false, false]);
  });

  it('writes a ticked flag, and hands back every other param as the file wrote it', async () => {
    const onEdit = renderTab();

    fireEvent.click(screen.getAllByRole('checkbox')[5]);
    await commit();

    expect(defined(onEdit)).toEqual({
      kind: 'params.define',
      params: {
        email: { required: true },
        password: { required: false, default: '{{testUserPassword}}' },
        retries: { default: 3, secret: true }
      }
    });
  });

  it('removes a flag and a default when they are cleared, rather than writing their defaults', async () => {
    const onEdit = renderTab();

    const [emailRequired] = screen.getAllByRole('checkbox');
    fireEvent.click(emailRequired);
    fireEvent.change(cells('default')[1], { target: { value: '' } });
    await commit();

    expect(defined(onEdit).params).toEqual({ email: {}, password: { required: false }, retries: { default: 3 } });
  });

  it('renames a param in its place', async () => {
    const onEdit = renderTab();

    fireEvent.change(cells('name')[0], { target: { value: 'login' } });
    await commit();

    expect(Object.keys(defined(onEdit).params)).toEqual(['login', 'password', 'retries']);
  });

  it('carries a row typed before its name, and writes it once it has one', async () => {
    const onEdit = renderTab([]);

    fireEvent.click(screen.getByText('add'));
    fireEvent.change(cells('default')[0], { target: { value: 'qa@example.com' } });
    await commit();
    // The block cannot hold the row yet, but the row stays in the table until it gets a name.
    expect(defined(onEdit).params).toEqual({});
    expect(cells('default')[0]).toHaveValue('qa@example.com');

    fireEvent.change(cells('name')[0], { target: { value: 'email' } });
    await commit();
    expect(defined(onEdit).params).toEqual({ email: { default: 'qa@example.com' } });
  });

  it('lists an opaque param under the table, and sends it back by name at its place', async () => {
    const onEdit = renderTab([{ name: 'email', opaque: true }, { name: 'password' }]);

    expect(cells('name').map((input) => input.value)).toEqual(['password']);
    expect(screen.getByTestId('flow-settings-param-opaque-email')).toBeInTheDocument();

    fireEvent.change(cells('name')[0], { target: { value: 'secret' } });
    await commit();

    expect(Object.entries(defined(onEdit).params)).toEqual([['email', {}], ['secret', {}]]);
  });

  it('does not write a row over an opaque param of the same name', async () => {
    const onEdit = renderTab([{ name: 'email', opaque: true }, { name: 'password' }]);

    fireEvent.change(cells('name')[0], { target: { value: 'email' } });
    await commit();

    expect(defined(onEdit).params).toEqual({ email: {} });
  });

  it('says when a required param with no default makes a flow unsafe to run on its own', () => {
    renderTab(PARAMS, { isLibrary: false });
    expect(screen.getByTestId('flow-settings-params-library-hint')).toBeInTheDocument();
  });

  it('says nothing about it for a library', () => {
    renderTab(PARAMS, { isLibrary: true });
    expect(screen.queryByTestId('flow-settings-params-library-hint')).not.toBeInTheDocument();
  });
});
