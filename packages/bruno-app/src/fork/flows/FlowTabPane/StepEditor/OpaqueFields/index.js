import React from 'react';
import Button from 'ui/Button';

/**
 * 005 §6.4 — the keys of a step the editor will not touch, named rather than hidden.
 *
 * Two kinds: a key this build does not model (a flow written by a newer Bruno, which 001 §15 says
 * must open and must not lose the key), and a value carrying a local tag — a `!file` body, an output
 * suppressed with `!...` — whose structure the form cannot show without inventing a widget for it.
 * The writer leaves both alone by construction, since it visits only the keys an edit names; what
 * this adds is that the author can *see* the key is there, and reach it where it can be edited.
 */
const OpaqueFields = ({ step, onOpenDocument }) => {
  if (!step.opaque.length) {
    return null;
  }

  return (
    <div className="editor-opaque" data-testid="flow-step-opaque">
      <div className="editor-opaque-title">Not editable here</div>
      {step.opaque.map(({ key, tag }) => (
        <div key={key} className="editor-opaque-row" data-testid={`flow-step-opaque-${key}`}>
          <code>{key}</code>
          {tag ? <span className="editor-tag">{tag}</span> : <span className="editor-hint">not a key this version edits</span>}
          <Button
            size="xs"
            variant="outline"
            color="secondary"
            onClick={() => onOpenDocument(step.keyPositions[key] || step.position)}
            data-testid={`flow-step-open-yaml-${key}`}
          >
            Open in YAML
          </Button>
        </div>
      ))}
    </div>
  );
};

export default OpaqueFields;
