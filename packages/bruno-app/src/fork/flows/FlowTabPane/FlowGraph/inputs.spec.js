import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import FlowGraph from './index';

/**
 * 002 §5.6 — the inputs panel: what a run starts from, drawn as the graph's leftmost box.
 *
 * The panel has two modes and one rule separating them: `onParamChange` is present while the tab
 * shows the flow as it stands, and absent once it shows a run. A run's inputs are a fact about that
 * run, so a box you could type into would be saying something untrue.
 */

const theme = themes.dark || Object.values(themes)[0];

const node = (id, rank) => ({
  id,
  kind: 'operation',
  operation: { api: 'backend', method: 'POST', path: '/login' },
  outputs: [],
  markers: { conditional: false, allowsErrorStatus: false, usesSharedSlot: false },
  position: { line: 1, column: 1 },
  rank
});

const described = ({ params = [], vars = [] } = {}) => ({
  id: 'login.flow.yml',
  name: 'Login',
  isLibrary: true,
  params,
  vars,
  apis: [],
  nodes: [node('login', 0)],
  edges: [],
  slots: [],
  stages: [],
  diagnostics: []
});

const renderGraph = (props) =>
  render(
    <ThemeProvider theme={theme}>
      <FlowGraph
        description={described(props.description)}
        nodeStates={{}}
        diagnostics={[]}
        selectedStep={undefined}
        expandedSubflows={[]}
        onSelectStep={() => {}}
        onToggleSubflow={() => {}}
        showDataEdges
        showSlotEdges={false}
        running={false}
        paramValues={props.paramValues}
        varValues={props.varValues}
        onParamChange={props.onParamChange}
      />
    </ThemeProvider>
  );

describe('the inputs panel', () => {
  const params = [
    { name: 'email', required: true, secret: false },
    { name: 'password', required: true, secret: true }
  ];

  it('is absent from a flow that declares no params and no vars', () => {
    renderGraph({ description: {}, onParamChange: () => {} });

    expect(screen.queryByTestId('flow-inputs')).not.toBeInTheDocument();
  });

  it('lists the declared params and vars together', () => {
    renderGraph({
      description: { params, vars: [{ name: 'orderId', expression: '{{$guid}}' }] },
      paramValues: {},
      onParamChange: () => {}
    });

    expect(screen.getByTestId('flow-inputs')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.getByText('orderId')).toBeInTheDocument();
    expect(screen.getByText('{{$guid}}')).toBeInTheDocument();
  });

  it('edits a param while the tab shows the flow as it stands', () => {
    const onParamChange = jest.fn();
    renderGraph({ description: { params }, paramValues: { email: 'qa@example.com' }, onParamChange });

    const input = screen.getByTestId('flow-input-email');
    expect(input).toHaveValue('qa@example.com');

    fireEvent.change(input, { target: { value: 'other@example.com' } });
    expect(onParamChange).toHaveBeenCalledWith('email', 'other@example.com');
  });

  /** A declared secret is not shown while it is typed, the way any password field is not. */
  it('masks a secret param as it is entered', () => {
    renderGraph({ description: { params }, paramValues: {}, onParamChange: () => {} });

    expect(screen.getByTestId('flow-input-password')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('flow-input-email')).toHaveAttribute('type', 'text');
  });

  /** §10: with a run open the panel reports rather than accepts — no inputs at all. */
  it('shows a run\'s values as text once a run is open', () => {
    renderGraph({
      description: { params },
      paramValues: { email: 'qa@example.com', password: '••••' }
    });

    expect(screen.getByTestId('flow-input-email')).toHaveTextContent('qa@example.com');
    expect(screen.getByTestId('flow-input-password')).toHaveTextContent('••••');
    expect(screen.getByTestId('flow-input-email').tagName).not.toBe('INPUT');
  });

  /**
   * §7.3 resolves vars per iteration, so a flow that has not run has only the expression to show —
   * and a run that has has the value it actually used, which is the whole point for `{{$guid}}`.
   */
  it('shows a var expression before a run and its resolved value after', () => {
    const vars = [{ name: 'runToken', expression: '{{$guid}}' }];

    const { unmount } = renderGraph({ description: { params, vars }, paramValues: {}, onParamChange: () => {} });
    expect(screen.getByTestId('flow-var-runToken')).toHaveTextContent('{{$guid}}');
    unmount();

    renderGraph({ description: { params, vars }, paramValues: {}, varValues: { runToken: 'abc-123' } });
    expect(screen.getByTestId('flow-var-runToken')).toHaveTextContent('abc-123');
  });

  /** An iteration whose vars were never recorded falls back to the expression rather than blanking. */
  it('falls back to the expression when a run recorded no vars', () => {
    renderGraph({
      description: { params, vars: [{ name: 'runToken', expression: '{{$guid}}' }] },
      paramValues: { email: 'qa@example.com' },
      varValues: undefined
    });

    expect(screen.getByTestId('flow-var-runToken')).toHaveTextContent('{{$guid}}');
  });

  /** A run recorded before inputs were says so, rather than reading as "nothing was supplied". */
  it('says a run predating the record is not recorded', () => {
    renderGraph({ description: { params }, paramValues: undefined });

    expect(screen.getByTestId('flow-input-email')).toHaveTextContent('not recorded');
  });

  /** A stored description written before §5.6 carries neither list, and must still draw. */
  it('draws a description that has no params or vars fields at all', () => {
    const legacy = described();
    delete legacy.params;
    delete legacy.vars;

    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={legacy}
          nodeStates={{}}
          diagnostics={[]}
          expandedSubflows={[]}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
          showDataEdges
          showSlotEdges={false}
          running={false}
        />
      </ThemeProvider>
    );

    expect(screen.queryByTestId('flow-inputs')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-graph')).toBeInTheDocument();
  });
});
