import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  border-top: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
  /* Never sized by flex distribution: the graph is what absorbs spare room, and a pane with fifteen
     rows must not squeeze it out. The height is the one the split hands down; the minimum here is
     only the floor for a render that has no split above it. */
  flex: 0 0 auto;
  min-height: 10rem;
  overflow: hidden;

  .sheet-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
  }

  /* The strip above a request — \`ui/ResponsiveTabs\`' tokens, so the step's tabs read as the same
     kind of thing as Params · Body · Headers above it. Not that component itself: its overflow
     measuring is for a strip that can run out of room, and this one holds six words. */
  .sheet-tabs {
    display: flex;
    padding: 0 1rem;

    button {
      padding: 6px 0;
      margin-right: ${(props) => props.theme.tabs.marginRight};
      font-size: ${(props) => props.theme.font.size.sm};
      /* The tab's name is its Playwright selector and its state value; capitalization is how it
         reads, not what it is. */
      text-transform: capitalize;
      color: ${(props) => props.theme.colors.text.subtext0};
      border-bottom: 2px solid transparent;
      white-space: nowrap;

      &:hover {
        color: ${(props) => props.theme.tabs.active.color};
      }

      &.active {
        font-weight: ${(props) => props.theme.tabs.active.fontWeight};
        color: ${(props) => props.theme.tabs.active.color};
        border-bottom-color: ${(props) => props.theme.tabs.active.border};
      }
    }
  }

  /* The scrollport for everything below the tabs. Without the zero min-height a flex item refuses
     to shrink below its content, so the auto overflow never engages and the rows simply overflow
     the pane — taking whatever is rendered last out of reach behind the hidden overflow. */
  .sheet-body {
    flex: 1;
    min-height: 0;
    padding: 0.75rem 1rem;
    overflow: auto;
  }
`;

export default StyledWrapper;
