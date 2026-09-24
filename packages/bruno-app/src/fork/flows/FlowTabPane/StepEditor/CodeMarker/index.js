import React, { useId } from 'react';
import { IconCode, IconMathFunction } from '@tabler/icons';
import { Tooltip } from 'react-tooltip';

/**
 * What a field is evaluated as — 001 §8.2 against §10.2, said where the field is rather than in the
 * documentation.
 *
 * The two look alike and behave differently, and nothing on screen said which was which. A script
 * position runs through the engine's script runner, so the flow's shared functions (§8.6's
 * `functions.use:`) are composed around it and are in scope by name. An expression position is
 * evaluated on its own: the same call there resolves to nothing, and because a missing value is an
 * ordinary failed assertion rather than a crashed run (§10.2), it fails without saying why. That
 * silence is the whole reason this marker exists — the box that most invites a shared function is
 * the one that says least when you use one.
 *
 * Marked at the label rather than inside the control: half of these are cells in a table, where an
 * adornment would take width the value needs, and the sentence is the payload either way.
 *
 * **`react-tooltip`, not the `title` attribute.** A native tooltip waits about a second before it
 * appears, which is long enough that a reader scanning the form never sees it; the app's own help
 * tooltips are this component, shown on hover with no delay, and a marker that behaved differently
 * from every other hint in the window would read as a different kind of thing. `aria-label` carries
 * the same sentence for anyone not hovering anything.
 */

const KINDS = {
  script: {
    Icon: IconCode,
    label: 'Takes a script — the flow\'s shared functions are in scope.'
  },
  expression: {
    Icon: IconMathFunction,
    label:
      'Takes a JavaScript expression — shared functions are not in scope here. '
      + 'To use one, compute the value in an output and assert on that.'
  }
};

const CodeMarker = ({ kind }) => {
  const { Icon, label } = KINDS[kind];
  // One id per marker: several of these sit on a tab, and a shared one would anchor them all to the
  // first icon rendered. `useId` spells its ids with colons, which are legal in an id attribute and
  // not in the `#id` selector anything reading this one would reach for.
  const id = `flow-code-marker-${useId().replace(/:/g, '')}`;

  return (
    <span className="editor-code-marker" role="img" aria-label={label} data-testid={`flow-code-marker-${kind}`}>
      <Icon size={14} strokeWidth={1.5} data-tooltip-id={id} />
      <Tooltip className="tooltip-mod" id={id} content={label} delayShow={0} />
    </span>
  );
};

export default CodeMarker;
