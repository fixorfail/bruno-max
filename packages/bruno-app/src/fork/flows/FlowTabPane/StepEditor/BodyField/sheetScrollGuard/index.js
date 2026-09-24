const CodeMirror = require('codemirror');

/**
 * An editor inside the step sheet must not scroll the sheet when it restores its cursor.
 *
 * On mount, `CodeEditor` puts the cursor back where it was, and CodeMirror then scrolls that cursor
 * into the window — through every scrollable ancestor. The body editor sits below three tables, so
 * at mount it lies past the sheet's bottom edge, CodeMirror takes that for "off screen", and the
 * Request tab opens with its tables already scrolled out of reach. A request's body in the
 * collections pane never meets this because nothing sits above it.
 *
 * CodeMirror asks before it scrolls the window (`scrollCursorIntoView`), and a handler that prevents
 * the default keeps the scroll inside the editor's own box. The hook is registered once for every
 * editor created afterwards and answers only for one under the marked ancestor, so no other editor
 * in the app changes behaviour.
 */
export const SHEET_EDITOR_ATTRIBUTE = 'data-flow-sheet-editor';

CodeMirror.defineInitHook((editor) => {
  editor.on('scrollCursorIntoView', (instance, event) => {
    if (instance.getWrapperElement().closest(`[${SHEET_EDITOR_ATTRIBUTE}]`)) {
      event.preventDefault();
    }
  });
});
