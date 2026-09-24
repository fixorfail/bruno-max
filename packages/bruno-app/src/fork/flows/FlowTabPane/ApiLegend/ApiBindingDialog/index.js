import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import Modal from 'components/Modal';
import { matchLoadedApiSpecs } from 'components/Sidebar/ApiSpecs/matchLoadedApiSpecs';
import { aliasFor, uniqueAlias } from '../../../CreateFlow/flowDocument';

/**
 * 005 §5.5 — one `apis:` binding, as the legend adds or edits it.
 *
 * The document is chosen from the workspace's API Specs paired with what is loaded, exactly as 002
 * §4.1c's create form pairs them, and the alias is derived from the document's filename by the same
 * rule and shown for the same reason — it is what every step will type. What is sent is the spec's
 * path as the renderer knows it, absolute; the host relativizes it against the flow's directory,
 * since paths are the host's (§9.4).
 *
 * Editing keeps the source the file wrote unless a different document is chosen: a relative path
 * is not something this dialog can match to the workspace's list, and rewriting it to an absolute
 * one it happened to resolve would be a change the author did not ask for.
 *
 * **Everything the binding says is carried, whether or not this form draws it.** `api.update` leaves
 * a key the engine does not model alone (§9.1), but a *modelled* key the draft omits is how this
 * form clears one — so a modelled field the dialog dropped would be deleted from the file by an edit
 * to the colour. `defaultHeaders:` and `defaultQuery:` are carried through untouched for exactly
 * that reason, and are edited in the YAML tab until this form grows a table for them.
 */

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `strictNulls` is a boolean whose meaningful value is `false`, so its absence is its own state. */
const nullState = (value) => (value === true ? 'on' : value === false ? 'off' : 'default');

const numberOrUndefined = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : NaN;
};

