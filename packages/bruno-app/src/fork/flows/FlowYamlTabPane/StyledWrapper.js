import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* Whatever is inside scrolls within its own half — §5's graph or the editor. The pane itself never
     grows past the tab, which is the same rule §4.2's run view keeps. */
  overflow: hidden;

  .yaml-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
  }

  .yaml-filename {
    font-weight: 500;
  }

  /* The tab is marked (§4.3), and the view says the same thing where the editing happens. */
  .yaml-badge {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
  }

  .yaml-toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  .yaml-state {
    color: ${(props) => props.theme.colors.text.muted};

    &.dirty {
      color: ${(props) => props.theme.colors.text.yellow};
    }

    &.error {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .yaml-save {
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    padding: 0.125rem 0.5rem;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }

  .yaml-split {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* The graph is what absorbs spare room and scrolls inside it — §5.2 draws at its own size rather
     than scaling to fit, so this is the box that scrolls, in both directions. */
  .yaml-graph {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .yaml-split-handle {
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

  /* While dragging, the cursor outruns the 5px target — the whole split holds the gesture's cursor,
     and text selection under it would otherwise turn the drag into a highlight. */
  .yaml-split.is-dragging {
    cursor: row-resize;
    user-select: none;

    .yaml-split-handle {
      opacity: 1;
    }
  }

  /*
   * A definite height, handed down by the split, so CodeMirror is the scroller and keeps
   * virtualizing its lines rather than putting every line of the file in the DOM.
   *
   * The editor must fill that height exactly. Taller and it scrolls nothing — its own viewport is
   * bigger than the box showing it, so the lines past the fold are unreachable rather than scrolled
   * to; shorter and the box has dead space under it. Hiding the overflow is the backstop for the
   * first case: whatever the editor does with its height, it cannot escape the split.
   */
  .yaml-editor {
    flex: 0 0 auto;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};

    .CodeMirror {
      height: 100%;
    }
  }
`;

export default StyledWrapper;
