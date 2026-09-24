import styled from 'styled-components';

const StyledWrapper = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: ${(props) => props.theme.colors.text.muted};

  .dirty {
    color: ${(props) => props.theme.colors.text.yellow};
  }

  .error {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .save-state-revert {
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    padding: 0.125rem 0.5rem;
    color: ${(props) => props.theme.colors.text.muted};
  }
`;

export default StyledWrapper;