const ApiBindingDialog = ({ binding, taken, authProfiles, onSubmit, onClose }) => {
  const allApiSpecs = useSelector((state) => state.apiSpec.apiSpecs);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const activeWorkspace = workspaces.find((workspace) => workspace.uid === activeWorkspaceUid);
  const apiSpecs = useMemo(() => matchLoadedApiSpecs(activeWorkspace?.apiSpecs, allApiSpecs), [activeWorkspace, allApiSpecs]);

  const editing = Boolean(binding);
  const [specUid, setSpecUid] = useState('');
  const [alias, setAlias] = useState(binding?.alias || '');
  const [aliasTouched, setAliasTouched] = useState(editing);
  const [auth, setAuth] = useState(binding?.auth || '');
  const [color, setColor] = useState(binding?.color || '');
  const [baseUrl, setBaseUrl] = useState(binding?.baseUrl || '');
  const [requests, setRequests] = useState(binding?.rateLimit?.requests === undefined ? '' : String(binding.rateLimit.requests));
  const [per, setPer] = useState(binding?.rateLimit?.per || 'second');
  const [burst, setBurst] = useState(binding?.rateLimit?.burst === undefined ? '' : String(binding.rateLimit.burst));
  const [strictNulls, setStrictNulls] = useState(nullState(binding?.strictNulls));

  const spec = apiSpecs.find((entry) => entry.uid === specUid);
  const source = spec ? spec.pathname : binding?.source || '';
  const others = new Set(taken.filter((name) => name !== binding?.alias));

  const chooseSpec = (uid) => {
    setSpecUid(uid);
    const chosen = apiSpecs.find((entry) => entry.uid === uid);
    // The alias follows the document until the author has typed one — the same default 002 §4.1c's
    // form applies, for the same reason: it is only ever right by default.
    if (chosen && !aliasTouched) {
      setAlias(uniqueAlias(aliasFor(chosen), new Set(others)));
    }
  };

  const aliasError = !alias.trim()
    ? 'An alias is required — it is what every step types'
    : others.has(alias.trim())
      ? 'Another binding already uses this alias'
      : undefined;
  const colorError = color.trim() && !COLOR.test(color.trim()) ? 'A colour is #rgb or #rrggbb' : undefined;
  const sourceError = source ? undefined : 'Choose a document';

  const rate = numberOrUndefined(requests);
  const burstOf = numberOrUndefined(burst);
  const rateError = Number.isNaN(rate) || Number.isNaN(burstOf)
    ? 'A rate is a whole number of requests, one or more'
    : burstOf !== undefined && rate === undefined
      ? 'A burst is an allowance against a rate — say how many requests first'
      : undefined;

  const submit = () => {
    if (aliasError || colorError || sourceError || rateError) {
      return;
    }
    onSubmit({
      alias: alias.trim(),
      source,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(auth.trim() ? { auth: auth.trim() } : {}),
      ...(color.trim() ? { color: color.trim() } : {}),
      ...(rate === undefined
        ? {}
        : { rateLimit: { requests: rate, per, ...(burstOf === undefined ? {} : { burst: burstOf }) } }),
      // Carried, not edited here — see the note above `COLOR`.
      ...(binding?.defaultHeaders ? { defaultHeaders: binding.defaultHeaders } : {}),
      ...(binding?.defaultQuery ? { defaultQuery: binding.defaultQuery } : {}),
      ...(strictNulls === 'default' ? {} : { strictNulls: strictNulls === 'on' })
    });
  };

  return (
    <Modal
      size="md"
      title={editing ? `Edit binding ${binding.alias}` : 'Bind an API'}
      confirmText={editing ? 'Save' : 'Add'}
      handleConfirm={submit}
      handleCancel={onClose}
      confirmDisabled={Boolean(aliasError || colorError || sourceError || rateError)}
      dataTestId="flow-api-dialog"
    >
      <form className="bruno-form" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="flow-api-source" className="block font-semibold">
          Document
        </label>
        <select
          id="flow-api-source"
          className="block textbox mt-2 w-full"
          value={specUid}
          onChange={(event) => chooseSpec(event.target.value)}
          data-testid="flow-api-source"
        >
          <option value="">{editing ? `keep ${binding.source}` : apiSpecs.length ? '— choose a document —' : 'No API Specs are open in this workspace'}</option>
          {apiSpecs.map((entry) => (
            <option key={entry.uid} value={entry.uid}>
              {entry.name || entry.filename}
            </option>
          ))}
        </select>
        {sourceError ? <div className="text-red-500">{sourceError}</div> : null}

        <label htmlFor="flow-api-alias" className="block font-semibold mt-3">
          Alias
        </label>
        <input
          id="flow-api-alias"
          type="text"
          className="block textbox mt-2 w-full"
          autoComplete="off"
          spellCheck="false"
          value={alias}
          onChange={(event) => {
            setAlias(event.target.value);
            setAliasTouched(true);
          }}
          data-testid="flow-api-alias"
        />
        {aliasError && alias ? <div className="text-red-500">{aliasError}</div> : null}

        <label htmlFor="flow-api-baseUrl" className="block font-semibold mt-3">
          Base URL
        </label>
        <input
          id="flow-api-baseUrl"
          type="text"
          className="block textbox mt-2 w-full"
          autoComplete="off"
          spellCheck="false"
          placeholder="optional — overrides config.baseUrl for this API"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          data-testid="flow-api-baseUrl"
        />

        <label htmlFor="flow-api-auth" className="block font-semibold mt-3">
          Auth profile
        </label>
        <input
          id="flow-api-auth"
          type="text"
          className="block textbox mt-2 w-full"
          autoComplete="off"
          spellCheck="false"
          list="flow-api-auth-profiles"
          placeholder="optional — a name under authProfiles:"
          value={auth}
          onChange={(event) => setAuth(event.target.value)}
          data-testid="flow-api-auth"
        />
        <datalist id="flow-api-auth-profiles">
          {(authProfiles || []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <label htmlFor="flow-api-color" className="block font-semibold mt-3">
          Colour
        </label>
        <input
          id="flow-api-color"
          type="text"
          className="block textbox mt-2 w-full"
          autoComplete="off"
          spellCheck="false"
          placeholder="optional — #8ab4f8, how the graph marks this API"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          data-testid="flow-api-color"
        />
        {colorError ? <div className="text-red-500">{colorError}</div> : null}

        {/* 004 §5: how fast this flow is willing to call the API. `requests` is the only one an
            author must write — `per` defaults to a second and `burst` to strict even spacing. */}
        <label htmlFor="flow-api-rate-requests" className="block font-semibold mt-3">
          Rate limit
        </label>
        <div className="flex gap-2 mt-2">
          <input
            id="flow-api-rate-requests"
            type="number"
            min="1"
            className="block textbox w-full"
            autoComplete="off"
            placeholder="optional — requests"
            value={requests}
            onChange={(event) => setRequests(event.target.value)}
            data-testid="flow-api-rate-requests"
          />
          <select
            className="block textbox w-full"
            aria-label="per"
            value={per}
            onChange={(event) => setPer(event.target.value)}
            data-testid="flow-api-rate-per"
          >
            <option value="second">per second</option>
            <option value="minute">per minute</option>
            <option value="hour">per hour</option>
          </select>
          <input
            type="number"
            min="1"
            className="block textbox w-full"
            autoComplete="off"
            aria-label="burst"
            placeholder="burst — default 1"
            value={burst}
            onChange={(event) => setBurst(event.target.value)}
            data-testid="flow-api-rate-burst"
          />
        </div>
        {rateError ? <div className="text-red-500">{rateError}</div> : null}

        {/* 001 §10.1: whether a null where this document declares a typed field fails the check. On
            the binding because it is a property of the document, not of this flow — and three-state
            rather than a tick because a connector file may declare it for the whole scope (§8.5):
            saying nothing here takes that, and the other two say it for this flow whatever the
            scope decided. */}
        <label htmlFor="flow-api-strictNulls" className="block font-semibold mt-3">
          Nulls the document does not declare
        </label>
        <select
          id="flow-api-strictNulls"
          className="block textbox mt-2 w-full"
          value={strictNulls}
          onChange={(event) => setStrictNulls(event.target.value)}
          data-testid="flow-api-strictNulls"
        >
          <option value="default">default — the connector file&apos;s answer, or strict</option>
          <option value="on">strict — a null fails the response check</option>
          <option value="off">tolerated — this API sends nulls the spec does not declare</option>
        </select>
      </form>
    </Modal>
  );
};

export default ApiBindingDialog;
