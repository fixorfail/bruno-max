import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import toast from 'react-hot-toast';
import SpecialTab from 'components/RequestTabs/RequestTab/SpecialTab';
import { makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { saveFlowSource } from '../actions';
import { flowLabel } from '../flowTree';
import ConfirmFlowYamlClose from './ConfirmFlowYamlClose';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.2, §4.3 and §4.5's tabs in the strip, with the one thing upstream's `SpecialTab` cannot
 * supply for them: whether the file behind the tab has unsaved work, and what to do about it on a
 * close.
 *
 * **`SpecialTab` is rendered rather than replaced.** The icon, the label delegation, the close
 * button and the double-click-to-pin all already work for a flow tab; the only two things it lacks
 * are inputs — `hasDraft`, and a close handler that can refuse. Reimplementing the tab to add them
 * would be a copy of an upstream component to keep in step with forever.
 *
 * **Why the fork has to be the one asking.** A dirty flow editor is the only unsaved state in the
 * app that upstream cannot see: every other draft hangs off a collection item, and §4.3's and
 * §4.5's live in the flows slice keyed by path. Closing one is not destructive *within a session* —
 * the slice keeps the draft and reopening the tab restores it — but nothing persists that slice, so
 * a quit after the close loses the edit with nothing having said so.
 */
/**
 * What a fork tab is called, from the flow it is a view of — §4.2's run view reads by `meta.name`
 * the way §4.1's sidebar row does, and §4.3's editor, §4.5's script and §4.6's fixture are views of
 * a *file* and keep its filename.
 *
 * `undefined` for a flow no longer in the tree, which is what upstream's own fallback is for.
 */
const labelFor = (tab, flow) => {
  if (!flow) {
    return undefined;
  }
  return tab.type === 'flow' ? flowLabel(flow) : flow.filename;
};

const ForkSpecialTab = ({ tab, onClose }) => {
  const dispatch = useDispatch();
  const [confirming, setConfirming] = useState(false);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const source = useSelector((state) => state.flows.sources[tab.pathname]);
  const run = useSelector((state) => state.flows.runs[tab.pathname]);

  // §4.2's run view is a view of a file it never edits, so it never has anything to ask about. The
  // two editing tabs — §4.3's YAML and §4.5's script — both can.
  const dirty = tab.type !== 'flow' && Boolean(source) && source.content !== source.saved;

  const handleCloseClick = (event) => {
    if (!dirty) {
      onClose(event);
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    setConfirming(true);
  };

  const saveAndClose = (event) => {
    dispatch(saveFlowSource(flow))
      .then(() => {
        setConfirming(false);
        onClose(event);
      })
      // The tab stays open on a failed save, which is the whole point of asking: closing anyway
      // would discard the edit the dialog just promised to keep. The pane states the error too.
      .catch((error) => toast.error(error?.message || 'The flow could not be saved'));
  };

  /**
   * §4.1: the tab label carries the run's mark, the way the sidebar row does — a running indicator
   * while the run executes, and a pass/fail mark when it ends, cleared the next time the flow is
   * opened. §4.2 keeps a run alive across a closed tab and across a tab that is merely not focused,
   * so without this a run can be in flight with nothing in the strip saying so.
   *
   * Only §4.2's run view has one. §4.3's editor, §4.5's script and §4.6's fixture are views of a
   * file, and a mark on them would attach a run to a tab that cannot start or show one.
   */
  const mark = tab.type === 'flow' && run && (run.state === 'running' || !run.outcomeSeen)
    ? run.state === 'running' ? 'running' : run.status || run.state
    : undefined;

  return (
    <StyledWrapper>
      {confirming ? (
        <ConfirmFlowYamlClose
          name={tab.tabName}
          onCancel={() => setConfirming(false)}
          onCloseWithoutSave={(event) => {
            setConfirming(false);
            onClose(event);
          }}
          onSaveAndClose={saveAndClose}
        />
      ) : null}
      {mark ? (
        <span className={`flow-tab-mark ${mark}`} data-status={mark} data-testid={`flow-tab-mark-${tab.pathname}`} />
      ) : null}
      <SpecialTab
        handleCloseClick={handleCloseClick}
        handleDoubleClick={() => dispatch(makeTabPermanent({ uid: tab.uid }))}
        type={tab.type}
        /**
         * §4.2's tab survives a restart through the snapshot, and `tabName` does not: `addTab`
         * destructures the fields it keeps and upstream's serializer records a tab's `name`, so a
         * restored flow tab arrives with neither and its label reads as the literal word "Flow".
         *
         * The flow is what the label is *of*, so it is derived from the flow rather than carried —
         * which also keeps the strip agreeing with §4.1's sidebar row after a `meta.name` is edited
         * on disk, the same way §4.1 requires the two never to disagree about what a flow is called.
         */
        tabName={tab.tabName || labelFor(tab, flow)}
        hasDraft={dirty}
      />
    </StyledWrapper>
  );
};

export default ForkSpecialTab;
