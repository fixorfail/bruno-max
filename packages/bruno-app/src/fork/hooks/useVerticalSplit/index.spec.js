import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useVerticalSplit } from './index';

/**
 * The vertical mirror of `hooks/useDragResize`, tested the way that hook is — a stubbed container
 * rect, because jsdom lays nothing out and every assertion here is about arithmetic against one.
 */

const CONTAINER_HEIGHT = 600;
const MIN_TOP = 120;
const MIN_BOTTOM = 160;

const makeContainer = (height = CONTAINER_HEIGHT) => {
  const element = document.createElement('div');
  element.getBoundingClientRect = jest.fn(() => ({
    left: 0,
    top: 0,
    width: 800,
    height,
    right: 800,
    bottom: height,
    x: 0,
    y: 0
  }));
  return element;
};

const renderSplit = ({ height, onHeightChange = jest.fn(), container } = {}) => {
  const containerEl = container ?? makeContainer();
  const result = renderHook(
    (props) => {
      const containerRef = useRef(containerEl);
      return useVerticalSplit({
        containerRef,
        height: props.height,
        onHeightChange: props.onHeightChange,
        minTop: MIN_TOP,
        minBottom: MIN_BOTTOM
      });
    },
    { initialProps: { height, onHeightChange } }
  );
  return { ...result, containerEl, onHeightChange };
};

const fireMouse = (type, clientY) => {
  act(() => {
    document.dispatchEvent(new MouseEvent(type, { clientY, bubbles: true }));
  });
};

const startDrag = (result) => {
  act(() => {
    result.current.dragbarProps.onMouseDown({ preventDefault: jest.fn() });
  });
};

describe('useVerticalSplit', () => {
  let observers;

  beforeEach(() => {
    observers = [];
    global.ResizeObserver = jest.fn().mockImplementation((callback) => {
      const instance = { callback, observe: jest.fn(), disconnect: jest.fn() };
      observers.push(instance);
      return instance;
    });
  });

  it('measures the bottom pane from the floor up, not from the top down', () => {
    const { result } = renderSplit({ height: 260 });
    startDrag(result);

    fireMouse('mousemove', 300);

    expect(result.current.dragging).toBe(true);
    expect(result.current.dragHeight).toBe(CONTAINER_HEIGHT - 300);
  });

  it('keeps the bottom pane at its minimum', () => {
    const { result } = renderSplit({ height: 260 });
    startDrag(result);

    fireMouse('mousemove', 580);

    expect(result.current.dragHeight).toBe(MIN_BOTTOM);
  });

  it('keeps the top pane at its minimum', () => {
    const { result } = renderSplit({ height: 260 });
    startDrag(result);

    fireMouse('mousemove', 20);

    expect(result.current.dragHeight).toBe(CONTAINER_HEIGHT - MIN_TOP);
  });

  /** The caller owns the persisted value, so it is written once per gesture rather than per frame. */
  it('commits the height at the end of the gesture, not during it', () => {
    const { result, onHeightChange } = renderSplit({ height: 260 });
    startDrag(result);

    fireMouse('mousemove', 400);
    fireMouse('mousemove', 350);
    expect(onHeightChange).not.toHaveBeenCalled();

    fireMouse('mouseup', 350);
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(CONTAINER_HEIGHT - 350);
    expect(result.current.dragging).toBe(false);
  });

  it('ignores the cursor until a drag has started', () => {
    const { result } = renderSplit({ height: 260 });

    fireMouse('mousemove', 300);

    expect(result.current.dragging).toBe(false);
    expect(result.current.dragHeight).toBeNull();
  });

  it('hands the pane back to its stylesheet on double-click', () => {
    const { result, onHeightChange } = renderSplit({ height: 260 });

    act(() => {
      result.current.dragbarProps.onDoubleClick({ preventDefault: jest.fn() });
    });

    expect(onHeightChange).toHaveBeenCalledWith(null);
  });

  /** A pane sized in a tall window must not survive into a short one at a size that leaves no graph. */
  it('re-clamps a stored height when the container shrinks', () => {
    const containerEl = makeContainer(CONTAINER_HEIGHT);
    const { onHeightChange } = renderSplit({ height: 500, container: containerEl });

    containerEl.getBoundingClientRect = jest.fn(() => ({
      left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300, x: 0, y: 0
    }));
    act(() => observers[observers.length - 1].callback());

    expect(onHeightChange).toHaveBeenCalledWith(300 - MIN_TOP);
  });

  it('leaves a stored height alone while it still fits', () => {
    const { onHeightChange } = renderSplit({ height: 260 });

    act(() => observers[observers.length - 1].callback());

    expect(onHeightChange).not.toHaveBeenCalled();
  });
});
