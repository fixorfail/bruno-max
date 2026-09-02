import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import FlowGraph from './index';

/**
 * 002 §5.3 and §8.2 — what the drawing says about a run.
 *
 * The case these are about is the run that fails while every node it drew is green or grey: 001
 * §11.2 skips a step whose reference was never produced, and the value that never arrived is on an
 * edge rather than in any node's own outcome.
 */

const theme = themes.dark || Object.values(themes)[0];

const markers = () => ({
  conditional: false,
  allowsErrorStatus: false,
  usesSharedSlot: false,
  computesValues: false
});

const node = (id, rank) => ({
  id,
  kind: 'operation',
  operation: { api: 'httpbin', method: 'POST', path: '/post' },
  outputs: [],
  markers: markers(),
  position: { line: 1, column: 1 },
  rank
});

const description = {
  id: 'checkout.flow.yml',
  name: 'checkout',
  isLibrary: false,
  params: [],
  nodes: [node('bearer_check', 0), node('echo', 1)],
  edges: [{ from: 'bearer_check', to: 'echo', kind: 'data', output: 'token', declared: true }],
  slots: [],
  diagnostics: []
};

const renderGraphOf = (graphDescription, nodeStates, running = true) =>
  render(
    <ThemeProvider theme={theme}>
      <FlowGraph
        description={graphDescription}
        nodeStates={nodeStates}
        running={running}
        diagnostics={[]}
        selectedStep={undefined}
        expandedSubflows={[]}
        showDataEdges
        onSelectStep={() => {}}
        onToggleSubflow={() => {}}
      />
    </ThemeProvider>
  );

const renderGraph = (nodeStates, running) => renderGraphOf(description, nodeStates, running);

/** The run this fixture describes: the producer ran and declared `token`, and produced nothing. */
const unproducedRun = {
  bearer_check: { state: 'success', attempts: 1, outputs: {} },
  echo: {
    state: 'skipped',
    reason: 'unresolved-dependency',
    message: 'never produced: steps.bearer_check.token',
    attempts: 0,
    outputs: {}
  }
};

/**
 * 001 §8.1 draws a connector per output, and every edge between one pair of steps runs the same
 * path — so a step consuming two of a producer's values had both names in one place.
 */
describe('FlowGraph parallel edges', () => {
  const twoOutputs = {
    ...description,
    edges: [
      { from: 'bearer_check', to: 'echo', kind: 'data', output: 'token', declared: true },
      { from: 'bearer_check', to: 'echo', kind: 'data', output: 'expiry', declared: true }
    ]
  };

  const labels = (container) => [...container.querySelectorAll('.edge-label')];

  it('gives each label between one pair of steps its own line', () => {
    const { container } = renderGraphOf(twoOutputs, {});

    const offsets = labels(container).map((label) => Number(label.getAttribute('dy')));
    expect(offsets).toHaveLength(2);
    expect(new Set(offsets).size).toBe(2);
  });

  /** Stacked away from the path, not into it: a label below the line is a label over the next rank. */
  it('stacks them clear of the path they belong to', () => {
    const { container } = renderGraphOf(twoOutputs, {});

    for (const offset of labels(container).map((label) => Number(label.getAttribute('dy')))) {
      expect(offset).toBeLessThan(0);
    }
  });

  it('leaves each one its own value on hover', () => {
    const { container } = renderGraphOf(twoOutputs, {
      bearer_check: { state: 'success', outputs: { token: 'tok_1', expiry: 60 } },
      echo: { state: 'success', outputs: {} }
    });

    const titles = [...container.querySelectorAll('.edge-data title')].map((node) => node.textContent);
    expect(titles).toEqual(['token = "tok_1"', 'expiry = 60']);
  });

  /** One label between a pair is the common case and must not drift off the path to make room. */
  it('leaves a lone label where it was', () => {
    const { container } = renderGraph({});

    expect(labels(container).map((label) => Number(label.getAttribute('dy')))).toEqual([-4]);
  });
});

/**
 * §5.2: the corridor between two ranks is what a label has to fit in. Laid out *from* the midpoint
 * of its edge it only ever had half of one, so a name of ordinary length — `accountId` — finished
 * inside the box the edge points at, over the step's own name.
 */
describe('FlowGraph edge label width', () => {
  const named = (output) => ({
    ...description,
    edges: [{ from: 'bearer_check', to: 'echo', kind: 'data', output, declared: true }]
  });

  const labels = (container) => [...container.querySelectorAll('.edge-label')];

  it('centres a label on its edge rather than running it toward the next step', () => {
    const { container } = renderGraphOf(named('accountId'), {});

    expect(labels(container).map((label) => label.getAttribute('text-anchor'))).toEqual(['middle']);
  });

  it('leaves a name the corridor fits alone', () => {
    const { container } = renderGraphOf(named('accountId'), {});

    expect(labels(container)[0].textContent).toBe('accountId');
  });

  /** The elision is a display, not a rename: the name it stands for has to stay readable somewhere. */
  it('elides a name wider than the corridor and keeps the whole of it on hover', () => {
    const { container } = renderGraphOf(named('verifiedCompanyIdentifier'), {});

    const label = labels(container)[0].textContent;
    expect(label).toMatch(/…$/);
    expect(label.length).toBeLessThan('verifiedCompanyIdentifier'.length);
    expect(container.querySelector('.edge-data title').textContent).toBe('verifiedCompanyIdentifier');
  });

  /** The run's own answer is the better one, and elision must not displace it. */
  it('keeps the value on hover when the run has one', () => {
    const { container } = renderGraphOf(named('verifiedCompanyIdentifier'), {
      bearer_check: { state: 'success', outputs: { verifiedCompanyIdentifier: 'co_1' } },
      echo: { state: 'success', outputs: {} }
    });

    expect(container.querySelector('.edge-data title').textContent).toBe('verifiedCompanyIdentifier = "co_1"');
  });
});

