import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import DependsEditor, { readDepends, writeDepends } from './index';

const theme = themes.dark || Object.values(themes)[0];

/**
 * 005 §6.2, 001 §9.1 — every spelling of `depends:` reads into one shape and is written back in the
 * plainest spelling that still says the same thing.
 */

describe('reading and writing depends', () => {
  it('reads each form the file may use', () => {
    expect(readDepends(undefined)).toEqual({ join: 'all', entries: [], root: false });
    expect(readDepends([])).toEqual({ join: 'all', entries: [], root: true });
    expect(readDepends(['a', 'b'])).toEqual({ join: 'all', entries: [{ on: 'a', status: [] }, { on: 'b', status: [] }], root: false });
    expect(readDepends([{ on: 'a', status: ['failed'] }])).toEqual({ join: 'all', entries: [{ on: 'a', status: ['failed'] }], root: false });
    expect(readDepends({ any: [{ on: 'a' }, { on: 'b' }] })).toEqual({ join: 'any', entries: [{ on: 'a', status: [] }, { on: 'b', status: [] }], root: false });
    expect(readDepends({ all: ['a'] })).toEqual({ join: 'all', entries: [{ on: 'a', status: [] }], root: false });
  });

  it('writes the plainest spelling that means the same', () => {
    expect(writeDepends({ join: 'all', entries: [], root: false })).toBeUndefined();
    expect(writeDepends({ join: 'all', entries: [], root: true })).toEqual([]);
    expect(writeDepends({ join: 'all', entries: [{ on: 'a', status: [] }, { on: 'b', status: ['success'] }], root: false })).toEqual(['a', 'b']);
    expect(writeDepends({ join: 'all', entries: [{ on: 'a', status: ['failed'] }, { on: 'b', status: [] }], root: false })).toEqual([{ on: 'a', status: ['failed'] }, 'b']);
    expect(writeDepends({ join: 'any', entries: [{ on: 'a', status: [] }, { on: 'b', status: ['failed'] }], root: false })).toEqual({ any: [{ on: 'a' }, { on: 'b', status: ['failed'] }] });
  });

  it('round-trips each form', () => {
    for (const depends of [['a', 'b'], [{ on: 'a', status: ['failed', 'cancelled'] }], { any: [{ on: 'a' }, { on: 'b' }] }, []]) {
      expect(writeDepends(readDepends(depends))).toEqual(depends);
    }
  });
});

describe('the depends editor', () => {
  const model = {
    steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    vocabulary: { statuses: ['success', 'failed', 'skipped', 'cancelled'] }
  };
  const renderEditor = (depends, onPatch = jest.fn()) => {
    render(
      <ThemeProvider theme={theme}>
        <DependsEditor step={{ id: 'c', fields: depends === undefined ? {} : { depends } }} model={model} onPatch={onPatch} />
      </ThemeProvider>
    );
    return onPatch;
  };

  it('offers the other steps, not the step itself', () => {
    renderEditor(['a']);

    const options = [...screen.getByTestId('flow-step-depends-0-on').options].map((option) => option.value);
    expect(options).toEqual(['', 'a', 'b']);
  });

  it('adds a dependency as a bare list entry', () => {
    const onPatch = renderEditor(undefined);

    fireEvent.click(screen.getByTestId('flow-step-depends-add'));

    expect(onPatch).toHaveBeenCalledWith({ set: { depends: ['a'] } });
  });

  it('writes a status other than the default in the longer form', () => {
    const onPatch = renderEditor(['a']);

    fireEvent.click(screen.getByTestId('flow-step-depends-0-failed'));

    expect(onPatch).toHaveBeenCalledWith({ set: { depends: [{ on: 'a', status: ['success', 'failed'] }] } });
  });

  it('marks an explicit root, and unsets when neither a root nor a dependency', () => {
    const onPatch = renderEditor(undefined);

    fireEvent.click(screen.getByTestId('flow-step-depends-root'));
    expect(onPatch).toHaveBeenLastCalledWith({ set: { depends: [] } });

    const other = renderEditor([]);
    fireEvent.click(screen.getAllByTestId('flow-step-depends-root')[1]);
    expect(other).toHaveBeenLastCalledWith({ unset: ['depends'] });
  });

  it('switches the join once there is more than one', () => {
    const onPatch = renderEditor(['a', 'b']);

    fireEvent.change(screen.getByTestId('flow-step-depends-join'), { target: { value: 'any' } });

    expect(onPatch).toHaveBeenCalledWith({ set: { depends: { any: [{ on: 'a' }, { on: 'b' }] } } });
  });

  it('removes an entry, and the key with the last one', () => {
    const onPatch = renderEditor(['a']);

    fireEvent.click(screen.getByTestId('flow-step-depends-0-remove'));

    expect(onPatch).toHaveBeenCalledWith({ unset: ['depends'] });
  });
});
