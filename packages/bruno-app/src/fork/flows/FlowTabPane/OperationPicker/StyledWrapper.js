import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  gap: 1rem;
  min-height: 20rem;
  max-height: 60vh;

  .picker-apis {
    flex: 0 0 11rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    border-right: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    padding-right: 0.5rem;
    overflow: auto;

    button {
      text-align: left;
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      font-size: 0.8125rem;
      color: ${(props) => props.theme.colors.text.muted};

      &.active {
        color: ${(props) => props.theme.colors.text.subtext2};
        background: ${(props) => props.theme.sidebar.collection.item.bg};
      }
    }

    /* Not an alias: set apart from the APIs above it the way the sidebar sets libraries apart. */
    .picker-libraries {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid ${(props) => props.theme.border.border0};
      border-radius: 0 0 3px 3px;
    }
  }

  /* A library reads as a flow, not as a verb — the name is the line, the place is the summary. */
  .picker-library .picker-path {
    font-family: inherit;
  }

  .picker-operations {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .picker-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .picker-operation {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    grid-template-rows: auto auto;
    column-gap: 0.5rem;
    align-items: baseline;
    text-align: left;
    padding: 0.375rem 0.5rem;
    border-radius: 3px;
    font-size: 0.8125rem;

    &:hover:not(:disabled),
    &:focus-visible {
      background: ${(props) => props.theme.sidebar.collection.item.bg};
      outline: none;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    &.deprecated .picker-path {
      text-decoration: line-through;
    }
  }

  .picker-method {
    font-family: monospace;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    color: ${(props) => props.theme.colors.text.purple};
  }

  .picker-path {
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-summary {
    grid-column: 2;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-tag {
    margin-left: 0.375rem;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
  }

  .picker-empty,
  .picker-error {
    padding: 0.5rem;
    font-size: 0.8125rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .picker-error {
    color: ${(props) => props.theme.colors.text.danger};
  }
`;

export default StyledWrapper;