/**
 * §8.2: `running` and `retrying` are separate states because a poll that reads as `running` for a
 * minute is indistinguishable from a hang. The halo carries both — its motion says a request is in
 * flight, its colour says which of the two.
 */
/**
 * §5.1's box, and the one thing SVG will not do for it: `<text>` does not wrap, by any attribute. A
 * step id or a path longer than the box ran straight out of it and over whatever it met — and the
 * longest names are the ones most worth reading.
 */
describe('FlowGraph node text', () => {
  const longNames = {
    ...description,
    nodes: [
      { ...node('await_micro_deposits_processed_for_the_manual_bank_account', 0), name: undefined },
      {
        ...node('echo', 1),
        operation: { api: 'backend', method: 'POST', path: '/companies/{pk}/funding_accounts/{id}/verify' }
      }
    ],
    edges: []
  };

  const content = (container, id) =>
    container.querySelector(`[data-testid="flow-node-${id}"] .node-content`);

  it('lays the box out as wrapping text rather than as an SVG line', () => {
    const { container } = renderGraphOf(longNames, {});

    // `foreignObject` is the seam: inside it the text is HTML, and HTML wraps.
    expect(container.querySelector('foreignObject .node-content')).toBeInTheDocument();
    expect(container.querySelector('text.node-id')).toBeNull();
  });

  it('keeps a name too long for the box inside it, and readable', () => {
    const { container } = renderGraphOf(longNames, {});
    const box = content(container, 'await_micro_deposits_processed_for_the_manual_bank_account');

    expect(box).toHaveTextContent('await_micro_deposits_processed_for_the_manual_bank_account');
    // The box's own width bounds it: the element cannot draw wider than the foreignObject it is in.
    expect(box.closest('foreignObject').getAttribute('width')).toBe('220');
  });

  it('leaves the operation and the status in the same box', () => {
    const { container } = renderGraphOf(longNames, { echo: { state: 'failed', reason: 'unexpected-status' } });
    const box = content(container, 'echo');

    expect(box).toHaveTextContent('POST /companies/{pk}/funding_accounts/{id}/verify');
    expect(box).toHaveTextContent('failed · unexpected-status');
  });

  /** A poll's attempt count shares the last line with the status rather than being placed over it. */
  it('puts the attempt count of a poll beside the status', () => {
    const { container } = renderGraphOf(
      { ...longNames, nodes: [{ ...longNames.nodes[1], markers: { ...markers(), retryMaxAttempts: 10 } }] },
      { echo: { state: 'retrying', attempt: 4 } }
    );

    expect(content(container, 'echo')).toHaveTextContent('attempt 4/10');
  });
});

describe('FlowGraph in-flight halo', () => {
  const halo = (container) => container.querySelector('[data-testid="flow-node-halo-bearer_check"]');

  it('rings the step whose request is in flight', () => {
    const { container } = renderGraph({ bearer_check: { state: 'running' } });

    expect(halo(container)).toBeInTheDocument();
  });

  /** A retry is the same request still in flight, so the ring stays up and only its colour moves. */
  it('stays up while the step retries, under the state the colour keys off', () => {
    const { container } = renderGraph({ bearer_check: { state: 'retrying', attempt: 3 } });

    expect(halo(container)).toBeInTheDocument();
    expect(container.querySelector('[data-testid="flow-node-bearer_check"]')).toHaveAttribute(
      'data-status',
      'retrying'
    );
  });

  /**
   * The dash travels by covering the outline's own length once per lap, so the ring has to carry
   * that measurement — a wrong one puts a visible jump in every turn.
   *
   * **With a unit.** `stroke-dashoffset` takes a length, so `calc()` over a unitless value is
   * invalid there and the keyframe is dropped silently: the arc still draws, parked at the path's
   * start, which on a rectangle is a solid line along the top edge and no motion at all. The defect
   * looks like a styling choice rather than a broken animation, which is why it is asserted here.
   */
  it('measures the outline it travels around, in units a length accepts', () => {
    const { container } = renderGraph({ bearer_check: { state: 'running' } });
    const outline = halo(container).style.getPropertyValue('--halo-outline');

    expect(outline).toMatch(/px$/);
    expect(parseFloat(outline)).toBeGreaterThan(0);
  });

  /** Part lit, part dark, and the two together are the lap the offset animates over. */
  it('is an arc of that outline rather than a ring of it', () => {
    const { container } = renderGraph({ bearer_check: { state: 'running' } });
    const [lit, dark] = halo(container).getAttribute('stroke-dasharray').split(' ').map(Number);
    const outline = parseFloat(halo(container).style.getPropertyValue('--halo-outline'));

    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(outline);
    expect(lit + dark).toBeCloseTo(outline);
  });

  it.each(['success', 'failed', 'skipped', 'cancelled'])('is gone once the step is %s', (state) => {
    const { container } = renderGraph({ bearer_check: { state, outputs: {} } });

    expect(halo(container)).not.toBeInTheDocument();
  });

  it('is absent from a step that has not started', () => {
    const { container } = renderGraph({});

    expect(halo(container)).not.toBeInTheDocument();
  });

  /**
   * A node's state is the last thing the engine said about that step, so one that announced
   * `step:start` and never announced its end reads `running` for as long as the tab is open. The
   * run's own end is what settles it — otherwise the graph animates a request that stopped minutes
   * ago, beside a summary saying the run is over.
   */
  it('goes out when the run ends, whatever the step last reported', () => {
    const { container } = renderGraph({ bearer_check: { state: 'running' } }, false);

    expect(halo(container)).not.toBeInTheDocument();
  });
});

