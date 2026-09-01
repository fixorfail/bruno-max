import { IconAlertTriangle } from '@tabler/icons';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import Portal from 'ui/Portal';

/**
 * 002 §4.3: closing a raw editor that has unsaved YAML.
 *
 * Upstream's `ConfirmRequestClose` shape, deliberately — a flow's editor is one more tab in the same
 * strip, and an unsaved-changes prompt that looked or behaved differently would read as a different
 * kind of loss than the one three tabs along. It is a separate component only because that one is
 * built around a collection `item`, which a flow does not have.
 */
const ConfirmFlowYamlClose = ({ name, onCancel, onCloseWithoutSave, onSaveAndClose }) => (
  <Portal>
    <Modal
      size="md"
      title="Unsaved changes"
      disableEscapeKey={true}
      disableCloseOnOutsideClick={true}
      closeModalFadeTimeout={150}
      handleCancel={onCancel}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      hideFooter={true}
      dataTestId="confirm-flow-yaml-close"
    >
      <div className="flex items-center font-normal">
        <IconAlertTriangle size={32} strokeWidth={1.5} className="text-yellow-600" />
        <h1 className="ml-2 text-lg font-medium">Hold on..</h1>
      </div>
      <div className="font-normal mt-4">
        You have unsaved changes in <span className="font-medium">{name}</span>.
      </div>

      <div className="flex justify-between mt-6">
        <div>
          <Button color="danger" onClick={onCloseWithoutSave} data-testid="confirm-flow-yaml-close-discard">
            Don't Save
          </Button>
        </div>
        <div className="flex gap-2">
          <Button color="secondary" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSaveAndClose} data-testid="confirm-flow-yaml-close-save">
            Save
          </Button>
        </div>
      </div>
    </Modal>
  </Portal>
);

export default ConfirmFlowYamlClose;
