import React, { useMemo } from 'react';
import { layoutGraph } from './layout';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §5 — the graph, as hand-rolled inline SVG.
 *
 * Nothing here computes flow semantics: `describeFlow` supplies nodes, edges and ranks, `layout.js`
 * turns ranks into coordinates, and the run's node states come from `FlowEvent`s. §13 records what
 * declining a graph library trades away.
 */

/** §5.1's markers, each shown only when the step carries the thing it marks. */
const markersFor = (node) => {
  const markers = [];
  if (node.markers.conditional) markers.push({ key: 'when', glyph: 'when', title: 'Conditional (when:)' });
  if (node.markers.retryMaxAttempts) {
    markers.push({ key: 'retry', glyph: `↻ ${node.markers.retryMaxAttempts}`, title: 'Retries' });
  }
  if (node.kind === 'subflow') markers.push({ key: 'subflow', glyph: '⊂', title: 'Sub-flow' });
  // A step that passes on a 403 is otherwise indistinguishable from one that passes on a 200, and
  // mistaking the first for the second is how a broken authorization check reads as green (§5.1).
  if (node.markers.allowsErrorStatus) markers.push({ key: 'negative', glyph: '!', title: 'Negative test' });
  if (node.markers.usesSharedSlot) markers.push({ key: 'slot', glyph: '⌸', title: 'Uses a shared slot' });
  return markers;
};

/**
 * §5.3: five drawing treatments over four `kind` values. A status-conditioned edge is a `depends`
 * edge with a non-empty `status`, and switching on `kind` alone would draw it as an ordinary one —
 * which is the mistake 002-C U1.3 exists to catch.
 */
const edgeClassName = (edge) => {
  if (edge.kind === 'slot-read' || edge.kind === 'slot-write') return 'edge edge-slot';
  if (edge.kind === 'data') return edge.declared === false ? 'edge edge-data edge-undeclared' : 'edge edge-data';
  if (edge.status && edge.status.length) return 'edge edge-conditional';
  return edge.kind === 'sequence' ? 'edge edge-sequence' : 'edge edge-depends';
};

const edgeLabel = (edge) => {
  if (edge.kind === 'data') return edge.output;
  if (edge.status && edge.status.length) return `[${edge.status.join(', ')}]`;
  return undefined;
};

const FlowGraph = ({ description, nodeStates, diagnostics, selectedStep, expandedSubflows, onSelectStep, onToggleSubflow, showDataEdges }) => {
  const graph = useMemo(
    () => layoutGraph(description, { expandedSubflows }),
    [description, expandedSubflows]
  );

  const badgedSteps = useMemo(() => {
    const byStep = {};
    for (const diagnostic of diagnostics) {
      if (diagnostic.stepId) {
        byStep[diagnostic.stepId] = diagnostic.severity === 'error' ? 'error' : byStep[diagnostic.stepId] || 'warning';
      }
    }
    return byStep;
  }, [diagnostics]);

  const edges = showDataEdges ? graph.edges : graph.edges.filter((edge) => edge.kind !== 'data');

  return (
    <StyledWrapper>
      <svg
        className="flow-graph"
        viewBox={`-8 -8 ${graph.width + 16} ${graph.height + 16}`}
        width={graph.width + 16}
        height={graph.height + 16}
        data-testid="flow-graph"
      >
        <defs>
          <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>

        {edges.map((edge, index) => {
          const label = edgeLabel(edge);
          return (
            <g key={`${edge.from}-${edge.to}-${edge.kind}-${index}`} className={edgeClassName(edge)}>
              <path d={edge.path} markerEnd="url(#flow-arrow)" />
              {label ? (
                <text className="edge-label" dy="-4">
                  <textPath href={`#edge-path-${index}`} startOffset="50%">
                    {label}
                  </textPath>
                </text>
              ) : null}
              <path id={`edge-path-${index}`} d={edge.path} className="edge-path-anchor" />
            </g>
          );
        })}

        {graph.slots.map((slot) => (
          <g key={slot.id} className="slot" transform={`translate(${slot.x}, ${slot.y})`}>
            <rect width={slot.width} height={slot.height} rx="4" />
            <text x={slot.width / 2} y={slot.height / 2} textAnchor="middle" dominantBaseline="middle">
              ⌸
            </text>
            <title>{`shared slot: ${slot.name}`}</title>
          </g>
        ))}

        {graph.nodes.map((node) => {
          const state = nodeStates[node.id];
          return (
            <g
              key={node.id}
              className={`node ${node.id === selectedStep ? 'selected' : ''}`}
              transform={`translate(${node.x}, ${node.y})`}
              data-testid={`flow-node-${node.id}`}
              data-status={state?.state || 'pending'}
              onClick={() => onSelectStep(node.id)}
              onDoubleClick={() => (node.kind === 'subflow' ? onToggleSubflow(node.id) : undefined)}
            >
              <rect className="node-box" width={node.width} height={node.height} rx="4" />
              <text className="node-id" x="10" y="20">
                {node.name || node.id}
              </text>
              <text className="node-operation" x="10" y="38">
                {node.operation ? `${node.operation.method} ${node.operation.path}` : node.uses}
              </text>
              <text className="node-status" x="10" y="55">
                {/* §8.2: the reason is on the node, not behind a click — the four skip reasons are
                    the substance of a run's outcome. */}
                {state ? [state.state, state.reason].filter(Boolean).join(' · ') : ''}
              </text>
              {state?.state === 'retrying' && node.markers.retryMaxAttempts ? (
                <text className="node-attempts" x={node.width - 10} y="55" textAnchor="end">
                  {`attempt ${state.attempt}/${node.markers.retryMaxAttempts}`}
                </text>
              ) : null}
              {badgedSteps[node.id] ? (
                <circle className={`node-badge ${badgedSteps[node.id]}`} cx={node.width - 10} cy="12" r="5" />
              ) : null}
              {markersFor(node).map((marker, index) => (
                <text key={marker.key} className="node-marker" x={node.width - 12 - index * 22} y="24" textAnchor="end">
                  {marker.glyph}
                  <title>{marker.title}</title>
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </StyledWrapper>
  );
};

export default FlowGraph;