describe('FlowGraph data edges', () => {
  it('marks the edge whose value was never produced, and explains it on hover', () => {
    const { container } = renderGraph(unproducedRun);

    expect(container.querySelector('.edge-unproduced .edge-mark')).toHaveTextContent('✗');
    expect(container.querySelector('.edge-unproduced title')).toHaveTextContent(
      'never produced: steps.bearer_check.token'
    );
  });

  /**
   * A label runs rightward from the midpoint of its edge, so a mark prefixed to it pushes the name
   * away from the edge and toward the node. The mark takes its space from the gutter instead, which
   * is why it is an element of its own and not two characters on the front of the label.
   */
  it('hangs the mark off the label rather than displacing it', () => {
    const { container } = renderGraph(unproducedRun);

    const mark = container.querySelector('.edge-unproduced .edge-mark');
    expect(Number(mark.getAttribute('dx'))).toBeLessThan(0);
    // The name is its own run, positioned after the mark rather than concatenated onto it.
    expect(mark.nextSibling).toHaveTextContent('token');
  });

  /**
   * The drawing says a value moved; the run says which one. Without this it is behind selecting the
   * producing step and opening a tab, which is a long way round for "what was the token".
   */
  describe('the value on hover (§5.3)', () => {
    const titleOf = (container) => container.querySelector('.edge-data title');

    it('names the output and what it was', () => {
      const { container } = renderGraph({
        bearer_check: { state: 'success', outputs: { token: 'tok_1' } },
        echo: { state: 'success', outputs: {} }
      });

      expect(titleOf(container)).toHaveTextContent('token = "tok_1"');
    });

    it('carries a structured value rather than reporting its type', () => {
      const { container } = renderGraph({
        bearer_check: { state: 'success', outputs: { token: { id: 7, scopes: ['a'] } } },
        echo: { state: 'success', outputs: {} }
      });

      expect(titleOf(container)).toHaveTextContent('{"id":7,"scopes":["a"]}');
    });

    /** A tooltip is not a viewer: §9's pane is where a whole response fragment gets read. */
    it('cuts a value too long to glance at', () => {
      const { container } = renderGraph({
        bearer_check: { state: 'success', outputs: { token: 'x'.repeat(500) } },
        echo: { state: 'success', outputs: {} }
      });

      const text = titleOf(container).textContent;
      expect(text.length).toBeLessThan(260);
      expect(text.endsWith('…')).toBe(true);
    });

    it('says nothing until the producing step has ended', () => {
      const { container } = renderGraph({ bearer_check: { state: 'running' } });

      expect(titleOf(container)).toBeNull();
    });

    /** An output not among the producer's is either the missing-value case or nothing to report. */
    it('says nothing about an output the run never mentions', () => {
      const { container } = renderGraph({
        bearer_check: { state: 'success', outputs: {} },
        echo: { state: 'success', outputs: {} }
      });

      expect(titleOf(container)).toBeNull();
    });
  });

  it('leaves the edge alone while the run is producing values as declared', () => {
    const { container } = renderGraph({
      bearer_check: { state: 'success', attempts: 1, outputs: { token: 'tok_1' } },
      echo: { state: 'success', attempts: 1, outputs: {} }
    });

    expect(screen.getByText('token')).toBeInTheDocument();
    expect(container.querySelector('.edge-unproduced')).toBeNull();
  });

  /**
   * A step referencing two values that failed on one must not paint both edges — which is the whole
   * reason the producer's own outputs are consulted rather than the consumer's reason alone.
   */
  it('marks only the output the producer is actually missing', () => {
    const { container } = renderGraph({
      ...unproducedRun,
      bearer_check: { state: 'success', attempts: 1, outputs: { token: 'tok_1' } }
    });

    expect(container.querySelector('.edge-unproduced')).toBeNull();
  });

  /** Nothing is missing until the producer has finished: a step still running has produced nothing yet. */
  it('says nothing while the producer is still running', () => {
    const { container } = renderGraph({
      ...unproducedRun,
      bearer_check: { state: 'running' }
    });

    expect(container.querySelector('.edge-unproduced')).toBeNull();
  });

  /** A run stored before outputs were recorded reports none — which is not the same as producing none. */
  it('says nothing about a run that reported no outputs at all', () => {
    const { container } = renderGraph({
      ...unproducedRun,
      bearer_check: { state: 'success', attempts: 1 }
    });

    expect(container.querySelector('.edge-unproduced')).toBeNull();
  });
});

/**
 * 002 §5.2 — the graph scrolls rather than scaling, so a run walks off the edge of the box on any
 * flow longer than the tab is wide. The view follows the step in flight while nobody has said they
 * are reading a different one.
 */
