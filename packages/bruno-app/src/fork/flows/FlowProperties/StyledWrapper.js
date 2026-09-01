import styled from 'styled-components';

const StyledWrapper = styled.div`
  .flow-library-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .flow-field-hint,
  .flow-file-hint {
    margin-top: 0.125rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-file-extension {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }
`;

export default StyledWrapper;
