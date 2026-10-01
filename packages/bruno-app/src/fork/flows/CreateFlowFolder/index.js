import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { validateName, validateNameError } from 'utils/common/regex';
import { createFlowFolder } from '../actions';

/**
 * 002 §4.1d — a new, empty folder under `parent`, which is a directory of `scope`'s `flows/`.
 *
 * The name is checked with upstream's own rule for a file or folder name, so a folder the collection
 * tree would refuse is refused here too. The host adds the rules only it can apply: the bucket
 * directories at the top of `flows/`, and a name already taken.
 *
 * `onCreated` receives the new folder's path. The section opens the folder it was made in, so the new
 * row is seen, and remembers a folder made from the `Libraries` label.
 */
const CreateFlowFolder = ({ scope, parent, onCreated, onClose }) => {
  const dispatch = useDispatch();
  const [submitting, setSubmitting] = useState(false);

  const formik = useFormik({
    initialValues: { folderName: '' },
    validationSchema: Yup.object({
      folderName: Yup.string()
        .trim()
        .required('Folder name cannot be empty.')
        .test('is-valid-name', function (value) {
          return validateName(value || '') ? true : this.createError({ message: validateNameError(value || '') });
        })
    }),
    onSubmit: async (values) => {
      setSubmitting(true);

      try {
        const pathname = await dispatch(createFlowFolder({ scope, parent, name: values.folderName.trim() }));
        toast.success('Folder created');
        onCreated(pathname);
        onClose();
      } catch (error) {
        toast.error(error?.message || 'An error occurred while creating the folder');
      } finally {
        setSubmitting(false);
      }
    }
  });

  return (
    <Modal
      size="sm"
      title="New Folder"
      confirmText={submitting ? 'Creating…' : 'Create'}
      confirmDisabled={submitting}
      handleConfirm={formik.handleSubmit}
      handleCancel={onClose}
      dataTestId="create-flow-folder"
    >
      <form className="bruno-form" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="create-flow-folder-name" className="block font-semibold">
          Folder Name
        </label>
        <input
          id="create-flow-folder-name"
          type="text"
          name="folderName"
          autoFocus
          className="block textbox mt-2 w-full"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          data-testid="create-flow-folder-name"
          onChange={formik.handleChange}
          onBlur={formik.handleBlur}
          value={formik.values.folderName}
        />
        {formik.touched.folderName && formik.errors.folderName ? (
          <div className="text-red-500">{formik.errors.folderName}</div>
        ) : null}
      </form>
    </Modal>
  );
};

export default CreateFlowFolder;