describe('FlowGraph follows the running step', () => {
  const VIEWPORT_WIDTH = 400;
  const VIEWPORT_HEIGHT = 300;
  /** layout.js: a 220px box and a 72px rank gap, and a linear flow is one step per rank. */
  const NODE_PITCH = 292;
  const NODE_WIDTH = 220;
  const NODE_HEIGHT = 84;

  const linear = {
    ...description,
    nodes: [node('first', 0), node('second', 1), node('third', 2)],
    edges: []
  };

  const tree = (nodeStates, selectedStep) => (
    <ThemeProvider theme={theme}>
      <FlowGraph
        description={linear}
        nodeStates={nodeStates}
        running
        diagnostics={[]}
        selectedStep={selectedStep}
        expandedSubflows={[]}
        showDataEdges
        onSelectStep={() => {}}
        onToggleSubflow={() => {}}
      />
    </ThemeProvider>
  );

  /**
   * jsdom lays nothing out, so the graph gets the geometry it would have in the app: a box narrower
   * than the drawing, and a node per rank across it. The rects answer relative to the current scroll,
   * the way real ones do — which is what makes "it is already in view" a real question here.
   */
  const stubGeometry = (viewport) => {
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    Object.defineProperty(viewport, 'clientWidth', { value: VIEWPORT_WIDTH, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true });
    viewport.scrollTo = jest.fn(({ left, top }) => {
      viewport.scrollLeft = left;
      viewport.scrollTop = top;
    });

    linear.nodes.forEach((graphNode, index) => {
      const element = screen.getByTestId(`flow-node-${graphNode.id}`);
      element.getBoundingClientRect = () => ({
        left: index * NODE_PITCH - viewport.scrollLeft,
        top: -viewport.scrollTop,
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      });
    });
  };

  /** Mounted with nothing in flight, then given a run — the order the app meets one in. */
  const mountAndStub = () => {
    const { rerender } = render(tree({}, undefined));
    const viewport = screen.getByTestId('flow-graph-viewport');
    stubGeometry(viewport);
    return { rerender, viewport };
  };

  it('scrolls to a step that starts running off-screen', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ third: { state: 'running' } }, undefined));

    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
    const { left, top } = viewport.scrollTo.mock.calls[0][0];
    expect(left).toBe(2 * NODE_PITCH + NODE_WIDTH + 32 - VIEWPORT_WIDTH);
    expect(top).toBe(0);
  });

  it('leaves a step that is already in view alone', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ first: { state: 'running' } }, undefined));

    expect(viewport.scrollTo).not.toHaveBeenCalled();
  });

  /**
   * A poll rewrites its node on every attempt (§8.2). The view must not answer to that: the step it
   * is following has not moved, and a graph that re-scrolled on each attempt would fight a reader
   * who scrolled off it.
   */
  it('holds still while the step it followed is still in flight', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ third: { state: 'running' } }, undefined));
    rerender(tree({ third: { state: 'retrying', attempt: 2 } }, undefined));

    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('moves on when that step ends and the next one starts', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ first: { state: 'running' } }, undefined));
    rerender(tree({ first: { state: 'success' }, third: { state: 'running' } }, undefined));

    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTo.mock.calls[0][0].left).toBe(2 * NODE_PITCH + NODE_WIDTH + 32 - VIEWPORT_WIDTH);
  });

  /** §8.3: several steps are in flight under `concurrency > 1`, and the earliest rank is the one followed. */
  it('follows the earliest of several steps in flight', () => {
    const { rerender, viewport } = mountAndStub();

    viewport.scrollLeft = 900;
    rerender(tree({ second: { state: 'running' }, third: { state: 'running' } }, undefined));

    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTo.mock.calls[0][0].left).toBe(NODE_PITCH - 32);
  });

  /** §9's pane is reading the selected step, and the drawing must not slide out from under it. */
  it('stops following once a step is selected', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ third: { state: 'running' } }, 'first'));

    expect(viewport.scrollTo).not.toHaveBeenCalled();
  });

  it('picks the run back up when the selection is cleared', () => {
    const { rerender, viewport } = mountAndStub();

    rerender(tree({ third: { state: 'running' } }, 'first'));
    rerender(tree({ third: { state: 'running' } }, undefined));

    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
  });

  /** A step whose node reads `running` beside a run that has ended is §8.2's stale report, not a run. */
  it('does not follow a run that has ended', () => {
    const { rerender } = render(tree({}, undefined));
    const viewport = screen.getByTestId('flow-graph-viewport');
    stubGeometry(viewport);

    rerender(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={linear}
          nodeStates={{ third: { state: 'running' } }}
          running={false}
          diagnostics={[]}
          selectedStep={undefined}
          expandedSubflows={[]}
          showDataEdges
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
        />
      </ThemeProvider>
    );

    expect(viewport.scrollTo).not.toHaveBeenCalled();
  });
});

/**
 * 002 §5.3 — the focus, and the slot layer it draws on demand.
 *
 * A drawing with sixty edges on it answers "how much is going on" and not "which of these is mine".
 * The focus is the second question: what the pointer is over, or what §9's pane is reading, keeps
 * its lines and its neighbours while everything else recedes.
 */
