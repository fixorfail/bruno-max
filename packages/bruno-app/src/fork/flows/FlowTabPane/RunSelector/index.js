import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { listFlowRuns, openPastRun } from '../../actions';
import { runClosed } from '../../slice';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §10 — the runs under `.bruno-runs/` for the scope that owns this flow, newest first.
 *
 * A past run opens into the *same* view as a live one; only the source differs. A second, weaker
 * viewer for stored runs would guarantee the two drift, and the stored form is a superset of what
 * events carry.
 *
 * Runs of other flows in the same scope are excluded by `listRuns`, which filters on `run.json` —
 * which is why the filter works on a run that never finished as well as one that did.
 */

/** The flow as it stands on disk — no run open, the graph drawn from §6's description. */
const CURRENT = '';

/**
 * The run the tab is showing when this list does not hold it: a run started *without* capture, which
 * never gets a directory to be listed from, and the moment between a run ending and the re-listing
 * that picks it up. Both need a selected option that is not `current` — the graph is showing a run's
 * outcomes, and `current` claims the opposite.
 */
const OPEN = 'open';

/**
 * The environment a listed run was made against, from 001 §14.5's `origin`.
 *
 * The host is not named here and the badge above the graph carries it: this list is one flow's own
 * history and the environment is what tells two of its rows apart, while `app` on every row would
 * only make each one longer. A run recorded before the field, or made against no environment, adds
 * nothing rather than a word standing in for one.
 */
const against = (origin) => {
  const environment = origin ? origin.environment || origin.globalEnvironment : undefined;
  return environment ? ` · ${environment}` : '';
};

/**
 * §10: a run made against text the flow no longer has says so, because the graph it opens into is
 * that older flow's and would otherwise be indistinguishable from the current one.
 *
 * Only a definite `true` is marked. `flowChanged` is three-valued (001 §14.5): `undefined` means the
 * run predates the digest or the flow is no longer readable, and marking those "edited since" would
 * put a claim on every old run that nothing supports.
 */
const label = (entry) => {
  const when = entry.startedAt.replace('T', ' ').replace(/\.\d+Z$/, '');
  const edited = entry.flowChanged === true ? ' · flow edited since' : '';
  const environment = against(entry.origin);
  if (entry.state === 'complete') {
    return `${when} · ${entry.status} · ${entry.summary.passed}/${entry.summary.total}${environment}${edited}`;
  }
  // §10: an interrupted run must not claim an outcome — nobody recorded one.
  return `${when} · ${entry.state}${environment}${edited}`;
};

/** The same rule for the run in the view: state, and a status only where one was recorded. */
const openLabel = (run) => {
  const uncaptured = run.dir ? '' : ' · not captured';
  if (run.state === 'running') {
    return `this run · running${uncaptured}`;
  }
  return `this run · ${run.status || run.state}${uncaptured}`;
};

const RunSelector = ({ flow, description, run }) => {
  const dispatch = useDispatch();
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    let current = true;
    dispatch(listFlowRuns(flow))
      .then((found) => current && setEntries(found))
      .catch(() => current && setEntries([]));

    return () => {
      current = false;
    };
    // Re-listed when a run ends, so the run just finished joins the list.
  }, [dispatch, flow, run?.state]);

  if (!entries.length && !run) {
    return null;
  }

  const listed = Boolean(run?.dir) && entries.some((entry) => entry.dir === run.dir);
  const value = run ? (listed ? run.dir : OPEN) : CURRENT;
  const isRunning = run?.state === 'running';

  const choose = (chosen) => {
    // Already what the view is showing — the option exists to name it, not to switch to it.
    if (chosen === OPEN) {
      return;
    }

    /**
     * `current` is not another run: the tab draws the run it has open in preference to the file
     * (§10's pinned graph), so going back to the flow as it stands is *dropping* the run.
     */
    if (chosen === CURRENT) {
      dispatch(runClosed({ pathname: flow.pathname }));
      return;
    }

    const entry = entries.find((candidate) => candidate.dir === chosen);
    if (entry) {
      dispatch(openPastRun({ flow, entry, stepIds: description ? description.nodes.map((node) => node.id) : [] }));
    }
  };

  return (
    <StyledWrapper>
      <label>
        Run
        {/* Locked while a run is executing: every other option in this list replaces the run state
            the events are being folded into, and the live run has nowhere to be restored from — its
            Cancel control (§7.1) would go with it, mid-run. */}
        <select
          value={value}
          disabled={isRunning}
          title={isRunning ? 'This flow is running' : undefined}
          onChange={(event) => choose(event.target.value)}
          data-testid="flow-run-selector"
        >
          {/* §10: the flow as it is now, always offered. Every other option is a record of something
              that already happened, and the file can have been edited since the newest of them — so
              the one graph that is not history has to remain reachable after a run, not only before
              the first one. */}
          <option value={CURRENT}>current</option>
          {value === OPEN ? <option value={OPEN}>{openLabel(run)}</option> : null}
          {entries.map((entry) => (
            <option key={entry.dir} value={entry.dir}>
              {label(entry)}
            </option>
          ))}
        </select>
      </label>
    </StyledWrapper>
  );
};

export default RunSelector;
