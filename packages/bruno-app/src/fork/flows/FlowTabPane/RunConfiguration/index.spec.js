import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import { runFlow } from 'fork/flows/actions';
import RunConfiguration from './index';

/**
 * 002 §7.2's run configuration — the panel, and the fact that everything it edits reaches the engine.
 *
 * The second half is the point of the first: variable overrides and the dataset had complete
 * renderer→main→engine plumbing and no control anywhere, so both fields could only ever be
 * `undefined`.
 */

const theme = themes.dark || Object.values(themes)[0];

const description = (extras = {}) => ({
  isLibrary: false,
  params: [],
  dataset: undefined,
  diagnostics: [],
  ...extras
});

/**
 * The panel is controlled by the slice, so a test drives it the way the tab does: render, act,
 * re-render with what the change asked for.
 */
const renderPanel = ({ configuration = {}, described = description(), disabled = false } = {}) => {
  const onConfigurationChange = jest.fn();
  const view = render(
    <ThemeProvider theme={theme}>
      <RunConfiguration
        description={described}
        configuration={configuration}
        onConfigurationChange={onConfigurationChange}
        disabled={disabled}
      />
    </ThemeProvider>
  );

  return { ...view, onConfigurationChange };
};

const open = () => fireEvent.click(screen.getByTestId('flow-run-configuration-toggle'));

describe('the run configuration panel (§7.2)', () => {
  it('is shut until it is opened', () => {
    renderPanel();

    expect(screen.queryByTestId('flow-run-configuration')).not.toBeInTheDocument();
    open();
    expect(screen.getByTestId('flow-run-configuration')).toBeInTheDocument();
  });

  /** Counts rather than values: a summary spelling out an override puts a token on a shared screen. */
  it('says how much it is holding while it is shut, without saying what', () => {
    renderPanel({
      configuration: {
        concurrency: 4,
        dataset: './rows.csv',
        variableOverrides: [{ name: 'token', value: 'sk-live-1' }, { name: '', value: '' }]
      }
    });

    const summary = screen.getByTestId('flow-run-configuration-summary');
    expect(summary).toHaveTextContent('1 variable');
    expect(summary).toHaveTextContent('dataset');
    expect(summary).toHaveTextContent('concurrency 4');
    expect(summary).not.toHaveTextContent('sk-live-1');
  });

  describe('variable overrides', () => {
    it('adds a row, and edits its name and value', () => {
      const { onConfigurationChange, rerender } = renderPanel();
      open();

      fireEvent.click(screen.getByTestId('flow-config-variable-add'));
      expect(onConfigurationChange).toHaveBeenCalledWith({ variableOverrides: [{ name: '', value: '' }] });

      // The slice owns the value, so the panel comes back with the row the change asked for. It
      // stays open across that, which is what makes adding a second row a second click and not four.
      rerender(
        <ThemeProvider theme={theme}>
          <RunConfiguration
            description={description()}
            configuration={{ variableOverrides: [{ name: '', value: '' }] }}
            onConfigurationChange={onConfigurationChange}
          />
        </ThemeProvider>
      );
      fireEvent.change(screen.getByTestId('flow-config-variable-name-0'), { target: { value: 'token' } });

      expect(onConfigurationChange).toHaveBeenLastCalledWith({
        variableOverrides: [{ name: 'token', value: '' }]
      });
    });

    it('removes the row that was asked for', () => {
      const { onConfigurationChange } = renderPanel({
        configuration: { variableOverrides: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] }
      });
      open();

      fireEvent.click(screen.getByTestId('flow-config-variable-remove-0'));

      expect(onConfigurationChange).toHaveBeenCalledWith({ variableOverrides: [{ name: 'b', value: '2' }] });
    });
  });

  it('edits the dataset and the concurrency', () => {
    const { onConfigurationChange } = renderPanel();
    open();

    fireEvent.change(screen.getByTestId('flow-config-dataset'), { target: { value: './rows.csv' } });
    expect(onConfigurationChange).toHaveBeenLastCalledWith({ dataset: './rows.csv' });

    fireEvent.change(screen.getByTestId('flow-config-concurrency'), { target: { value: '3' } });
    expect(onConfigurationChange).toHaveBeenLastCalledWith({ concurrency: 3 });
  });

  /** 001 §9.4 lets an override supply a dataset to a flow with none, so the box is offered either way. */
  it('offers a dataset to a flow that declares none', () => {
    renderPanel();
    open();

    expect(screen.getByTestId('flow-config-dataset')).toHaveAttribute('placeholder', 'no dataset');
  });

  /** An empty box is the flow's own dataset, so the declared source is what the box stands in for. */
  it('names the declared dataset as what an empty box means', () => {
    renderPanel({ described: description({ dataset: { source: './orders.csv', parallel: 1 } }) });
    open();

    expect(screen.getByTestId('flow-config-dataset')).toHaveAttribute('placeholder', './orders.csv');
  });

  /** §7.2: Parameters are shown for any flow that declares them, library or not. */
  describe('parameters', () => {
    const library = description({
      isLibrary: true,
      params: [
        { name: 'email', required: true, secret: false },
        { name: 'password', required: false, secret: true }
      ]
    });

    it('is absent for a flow that declares none', () => {
      renderPanel();
      open();

      expect(screen.queryByTestId('flow-config-params')).not.toBeInTheDocument();
    });

    /**
     * `library: true` says a flow is meant to be called by another one, not that it is the only kind
     * that takes params — and the run this panel configures is refused without them either way.
     */
    it('offers the boxes to a flow that declares params and is not a library', () => {
      renderPanel({ described: description({ params: [{ name: 'tenant', required: true, secret: false }] }) });
      open();

      expect(screen.getByTestId('flow-config-params')).toBeInTheDocument();
      expect(screen.getByTestId('flow-config-param-tenant')).toBeInTheDocument();
    });

    it('counts the params it is holding for a flow that is not a library', () => {
      renderPanel({
        described: description({ params: [{ name: 'tenant', required: true, secret: false }] }),
        configuration: { params: { tenant: 'acme' } }
      });

      const summary = screen.getByTestId('flow-run-configuration-summary');
      expect(summary).toHaveTextContent('1 param');
      expect(summary).not.toHaveTextContent('acme');
    });

    it('edits the same params the inputs node does', () => {
      const { onConfigurationChange } = renderPanel({ described: library });
      open();

      fireEvent.change(screen.getByTestId('flow-config-param-email'), { target: { value: 'qa@example.com' } });

      expect(onConfigurationChange).toHaveBeenCalledWith({ params: { email: 'qa@example.com' } });
    });

    /** 001 §14.4 masks a secret param in the capture; the box it is typed into does the same. */
    it('masks a secret param as it is typed', () => {
      renderPanel({ described: library });
      open();

      expect(screen.getByTestId('flow-config-param-password')).toHaveAttribute('type', 'password');
      expect(screen.getByTestId('flow-config-param-email')).toHaveAttribute('type', 'text');
    });
  });

  /** A run's configuration is what it was started with; changing it mid-run would change nothing. */
  it('is not editable while the flow is running', () => {
    renderPanel({ configuration: { variableOverrides: [{ name: 'a', value: '1' }] }, disabled: true });
    open();

    expect(screen.getByTestId('flow-config-dataset')).toBeDisabled();
    expect(screen.getByTestId('flow-config-concurrency')).toBeDisabled();
    expect(screen.getByTestId('flow-config-variable-name-0')).toBeDisabled();
  });
});

