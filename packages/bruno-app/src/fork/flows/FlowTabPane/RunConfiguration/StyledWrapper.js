import styled from 'styled-components';

/**
 * 002 §7.2's panel. It sits inline with §7.1's control while shut and drops below the toolbar when
 * opened, so opening it never moves the run button out from under the pointer.
 */
const StyledWrapper = styled.div`
  display: contents;

  .run-config-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};

    &:hover,
    &.is-open {
      color: ${(props) => props.theme.colors.text.white};
    }
  }

  .run-config-summary {
    margin-left: 0.25rem;
    padding: 0 0.3rem;
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
  }

  /* Full width of the toolbar's wrap, so the panel is a row of its own under the controls. */
  .run-config-panel {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.75rem 1.25rem;
    padding: 0.5rem 0 0.25rem;
  }

  .run-config-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .run-config-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .run-config-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .run-config-param-name {
    min-width: 6rem;
    font-size: 0.75rem;

    .required {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  input[type='text'],
  input[type='password'],
  input[type='number'] {
    width: 8rem;
    padding: 0.125rem 0.25rem;
    background: ${(props) => props.theme.sidebar.collection.item.bg};
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;

    &:disabled {
      opacity: 0.5;
    }
  }

  input.run-config-wide {
    width: 14rem;
  }

  .run-config-add,
  .run-config-remove {
    font-size: 0.7rem;
    color: ${(props) => props.theme.colors.text.muted};

    &:hover:not(:disabled) {
      color: ${(props) => props.theme.colors.text.white};
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
`;

export default StyledWrapper;
