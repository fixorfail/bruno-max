import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import FlowGraph from './index';

/**
 * 002 §5.6 — the exports panel: what a library hands back, drawn as the graph's rightmost box.
 *
 * It is the inputs panel at the other end of the flow, and the end is the point: a value enters at
 * rank 0 and leaves past the last rank, so a reader following the drawing left to right meets the
 * two in the order the run does. What each row shows is the same trade the vars row makes — the
 * reference the file declares until the run produces a value, and the value after that.
 */

const theme = themes.dark || Object.values(themes)[0];

const node = (id, rank) => ({
  id,
  kind: 'operation',
  operation: { api: 'auth', method: 'POST', path: '/login' },
  outputs: ['token'],
  markers: { conditional: false, allowsErrorStatus: false, usesSharedSlot: false },
  position: { line: 1, column: 1 },
  rank
});

const described = ({ params = [], vars = [], exports: exported = [] } = {}) => ({
  id: 'login.flow.yml',
  name: 'Login',
  isLibrary: true,
  params,
  vars,
  exports: exported,
  apis: [],
  nodes: [node('login', 0)],
  edges: [],
  slots: [],
  stages: [],
  diagnostics: []
});

const renderGraph = ({ description, nodeStates = {} } = {}) =>
  render(
    <ThemeProvider theme={theme}>
      <FlowGraph
        description={described(description)}
        nodeStates={nodeStates}
        diagnostics={[]}
        selectedStep={undefined}
        expandedSubflows={[]}
        onSelectStep={() => {}}
        onToggleSubflow={() => {}}
        showDataEdges
        showSlotEdges={false}
        running={false}
      />
    </ThemeProvider>
  );

const translationX = (element) => Number(/translate\(([-\d.]+),/.exec(element.getAttribute('transform'))[1]);

describe('the exports panel', () => {
  const exported = [
    { name: 'token', source: 'steps.login.token' },
    { name: 'userId', source: 'steps.login.userId' }
  ];

  const ended = {
    login: { state: 'success', attempts: 1, outputs: { token: 'tok_1', userId: 42 } }
  };

  it('is absent from a flow that exports nothing', () => {
    renderGraph({ description: {} });

    expect(screen.queryByTestId('flow-exports')).not.toBeInTheDocument();
  });

  it('lists every declared export', () => {
    renderGraph({ description: { exports: exported } });

    expect(screen.getByTestId('flow-exports')).toBeInTheDocument();
    expect(screen.getByText('token')).toBeInTheDocument();
    expect(screen.getByText('userId')).toBeInTheDocument();
  });

  /** The end of the drawing a value leaves by — and the opposite end from the one it entered at. */
  it('stands past the last rank, opposite the inputs', () => {
    renderGraph({
      description: { params: [{ name: 'email', required: true, secret: false }], exports: exported }
    });

    expect(translationX(screen.getByTestId('flow-inputs'))).toBeLessThan(0);
    expect(translationX(screen.getByTestId('flow-exports'))).toBeGreaterThan(0);
  });

  /** The viewBox is what clips: a panel outside it is a box the reader can never scroll to. */
  it('is inside the drawing the viewport scrolls', () => {
    renderGraph({ description: { exports: exported } });

    const panel = screen.getByTestId('flow-exports');
    const graph = screen.getByTestId('flow-graph');
    const [originX, , width] = graph.getAttribute('viewBox').split(' ').map(Number);
    const right = translationX(panel) + Number(panel.querySelector('.panel-box').getAttribute('width'));

    expect(right).toBeLessThanOrEqual(originX + width);
  });

  it('shows the reference the file declares before the run produces anything', () => {
    renderGraph({ description: { exports: exported } });

    expect(screen.getByTestId('flow-export-token')).toHaveTextContent('steps.login.token');
  });

  it('shows the value once the step behind it has ended', () => {
    renderGraph({ description: { exports: exported }, nodeStates: ended });

    expect(screen.getByTestId('flow-export-token')).toHaveTextContent('"tok_1"');
    expect(screen.getByTestId('flow-export-userId')).toHaveTextContent('42');
  });

  /**
   * A step that is still running has no value to report — the one it holds is the previous attempt's
   * where it is retrying — so the row says where the value will come from rather than what it is.
   */
  it('claims nothing while the producing step is still running', () => {
    renderGraph({
      description: { exports: exported },
      nodeStates: { login: { state: 'running', attempts: 1, outputs: { token: 'stale' } } }
    });

    expect(screen.getByTestId('flow-export-token')).toHaveTextContent('steps.login.token');
  });

  /** A step can end without producing its declared output (001 §14.6), and the row must not blank. */
  it('falls back to the reference when the step ended without the output', () => {
    renderGraph({
      description: { exports: exported },
      nodeStates: { login: { state: 'failed', attempts: 1, outputs: {} } }
    });

    expect(screen.getByTestId('flow-export-token')).toHaveTextContent('steps.login.token');
  });

  /** The reference stays reachable once the value has replaced it on the row. */
  it('keeps the reference on the row it resolved', () => {
    renderGraph({ description: { exports: exported }, nodeStates: ended });

    expect(screen.getByTestId('flow-export-token')).toHaveAttribute('title', 'steps.login.token');
  });

  /** A stored description written before §5.6 carries no list, and must still draw. */
  it('draws a description that has no exports field at all', () => {
    const legacy = described();
    delete legacy.exports;

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

    expect(screen.queryByTestId('flow-exports')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-graph')).toBeInTheDocument();
  });
});
