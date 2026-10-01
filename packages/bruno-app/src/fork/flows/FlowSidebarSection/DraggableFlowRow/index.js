import React from 'react';
import classnames from 'classnames';
import { useDrag } from 'react-dnd';

/**
 * 002 §4.1d's drag type. Its own rather than upstream's collection item type, so a flow row is never
 * offered to a collection folder and a request is never offered to a flow folder.
 */
export const FLOW_ENTRY = 'flow-sidebar-entry';

/**
 * One listed file's row, draggable into another folder of its bucket (§4.1d) and marked while its
 * tab is the active one.
 *
 * The connector file does not drag: the engine finds it by its exact path (§8.5), so there is no
 * folder it could be dropped in.
 */
const DraggableFlowRow = ({ entry, depth, isActive, testId, runState, onClick, children }) => {
  const [{ isDragging }, drag] = useDrag({
    type: FLOW_ENTRY,
    item: { entry },
    canDrag: () => !entry.connectors,
    collect: (monitor) => ({ isDragging: monitor.isDragging() })
  });

  return (
    <div
      ref={drag}
      className={classnames('flow-row', { 'is-active': isActive, 'is-dragging': isDragging })}
      style={{ '--flow-depth': depth }}
      data-testid={testId}
      data-run-state={runState}
      aria-current={isActive ? 'true' : undefined}
      onClick={onClick}
    >
      {children}
    </div>
  );
};

export default DraggableFlowRow;
