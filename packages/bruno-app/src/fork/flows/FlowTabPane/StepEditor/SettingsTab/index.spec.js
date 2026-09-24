import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SettingsTab from './index';

/**
 * 005 §6.5 — the flags are three-state, and *inherit* deletes the key rather than writing the
 * default. The silent-override case, in both directions.
 */
describe('the settings tab', () => {
  const renderTab = (fields, onPatch = jest.fn()) => {
    render(<SettingsTab step={{ id: 'a', fields, opaque: [] }} onPatch={onPatch} />);
    return onPatch;
  };

  it('B4.2 reads an absent key as inherit, not as the default', () => {
    renderTab({ validateSchema: false });

    expect(screen.getByTestId('flow-step-flag-failOnStatusCode')).toHaveValue('inherit');
    expect(screen.getByTestId('flow-step-flag-validateSchema')).toHaveValue('off');
  });

  it('writes on and off, and deletes the key for inherit', () => {
    const onPatch = renderTab({ failOnStatusCode: true });

    fireEvent.change(screen.getByTestId('flow-step-flag-failOnStatusCode'), { target: { value: 'off' } });
    expect(onPatch).toHaveBeenLastCalledWith({ set: { failOnStatusCode: false } });

    fireEvent.change(screen.getByTestId('flow-step-flag-failOnStatusCode'), { target: { value: 'inherit' } });
    expect(onPatch).toHaveBeenLastCalledWith({ unset: ['failOnStatusCode'] });

    fireEvent.change(screen.getByTestId('flow-step-flag-strictSchema'), { target: { value: 'on' } });
    expect(onPatch).toHaveBeenLastCalledWith({ set: { strictSchema: true } });
  });
});
