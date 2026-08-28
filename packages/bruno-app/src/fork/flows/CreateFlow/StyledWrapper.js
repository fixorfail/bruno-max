import styled from 'styled-components';

const StyledWrapper = styled.div`
  .flow-spec-list {
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid ${(props) => props.theme.modal.input.border};
    border-radius: 3px;
  }

  .flow-spec-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    cursor: pointer;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  /* The alias, shown beside the title rather than instead of it: an author picking a spec by its
     OpenAPI title still has to type the alias in every step that uses it. */
  .flow-spec-alias {
    margin-left: auto;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-library-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .flow-library-hint {
    margin-top: 0.125rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-spec-empty {
    padding: 0.5rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-file-extension {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }
`;

export default StyledWrapper;
