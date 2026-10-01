import React from 'react';

jest.mock('components/EditableTable', () => jest.requireActual('../EditableTableStandIn').default);

import { act, fireEvent, render, screen } from '@testing-library/react';
import ExportsTab from './index';

/**
 * 001 §12.1's `exports:` as a table. One `exports.define` commits the full block. The tab suggests
 * the references that the engine's description shows the flow can export.
 */

const EXPORTS = [
  { name: 'token', source: 'steps.login.token' },
  { name: 'userId', source: 'steps.login.userId' }
];

const DESCRIPTION = {
  nodes: [
    { id: 'login', outputs: ['token', 'userId'] },
    { id: 'auth', uses: './shared/auth.flow.yml', outputs: ['session'], exports: [{ name: 'session', source: 'steps.inner.session' }, { name: 'role', source: 'shared.role' }] },
    { id: 'auth.inner', parent: 'auth', outputs: ['session'] }
  ],
  slots: [{ name: 'chargeId' }]
};

const renderTab = (exports = EXPORTS, description = DESCRIPTION) => {
  const onEdit = jest.fn();
  render(<ExportsTab exports={exports} description={description} onEdit={onEdit} />);
  return onEdit;
};

const sources = () => screen.getAllByPlaceholderText('steps.<step>.<output> or shared.<slot>');
const commit = async () => {
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
};

describe('the flow settings\' Exports tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows each export as written', () => {
    renderTab();

    expect(screen.getAllByLabelText('name').map((input) => input.value)).toEqual(['token', 'userId']);
    expect(sources().map((input) => input.value)).toEqual(['steps.login.token', 'steps.login.userId']);
  });

  it('writes the whole block as one edit when a source changes', async () => {
    const onEdit = renderTab();

    fireEvent.change(sources()[1], { target: { value: 'shared.chargeId' } });
    await commit();

    expect(onEdit).toHaveBeenCalledWith([
      { kind: 'exports.define', exports: { token: 'steps.login.token', userId: 'shared.chargeId' } }
    ]);
  });

  it('removes the block with its last export', async () => {
    const onEdit = renderTab([{ name: 'token', source: 'steps.login.token' }]);

    fireEvent.change(screen.getByLabelText('name'), { target: { value: '' } });
    fireEvent.change(sources()[0], { target: { value: '' } });
    await commit();

    expect(onEdit).toHaveBeenLastCalledWith([{ kind: 'exports.define', exports: {} }]);
  });

  it('suggests every top-level output, a library\'s exports and every slot, and not a sub-flow\'s own steps', () => {
    renderTab();

    const suggested = [...screen.getByTestId('flow-settings-export-suggestions').querySelectorAll('option')].map((option) => option.value);
    expect(suggested).toEqual([
      'steps.login.token',
      'steps.login.userId',
      'steps.auth.session',
      'steps.auth.role',
      'shared.chargeId'
    ]);
    expect(sources()[0]).toHaveAttribute('list', 'flow-settings-export-sources');
  });

  it('lists an opaque export under the table, and sends it back by name at its place', async () => {
    const onEdit = renderTab([{ name: 'token', source: '', opaque: true }, { name: 'userId', source: 'steps.login.userId' }]);

    expect(screen.getByTestId('flow-settings-export-opaque-token')).toBeInTheDocument();
    fireEvent.change(sources()[0], { target: { value: 'steps.login.id' } });
    await commit();

    expect(Object.entries(onEdit.mock.calls.at(-1)[0][0].exports)).toEqual([['token', ''], ['userId', 'steps.login.id']]);
  });
});
