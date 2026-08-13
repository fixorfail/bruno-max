import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { readStepCapture } from '../../actions';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §9 — a step's request, response, assertions, validation and attempts.
 *
 * **Bodies come from the capture, fetched on demand.** 001 §13.2 excludes them from events
 * deliberately: every event crosses IPC, and attaching payloads would serialize them twice for data
 * the UI needs only when a step is opened. What the events *do* carry — status, reason, attempts,
 * duration, assertion results, declared outputs — renders immediately, so a step's verdict never
 * waits on a file read.
 *
 * Redaction (001 §14.4) is applied by the engine before emission and before writing captures, so
 * this pane displays what it is given and has no `--show-sensitive` equivalent.
 */

const TABS = ['request', 'response', 'assertions', 'validation', 'attempts'];

const Row = ({ label, children }) => (
  <div className="detail-row">
    <span className="detail-label">{label}</span>
    <span className="detail-value">{children}</span>
  </div>
);

const Body = ({ body }) => {
  if (!body) {
    return <div className="detail-empty">No body</div>;
  }
  // §14.5 never inlines a binary body — it records the type and names a sibling artifact.
  if (body.preview === undefined) {
    return <div className="detail-empty">{`${body.contentType || 'binary'} · ${body.size ?? 0} bytes`}</div>;
  }
  return (
    <pre className="detail-body">
      {body.preview}
      {body.truncated ? '\n…truncated' : ''}
    </pre>
  );
};

const StepDetail = ({ stepId, node, runDir, iteration, captureEnabled }) => {
  const dispatch = useDispatch();
  const [tab, setTab] = useState('request');
  const [attempt, setAttempt] = useState(1);
  /**
   * `idle` and `failed` are distinct from a capture that loaded and simply has no request in it.
   * Collapsing them is how "the read failed" renders as "nothing was sent" — a claim about the run
   * that the pane is in no position to make.
   */
  const [read, setRead] = useState({ status: 'idle' });

  useEffect(() => {
    setAttempt(1);
    setRead({ status: 'idle' });
  }, [stepId]);

  useEffect(() => {
    if (!captureEnabled) {
      return undefined;
    }
    if (!runDir) {
      setRead({ status: 'failed', error: 'This run did not report a capture directory' });
      return undefined;
    }

    let current = true;
    setRead({ status: 'loading' });
    dispatch(readStepCapture({ dir: runDir, stepId, iteration, attempt }))
      .then((capture) => current && setRead({ status: 'loaded', capture }))
      .catch((error) => current && setRead({ status: 'failed', error: error.message }));

    return () => {
      current = false;
    };
  }, [dispatch, runDir, stepId, iteration, attempt, captureEnabled]);

  if (!node) {
    return (
      <StyledWrapper>
        <div className="detail-empty">{`${stepId} has not run in this iteration`}</div>
      </StyledWrapper>
    );
  }

  const needsCapture = tab === 'request' || tab === 'response';
  const capture = read.capture;

  return (
    <StyledWrapper data-testid="flow-step-detail">
      <div className="detail-header">
        <span className="detail-step">{stepId}</span>
        <span className={`detail-status ${node.state}`}>{[node.state, node.reason].filter(Boolean).join(' · ')}</span>
        {node.durationMs === undefined ? null : <span className="detail-duration">{`${node.durationMs}ms`}</span>}
      </div>

      <div className="detail-tabs">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={name === tab ? 'active' : ''}
            onClick={() => setTab(name)}
            data-testid={`flow-step-tab-${name}`}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="detail-body-area">
        {/* §9: with capture disabled the request and response tabs say so, rather than showing
            empty panels. Assertion and validation outcomes still render — they arrive in
            `StepResult`, so there is no excuse for losing them. */}
        {needsCapture && !captureEnabled ? (
          <div className="detail-empty">Captures were disabled for this run</div>
        ) : null}

        {needsCapture && captureEnabled && read.status === 'loading' ? (
          <div className="detail-empty">Loading capture…</div>
        ) : null}

        {needsCapture && captureEnabled && read.status === 'failed' ? (
          <div className="detail-empty">{`The capture could not be read — ${read.error}`}</div>
        ) : null}

        {tab === 'request' && read.status === 'loaded' ? (
          capture?.request ? (
            <>
              <Row label="Method">{capture.request.method}</Row>
              <Row label="URL">{capture.request.url}</Row>
              {Object.entries(capture.request.headers || {}).map(([name, value]) => (
                <Row key={name} label={name}>
                  {value}
                </Row>
              ))}
              <Body body={capture.request.body} />
            </>
          ) : (
            <div className="detail-empty">Nothing was sent</div>
          )
        ) : null}

        {tab === 'response' && read.status === 'loaded' ? (
          capture?.response ? (
            <>
              <Row label="Status">{`${capture.response.status} ${capture.response.statusText || ''}`}</Row>
              <Row label="Duration">{`${capture.response.responseTimeMs}ms`}</Row>
              {Object.entries(capture.response.headers || {}).map(([name, value]) => (
                <Row key={name} label={name}>
                  {[].concat(value).join(', ')}
                </Row>
              ))}
              <Body body={capture.response.body} />
            </>
          ) : (
            <div className="detail-empty">No response arrived</div>
          )
        ) : null}

        {tab === 'assertions' ? (
          <table className="detail-table">
            <tbody>
              {(node.assertions || []).map((assertion, index) => (
                <tr key={index} className={assertion.passed ? 'passed' : 'failed'}>
                  <td>{assertion.passed ? '✓' : '✗'}</td>
                  <td>{assertion.expr}</td>
                  <td>{JSON.stringify(assertion.expected)}</td>
                  <td>{JSON.stringify(assertion.actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {tab === 'validation' ? (
          <>
            {['request', 'response'].map((side) =>
              node.validation?.[side] ? (
                <div key={side}>
                  <Row label={side}>{node.validation[side].valid ? 'valid' : 'invalid'}</Row>
                  {node.validation[side].errors.map((error, index) => (
                    <Row key={index} label={error.path}>
                      {error.message}
                    </Row>
                  ))}
                </div>
              ) : null
            )}
            {node.validation ? null : <div className="detail-empty">No schema validation ran</div>}
          </>
        ) : null}

        {tab === 'attempts' ? (
          <div className="detail-attempts">
            {Array.from({ length: node.attempts || 1 }, (unused, index) => index + 1).map((number) => (
              <button
                key={number}
                type="button"
                className={number === attempt ? 'active' : ''}
                onClick={() => setAttempt(number)}
              >
                {`attempt ${number}`}
              </button>
            ))}
          </div>
        ) : null}

        {/* §9: declared outputs with their values — the inspection counterpart to §5.3's data
            edges. The edge says a value moves; this says what it was. */}
        {node.outputs && Object.keys(node.outputs).length ? (
          <div className="detail-outputs">
            <div className="detail-label">Outputs</div>
            {Object.entries(node.outputs).map(([name, value]) => (
              <Row key={name} label={name}>
                {JSON.stringify(value)}
              </Row>
            ))}
          </div>
        ) : null}
      </div>
    </StyledWrapper>
  );
};

export default StepDetail;
