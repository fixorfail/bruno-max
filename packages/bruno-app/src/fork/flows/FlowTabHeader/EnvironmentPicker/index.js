import React, { forwardRef, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import toast from 'react-hot-toast';
import { IconCaretDown, IconWorld } from '@tabler/icons';
import { transparentize } from 'polished';
import Dropdown from 'components/Dropdown';
import EnvironmentListContent from 'components/Environments/EnvironmentSelector/EnvironmentListContent';
import EnvironmentSelectorWrapper from 'components/Environments/EnvironmentSelector/StyledWrapper';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { selectGlobalEnvironment } from 'providers/ReduxStore/slices/global-environments';

/**
 * 002 §7.2's Environment control — the app's own environment dropdown, in a flow's run
 * configuration.
 *
 * **The list, its styling and its behaviour are upstream's**: `EnvironmentListContent` is the body of
 * the selector a collection's header shows, and it is written against environments rather than
 * against a collection, so it composes here as it stands — search, colour badges, the active tick and
 * the *No Environment* row all included. Its stylesheet comes with it, because the markup is styled
 * by the wrapper the selector puts around it. A bespoke control beside it would be a second answer to
 * a question this app has already answered, drifting from it at the first change.
 *
 * What is *not* reused is upstream's `EnvironmentSelector` itself. It is built around a collection:
 * it opens on the Collection tab, and its configure and create paths key tabs off `collection.uid`.
 * A flow tab does have a collection — §4.2 has it borrow one — but for a workspace-scoped flow that is
 * the workspace's *scratch* collection, which §4.2 is emphatic must never show through as chrome.
 * Offering its environments under a Collection tab is exactly that leak, and it would take an
 * upstream change to suppress.
 *
 * **The selection is the app's, not the flow's.** Every request in the app runs against the same
 * environment, and a flow holding a private one would run against different values than the request
 * in the next tab — the drift this feature exists to remove. So this dispatches the same thunk the
 * collection's selector does, and `tiersFor` needs no notion of a flow having chosen.
 */

/**
 * The trigger's two states, in upstream's own classes: `no-environments` is what carries the dashed
 * border that says *nothing is selected* everywhere else in this app, and a selected environment
 * wears its colour the way the collection header wears it. Both are recognised before they are read,
 * which is the whole reason for putting this where a collection puts it.
 */
const Trigger = forwardRef(({ environment }, ref) =>
  environment ? (
    <div
      ref={ref}
      className="current-environment flex align-center justify-center cursor-pointer bg-transparent"
      style={{ padding: 0 }}
      data-testid="flow-environment"
    >
      <div
        className="flex items-center"
        style={{
          backgroundColor: environment.color ? transparentize(1 - 0.12, environment.color) : 'transparent',
          padding: '0.25rem 0.3rem 0.25rem 0.5rem',
          borderRadius: '0.3rem'
        }}
      >
        <IconWorld size={16} strokeWidth={1.5} style={environment.color ? { color: environment.color } : undefined} />
        <span className="ml-1 max-w-36 truncate no-wrap">{environment.name}</span>
        <IconCaretDown className="caret flex items-center justify-center" size={12} strokeWidth={2} />
      </div>
    </div>
  ) : (
    <div
      ref={ref}
      className="current-environment flex align-center justify-center cursor-pointer bg-transparent no-environments"
      data-testid="flow-environment"
    >
      <span className="env-text-inactive max-w-36 truncate no-wrap">No Environment</span>
      <IconCaretDown className="caret flex items-center justify-center" size={12} strokeWidth={2} />
    </div>
  ));

const EnvironmentPicker = ({ collectionUid }) => {
  const dispatch = useDispatch();
  const dropdownRef = useRef();
  const [searchText, setSearchText] = useState('');

  const environments = useSelector((state) => state.globalEnvironments.globalEnvironments);
  const activeUid = useSelector((state) => state.globalEnvironments.activeGlobalEnvironmentUid);
  const active = activeUid ? find(environments, (entry) => entry.uid === activeUid) : null;
  const hide = () => dropdownRef.current?.hide();

  const select = (environment) => {
    dispatch(selectGlobalEnvironment({ environmentUid: environment?.uid || null }))
      .then(() => {
        // The wording is the selector's, because this *is* that selection: a flow reporting it
        // differently would read as a second, flow-local setting.
        toast.success(environment ? `Environment changed to ${environment.name}` : 'No Environments are active now');
        hide();
      })
      .catch(() => toast.error('An error occurred while selecting the environment'));
  };

  /**
   * Configure, create and import all land in the same place — the workspace's environments — because
   * that is where all three happen. The collection is the one the flow's tab already borrowed (§4.2),
   * which for a workspace flow is the scratch collection that holds `workspaceEnvironments` anyway.
   */
  const openEnvironments = () => {
    dispatch(addTab({ uid: `${collectionUid}-environments`, collectionUid, type: 'workspaceEnvironments' }));
    hide();
  };

  return (
    <EnvironmentSelectorWrapper>
      <div className="environment-selector flex items-center cursor-pointer">
        <Dropdown
          onCreate={(ref) => (dropdownRef.current = ref)}
          onHidden={() => setSearchText('')}
          icon={<Trigger environment={active} />}
          placement="bottom-start"
        >
          <EnvironmentListContent
            environments={environments}
            activeEnvironmentUid={activeUid}
            description="Create your first workspace environment to run flows against."
            onEnvironmentSelect={select}
            onSettingsClick={openEnvironments}
            onCreateClick={openEnvironments}
            onImportClick={openEnvironments}
            searchText={searchText}
            setSearchText={setSearchText}
          />
        </Dropdown>
      </div>
    </EnvironmentSelectorWrapper>
  );
};

export default EnvironmentPicker;