describe('FlowGraph focus', () => {
  const focusDescription = {
    ...description,
    nodes: [node('bearer_check', 0), node('echo', 1), node('report', 2)],
    edges: [
      { from: 'bearer_check', to: 'echo', kind: 'sequence' },
      { from: 'echo', to: 'report', kind: 'sequence' }
    ],
    slots: [{ name: 'authToken', writers: ['bearer_check'], readers: ['report'] }]
  };

  const renderFocus = (props = {}) =>
    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={focusDescription}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep={undefined}
          expandedSubflows={[]}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
          {...props}
        />
      </ThemeProvider>
    );

  const dimmed = (testId) => screen.getByTestId(testId).classList.contains('dimmed');

  it('dims nothing while nothing is focused', () => {
    renderFocus();

    expect(dimmed('flow-node-bearer_check')).toBe(false);
    expect(dimmed('flow-edge-sequence-echo-report')).toBe(false);
  });

  it('keeps a hovered step, its edges and its neighbours lit, and dims the rest', () => {
    renderFocus();

    fireEvent.mouseEnter(screen.getByTestId('flow-node-echo'));

    expect(dimmed('flow-node-echo')).toBe(false);
    // Both ends of a lit edge stay lit: a line into a faded box says a value went somewhere and not where.
    expect(dimmed('flow-node-bearer_check')).toBe(false);
    expect(dimmed('flow-node-report')).toBe(false);
    expect(dimmed('flow-edge-sequence-bearer_check-echo')).toBe(false);
    expect(dimmed('flow-edge-sequence-echo-report')).toBe(false);

    fireEvent.mouseEnter(screen.getByTestId('flow-node-bearer_check'));
    expect(dimmed('flow-edge-sequence-echo-report')).toBe(true);
    expect(dimmed('flow-node-report')).toBe(true);
  });

  it('restores the drawing when the pointer leaves', () => {
    renderFocus();
    const step = screen.getByTestId('flow-node-bearer_check');

    fireEvent.mouseEnter(step);
    fireEvent.mouseLeave(step);

    expect(dimmed('flow-node-report')).toBe(false);
  });

  /** §9's pane is reading the selected step, so the drawing keeps saying which step that is. */
  it('focuses the selected step with no pointer involved', () => {
    renderFocus({ selectedStep: 'bearer_check' });

    expect(dimmed('flow-node-report')).toBe(true);
    expect(dimmed('flow-node-echo')).toBe(false);
  });

  it('draws no slot layer until a step is focused or the layer is on', () => {
    renderFocus();

    expect(screen.queryByTestId('flow-slot-authToken')).toBeNull();
  });

  /**
   * §5.3: the layer is off by default because a slot every authenticated step reads is a line from
   * every box on the drawing — and the step being read still brings its own along.
   */
  it('brings the focused step\'s own slots with it while the layer is off', () => {
    renderFocus({ selectedStep: 'report' });

    expect(screen.getByTestId('flow-slot-authToken')).toBeInTheDocument();
    expect(screen.getByTestId('flow-edge-slot-read-authToken-report')).toBeInTheDocument();
    // The reader's own edge, not the writer's: the glyph names who else touches it.
    expect(screen.queryByTestId('flow-edge-slot-write-authToken-bearer_check')).toBeNull();
  });

  it('draws every slot edge once the layer is on', () => {
    renderFocus({ showSlotEdges: true });

    expect(screen.getByTestId('flow-edge-slot-write-authToken-bearer_check')).toBeInTheDocument();
    expect(screen.getByTestId('flow-edge-slot-read-authToken-report')).toBeInTheDocument();
  });

  /** The lane is below the drawing, so what it costs is height nothing else was using. */
  it('grows the drawing downward rather than moving a step to make room', () => {
    const { rerender } = renderFocus();
    const before = screen.getByTestId('flow-node-report').getAttribute('transform');
    const height = Number(screen.getByTestId('flow-graph').getAttribute('height'));

    rerender(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={focusDescription}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep="report"
          expandedSubflows={[]}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
        />
      </ThemeProvider>
    );

    expect(screen.getByTestId('flow-node-report').getAttribute('transform')).toBe(before);
    expect(Number(screen.getByTestId('flow-graph').getAttribute('height'))).toBeGreaterThan(height);
  });
});

/**
 * 002 §9 — selecting a step opens the pane that reads it, and the same click closes it again.
 * Without the second half there is no way back to nothing being selected, which is the state both
 * the pane and §5.2's follow answer to.
 */
describe('FlowGraph selection', () => {
  const selectable = {
    ...description,
    nodes: [node('bearer_check', 0), node('echo', 1)],
    edges: [{ from: 'bearer_check', to: 'echo', kind: 'sequence' }]
  };

  const renderSelectable = (selectedStep, onSelectStep) =>
    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={selectable}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep={selectedStep}
          expandedSubflows={[]}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={onSelectStep}
          onToggleSubflow={() => {}}
        />
      </ThemeProvider>
    );

  it('clears the selection when the selected step is clicked again', () => {
    const onSelectStep = jest.fn();
    renderSelectable('echo', onSelectStep);

    fireEvent.click(screen.getByTestId('flow-node-echo'));

    expect(onSelectStep).toHaveBeenCalledWith(null);
  });

  it('moves the selection when another step is clicked', () => {
    const onSelectStep = jest.fn();
    renderSelectable('echo', onSelectStep);

    fireEvent.click(screen.getByTestId('flow-node-bearer_check'));

    expect(onSelectStep).toHaveBeenCalledWith('bearer_check');
  });

  it('selects a step when nothing is selected', () => {
    const onSelectStep = jest.fn();
    renderSelectable(undefined, onSelectStep);

    fireEvent.click(screen.getByTestId('flow-node-echo'));

    expect(onSelectStep).toHaveBeenCalledWith('echo');
  });
});

/**
 * 002 §5.1 — the footer bar: the markers, and which binding the step calls.
 *
 * The markers were drawn over the box's top-right corner, on top of the step's name. On a strip of
 * their own they have a fixed place to be looked for, and room beside them for the one thing the box
 * never said — which of the flow's `apis:` this step talks to.
 */
