import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { renameFlowScript } from '../actions';
import { fileNameStem, flowFileNameError, SCRIPT_EXTENSION } from '../flowFileName';
import { retargetFlowTabs } from '../retargetTabs';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.5 — renaming a script.
 *
 * **A name and nothing else**, which is the whole difference from §4.4's dialog: a flow carries a
 * `meta:` block that its file name is only half of, and a `.js` file carries no metadata at all. A
 * form that offered the same fields would be offering to edit something that does not exist.
 *
 * The file stays in `flows/scripts/`. The directory is what makes a `.js` a listed script (§4.5), so
 * a rename that moved it out would delete it from the sidebar as a side effect of naming it.
 */
const RenameScript = ({ script, onClose }) => {
  const dispatch = useDispatch();
  const [submitting, setSubmitting] = useState(false);

  const formik = useFormik({
    initialValues: { fileName: fileNameStem(script.filename, SCRIPT_EXTENSION) },
    validationSchema: Yup.object({
      fileName: Yup.string().test('is-valid-filename', function (value) {
        const error = flowFileNameError((value || '').trim(), SCRIPT_EXTENSION);
        return error ? this.createError({ message: error }) : true;
      })
    }),
    onSubmit: async (values) => {
      const filename = `${values.fileName.trim()}${SCRIPT_EXTENSION}`;
      setSubmitting(true);

      try {
        const pathname = await dispatch(renameFlowScript({ script, filename }));

        if (pathname !== script.pathname) {
          // §4.5 labels a script tab by its file, which is the only name it has.
          dispatch(retargetFlowTabs({ from: script.pathname, to: pathname, tabNameFor: () => filename }));
        }

        toast.success('Script renamed');
        onClose();
      } catch (error) {
        toast.error(error?.message || 'An error occurred while renaming the script');
      } finally {
        setSubmitting(false);
      }
    }
  });

  return (
    <StyledWrapper>
      <Modal
        size="sm"
        title="Rename Script"
        confirmText={submitting ? 'Renaming…' : 'Rename'}
        confirmDisabled={submitting}
        handleConfirm={formik.handleSubmit}
        handleCancel={onClose}
        dataTestId="rename-script"
      >
        <form className="bruno-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="rename-script-file-name" className="block font-semibold">
            File Name
          </label>
          <div className="relative">
            <input
              id="rename-script-file-name"
              type="text"
              name="fileName"
              autoFocus
              className="block textbox mt-2 !pr-12 w-full"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-testid="rename-script-file-name"
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              value={formik.values.fileName}
            />
            <div className="absolute right-2 top-0 bottom-0 h-full flex items-center script-file-extension">
              {SCRIPT_EXTENSION}
            </div>
          </div>
          {formik.touched.fileName && formik.errors.fileName ? (
            <div className="text-red-500">{formik.errors.fileName}</div>
          ) : null}
          {/* 001 §8.6 resolves a script by the path the flow wrote, so a rename breaks every `use:`
              naming the old one — said where the rename is typed rather than found by
              `bru flow validate` afterwards. */}
          <div className="script-file-hint">
            Flows that <code>use:</code> this script by its old name will stop resolving.
          </div>
        </form>
      </Modal>
    </StyledWrapper>
  );
};

export default RenameScript;
