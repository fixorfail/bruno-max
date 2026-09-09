/**
 * 002 §4.3 and §6 — the engine's diagnostics, marked in the editor's own gutter.
 *
 * §6 makes the document view the primary diagnostic surface and 001 §13.2 returns a `line` for
 * exactly this: a diagnostic about `depends` is most useful beside the `depends` that caused it, and
 * a list under the graph can only ever say which line to go and look at. The mark is what puts the
 * statement where the text is.
 *
 * It writes into CodeMirror directly rather than rendering React into the gutter, because the gutter
 * is not part of this component's tree — CodeMirror owns those elements and rebuilds them when it
 * redraws. Everything here is therefore idempotent: each pass re-asserts the gutter, clears it, and
 * draws the current set.
 */

/**
 * Fork-owned, and named so it cannot collide with the two gutters upstream's editor declares
 * (`CodeMirror-linenumbers`, `CodeMirror-foldgutter`). It doubles as the gutter column's CSS class,
 * which is how CodeMirror names them.
 */
export const FLOW_GUTTER_ID = 'flow-diagnostics';

/** 001 §13.2's positions are one-based, as an editor's error messages are; CodeMirror's are not. */
const toEditorLine = (line) => Math.max(line - 1, 0);

/**
 * A diagnostic marks this document only when its line is *in* this document.
 *
 * A connector-file check (001 §8.5) names the `connectors.yml` the entry is written in and a line in
 * **that** file (§6), so marking the flow's own gutter at that number would put an authoritative mark
 * on unrelated text. §6's list states such a diagnostic with its file named and offers no control for
 * the same reason; the gutter has no way to state a file at all, so it leaves the line alone.
 *
 * A diagnostic carrying no file is taken as this flow's, matching how §4.2's list decides it.
 */
export const inThisDocument = (diagnostic, pathname) =>
  typeof diagnostic.line === 'number' && (!diagnostic.file || diagnostic.file === pathname);

const byLine = (diagnostics) => {
  const lines = new Map();

  diagnostics.forEach((diagnostic) => {
    const existing = lines.get(diagnostic.line);
    if (existing) {
      existing.push(diagnostic);
      return;
    }
    lines.set(diagnostic.line, [diagnostic]);
  });

  return lines;
};

/**
 * One mark per line, whatever the line has on it: two marks in one gutter cell would overlap, and a
 * line with two problems is still one place to go and look. It takes the louder severity, because
 * severity is what decides whether a run is blocked (§6), and its tooltip carries every diagnostic
 * with its stable code (001 §14.6) so the mark is readable without going to the list.
 *
 * Clicking it does what §6's `line N` control does, so the two surfaces cannot send a reader to
 * different places. It is deliberately not a focusable control: CodeMirror's gutter is outside the
 * tab order and putting it in would make every diagnostic a stop on the way into the text — the list
 * under the graph is the keyboard-reachable surface for the same anchors.
 */
const markerFor = (line, diagnostics, onAnchor) => {
  const severity = diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'error' : 'warning';
  const marker = document.createElement('div');

  marker.className = `flow-gutter-marker ${severity}`;
  marker.title = diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
  marker.setAttribute('data-testid', `flow-gutter-${line}`);
  marker.setAttribute('data-severity', severity);
  marker.textContent = '●';
  marker.onclick = () => onAnchor(diagnostics[0]);

  return marker;
};

/**
 * Draws the current diagnostics into the editor's gutter, replacing whatever was there.
 *
 * The gutter is asserted here rather than only on mount because upstream's `CodeEditor` owns the
 * `gutters` option and rewrites it whole when it swaps editor profiles — a file with a long line
 * enters degraded mode with no gutters at all, and leaving it restores upstream's two. Adding ours
 * back on every pass is what survives that; adding it only when it is missing is what keeps
 * CodeMirror from rebuilding its gutter columns on every describe.
 */
export const renderDiagnosticGutter = ({ editor, diagnostics, pathname, onAnchor }) => {
  const gutters = editor.getOption('gutters') || [];
  if (!gutters.includes(FLOW_GUTTER_ID)) {
    editor.setOption('gutters', [FLOW_GUTTER_ID, ...gutters]);
  }

  editor.clearGutter(FLOW_GUTTER_ID);

  byLine(diagnostics.filter((diagnostic) => inThisDocument(diagnostic, pathname))).forEach((entries, line) => {
    editor.setGutterMarker(toEditorLine(line), FLOW_GUTTER_ID, markerFor(line, entries, onAnchor));
  });
};
