import styled from 'styled-components';

/**
 * 002 §5.1's key to the API colours. Over the drawing at the top right, out of the way of rank 0 and
 * of the run's own left-to-right progress. Inert to the pointer while it is only a key, so it never
 * takes a click meant for the node beneath it; a control while the flow is editable (005 §5.5).
 */
const StyledWrapper = styled.div`
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem 0.75rem;
  max-width: 60%;
  padding: 0.25rem 0.5rem;
  pointer-events: none;
  font-size: 0.6875rem;
  color: ${(props) => props.theme.colors.text.muted};
  background: ${(props) => props.theme.sidebar.collection.item.bg};
  border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
  border-radius: 4px;
  opacity: 0.94;

  /* Editable, the key's controls take the pointer and the box between them still does not: it sits
     over the right end of the drawing, where the last step's insert control is, and a click meant
     for that must reach it. */
  &.is-editable button,
  &.is-editable [data-tippy-root] {
    pointer-events: auto;
  }

  /* Names the key for what it is: without it a lone alias over the drawing reads as a caption on the
     flow rather than as the binding its steps call. */
  .flow-legend-title {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.625rem;
  }

  .flow-legend-entry {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  button.flow-legend-entry {
    padding: 0 0.25rem;
    border-radius: 3px;
    cursor: pointer;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  .flow-legend-swatch {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 1px;
  }

  .flow-legend-add {
    padding: 0 0.375rem;
    border: 1px dashed currentColor;
    border-radius: 3px;
    cursor: pointer;

    &:hover {
      color: ${(props) => props.theme.colors.text.purple};
    }
  }
`;

export default StyledWrapper;
