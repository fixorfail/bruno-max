import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};

  .run-control {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .run-control.cancel {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .run-option {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;

    input[type='number'],
    input[type='text'] {
      width: 5rem;
      padding: 0.125rem 0.25rem;
      background: ${(props) => props.theme.sidebar.collection.item.bg};
      border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
      border-radius: 3px;
    }

    .required {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .run-summary {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .run-status {
    text-transform: uppercase;
    letter-spacing: 0.04em;

    &.passed {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.cancelled {
      color: ${(props) => props.theme.colors.text.warning};
    }
  }

  /* The step the verdict fell on, where the counts beside it account for none of it (§8.4). It is a
     button because it goes somewhere — the step detail that explains it. */
  .run-cause {
    color: ${(props) => props.theme.colors.text.danger};
    border-bottom: 1px dotted currentColor;

    &:hover {
      opacity: 0.8;
    }
  }
`;

export default StyledWrapper;
