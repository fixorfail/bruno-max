import React from 'react';

/**
 * §4.1a's depth, drawn as upstream's collection tree draws it: one block per level, each carrying the
 * tree's guide line. A row directly in a bucket is one level in, as a request directly in a collection
 * is, so `depth` 0 draws one block.
 */
const IndentBlocks = ({ depth }) =>
  Array.from({ length: depth + 1 }, (_, level) => <div key={level} className="indent-block" aria-hidden="true" />);

export default IndentBlocks;
