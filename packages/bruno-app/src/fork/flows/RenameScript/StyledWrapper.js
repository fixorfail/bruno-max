import styled from 'styled-components';

const StyledWrapper = styled.div`
  .script-file-extension {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .script-file-hint {
    margin-top: 0.375rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }
`;

export default StyledWrapper;