describe('FlowGraph node footer', () => {
  const stepOn = (id, api, rank) => ({
    ...node(id, rank),
    operation: { api, method: 'POST', path: '/post' }
  });

  const twoApis = {
    ...description,
    nodes: [stepOn('probe', 'glados', 0), stepOn('seed', 'glados', 1), stepOn('sign_in', 'backend', 2)],
    edges: []
  };

  const oneApi = {
    ...description,
    nodes: [stepOn('probe', 'backend', 0), stepOn('sign_in', 'backend', 1)],
    edges: []
  };

  const renderWith = (graphDescription) =>
    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={graphDescription}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep={undefined}
          expandedSubflows={[]}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
        />
      </ThemeProvider>
    );

  /**
   * §5.1: 001 §8.7's `pre:` is the one thing on a box that changes what the step *sends*, and the
   * footer is already the busiest part of it. A strip reads across a whole graph at once, which is
   * what someone scanning for where a signature is built is actually doing.
   */
  describe('the pre: strip', () => {
    const computing = (value) => ({
      ...twoApis,
      nodes: [{ ...stepOn('probe', 'glados', 0), markers: { ...markers(), computesValues: value } }]
    });

    it('runs down the left edge, the full height of the box', () => {
      renderWith(computing(true));

      const step = screen.getByTestId('flow-node-probe');
      const strip = screen.getByTestId('flow-node-pre-probe');
      const height = Number(step.querySelector('.node-box').getAttribute('height'));

      // Starts at the box's left edge and ends at its bottom — the two coordinates a reader scans.
      expect(strip.getAttribute('d')).toContain(`V ${height}`);
      expect(strip.getAttribute('d')).toMatch(/^M 4,0/);
    });

    it('says what it means, for a strip that is otherwise only a colour', () => {
      renderWith(computing(true));

      expect(screen.getByTestId('flow-node-pre-probe').querySelector('title')).toHaveTextContent(
        'step includes a pre script'
      );
    });

    /* The strip's <title> is the accessible name, but it is not what a reader hovering the strip
       gets: the foreignObjects over it take the pointer first. The tooltip is an HTML title
       attribute on a target sized to the strip's column — the same mechanism as the footer
       markers, which are the one tooltip on this box known to fire. */
    it('puts the tooltip on a target over the strip, not on the strip itself', () => {
      renderWith(computing(true));

      const hit = screen.getByTestId('flow-node-pre-hit-probe');

      expect(hit).toHaveAttribute('title', 'step includes a pre script');
      // Sized to the strip it stands over, so the tooltip is the strip's rather than the box's.
      expect(hit).toHaveStyle({ width: '6px' });
    });

    it('has no hover target on a step that computes nothing', () => {
      renderWith(computing(false));

      expect(screen.queryByTestId('flow-node-pre-hit-probe')).not.toBeInTheDocument();
    });

    it('is absent from a step that computes nothing', () => {
      renderWith(computing(false));

      expect(screen.queryByTestId('flow-node-pre-probe')).not.toBeInTheDocument();
    });
  });

  it('draws the markers on the footer rather than over the step\'s name', () => {
    renderWith({
      ...twoApis,
      nodes: [{ ...stepOn('probe', 'glados', 0), markers: { ...markers(), conditional: true } }]
    });

    const step = screen.getByTestId('flow-node-probe');
    const height = Number(step.querySelector('.node-box').getAttribute('height'));
    const strip = step.querySelector('.node-markers').closest('foreignObject');

    // In the bottom strip, not the top-right corner it used to share with the name.
    expect(Number(strip.getAttribute('y'))).toBe(height - Number(strip.getAttribute('height')));
    expect(step.querySelector('.node-marker')).toHaveTextContent('when');
  });

  /**
   * §5.1: a marker that names a key spells the key. The sub-flow marker was `⊂` — a symbol for a
   * relationship nobody draws that way, learned from its tooltip or not at all.
   */
  it('marks a sub-flow with the key that declares it', () => {
    renderWith({
      ...twoApis,
      nodes: [
        {
          ...stepOn('checkout', 'glados', 0),
          kind: 'subflow',
          uses: 'auth.flow.yml',
          operation: undefined
        }
      ]
    });

    const marker = screen.getByTestId('flow-node-checkout').querySelector('.node-marker');
    expect(marker).toHaveTextContent('uses');
    expect(marker).toHaveAttribute('title', 'Sub-flow (uses:)');
  });

  /**
   * The overlap this replaced a fixed pitch to prevent: `↻ 16` and `when` are wider than any step
   * that fits `⌸`, so whichever pair a step happened to carry landed on top of each other.
   */
  it('lays several markers out in a row rather than on a fixed pitch', () => {
    renderWith({
      ...twoApis,
      nodes: [
        {
          ...stepOn('probe', 'glados', 0),
          markers: { conditional: true, retryMaxAttempts: 16, allowsErrorStatus: true, usesSharedSlot: true }
        }
      ]
    });

    const strip = screen.getByTestId('flow-node-probe').querySelector('.node-markers');

    expect(strip.querySelectorAll('.node-marker')).toHaveLength(4);
    // Laid out by the row, so no marker carries a position of its own to collide with.
    strip.querySelectorAll('.node-marker').forEach((marker) => {
      expect(marker.getAttribute('x')).toBeNull();
      expect(marker.getAttribute('transform')).toBeNull();
    });
  });

  it('colours each binding differently, and names it on the bar\'s hover', () => {
    renderWith(twoApis);

    const colorOf = (id) => screen.getByTestId(`flow-node-footer-${id}`).style.fill;

    expect(colorOf('probe')).toBeTruthy();
    expect(colorOf('probe')).toBe(colorOf('seed'));
    expect(colorOf('probe')).not.toBe(colorOf('sign_in'));

    // The alias is drawn nowhere on the box — §5.1's key carries it, and the bar answers on hover.
    const drawn = screen.getByTestId('flow-node-probe').querySelectorAll('.node-content, .node-markers');
    drawn.forEach((part) => expect(part).not.toHaveTextContent('glados'));
    expect(screen.getByTestId('flow-node-footer-probe').querySelector('title')).toHaveTextContent('glados');
  });

  /**
   * A colour that never varies is decoration — but which service the flow drives is worth saying
   * whether or not there is a second one, and the operation line names no host.
   */
  it('keys a flow that binds one API without colouring it', () => {
    renderWith(oneApi);

    expect(screen.getByTestId('flow-node-footer-probe').style.fill).toBe('');
    expect(screen.getByTestId('flow-legend')).toHaveTextContent('backend');
    expect(screen.getByTestId('flow-legend').querySelector('.flow-legend-swatch')).toBeNull();
  });

  /**
   * 001 §6.2: the file's own colour for a binding. It is the case a single-API flow has no other way
   * to get a tint, and the case a team recognises a service by a colour of their own.
   */
  it('paints the bar with the colour the flow declares', () => {
    renderWith({ ...oneApi, apis: [{ alias: 'backend', color: '#8ab4f8' }] });

    expect(screen.getByTestId('flow-node-footer-probe').style.fill).toBe('#8ab4f8');
    expect(screen.getByTestId('flow-legend').querySelector('.flow-legend-swatch')).toBeInTheDocument();
  });

  it('titles the key, so a lone alias reads as the binding rather than as a caption', () => {
    renderWith(oneApi);

    expect(screen.getByTestId('flow-legend').querySelector('.flow-legend-title')).toHaveTextContent('API');
  });

  /**
   * §5.2: the drawing is far wider than its box and scrolls, so a key drawn into the picture is
   * off-screen for all but the first rank.
   */
  it('keys the colours outside the scrolling box', () => {
    renderWith(twoApis);

    const legend = screen.getByTestId('flow-legend');
    expect(legend).toHaveTextContent('glados');
    expect(legend).toHaveTextContent('backend');
    expect(legend.closest('[data-testid="flow-graph-viewport"]')).toBeNull();
  });

  it('lists the bindings in the legend in the order the flow declares them', () => {
    renderWith(twoApis);

    expect([...screen.getByTestId('flow-legend').querySelectorAll('.flow-legend-entry')].map((entry) => entry.textContent))
      .toEqual(['glados', 'backend']);
  });
});