/**
 * The half that made the panel worth building: 002 §11.3's `RunRequest` carries both fields, and
 * before this nothing could put a value in either.
 */
describe('what the panel sends to the engine (§11.3)', () => {
  const flow = { pathname: '/w/flows/checkout.flow.yml', workspaceRoot: '/w' };

  const runWith = async (configuration) => {
    const invoke = jest.fn().mockResolvedValue({ runId: 'run-1' });
    window.ipcRenderer = { invoke };
    const getState = () => ({
      collections: { collections: [] },
      globalEnvironments: { globalEnvironments: [], activeGlobalEnvironmentUid: undefined }
    });

    await runFlow({ flow, configuration })(jest.fn(), getState);
    return invoke.mock.calls.find(([channel]) => channel === 'renderer:flow-run')[1];
  };

  it('sends the overrides as the tier the engine merges, unflattened by anything else', async () => {
    const request = await runWith({
      variableOverrides: [{ name: 'token', value: 'abc' }, { name: 'host', value: 'https://staging' }]
    });

    expect(request.tiers.envVarOverrides).toEqual({ token: 'abc', host: 'https://staging' });
  });

  /** A row with no name is one somebody is still typing, not an override of the empty string. */
  it('drops a row whose name was never typed', async () => {
    const request = await runWith({ variableOverrides: [{ name: '  ', value: 'abc' }] });

    expect(request.tiers.envVarOverrides).toBeUndefined();
  });

  it('sends the dataset and the concurrency as overrides', async () => {
    const request = await runWith({ dataset: './rows.csv', concurrency: 3 });

    expect(request.overrides).toMatchObject({ dataset: './rows.csv', concurrency: 3 });
  });
});
