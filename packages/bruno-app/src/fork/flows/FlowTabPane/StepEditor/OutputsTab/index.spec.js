import React from 'react';

// The tables are upstream's virtualised editor, which jsdom cannot lay out; what this tab adds is
// the list above them, so each table is a marker that says which one it is.
jest.mock('components/EditableTable', () => ({ testId }) => <div data-testid={testId} />);
// The outputs table reaches the real editor for a script row; these scenarios are about the list
// above the tables, so it is stood in for.
jest.mock('components/CodeEditor', () => () => <textarea data-testid="script-editor" />);
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import themes from 'themes/index';
import OutputsTab from './index';

/**
 * 005 §6.2's Outputs tab — a `uses:` step lists what its library exports before what it publishes.
 */
const theme = themes.dark || Object.values(themes)[0];

const renderTab = (fields, node) => {
  const store = configureStore({ reducer: { app: () => ({ preferences: {} }) } });
  return render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <OutputsTab
          step={{ id: 'sign_in', fields, opaque: [] }}
          flow={{ pathname: '/w/flows/checkout.flow.yml' }}
          model={{ vocabulary: {} }}
          node={node}
          onPatch={jest.fn()}
        />
      </ThemeProvider>
    </Provider>
  );
};

describe('the outputs tab', () => {
  it('B4.9 lists a library\'s exports first, as what the caller reads', () => {
    renderTab({ uses: './sign-in.flow.yml' }, { id: 'sign_in', kind: 'subflow', exports: [{ name: 'token', source: 'steps.authenticate.token' }] });

    const exports = screen.getByTestId('flow-step-exports');
    expect(exports).toHaveTextContent('Exported by ./sign-in.flow.yml');
    expect(screen.getByTestId('flow-step-export-token')).toHaveTextContent('steps.sign_in.token');
    expect(screen.getByTestId('flow-step-export-token')).toHaveTextContent('steps.authenticate.token');
    expect(exports.compareDocumentPosition(screen.getByTestId('flow-step-outputs')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says when the library exports nothing, and when it could not be read', () => {
    renderTab({ uses: './empty.flow.yml' }, { id: 'sign_in', kind: 'subflow', exports: [] });
    expect(screen.getByTestId('flow-step-exports')).toHaveTextContent('exports nothing');

    renderTab({ uses: './missing.flow.yml' }, { id: 'sign_in', kind: 'subflow' });
    expect(screen.getAllByTestId('flow-step-exports')[1]).toHaveTextContent('could not be read');
  });

  it('lists no exports for an operation step', () => {
    renderTab({ operation: 'api#charge' }, { id: 'sign_in', kind: 'operation', outputs: [] });

    expect(screen.queryByTestId('flow-step-exports')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-step-outputs')).toBeInTheDocument();
  });

  /**
   * §8.1's name is half of what reads it: everything that reads an output, including this step's own
   * assertions, addresses it as `steps.<id>.<name>` — and the bare name resolves to nothing there
   * without saying so.
   */
  it('says how an output is referenced, with this step\'s own id', () => {
    renderTab({ outputs: { token: 'data.token' } });

    expect(screen.getByTestId('flow-step-outputs')).toHaveTextContent('Reference these outputs with steps.sign_in.<output>');
  });

  it('says it of the outputs only — a slot is a name, not a reference', () => {
    renderTab({ shared: { sessionToken: 'token' } });

    expect(screen.getByTestId('flow-step-shared')).not.toHaveTextContent('Reference these outputs');
  });
});