/**
 * 002 §5.4: a sub-flow is collapsed by default and expands on a double-click — the one thing this
 * drawing does that nothing on it says, and the thing a reader wants exactly when a `uses:` step is
 * the step that failed.
 */
describe('FlowGraph sub-flow hint', () => {
  const container = {
    id: 'pay',
    kind: 'subflow',
    uses: '../lib/pay.flow.yml',
    outputs: [],
    markers: markers(),
    position: { line: 1, column: 1 },
    rank: 0
  };

  const withSubflow = {
    ...description,
    nodes: [
      container,
      { ...node('pay/charge', 0), parent: 'pay' },
      node('report', 1)
    ],
    edges: [{ from: 'pay', to: 'report', kind: 'sequence' }]
  };

  const renderSubflow = (props = {}) =>
    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={withSubflow}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep={undefined}
          expandedSubflows={[]}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
          {...props}
        />
      </ThemeProvider>
    );

  it('says nothing until the step is selected', () => {
    renderSubflow();

    expect(screen.queryByTestId('flow-node-hint-pay')).not.toBeInTheDocument();
  });

  it('writes it under the selected uses: node', () => {
    renderSubflow({ selectedStep: 'pay' });

    const hint = screen.getByTestId('flow-node-hint-pay');
    expect(hint).toHaveTextContent('double click to expand');
    // Outside the box and left-aligned with it — the node group is translated to the box's corner.
    expect(hint.getAttribute('x')).toBe('0');
    const box = screen.getByTestId('flow-node-pay').querySelector('.node-box');
    expect(Number(hint.getAttribute('y'))).toBeGreaterThan(Number(box.getAttribute('height')));
  });

  /** Selecting an ordinary step says nothing: there is nothing there to expand. */
  it('stays off a step that is not a sub-flow', () => {
    renderSubflow({ selectedStep: 'report' });

    expect(screen.queryByTestId('flow-node-hint-report')).not.toBeInTheDocument();
  });

  /** Expanded, the double-click collapses — so an invitation to expand would be a false one. */
  it('goes once the sub-flow is drawn', () => {
    renderSubflow({ selectedStep: 'pay', expandedSubflows: ['pay'] });

    expect(screen.getByTestId('flow-node-pay/charge')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-node-hint-pay')).not.toBeInTheDocument();
  });
});

/**
 * 002 §5.4: expanded, a sub-flow's steps are more boxes in the same picture, and nothing said where
 * the caller stopped and the sub-flow began. The band is that boundary and the ring is what ties it
 * to the step it came out of.
 */
