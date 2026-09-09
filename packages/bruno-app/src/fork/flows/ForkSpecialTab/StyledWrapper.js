import styled from 'styled-components';

/**
 * 002 §4.1's run mark, on the tab label rather than only on the sidebar row.
 *
 * `display: contents` so the wrapper adds no box of its own: upstream's tab strip lays this out as
 * the tab's contents, and a block here would break the row it sits in.
 */
const StyledWrapper = styled.div`
  display: contents;

  .flow-tab-mark {
    width: 6px;
    height: 6px;
    margin-right: 0.25rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: ${(props) => props.theme.colors.text.muted};

    &.passed {
      background: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      background: ${(props) => props.theme.colors.text.danger};
    }

    &.cancelled {
      background: ${(props) => props.theme.colors.text.warning};
    }

    /* Hollow while the run executes: a filled dot is an outcome, and a run in flight does not have
       one yet. The same distinction the sidebar row draws. */
    &.running {
      background: transparent;
      border: 1px solid ${(props) => props.theme.colors.text.white};
    }
  }
`;

export default StyledWrapper;
