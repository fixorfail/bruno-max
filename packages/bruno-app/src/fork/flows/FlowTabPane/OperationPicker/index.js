import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { search } from 'fast-fuzzy';
import Modal from 'components/Modal';
import SearchInput from 'components/SearchInput';
import { listFlowOperations } from '../../actions';
import StyledWrapper from './StyledWrapper';

/**
 * 005 §5.1 — choosing the operation a new step calls.
 *
 * The list is the engine's (§9.3): every operation of every API the *draft* binds, loaded through
 * the loader a run uses, so what is offered here is what the run can resolve — and a binding added
 * on the legend a moment ago is offered before the file is saved. The renderer holds parsed specs
 * of its own and could walk them; it does not, because it cannot know an id is declared twice, and
 * does not hold the documents a flow binds from outside the workspace.
 *
 * Two markings. `deprecated` is drawn as such and still selectable — the author knows their API.
 * `ambiguous` is listed, marked and not selectable: the id is declared twice, so 001 §6.5 refuses a
 * reference to it, and hiding the operation would send the author looking for something they can
 * see in the spec. Its method-and-path reference is what the row offers instead, since 001 §6.1's
 * fallback is exactly what an ambiguous id needs.
 *
 * Upstream's `SearchInput` is reused here where 002 §12.1 declined it for the sidebar: it autofocuses
 * and carries a fixed DOM id, which is wrong for a row that is always rendered and right for a
 * modal that is rendered only while open, once.
 */

const searchKey = (operation) =>
  [operation.method, operation.path, operation.operationId, operation.summary, ...(operation.tags || [])]
    .filter(Boolean)
    .join(' ');

const OperationRow = ({ operation, onPick }) => (
  <button
    type="button"
    className={`picker-operation${operation.deprecated ? ' deprecated' : ''}`}
    disabled={operation.ambiguous}
    onClick={() => onPick(operation)}
    title={operation.ambiguous ? `${operation.operationId} is declared twice in this document — pick it by method and path` : undefined}
    data-testid={operation.ambiguous ? `flow-operation-ambiguous-${operation.reference}` : `flow-operation-${operation.reference}`}
  >
    <span className="picker-method">{operation.method}</span>
    <span className="picker-path">
      {operation.path}
      {operation.deprecated ? <span className="picker-tag">deprecated</span> : null}
      {operation.ambiguous ? <span className="picker-tag">ambiguous id</span> : null}
    </span>
    {operation.summary || operation.operationId ? (
      <span className="picker-summary">{[operation.operationId, operation.summary].filter(Boolean).join(' — ')}</span>
    ) : null}
  </button>
);

/** The rail's last entry, after the aliases — the libraries the flow may `uses:` (§5.1). */
const LIBRARIES = 'libraries';

const librarySearchKey = (library) => [library.name, library.filename, ...(library.terms || [])].filter(Boolean).join(' ');

/** Where the library lives, said from the workspace rather than as the absolute path the tree holds. */
const libraryPlace = (library, flow) =>
  library.pathname.startsWith(flow.workspaceRoot) ? library.pathname.slice(flow.workspaceRoot.length).replace(/^[\\/]/, '') : library.pathname;

const LibraryRow = ({ library, flow, onPick }) => (
  <button type="button" className="picker-operation picker-library" onClick={() => onPick(library)} data-testid={`flow-library-${library.filename}`}>
    <span className="picker-method">flow</span>
    <span className="picker-path">{library.name || library.filename}</span>
    <span className="picker-summary">{libraryPlace(library, flow)}</span>
  </button>
);

/**
 * The picker hands back what the new step declares — `{ operation }` as the `alias#reference` its
 * `operation:` will read, or `{ uses }` as the library's path for the host to relativize (§9.4) —
 * and the caller writes the step. `libraries` is the rail's last entry, and empty where the caller
 * is changing an existing step's operation, which a library is not.
 */
const OperationPicker = ({ flow, content, libraries = [], onPick, onClose }) => {
  const dispatch = useDispatch();
  const [loaded, setLoaded] = useState();
  const [alias, setAlias] = useState();
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    let current = true;
    dispatch(listFlowOperations(flow, content))
      .then((result) => current && setLoaded(result))
      .catch((error) => current && setLoaded({ apis: [], error: error.message }));
    return () => {
      current = false;
    };
  }, [dispatch, flow, content]);

  const apis = loaded?.apis || [];
  const chosen = alias === LIBRARIES && libraries.length ? LIBRARIES : apis.find((entry) => entry.alias === alias) || apis[0] || (libraries.length ? LIBRARIES : undefined);
  const query = searchText.trim();
  const listingLibraries = chosen === LIBRARIES;
  const operations = chosen && !listingLibraries
    ? query
      ? search(query, chosen.operations, { keySelector: searchKey })
      : chosen.operations
    : [];
  const shownLibraries = listingLibraries ? (query ? search(query, libraries, { keySelector: librarySearchKey }) : libraries) : [];

  return (
    <Modal size="lg" title="Add a step" handleCancel={onClose} hideFooter dataTestId="flow-operation-picker">
      <StyledWrapper>
        {!loaded ? <div className="picker-empty">Reading the flow's APIs…</div> : null}

        {loaded && !apis.length && !libraries.length ? (
          <div className="picker-empty" data-testid="flow-operation-picker-empty">
            {loaded.error || 'This flow binds no API yet — add one on the legend, and its operations will be offered here.'}
          </div>
        ) : null}

        {loaded && chosen ? (
          <>
            <div className="picker-apis" role="tablist">
              {apis.map((entry) => (
                <button
                  key={entry.alias}
                  type="button"
                  role="tab"
                  className={entry === chosen ? 'active' : ''}
                  onClick={() => setAlias(entry.alias)}
                  data-testid={`flow-operation-api-${entry.alias}`}
                >
                  {entry.alias}
                </button>
              ))}
              {libraries.length ? (
                <button
                  type="button"
                  role="tab"
                  className={`picker-libraries${listingLibraries ? ' active' : ''}`}
                  onClick={() => setAlias(LIBRARIES)}
                  data-testid="flow-operation-libraries"
                >
                  Libraries
                </button>
              ) : null}
            </div>

            <div className="picker-operations">
              <SearchInput
                searchText={searchText}
                setSearchText={setSearchText}
                placeholder={listingLibraries ? 'Search libraries' : 'Search operations'}
                data-testid="flow-operation-search"
              />

              {!listingLibraries && chosen.error ? (
                <div className="picker-error" data-testid="flow-operation-api-error">
                  {`${chosen.source} could not be read — ${chosen.error}`}
                </div>
              ) : null}

              <div className="picker-list">
                {operations.map((operation) => (
                  <OperationRow
                    key={`${operation.method} ${operation.path}`}
                    operation={operation}
                    onPick={(picked) => onPick({ operation: `${chosen.alias}#${picked.reference}` })}
                  />
                ))}
                {shownLibraries.map((library) => (
                  <LibraryRow key={library.pathname} library={library} flow={flow} onPick={(picked) => onPick({ uses: picked.pathname })} />
                ))}
                {listingLibraries && !shownLibraries.length ? <div className="picker-empty">No library matches</div> : null}
                {!listingLibraries && !chosen.error && !operations.length ? (
                  <div className="picker-empty">{query ? 'No operation matches' : 'This document declares no operations'}</div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </StyledWrapper>
    </Modal>
  );
};

export default OperationPicker;
