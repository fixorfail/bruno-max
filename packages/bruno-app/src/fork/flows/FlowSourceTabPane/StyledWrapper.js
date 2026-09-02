import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;

  .script-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
  }

  .script-filename {
    font-weight: 500;
  }

  .script-badge {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
  }

  .script-toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  .script-state {
    color: ${(props) => props.theme.colors.text.muted};

    &.dirty {
      color: ${(props) => props.theme.colors.text.yellow};
    }

    &.error {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .script-save {
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    padding: 0.125rem 0.5rem;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }

  /*
   * The editor takes the whole pane below the toolbar rather than a dragged half — there is no graph
   * to share the space with. It must fill that height exactly: taller and its own viewport outgrows
   * the box showing it, so the lines past the fold are unreachable rather than scrolled to.
   */
  .script-editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};

    .CodeMirror {
      height: 100%;
    }
  }
`;

export default StyledWrapper;
