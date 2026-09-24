import styled from 'styled-components';
import BottomSheet from '../BottomSheet';

/**
 * The sheet's chrome is `BottomSheet`'s; what is styled here is the form drawn into it.
 *
 * The controls take the same tokens the collections' request pane gives its own — `theme.input`
 * for a box, `theme.colors.accent` for a tick, `theme.codemirror` through the editor it embeds —
 * so a step reads as a request being written. Bruno's `textbox` class carries no rule of its own:
 * every pane that uses it (the modal, the preferences) styles it in its own wrapper, and one that
 * does not gets the browser's white box whatever the theme.
 */
const StyledWrapper = styled(BottomSheet)`
  /* An arrow typed as the two characters = and > is drawn as one glyph by a font with calt
     ligatures — Fira Code, JetBrains Mono. In a code editor that is the author's own choice of code
     font; in a form control it reads as the app having rewritten what was typed, and an output's
     script form is written into a table cell. The value underneath is the two characters either
     way; this only stops the box from claiming otherwise. The app disables them the same way for
     its diff rows.

     CodeMirror draws its text in divs rather than in the textarea it takes input through, so the
     editors on these tabs keep whatever their code font does. */
  input,
  textarea,
  select {
    font-variant-ligatures: none;
    font-feature-settings: 'liga' 0, 'calt' 0;
  }

  .editor-step {
    font-weight: 500;
  }

  .editor-operation {
    font-family: monospace;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};
  }

  .editor-refusal {
    margin-left: auto;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.danger};
  }

  .editor-dangled {
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.warning};
  }

  /* The label column takes the width of the longest label on the tab and no more — "Id" sits by
     its box rather than a column's width from it — and wraps only past the width the Settings
     tab's sentences would otherwise claim. */
  .editor-fields {
    display: grid;
    grid-template-columns: fit-content(14rem) minmax(0, 1fr);
    gap: 0.375rem 0.75rem;
    align-items: center;
    max-width: 44rem;
  }

  .editor-label {
    font-size: ${(props) => props.theme.font.size.sm};
    font-weight: 500;
    color: ${(props) => props.theme.text};
  }

  .editor-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;

    .textbox {
      flex: 1;
      min-width: 0;
    }
  }

  .editor-hint {
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};
  }

  .editor-value {
    font-family: monospace;
    font-size: ${(props) => props.theme.font.size.base};
  }

  .textbox {
    width: 100%;
    line-height: 1.5;
    padding: 0.25rem 0.5rem;
    font-size: ${(props) => props.theme.font.size.base};
    color: ${(props) => props.theme.text};
    background-color: ${(props) => props.theme.input.bg};
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    outline: none;
    transition: border-color ease-in-out 0.1s;

    &:focus {
      border-color: ${(props) => props.theme.input.focusBorder};
      outline: none;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  /* The native chevron is the platform's and ignores the theme; this one is the modal's. The list
     it opens is painted by the platform too, so its rows are given the page's own colours. */
  select.textbox {
    appearance: none;
    padding-right: 1.75rem;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    cursor: pointer;

    option {
      background-color: ${(props) => props.theme.bg};
      color: ${(props) => props.theme.text};
    }
  }

  /* A select in a row of prose — a dependency's step, the join — sizes to its words. */
  .editor-depends-row select.textbox,
  .editor-check select.textbox {
    width: auto;
  }

  input[type='checkbox'] {
    width: 14px;
    height: 14px;
    margin: 0;
    cursor: pointer;
    accent-color: ${(props) => props.theme.colors.accent};
  }

  .editor-section {
    margin-bottom: 1rem;
  }

  /* The table's own scroll box. It has a floor because the table virtualises its rows against
     this box and the box would otherwise take its height from the rows — a box the height of the
     header alone gives the virtualiser no room to render a row into, and neither ever grows. Tall
     enough that a table of a few rows never scrolls inside it, and bounded so a long one scrolls
     here rather than growing the sheet. */
  .editor-table {
    min-height: 6.75rem;
    max-height: 16rem;
    overflow-y: auto;
  }

  /* §8.2 against §10.2, beside the field it is about: muted, because it is an annotation on the form
     rather than part of it, and it carries its sentence in a title the pointer and a reader both get. */
  .editor-code-marker {
    display: inline-flex;
    align-items: center;
    margin-left: 0.375rem;
    color: ${(props) => props.theme.colors.text.muted};
    cursor: help;
    vertical-align: middle;
  }

  /* An output's script is named by the output it produces — the only thing tying the editor under
     the table to its row. */
  .editor-script-name-label {
    font-family: monospace;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};
  }

  .editor-section-title {
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.subtext0};
    margin-bottom: 0.5rem;
  }

  /* The flow's block, not the step's — set apart from the step's own scripts beneath it as a panel
     in the sidebar's tone, the way the legend sits apart from the drawing. */
  .editor-shared-scripts {
    padding: 0.625rem 0.875rem;
    background: ${(props) => props.theme.sidebar.bg};
    border: 1px solid ${(props) => props.theme.border.border0};
    border-left: 3px solid ${(props) => props.theme.tabs.active.border};
    border-radius: ${(props) => props.theme.border.radius.base};
  }

  .editor-shared-script-add {
    width: auto;
    margin-top: 0.25rem;
    font-size: ${(props) => props.theme.font.size.sm};
    padding-top: 0.125rem;
    padding-bottom: 0.125rem;
  }

  .editor-shared-script {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.125rem 0;

    code {
      font-size: ${(props) => props.theme.font.size.sm};
    }
  }

  .editor-script-entry {
    margin-bottom: 0.5rem;
  }

  .editor-script-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .editor-script-name {
    width: 16rem;
    font-family: monospace;
  }

  /* Three lines of script, boxed: the editor's own border is the page's colour in the dark
     theme, and an unframed editor between two framed names reads as a gap. */
  .editor-body.editor-script-body {
    height: 5rem;
    margin-bottom: 0;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    overflow: hidden;
  }

  /* A box the editor fills and scrolls inside. The height here is what the box is *before* anything
     has been drawn into it — §6.7 sizes it to the document from there, inline, so this is the
     fallback for the first paint and for a host with no ResizeObserver. The border is the editor's
     own. */
  .editor-body {
    height: 12rem;
    margin-bottom: 0.75rem;

    .CodeMirror {
      height: 100%;
    }
  }

  .editor-error {
    margin: -0.5rem 0 0.75rem;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.danger};
  }

  .editor-check {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: ${(props) => props.theme.font.size.base};
  }

  .editor-depends-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.25rem 0;
  }

  .editor-depends-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 0.375rem;
  }

  .editor-script {
    font-family: monospace;
    resize: vertical;
  }

  .editor-export-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    font-size: ${(props) => props.theme.font.size.base};
    padding: 0.125rem 0;

    code {
      font-size: ${(props) => props.theme.font.size.sm};
    }
  }

  .editor-opaque {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid ${(props) => props.theme.border.border0};
  }

  .editor-opaque-title {
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.subtext0};
    margin-bottom: 0.25rem;
  }

  .editor-opaque-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: ${(props) => props.theme.font.size.base};
    padding: 0.125rem 0;

    code {
      font-size: ${(props) => props.theme.font.size.sm};
    }
  }

  .editor-tag {
    font-size: ${(props) => props.theme.font.size.xs};
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
    color: ${(props) => props.theme.colors.text.muted};
  }
`;

export default StyledWrapper;
