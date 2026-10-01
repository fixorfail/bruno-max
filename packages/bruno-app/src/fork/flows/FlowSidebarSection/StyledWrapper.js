import styled from 'styled-components';
import sidebarRowStyles from 'components/Sidebar/SidebarRowStyles';

/**
 * 002 §10's suite progress, in the section header beside the header's controls — which is outside
 * the section body this file's wrapper styles, so it is a component of its own rather than a rule.
 *
 * Tabular figures: the count changes once per flow, and digits of unequal width would shift the
 * controls beside it sideways on every one of them.
 */
export const SuiteProgress = styled.span`
  color: ${(props) => props.theme.colors.text.muted};
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
`;

const StyledWrapper = styled.div`
  /* §4.1b's search row, sized and coloured as the collection sidebar's own search: it is the same
     control a row above in the same sidebar, and two search fields that did not match would read as
     two different kinds of search. */
  .flow-search {
    position: relative;
    margin: 4px 10px 8px 10px;

    input {
      width: 100%;
      height: 28px;
      padding: 0 30px 0 30px;
      font-size: 12px;
      color: ${(props) => props.theme.sidebar.color};
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
      border: 1px solid transparent;
      border-radius: 6px;
      outline: none;

      &::placeholder {
        color: ${(props) => props.theme.sidebar.muted};
      }

      &:hover,
      &:focus {
        border-color: ${(props) => props.theme.input.border};
      }

      &:focus {
        background: ${(props) => props.theme.input.bg};
      }
    }
  }

  .flow-search-icon,
  .flow-search-clear {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    color: ${(props) => props.theme.sidebar.muted};
  }

  .flow-search-icon {
    left: 9px;
    pointer-events: none;
  }

  .flow-search-clear {
    right: 8px;
    cursor: pointer;

    &:hover {
      color: ${(props) => props.theme.sidebar.color};
    }
  }

  .flows-empty {
    padding: 0.25rem 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  /*
   * §4.1d: the label's typography is on its name, not on the label, so the menu trigger beside the
   * name is the same size and colour as every other row's.
   */
  .flow-group-label {
    display: flex;
    align-items: center;
    padding: 0.25rem 0.75rem;
  }

  .flow-group-name {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* §4.1's libraries, under the scope they belong to. Between the group label's indent and the
     rows' own, so it reads as inside the group and over the rows rather than beside either. */
  .flow-subgroup-label {
    display: flex;
    align-items: center;
    padding: 0.25rem 0.75rem 0.125rem 1.125rem;
  }

  .flow-subgroup-name {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
  }

  /*
   * Upstream's sidebar rows, shared: \`sidebarRowStyles\` is what the collection and API Spec rows are
   * built on — the row height, the hover and keyboard-focus colours, the colour of the row whose tab
   * is active, and a menu trigger that shows on hover, on focus and while its menu is open.
   */
  .flow-row,
  .flow-folder {
    ${sidebarRowStyles({ selectedClass: 'is-active', keyboardFocusedClass: 'is-keyboard-focused', actionsClass: 'flow-menu-icon' })}
    display: flex;
    align-items: center;
  }

  /*
   * §4.1a: a row's depth is drawn as upstream's collection tree draws it — one 16px block per level,
   * each with the tree's guide line on its right — and the name starts 8px after the last one.
   */
  .indent-block {
    width: 16px;
    min-width: 16px;
    height: 100%;
    border-right: 1px solid ${(props) => props.theme.sidebar.collection.item.indentBorder};
  }

  .flow-row-body {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    height: 100%;
    padding-left: 8px;
  }

  .flow-folder-chevron {
    color: rgb(160 160 160);
    transition: transform 0.1s ease;

    &.is-expanded {
      transform: rotateZ(90deg);
    }
  }

  .flow-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .flow-row.is-dragging {
    opacity: 0.5;
  }

  /* §4.1d: where a dragged row would land, in upstream's own drop-target colours. */
  .flow-folder.is-drop-target,
  .flow-group-label.is-drop-target {
    background: ${(props) => props.theme.dragAndDrop.hoverBg};
    outline: ${(props) => props.theme.dragAndDrop.borderStyle} ${(props) => props.theme.dragAndDrop.border};
    outline-offset: -1px;
  }

  /* The row's right edge — the run mark and the menu, which share it (§4.3). */
  .flow-row-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;
    padding-right: 0.5rem;
  }

  /*
   * The labels are headings, not rows, so the mixin above does not style them; their menu trigger
   * follows the same rule by hand.
   */
  .flow-group-label .flow-menu-icon,
  .flow-subgroup-label .flow-menu-icon {
    visibility: hidden;
  }

  .flow-group-label:hover .flow-menu-icon,
  .flow-subgroup-label:hover .flow-menu-icon,
  .flow-menu-icon[aria-expanded='true'] {
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
