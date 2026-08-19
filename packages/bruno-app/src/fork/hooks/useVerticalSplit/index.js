import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-resize for a vertical split whose **bottom** pane owns the size.
 *
 * The mirror of upstream's `useDragResize`, which does the same job on the horizontal axis and has
 * the same controlled shape: the caller owns the persisted value and passes it in, the hook owns the
 * transient drag state and the clamping. Reading one should teach you the other.
 *
 * **It is a near-duplicate on purpose.** Widening `hooks/useDragResize` to take an axis is the
 * better call in a repository that owns its own code; here it would put fork behavior in an upstream
 * file and be re-merged forever (`.claude/rules/architecture.md`). The duplication is a few dozen
 * lines that never conflict, against an upstream edit that conflicts at every merge.
 *
 * `containerRef` is the element the split divides, so `minTop` is the room reserved for everything
 * above the handle and `minBottom` the room reserved for the pane being dragged.
 */
export function useVerticalSplit({ containerRef, height, onHeightChange, minTop, minBottom }) {
  // Mirrors the live height so mouseup can read the final value without taking `dragHeight` as a
  // dep, which would re-create the handler on every mousemove and re-run the attach effect.
  const dragHeightRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [dragHeight, setDragHeight] = useState(null);

  const clamp = useCallback(
    (value) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.height === 0) return value;
      return Math.max(minBottom, Math.min(value, rect.height - minTop));
    },
    [containerRef, minTop, minBottom]
  );

  const handleMouseMove = useCallback(
    (event) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      // The bottom pane owns the size, so the height is the distance from the cursor to the floor.
      const clamped = clamp(rect.bottom - event.clientY);
      dragHeightRef.current = clamped;
      setDragHeight(clamped);
    },
    [containerRef, clamp]
  );

  const handleMouseUp = useCallback(
    (event) => {
      event.preventDefault();
      const finalHeight = dragHeightRef.current;
      dragHeightRef.current = null;
      setDragging(false);
      setDragHeight(null);
      if (finalHeight != null && onHeightChange) {
        onHeightChange(finalHeight);
      }
    },
    [onHeightChange]
  );

  const onMouseDown = useCallback(
    (event) => {
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const seed = height != null ? height : rect ? rect.height / 2 : null;
      const seedClamped = seed != null ? clamp(seed) : null;
      dragHeightRef.current = seedClamped;
      setDragHeight(seedClamped);
      setDragging(true);
    },
    [containerRef, height, clamp]
  );

  /** Double-click clears the explicit size, handing the pane back to its stylesheet. */
  const onDoubleClick = useCallback(
    (event) => {
      event.preventDefault();
      if (onHeightChange) onHeightChange(null);
    },
    [onHeightChange]
  );

  useEffect(() => {
    if (!dragging) return undefined;
    // On the document rather than the handle: a fast drag outruns a 4px target and would otherwise
    // drop out of the gesture.
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Re-clamp a persisted height when the container shrinks — a pane sized in a tall window must not
  // survive into a short one at a size that leaves the graph nothing. The ref keeps the observer
  // from being torn down on every height change.
  const heightRef = useRef(height);
  heightRef.current = height;
  const hasHeight = height != null;
  useEffect(() => {
    if (!hasHeight || !containerRef.current) return undefined;
    const observer = new ResizeObserver(() => {
      const clamped = clamp(heightRef.current);
      if (clamped !== heightRef.current && onHeightChange) {
        onHeightChange(clamped);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [hasHeight, clamp, onHeightChange, containerRef]);

  return { dragging, dragHeight, dragbarProps: { onMouseDown, onDoubleClick } };
}
