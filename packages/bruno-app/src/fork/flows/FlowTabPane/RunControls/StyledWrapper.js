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

    &:disabled,
    &.is-disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  /* §7.1's split control: Run, and the other ways to run. Two elements rather than one with a menu
     inside it, because the ordinary run must stay a single click — the menu is for the run you take
     a decision about, and taking that decision must never be on the path to the one you don't. */
  .run-split {
    display: inline-flex;
    align-items: stretch;

    .run {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }

    /* One border between the halves rather than two, so they read as one control. */
    .run-options {
      padding: 0.25rem 0.25rem;
      border-left: none;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      cursor: pointer;
      color: ${(props) => props.theme.colors.text.muted};
    }

    &:hover .run-options,
    &.is-open .run-options {
      color: ${(props) => props.theme.colors.text.white};
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
