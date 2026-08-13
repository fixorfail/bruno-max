import styled from 'styled-components';

const StyledWrapper = styled.div`
  label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  select {
    background: ${(props) => props.theme.sidebar.collection.item.bg};
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    padding: 0.125rem 0.25rem;
  }
`;

export default StyledWrapper;
