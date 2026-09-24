import React, { useRef } from 'react';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { useContentHeight } from 'fork/hooks/useContentHeight';
import { SHEET_EDITOR_ATTRIBUTE } from '../../BodyField/sheetScrollGuard';

/**
 * One output's script — 001 §8.1's `script:` form, under the table rather than inside it.
 *
 * A function is not written in a table cell, and it is not written in a row that grew one either:
 * a cell of a table sets the width it may use and the rows around it move whenever it changes
 * height. Below the table each script has the width of the pane and a heading naming the output it
 * produces, which is the only thing tying it to its row.
 *
 * **The box is the size of the script**, by the same measurement the body editor uses — so a
 * one-line extractor is one line tall and a long one opens to what it needs.
 */

/** Room for about two lines with nothing in it, and a ceiling a long script scrolls inside. */
const MIN_SCRIPT_HEIGHT = 64;
const MAX_SCRIPT_HEIGHT = 600;

const OutputScript = ({ name, value, docKey, names, onEdit }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const boxRef = useRef(null);
  const height = useContentHeight({ boxRef, key: docKey, min: MIN_SCRIPT_HEIGHT, max: MAX_SCRIPT_HEIGHT });

  return (
    <div className="editor-script-entry" data-testid={`flow-step-output-script-${name}`}>
      <div className="editor-script-head">
        {/* Which output this is the script for — the only thing tying the editor to its row. */}
        <code className="editor-script-name-label">{name || 'this output'}</code>
      </div>
      <div
        ref={boxRef}
        className="editor-body editor-script-body"
        style={height === null ? undefined : { height }}
        {...{ [SHEET_EDITOR_ATTRIBUTE]: '' }}
      >
        <CodeEditor
          docKey={docKey}
          theme={displayedTheme}
          font={get(preferences, 'font.codeFont', 'default')}
          fontSize={get(preferences, 'font.codeFontSize')}
          value={value}
          mode="javascript"
          knownGlobals={names}
          enableVariableHighlighting={false}
          enableBrunoVarInfo={false}
          onEdit={onEdit}
          onRun={() => {}}
        />
      </div>
    </div>
  );
};

export default OutputScript;
