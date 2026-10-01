import { useDrop } from 'react-dnd';
import { canMoveInto } from '../../flowTree';
import { FLOW_ENTRY } from '../DraggableFlowRow';

/**
 * 002 §4.1d: a place a dragged row can be dropped — a folder row, or a group label for the top of
 * the entry's own bucket.
 *
 * `directoryFor` answers where a given entry would go, because a group label means a different
 * directory to a script than to a flow; `undefined` means nowhere. Only a drop `canMoveInto` accepts
 * lights the target up, so a folder the host would refuse does not invite the drop.
 */
const useFlowDrop = ({ directoryFor, onMove }) => {
  const [{ isDropTarget }, drop] = useDrop({
    accept: FLOW_ENTRY,
    canDrop: ({ entry }) => {
      const directory = directoryFor(entry);
      return Boolean(directory) && canMoveInto(entry, directory);
    },
    drop: ({ entry }) => {
      onMove(entry, directoryFor(entry));
    },
    collect: (monitor) => ({ isDropTarget: monitor.isOver() && monitor.canDrop() })
  });

  return { isDropTarget, drop };
};

export default useFlowDrop;
