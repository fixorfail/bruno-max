import styled from 'styled-components';

/**
 * §5.3's edge treatments are the load-bearing part of this stylesheet: an implicit sequence edge is
 * muted where a declared one is not, and a data edge is dashed. Drawing them identically would hide
 * the one thing about 001 §9.1 that surprises authors.
 */
const StyledWrapper = styled.div`
  overflow-x: auto;
  padding: 1rem;

  .flow-graph {
    max-width: 100%;
  }

  #flow-arrow path {
    fill: ${(props) => props.theme.colors.text.muted};
  }

  .edge path {
    fill: none;
    stroke: ${(props) => props.theme.colors.text.muted};
    stroke-width: 1.5;
  }

  .edge-path-anchor {
    stroke: none;
    fill: none;
  }

  .edge-sequence path {
    opacity: 0.45;
  }

  .edge-data path {
    stroke-dasharray: 4 3;
  }

  .edge-undeclared path {
    stroke: ${(props) => props.theme.colors.text.warning};
  }

  .edge-slot path {
    stroke-dasharray: 2 3;
  }

  .edge-label {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
  }

  .node {
    cursor: pointer;
  }

  .node-box {
    fill: ${(props) => props.theme.sidebar.collection.item.bg};
    stroke: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    stroke-width: 1;
  }

  .node.selected .node-box {
    stroke: ${(props) => props.theme.colors.text.purple};
    stroke-width: 2;
  }

  .node[data-status='running'] .node-box,
  .node[data-status='retrying'] .node-box {
    stroke: ${(props) => props.theme.colors.text.yellow};
    stroke-width: 2;
  }

  .node[data-status='success'] .node-box {
    stroke: ${(props) => props.theme.colors.text.green};
  }

  .node[data-status='failed'] .node-box {
    stroke: ${(props) => props.theme.colors.text.danger};
  }

  .node[data-status='skipped'] .node-box,
  .node[data-status='cancelled'] .node-box {
    opacity: 0.55;
  }

  .node-id {
    fill: ${(props) => props.theme.colors.text.subtext2};
    font-size: 12px;
    font-weight: 500;
  }

  .node-operation,
  .node-status,
  .node-attempts,
  .node-marker {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 10px;
  }

  .node-badge.error {
    fill: ${(props) => props.theme.colors.text.danger};
  }

  .node-badge.warning {
    fill: ${(props) => props.theme.colors.text.warning};
  }

  .slot rect {
    fill: none;
    stroke: ${(props) => props.theme.colors.text.muted};
    stroke-dasharray: 3 2;
  }

  .slot text {
    fill: ${(props) => props.theme.colors.text.muted};
    font-size: 14px;
  }
`;

export default StyledWrapper;
