import { IconAlertTriangle } from '@tabler/icons';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import Portal from 'ui/Portal';

/**
 * 005 §7.4: the prompt before a revert.
 *
 * Asked because the way back is not guaranteed. ⌘Z takes a revert back like any other edit, but
 * §7.3 ends that history at the first hand-typed line — so a draft written partly in the YAML tab is
 * gone for good. An editor may lose work to a deliberate answer, never to a click.
 *
 * `ConfirmFlowYamlClose`'s shape, for its reason: this is the second place a flow tab asks before
 * discarding a draft, and two prompts about the same loss should not look like different kinds of
 * loss.
 */
const ConfirmRevert = ({ name, onCancel, onRevert }) => (
  <Portal>
    <Modal
      size="md"
      title="Revert changes"
      closeModalFadeTimeout={150}
      handleCancel={onCancel}
      hideFooter={true}
      dataTestId="confirm-flow-revert"
    >
      <div className="flex items-center font-normal">
        <IconAlertTriangle size={32} strokeWidth={1.5} className="text-yellow-600" />
        <h1 className="ml-2 text-lg font-medium">Hold on..</h1>
      </div>
      <div className="font-normal mt-4">
        This discards every change made to <span className="font-medium">{name}</span> since it was opened.
      </div>

      <div className="flex justify-end gap-2 mt-6">
        <Button color="secondary" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button color="danger" onClick={onRevert} data-testid="confirm-flow-revert-discard">
          Revert
        </Button>
      </div>
    </Modal>
  </Portal>
);

export default ConfirmRevert;
