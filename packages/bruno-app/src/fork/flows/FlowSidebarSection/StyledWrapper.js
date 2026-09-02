import styled from 'styled-components';

const StyledWrapper = styled.div`
  .flows-empty {
    padding: 0.25rem 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  .flow-group-label {
    padding: 0.25rem 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* §4.1's libraries, under the scope they belong to. Between the group label's indent and the
     rows' own, so it reads as inside the group and over the rows rather than beside either. */
  .flow-subgroup-label {
    padding: 0.25rem 0.75rem 0.125rem 1.125rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
  }

  /*
   * §4.1a: a row's indent is its depth in the folder tree. The custom property is 0 for everything
   * sitting directly in a bucket, which is the indent every row had before folders existed.
   */
  .flow-row,
  .flow-folder {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0.75rem 0.1875rem calc(1.5rem + var(--flow-depth, 0) * 0.75rem);
    cursor: pointer;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  /* The chevron sits in the row's own indent step, so a folder's name lands close to the left edge
     of the rows it holds rather than a further step out from them. */
  .flow-folder {
    padding-left: calc(0.75rem + var(--flow-depth, 0) * 0.75rem);
  }

  .flow-folder-chevron {
    display: flex;
    align-items: center;
    color: ${(props) => props.theme.sidebar.dropdownIcon.color};
  }

  .flow-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The row's right edge — the run mark and the menu, which share it (§4.3). */
  .flow-row-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;
  }

  /*
   * §4.3: the menu is revealed by hovering the row, the way upstream's own sidebar rows reveal
   * theirs. Visibility rather than display, because the row already carries the run mark: a control
   * that took its space only on hover would shift the mark sideways as the pointer crossed the row.
   *
   * An open menu stays visible wherever the pointer goes — reaching for an item in a popover means
   * leaving the row that opened it.
   */
  .flow-menu {
    display: flex;
    align-items: center;
    visibility: hidden;
    color: ${(props) => props.theme.sidebar.dropdownIcon.color};
  }

  .flow-row:hover .flow-menu,
  .flow-menu.is-open {
    visibility: visible;
  }

  /* §4.1: ambient run status on the row, so a run you walked away from is still reported. */
  .flow-run-mark {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${(props) => props.theme.colors.text.muted};

    &.passed {
      background: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      background: ${(props) => props.theme.colors.text.danger};
    }

    &.running {
      background: ${(props) => props.theme.colors.text.yellow};
    }
  }
`;

export default StyledWrapper;