describe('FlowGraph sub-flow band', () => {
  const containerNode = (id) => ({
    id,
    kind: 'subflow',
    uses: `../lib/${id}.flow.yml`,
    outputs: [],
    markers: markers(),
    position: { line: 1, column: 1 },
    rank: 0
  });

  const twoSubflows = {
    ...description,
    nodes: [
      containerNode('pay'),
      { ...node('pay/charge', 0), parent: 'pay' },
      containerNode('refund'),
      { ...node('refund/void', 0), parent: 'refund' }
    ],
    edges: [{ from: 'pay', to: 'refund', kind: 'sequence' }]
  };

  const renderBands = (expanded) =>
    render(
      <ThemeProvider theme={theme}>
        <FlowGraph
          description={twoSubflows}
          nodeStates={{}}
          running={false}
          diagnostics={[]}
          selectedStep={undefined}
          expandedSubflows={expanded}
          showDataEdges
          showSlotEdges={false}
          onSelectStep={() => {}}
          onToggleSubflow={() => {}}
        />
      </ThemeProvider>
    );

  /** `translate(x, y)` — where the layout put the group. */
  const at = (testId) => {
    const [x, y] = screen.getByTestId(testId).getAttribute('transform').match(/-?[\d.]+/g).map(Number);
    return { x, y };
  };
  const box = (testId) => {
    const rect = screen.getByTestId(testId);
    return {
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      width: Number(rect.getAttribute('width')),
      height: Number(rect.getAttribute('height'))
    };
  };

  it('draws nothing while every sub-flow is collapsed', () => {
    renderBands([]);

    expect(screen.queryByTestId('flow-subflow-band-pay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-subflow-ring-pay')).not.toBeInTheDocument();
  });

  it('encloses the steps the sub-flow drew, and not its container', () => {
    renderBands(['pay']);

    const band = box('flow-subflow-band-pay');
    const inner = at('flow-node-pay/charge');
    const container = at('flow-node-pay');

    expect(band.x).toBeLessThan(inner.x);
    expect(band.x + band.width).toBeGreaterThan(inner.x + 220);
    expect(band.y).toBeLessThan(inner.y);
    // The container is tied to the band by its ring, not by standing inside it.
    expect(container.x + 220).toBeLessThanOrEqual(band.x);
  });

  it('rings the container in the colour of its band', () => {
    renderBands(['pay']);

    const ring = screen.getByTestId('flow-subflow-ring-pay');
    expect(ring.getAttribute('stroke')).toBe(screen.getByTestId('flow-subflow-band-pay').getAttribute('fill'));
  });

  /** The ring belongs to the drawn band: collapsed, there is nothing for it to point at. */
  it('rings only the container that is open', () => {
    renderBands(['pay']);

    expect(screen.queryByTestId('flow-subflow-ring-refund')).not.toBeInTheDocument();
  });

  it('gives two open sub-flows two colours', () => {
    renderBands(['pay', 'refund']);

    const pay = screen.getByTestId('flow-subflow-band-pay').getAttribute('fill');
    const refund = screen.getByTestId('flow-subflow-band-refund').getAttribute('fill');

    expect(pay).toBeTruthy();
    expect(refund).not.toBe(pay);
  });

  /** Behind the boxes and the lines: a wash drawn over an edge takes the edge's colour with it. */
  it('draws the band before anything it stands behind', () => {
    const { container: root } = renderBands(['pay']);
    const drawn = [...root.querySelectorAll('svg > *')];

    expect(drawn.indexOf(screen.getByTestId('flow-subflow-band-pay'))).toBeLessThan(
      drawn.findIndex((element) => element.contains(screen.getByTestId('flow-node-pay')))
    );
  });
});

/**
 * 002 §5.5 — the stage rules. The engine decides which boundaries can be drawn (001 §5.5 drops the
 * ones the schedule contradicts), so everything here is about placing what it sends.
 */
describe('FlowGraph stages', () => {
  const staged = {
    ...description,
    nodes: [node('login', 0), node('create', 1), node('verify', 2), node('refund', 3)],
    edges: [
      { from: 'login', to: 'create', kind: 'sequence' },
      { from: 'create', to: 'verify', kind: 'sequence' },
      { from: 'verify', to: 'refund', kind: 'sequence' }
    ],
    stages: [
      { name: 'setup', from: 'login', rank: 0 },
      { name: 'test', from: 'create', rank: 1 },
      { name: 'teardown', from: 'refund', rank: 3 }
    ]
  };

  const nodeX = (id) => Number(screen.getByTestId(`flow-node-${id}`).getAttribute('transform').match(/-?[\d.]+/g)[0]);
  const ruleX = (name) => Number(screen.getByTestId(`flow-stage-rule-${name}`).getAttribute('x1'));
  const viewBox = () => screen.getByTestId('flow-graph').getAttribute('viewBox').split(' ').map(Number);

  it('names every stage the engine resolved', () => {
    renderGraphOf(staged, {}, false);

    expect(screen.getByTestId('flow-stage-setup')).toHaveTextContent('setup');
    expect(screen.getByTestId('flow-stage-test')).toHaveTextContent('test');
    expect(screen.getByTestId('flow-stage-teardown')).toHaveTextContent('teardown');
  });

  it('draws each rule in the gap before its own column', () => {
    renderGraphOf(staged, {}, false);

    for (const [name, step] of [['test', 'create'], ['teardown', 'refund']]) {
      // Clear of the box on either side: past the right edge of the column before it, and short of
      // the left edge of the column it opens.
      expect(ruleX(name)).toBeGreaterThan(nodeX(step) - 220);
      expect(ruleX(name)).toBeLessThan(nodeX(step));
    }
    expect(ruleX('test')).toBeLessThan(ruleX('teardown'));
  });

  /** A line down the left edge of the drawing separates the stage from nothing. */
  it('gives a stage at the first column its name and no rule', () => {
    renderGraphOf(staged, {}, false);

    expect(screen.queryByTestId('flow-stage-rule-setup')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-stage-setup')).toBeInTheDocument();
  });

  /** The names need room the halo of a step in the top row is already using. */
  it('opens a strip above the drawing for the names, and only when there are names', () => {
    const { unmount } = renderGraphOf(staged, {}, false);
    const [, withStages] = viewBox();
    unmount();

    renderGraphOf({ ...staged, stages: [] }, {}, false);
    expect(withStages).toBeLessThan(viewBox()[1]);
  });

  it('draws the rules behind the steps they divide', () => {
    const { container: root } = renderGraphOf(staged, {}, false);
    const drawn = [...root.querySelectorAll('svg > *')];

    expect(drawn.indexOf(screen.getByTestId('flow-stage-test'))).toBeLessThan(
      drawn.findIndex((element) => element.contains(screen.getByTestId('flow-node-create')))
    );
  });

  it('draws nothing for a flow that declares no stages', () => {
    renderGraphOf(description, {}, false);

    expect(screen.queryByTestId('flow-stage-setup')).not.toBeInTheDocument();
    expect(document.querySelector('.stage-rule')).toBeNull();
  });
});
