import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { updateFlowProperties } from '../actions';
import { fileNameStem, flowFileNameError, FLOW_EXTENSION } from '../flowFileName';
import { retargetFlowTabs } from '../retargetTabs';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §4.4 — a flow's name, on both of the things that carry one.
 *
 * §4.1 already makes the point the whole dialog turns on: a flow is listed by its `meta.name`, which
 * is prose, and lives in a file that is read in a directory listing and named by `uses:` from other
 * flows. `CreateFlow` asks for the two separately for that reason, and once a flow exists there is
 * nowhere else to change either — the raw editor reaches `meta:` and cannot rename a file at all.
 *
 * **The file moves nowhere.** A flow's directory decides its scope (001 §5.1) — which environment
 * tier it resolves against, and which collection's auth it inherits — so a control that quietly
 * relocated it would be changing what the flow *does* from a box labelled with what it is called.
 * Moving a flow is a filesystem operation, and the sidebar re-reads it either way.
 *
 * **A `uses:` reference is not followed.** 001 §5.2 makes a flow's identity its path and says a
 * rename is just a rename; another flow that names this one by path stops resolving, and
 * `bru flow validate` is what says so. Rewriting other files from here would edit flows the author
 * did not open, on a guess about which paths meant this one.
 */
const FlowProperties = ({ flow, properties, onClose }) => {
  const dispatch = useDispatch();
  const [submitting, setSubmitting] = useState(false);

  const formik = useFormik({
    initialValues: {
      fileName: fileNameStem(flow.filename),
      flowName: properties.name || '',
      description: properties.description || '',
      testId: properties.testId || '',
      // Edited as the line an author would write in the file, rather than as a list widget: §5.2
      // spells `tags` as a flow sequence, and a row of chips would be a second way to read the one
      // value the YAML view shows on one line.
      tags: (properties.tags || []).join(', '),
      library: properties.library
    },
    validationSchema: Yup.object({
      flowName: Yup.string().trim().required('Name is required'),
      fileName: Yup.string().test('is-valid-filename', function (value) {
        const error = flowFileNameError((value || '').trim());
        return error ? this.createError({ message: error }) : true;
      })
    }),
    onSubmit: async (values) => {
      const filename = `${values.fileName.trim()}${FLOW_EXTENSION}`;
      const flowName = values.flowName.trim();
      setSubmitting(true);

      try {
        const pathname = await dispatch(
          updateFlowProperties({
            flow,
            filename,
            properties: {
              name: flowName,
              description: values.description,
              // Cleared to `''`, which the writer treats as the key's absence — the same rule the
              // other optional fields are written by, so an edit and an undo leave the file as it
              // was rather than spelling out an empty case id.
              testId: values.testId.trim(),
              tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
              library: values.library
            }
          })
        );

        if (pathname !== flow.pathname) {
          // §4.1 names the run tab by the flow and the raw editor by its file, which is the same
          // rule the sidebar row is drawn by — so both have to be restated, not just the path.
          dispatch(
            retargetFlowTabs({
              from: flow.pathname,
              to: pathname,
              tabNameFor: (type) => (type === 'flow' ? flowName || filename : filename)
            })
          );
        }

        toast.success('Flow properties saved');
        onClose();
      } catch (error) {
        toast.error(error?.message || 'An error occurred while saving the flow properties');
      } finally {
        setSubmitting(false);
      }
    }
  });

  return (
    <StyledWrapper>
      <Modal
        size="md"
        title="Flow Properties"
        confirmText={submitting ? 'Saving…' : 'Save'}
        confirmDisabled={submitting}
        handleConfirm={formik.handleSubmit}
        handleCancel={onClose}
        dataTestId="flow-properties"
      >
        <form className="bruno-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="flow-properties-name" className="block font-semibold">
            Flow Name
          </label>
          <input
            id="flow-properties-name"
            type="text"
            name="flowName"
            autoFocus
            className="block textbox mt-2 w-full"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-testid="flow-properties-name"
            onChange={formik.handleChange}
            onBlur={formik.handleBlur}
            value={formik.values.flowName}
          />
          {formik.touched.flowName && formik.errors.flowName ? (
            <div className="text-red-500">{formik.errors.flowName}</div>
          ) : null}

          <label htmlFor="flow-properties-file-name" className="block font-semibold mt-3">
            File Name
          </label>
          <div className="relative">
            <input
              id="flow-properties-file-name"
              type="text"
              name="fileName"
              className="block textbox mt-2 !pr-20 w-full"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-testid="flow-properties-file-name"
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              value={formik.values.fileName}
            />
            <div className="absolute right-2 top-0 bottom-0 h-full flex items-center flow-file-extension">
              {FLOW_EXTENSION}
            </div>
          </div>
          {formik.touched.fileName && formik.errors.fileName ? (
            <div className="text-red-500">{formik.errors.fileName}</div>
          ) : null}
          {/* 001 §5.2 makes a flow's identity its path, so a rename breaks any `uses:` that named
              the old one — said where the rename is typed rather than found by `bru flow validate`
              afterwards. */}
          <div className="flow-file-hint">
            Renaming does not update flows that reference this one by path.
          </div>

          <label htmlFor="flow-properties-description" className="block font-semibold mt-3">
            Description
          </label>
          <textarea
            id="flow-properties-description"
            name="description"
            rows={3}
            className="block textbox mt-2 w-full"
            spellCheck="false"
            data-testid="flow-properties-description"
            onChange={formik.handleChange}
            value={formik.values.description}
          />

          <label htmlFor="flow-properties-test-id" className="block font-semibold mt-3">
            Test ID
          </label>
          <input
            id="flow-properties-test-id"
            type="text"
            name="testId"
            className="block textbox mt-2 w-full"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-testid="flow-properties-test-id"
            onChange={formik.handleChange}
            value={formik.values.testId}
          />
          {/* The flow's own case id, which nothing in the run reads — it is carried so a report can
              be matched back to the case the flow stands for. */}
          <div className="flow-field-hint">Optional. A test-management case id; reports carry it as `test_id`.</div>

          <label htmlFor="flow-properties-tags" className="block font-semibold mt-3">
            Tags
          </label>
          <input
            id="flow-properties-tags"
            type="text"
            name="tags"
            className="block textbox mt-2 w-full"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            placeholder="checkout, smoke"
            data-testid="flow-properties-tags"
            onChange={formik.handleChange}
            value={formik.values.tags}
          />
          <div className="flow-field-hint">Comma separated. `bru flow run --tags` selects on these.</div>

          <label className="flow-library-option mt-3">
            <input
              type="checkbox"
              name="library"
              className="cursor-pointer"
              data-testid="flow-properties-library"
              checked={formik.values.library}
              onChange={formik.handleChange}
            />
            <span className="font-semibold select-none">Library</span>
          </label>
          {/* §12.5's flag is not self-explanatory from its name, and it is the one choice here that
              changes whether the flow runs at all when the folder is run. */}
          <div className="flow-field-hint">
            Excluded from a run of the whole folder — meant to be invoked by other flows.
          </div>
        </form>
      </Modal>
    </StyledWrapper>
  );
};

export default FlowProperties;
