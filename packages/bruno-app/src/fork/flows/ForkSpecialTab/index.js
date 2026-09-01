import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import find from 'lodash/find';
import toast from 'react-hot-toast';
import SpecialTab from 'components/RequestTabs/RequestTab/SpecialTab';
import { makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { saveFlowSource } from '../actions';
import ConfirmFlowYamlClose from './ConfirmFlowYamlClose';

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
const ForkSpecialTab = ({ tab, onClose }) => {
  const dispatch = useDispatch();
  const [confirming, setConfirming] = useState(false);

  const flow = useSelector((state) => find(state.flows.flows, (entry) => entry.pathname === tab.pathname));
  const source = useSelector((state) => state.flows.sources[tab.pathname]);

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

  return (
    <>
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
      <SpecialTab
        handleCloseClick={handleCloseClick}
        handleDoubleClick={() => dispatch(makeTabPermanent({ uid: tab.uid }))}
        type={tab.type}
        tabName={tab.tabName}
        hasDraft={dirty}
      />
    </>
  );
};

export default ForkSpecialTab;
