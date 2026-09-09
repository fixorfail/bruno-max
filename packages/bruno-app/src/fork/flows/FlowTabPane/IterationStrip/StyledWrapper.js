import styled from 'styled-components';

/**
 * 002 §8.3's strip. It scrolls sideways rather than wrapping: a dataset of two hundred rows would
 * otherwise push the graph off the tab, and the rows in flight are what the strip is read for.
 */
const StyledWrapper = styled.div`
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  padding: 0.375rem 1rem;
  border-bottom: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};

  .iteration-chip {
    flex: 0 0 auto;
    min-width: 1.5rem;
    padding: 0 0.25rem;
    font-size: 0.7rem;
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    color: ${(props) => props.theme.colors.text.muted};

    &.is-selected {
      border-color: currentColor;
      color: ${(props) => props.theme.colors.text.white};
    }

    &.passed {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.cancelled {
      color: ${(props) => props.theme.colors.text.warning};
    }

    /* The rows in flight, which under a parallel dataset is more than one at a time — the fact the
       strip exists to show. */
    &.running {
      color: ${(props) => props.theme.colors.text.white};
      border-style: dashed;
    }
  }
`;

export default StyledWrapper;
