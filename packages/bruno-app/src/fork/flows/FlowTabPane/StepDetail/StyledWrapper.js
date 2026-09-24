import styled from 'styled-components';
import BottomSheet from '../BottomSheet';

/** The sheet's chrome is `BottomSheet`'s; what is styled here is the run record drawn into it. */
const StyledWrapper = styled(BottomSheet)`
  .detail-step {
    font-weight: 500;
  }

  .detail-status {
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};

    &.success {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.failed {
      color: ${(props) => props.theme.colors.text.danger};
    }

    /* A statement about the report rather than about the step, so it does not wear a status colour. */
    &.unreported {
      font-style: italic;
    }
  }

  .detail-attempt {
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
    background: ${(props) => props.theme.sidebar.collection.item.bg};
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    padding: 0.125rem 0.25rem;
  }

  /* The same two colours the graph's halo uses for the same two states, so the pane and the node
     being read agree about what is happening to the step. */
  .detail-spinner {
    color: ${(props) => props.theme.colors.text.yellow};

    &.retrying {
      color: ${(props) => props.theme.colors.text.warning};
    }
  }

  .detail-duration {
    margin-left: auto;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .detail-paced {
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  /* Wraps rather than truncates: a schema failure names every field it rejected, and half of that
     list is not a shorter version of the answer. */
  .detail-message {
    padding: 0 1rem 0.5rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: ${(props) => props.theme.colors.text.muted};
    overflow-wrap: anywhere;

    &.failed {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .detail-message-toggle {
    margin-top: 0.25rem;
    color: ${(props) => props.theme.colors.text.muted};
    text-decoration: underline;
    text-underline-offset: 2px;

    &:hover {
      color: ${(props) => props.theme.text};
    }
  }

  /* §14.6's message is one sentence for most reasons and a list for the schema ones, where a comma
     run of paths is unreadable at exactly the moment it matters most. */
  /* Expanded, the list scrolls in a box of its own rather than pushing the tabs off the pane: the
     message explains the outcome, and the request that caused it is below. */
  .detail-message-list {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
    list-style: disc;

    &.is-expanded {
      max-height: 14rem;
      overflow-y: auto;
    }

    li {
      padding: 0.0625rem 0;
    }
  }

  .detail-row {
    display: flex;
    gap: 0.5rem;
    font-size: 0.75rem;
    padding: 0.0625rem 0;
  }

  .detail-label {
    color: ${(props) => props.theme.colors.text.muted};
    min-width: 8rem;
  }

  .detail-value {
    word-break: break-all;
  }

  .detail-empty {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 0.75rem;
  }

  /* Reads as the continuation of the sentence above it, because that is what it is — where the
     steps it names can be seen. */
  .detail-expand {
    margin-left: 0.375rem;
    color: ${(props) => props.theme.colors.text.muted};
    border-bottom: 1px dotted currentColor;

    &:hover {
      color: ${(props) => props.theme.text};
    }
  }

  /* A definite height, so CodeMirror is the scroller and keeps virtualizing its lines. Sizing it to
     its content puts every line of a large captured body in the DOM, and 001 §14.5 caps the size of
     a capture nowhere. A definite height also settles the percentage chain the editor sizes itself
     through: it is h-full over an editor-container at 100%, which resolve to nothing over a parent
     that has no height of its own.

     The height is set inline, measured from the content, so the box is as tall as the body it holds
     and the pane is the only thing that scrolls. Past the cap it stays definite and the editor
     scrolls inside it, which is what keeps a very large capture from putting every line in the DOM. */
  .detail-body {
    margin-top: 0.5rem;
    border: 1px solid ${(props) => props.theme.sidebar.collection.item.focusBorder};
    border-radius: 3px;
    overflow: hidden;

    .CodeMirror {
      background: transparent;
      height: 100%;
    }
  }

  .detail-parts {
    margin-top: 0.5rem;
  }

  .detail-table {
    font-size: 0.75rem;
    width: 100%;

    th {
      padding: 0 0.5rem 0.25rem 0;
      text-align: left;
      font-weight: 400;
      color: ${(props) => props.theme.colors.text.muted};
    }

    td {
      padding: 0.125rem 0.5rem 0.125rem 0;
      vertical-align: top;
    }

    tr.passed td:first-child {
      color: ${(props) => props.theme.colors.text.green};
    }

    tr.failed td:first-child {
      color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .detail-headers,
  .detail-outputs {
    margin-top: 0.75rem;
  }

  /* An output that found nothing is a row, not an absence — drawn as the word rather than as a
     value, so it does not read as the string "undefined" the API sent back. */
  .detail-unresolved {
    color: ${(props) => props.theme.colors.text.muted};
    font-style: italic;
  }

  .detail-headers > .detail-label,
  .detail-outputs > .detail-label {
    display: block;
    margin-bottom: 0.125rem;
  }
`;

export default StyledWrapper;
