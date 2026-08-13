import styled from 'styled-components';

const StyledWrapper = styled.div`
  .flows-empty {
    padding: 0.25rem 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-group-label {
    padding: 0.25rem 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .flow-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0.75rem 0.1875rem 1.5rem;
    cursor: pointer;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  .flow-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .flow-tag {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.625rem;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
  }

  /* §4.1: ambient run status on the row, so a run you walked away from is still reported. */
  .flow-run-mark {
    margin-left: auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${(props) => props.theme.colors.text.muted};

    &.passed {
      background: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      background: ${(props) => props.theme.colors.text.danger};
    }

    &.running {
      background: ${(props) => props.theme.colors.text.yellow};
    }
  }
`;

export default StyledWrapper;
