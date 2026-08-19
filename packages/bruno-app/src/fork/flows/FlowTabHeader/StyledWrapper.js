import styled from 'styled-components';

/**
 * Deliberately matched to `RequestTabs/CollectionHeader` — same row padding, same icon size, same
 * weight — so swapping one for the other does not move the tab strip underneath it.
 */
const StyledWrapper = styled.div`
  .flow-header-icon {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .flow-header-title {
    font-weight: 500;
  }

  /* Pushed to the end of the row, which is where a collection's header keeps it. */
  .flow-header-environment {
    margin-left: auto;
  }
`;

export default StyledWrapper;
