import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  border-top: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
  min-height: 14rem;
  overflow: hidden;

  .detail-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
  }

  .detail-step {
    font-weight: 500;
  }

  .detail-status {
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};

    &.success {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .detail-duration {
    margin-left: auto;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .detail-tabs,
  .detail-attempts {
    display: flex;
    gap: 0.25rem;
    padding: 0 1rem;

    button {
      padding: 0.125rem 0.5rem;
      font-size: 0.75rem;
      color: ${(props) => props.theme.colors.text.muted};
      border-bottom: 2px solid transparent;

      &.active {
        color: ${(props) => props.theme.colors.text.subtext2};
        border-bottom-color: ${(props) => props.theme.colors.text.purple};
      }
    }
  }

  .detail-body-area {
    padding: 0.75rem 1rem;
    overflow: auto;
  }

  .detail-row {
    display: flex;
    gap: 0.5rem;
    font-size: 0.75rem;
    padding: 0.0625rem 0;
  }

  .detail-label {
    color: ${(props) => props.theme.colors.text.muted};
    min-width: 8rem;
  }

  .detail-value {
    word-break: break-all;
  }

  .detail-empty {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  /* The body is the pane's last element (§9), so it takes the room that is left rather than a
     fixed height — CodeMirror sizes to its content and scrolls inside this box. */
  .detail-body {
    margin-top: 0.5rem;
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    overflow: auto;
    max-height: 24rem;

    .CodeMirror {
      background: transparent;
      height: auto;
    }
  }

  .detail-parts {
    margin-top: 0.5rem;
  }

  .detail-table {
    font-size: 0.75rem;
    width: 100%;

    td {
      padding: 0.125rem 0.5rem 0.125rem 0;
      vertical-align: top;
    }

    tr.passed td:first-child {
      color: ${(props) => props.theme.colors.text.green};
    }

    tr.failed td:first-child {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .detail-outputs {
    margin-top: 0.75rem;
  }
`;

export default StyledWrapper;
