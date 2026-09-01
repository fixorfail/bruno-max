import { useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { browseDirectory } from 'providers/ReduxStore/slices/collections/actions';
import { matchLoadedApiSpecs } from 'components/Sidebar/ApiSpecs/matchLoadedApiSpecs';
import { createFlow } from '../actions';
import { kebabCase, flowFileNameError } from '../flowFileName';
import { aliasFor, buildFlowDocument } from './flowDocument';
import StyledWrapper from './StyledWrapper';

/**
 * A blank file name means "call it after the flow", which is what it is called nine times in ten.
 * Kebab-case is the convention the existing flows are named by, and it also happens to drop every
 * character `validateName` would reject — a name with a colon in it still yields a usable file.
 */
const effectiveFileName = ({ fileName, flowName }) => (fileName || '').trim() || kebabCase(flowName || '');

/**
 * 002 §4.1 — starting a flow from the sidebar rather than by hand-writing the file.
 *
 * The form answers the questions a blank `.flow.yml` cannot be written without: where the file goes,
 * what it is called, what it is for, how it is selected, whether it is a library, and which OpenAPI
 * documents it binds. §4.4's properties dialog is the same set once the flow exists.
 * Everything after that is §4.3's editor, which is why nothing here offers to add a step.
 *
 * **The name and the file name are separate fields.** §4.1 lists a flow by its `meta.name`, which is
 * prose — `Order fulfillment` — while the file it lives in is read by people in a directory listing
 * and referenced by `uses:` from other flows. Deriving one from the other is only ever right by
 * default, so it *is* the default: leave the file name blank and it becomes the name in kebab-case.
 *
 * The spec list is the sidebar's own — `matchLoadedApiSpecs` pairs the workspace's entries with the
 * loaded specs in the store — so the two surfaces cannot disagree about what belongs to a workspace.
 */
const CreateFlow = ({ defaultDirectory, onClose }) => {
  const dispatch = useDispatch();
  const allApiSpecs = useSelector((state) => state.apiSpec.apiSpecs);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const activeWorkspace = workspaces.find((workspace) => workspace.uid === activeWorkspaceUid);

  const apiSpecs = useMemo(
    () => matchLoadedApiSpecs(activeWorkspace?.apiSpecs, allApiSpecs),
    [activeWorkspace, allApiSpecs]
  );

  const formik = useFormik({
    initialValues: {
      flowName: '',
      fileName: '',
      flowLocation: defaultDirectory,
      description: '',
      tags: '',
      library: false,
      apiSpecUids: []
    },
    validationSchema: Yup.object({
      // `meta.name` is prose that `js-yaml` will quote for us, so the only thing asked of it is that
      // it is there — the filename rules below belong to the field that becomes a filename.
      flowName: Yup.string().trim().required('Name is required'),
      fileName: Yup.string().test('is-valid-filename', function (value) {
        const error = flowFileNameError(effectiveFileName({ fileName: value, flowName: this.parent.flowName }));
        return error ? this.createError({ message: error }) : true;
      }),
      flowLocation: Yup.string().required('Location is required')
    }),
    onSubmit: async (values) => {
      const selected = values.apiSpecUids
        .map((uid) => apiSpecs.find((apiSpec) => apiSpec.uid === uid))
        .filter(Boolean);

      try {
        await dispatch(
          createFlow({
            fileName: effectiveFileName(values),
            directory: values.flowLocation,
            content: buildFlowDocument({
              name: values.flowName.trim(),
              description: values.description,
              tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
              library: values.library,
              directory: values.flowLocation,
              apiSpecs: selected
            })
          })
        );
        toast.success('Flow created');
        onClose();
      } catch (error) {
        toast.error(error?.message || 'An error occurred while creating the flow');
      }
    }
  });

  /**
   * Filling the field on blur rather than only at submit, so the author sees the file they are about
   * to create and can still overrule it. It fills only a blank field: one that was cleared on
   * purpose is refilled the next time the name is left, which is the same rule stated once.
   */
  const fillFileNameFromName = (event) => {
    formik.handleBlur(event);
    if (!formik.values.fileName.trim()) {
      formik.setFieldValue('fileName', kebabCase(event.target.value));
    }
  };

  const browse = () => {
    dispatch(browseDirectory())
      .then((dirPath) => {
        // The dialog resolves `false` when it is dismissed, which is not a choice of directory.
        if (typeof dirPath === 'string') {
          formik.setFieldValue('flowLocation', dirPath);
        }
      })
      .catch((error) => console.error(error));
  };

  const toggleApiSpec = (uid) => {
    const selected = formik.values.apiSpecUids;
    formik.setFieldValue(
      'apiSpecUids',
      selected.includes(uid) ? selected.filter((entry) => entry !== uid) : [...selected, uid]
    );
  };

  return (
    <StyledWrapper>
      <Modal
        size="md"
        title="Create API Flow"
        confirmText="Create"
        handleConfirm={formik.handleSubmit}
        handleCancel={onClose}
        dataTestId="create-flow"
      >
        <form className="bruno-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="flow-name" className="block font-semibold">
            Flow Name
          </label>
          <input
            id="flow-name"
            type="text"
            name="flowName"
            autoFocus
            className="block textbox mt-2 w-full"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-testid="create-flow-name"
            onChange={formik.handleChange}
            onBlur={fillFileNameFromName}
            value={formik.values.flowName}
          />
          {formik.touched.flowName && formik.errors.flowName ? (
            <div className="text-red-500">{formik.errors.flowName}</div>
          ) : null}

          <label htmlFor="flow-file-name" className="block font-semibold mt-3">
            File Name
          </label>
          <div className="relative">
            <input
              id="flow-file-name"
              type="text"
              name="fileName"
              className="block textbox mt-2 !pr-20 w-full"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder={kebabCase(formik.values.flowName)}
              data-testid="create-flow-file-name"
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              value={formik.values.fileName}
            />
            <div className="absolute right-2 top-0 bottom-0 h-full flex items-center flow-file-extension">
              .flow.yml
            </div>
          </div>
          {formik.touched.fileName && formik.errors.fileName ? (
            <div className="text-red-500">{formik.errors.fileName}</div>
          ) : null}

          <label htmlFor="flow-location" className="block font-semibold mt-3">
            Flow Location
          </label>
          <input
            id="flow-location"
            type="text"
            name="flowLocation"
            readOnly={true}
            className="block textbox mt-2 w-full cursor-pointer"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-testid="create-flow-location"
            title={formik.values.flowLocation}
            value={formik.values.flowLocation}
            onClick={browse}
          />
          {formik.touched.flowLocation && formik.errors.flowLocation ? (
            <div className="text-red-500">{formik.errors.flowLocation}</div>
          ) : null}
          <div className="mt-1">
            <span className="text-link cursor-pointer hover:underline" onClick={browse}>
              Browse
            </span>
            <span className="text-xs opacity-60 ml-2">
              (defaults to the workspace's flows folder)
            </span>
          </div>

          <label htmlFor="flow-description" className="block font-semibold mt-3">
            Description
          </label>
          <textarea
            id="flow-description"
            name="description"
            rows={3}
            className="block textbox mt-2 w-full"
            spellCheck="false"
            data-testid="create-flow-description"
            onChange={formik.handleChange}
            value={formik.values.description}
          />

          <label htmlFor="flow-tags" className="block font-semibold mt-3">
            Tags
          </label>
          <input
            id="flow-tags"
            type="text"
            name="tags"
            className="block textbox mt-2 w-full"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            placeholder="checkout, smoke"
            data-testid="create-flow-tags"
            onChange={formik.handleChange}
            value={formik.values.tags}
          />
          <div className="flow-library-hint">Comma separated. `bru flow run --tags` selects on these.</div>

          <label className="flow-library-option mt-3">
            <input
              type="checkbox"
              name="library"
              className="cursor-pointer"
              data-testid="create-flow-library"
              checked={formik.values.library}
              onChange={formik.handleChange}
            />
            <span className="font-semibold select-none">Library</span>
          </label>
          {/* §12.5's flag is not self-explanatory from its name, and it is the one choice here that
              changes whether the flow runs at all when the folder is run. */}
          <div className="flow-library-hint">
            Excluded from a run of the whole folder — meant to be invoked by other flows.
          </div>

          <div className="block font-semibold mt-3">APIs</div>
          <div className="flow-spec-list mt-2" data-testid="create-flow-api-list">
            {apiSpecs.length === 0 ? (
              <div className="flow-spec-empty">No API specs are open in this workspace.</div>
            ) : (
              apiSpecs.map((apiSpec) => (
                <label className="flow-spec-option" key={apiSpec.uid}>
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    data-testid={`create-flow-api-${apiSpec.filename}`}
                    checked={formik.values.apiSpecUids.includes(apiSpec.uid)}
                    onChange={() => toggleApiSpec(apiSpec.uid)}
                  />
                  <span className="select-none">{apiSpec.name || apiSpec.filename}</span>
                  {/* The alias every step will type, shown where it is chosen rather than
                      discovered after the file is written. */}
                  <span className="flow-spec-alias">{aliasFor(apiSpec)}</span>
                </label>
              ))
            )}
          </div>
        </form>
      </Modal>
    </StyledWrapper>
  );
};

export default CreateFlow;
