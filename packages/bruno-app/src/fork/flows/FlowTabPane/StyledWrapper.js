import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;

  .flow-toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.375rem 1rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};

    label {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
  }

  .flow-loading,
  .flow-error {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .flow-error {
    color: ${(props) => props.theme.colors.text.danger};
  }

  /* Graph over step detail, with the handle between them. This is the box the drag clamps against,
     so the toolbar and the diagnostics sit outside it and never count toward either minimum. */
  .flow-split {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .flow-split-handle {
    flex: 0 0 auto;
    height: 5px;
    cursor: row-resize;
    background: ${(props) => props.theme.sidebar.collection.item.focusBorder};
    opacity: 0.35;
    transition: opacity 0.1s ease-in-out;

    &:hover {
      opacity: 1;
    }
  }

  /* While dragging, the cursor outruns the 5px target — the whole pane holds the gesture's cursor,
     and text selection under it would otherwise turn the drag into a highlight. */
  &.is-dragging,
  .flow-split.is-dragging {
    cursor: row-resize;
    user-select: none;
  }

  .flow-split.is-dragging .flow-split-handle {
    opacity: 1;
  }

  .flow-diagnostics {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    max-height: 10rem;
    overflow: auto;
  }

  .diagnostic-counts {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 0.25rem;

    /* The run's own, which are neither the file's errors nor its warnings. */
    .run-diagnostics-label {
      color: ${(props) => props.theme.colors.text.muted};
    }

    .error {
      color: ${(props) => props.theme.colors.text.danger};
    }

    .warning {
      color: ${(props) => props.theme.colors.text.warning};
    }
  }

  .diagnostic {
    display: flex;
    gap: 0.5rem;
    padding: 0.0625rem 0;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .diagnostic.error .diagnostic-code {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .diagnostic.warning .diagnostic-code {
    color: ${(props) => props.theme.colors.text.warning};
  }

  .diagnostic-line {
    margin-left: auto;
  }

  /* §6's warnings: a count at the end of the toolbar, its list one hover away. Right-aligned by the
     row rather than placed over the graph, so it keeps its distance from the drawing whatever the
     drawing does. Positioned only so the list has something to hang from. */
  .flow-warnings {
    position: relative;
    margin-left: auto;
    color: ${(props) => props.theme.colors.text.warning};
    cursor: default;
  }

  .flow-warnings-count {
    border-bottom: 1px dotted currentColor;
  }

  .flow-warnings-list {
    display: none;
    position: absolute;
    /* Below its own count, and over the graph beneath the toolbar — which needs the stacking order
       stated, because the graph comes after this in the document. */
    top: 100%;
    margin-top: 0.25rem;
    z-index: 2;
    /* Opening leftward: the count is already at the right edge, and a panel that grew rightward
       would open off the tab. */
    right: 0;
    width: max-content;
    /* Wide enough for a rule and its message on one line, and never wider than the graph it covers,
       whose room is the thing this whole arrangement is protecting. */
    max-width: min(32rem, 80vw);
    padding: 0.5rem 0.75rem;
    background: ${(props) => props.theme.sidebar.collection.item.bg};
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
  }

  /* Focus as well as hover, so the list is reachable from the keyboard rather than pointer-only. */
  .flow-warnings:hover .flow-warnings-list,
  .flow-warnings:focus-within .flow-warnings-list {
    display: block;
  }

  .flow-warnings-list .diagnostic {
    /* The panel is the one place a diagnostic wraps rather than being cut: it is as wide as it gets
       here, and a message trimmed at the edge of a hover is a message nobody can finish reading. */
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.5rem;
    align-items: baseline;
  }
`;

export default StyledWrapper;
