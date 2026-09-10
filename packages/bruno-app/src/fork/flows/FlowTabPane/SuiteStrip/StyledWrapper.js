import styled from 'styled-components';

/**
 * 003 §4's strip. It scrolls sideways rather than wrapping, for the reason §8.3's does: a selection
 * of thirty flows would otherwise push the graph off the tab, and the flows in flight are what the
 * strip is read for.
 *
 * Chips carry a name rather than a number, unlike an iteration's — an iteration is identified by its
 * index and a flow is not, and a strip of numbers would make the reader count to find the one they
 * were watching.
 */
const StyledWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  overflow-x: auto;
  padding: 0.375rem 1rem;
  border-bottom: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};

  .suite-label {
    flex: 0 0 auto;
    margin-right: 0.25rem;
    font-size: 0.7rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .suite-chip {
    flex: 0 0 auto;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 0.375rem;
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

    &.failed,
    &.invalid {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.cancelled {
      color: ${(props) => props.theme.colors.text.warning};
    }

    /* The flows in flight, which under 003 §2 is more than one at a time — the fact this strip
       exists to show, and the one a progress counter cannot. */
    &.running {
      color: ${(props) => props.theme.colors.text.white};
      border-style: dashed;
    }
  }
`;

export default StyledWrapper;
