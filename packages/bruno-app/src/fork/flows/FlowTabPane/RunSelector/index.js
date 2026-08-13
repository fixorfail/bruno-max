import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { listFlowRuns, openPastRun } from '../../actions';
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

const label = (entry) => {
  const when = entry.startedAt.replace('T', ' ').replace(/\.\d+Z$/, '');
  if (entry.state === 'complete') {
    return `${when} · ${entry.status} · ${entry.summary.passed}/${entry.summary.total}`;
  }
  // §10: an interrupted run must not claim an outcome — nobody recorded one.
  return `${when} · ${entry.state}`;
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

  if (!entries.length) {
    return null;
  }

  const select = (dir) => {
    const entry = entries.find((candidate) => candidate.dir === dir);
    if (entry) {
      dispatch(openPastRun({ flow, entry, stepIds: description ? description.nodes.map((node) => node.id) : [] }));
    }
  };

  return (
    <StyledWrapper>
      <label>
        Run
        <select value={run?.dir || ''} onChange={(event) => select(event.target.value)} data-testid="flow-run-selector">
          {run?.dir ? null : <option value="">current</option>}
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
