import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import get from 'lodash/get';
import { IconLoader2 } from '@tabler/icons';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { safeParseJSON, safeStringifyJSON } from 'utils/common';
import { getCodeMirrorModeBasedOnContentType } from 'utils/common/codemirror';
import { readStepCapture } from '../../actions';
import StyledWrapper from './StyledWrapper';

/**
 * 002 §9 — a step's request, response, assertions and validation, for one of its attempts.
 *
 * **Bodies come from the capture, fetched on demand.** 001 §13.2 excludes them from events
 * deliberately: every event crosses IPC, and attaching payloads would serialize them twice for data
 * the UI needs only when a step is opened. What the events *do* carry — status, reason, attempts,
 * duration, declared outputs — renders immediately, so a step's verdict never waits on a file read.
 * The assertion and validation tabs do wait, because which attempt's outcomes they show is the
 * question the capture answers.
 *
 * Redaction (001 §14.4) is applied by the engine before emission and before writing captures, so
 * this pane displays what it is given and has no `--show-sensitive` equivalent.
 */

const TABS = ['request', 'response', 'assertions', 'validation'];

/**
 * What each tab has to say about a step that never dispatched — 001 §11.2's skips, and a step
 * cancelled before it sent anything. There is no capture and never will be one, and every tab is
 * describing the same absence from its own side.
 */
const NOTHING_SENT = {
  request: 'Nothing was sent',
  response: 'No response arrived',
  assertions: 'Nothing was sent, so nothing was asserted',
  validation: 'Nothing was sent, so nothing was validated'
};

const Row = ({ label, children }) => (
  <div className="detail-row">
    <span className="detail-label">{label}</span>
    <span className="detail-value">{children}</span>
  </div>
);

const bytes = (count) => `${count} bytes`;

/**
 * One block for both directions: a request header is a string and a response header may repeat
 * (§13.2 types it `string | string[]`), which is the only difference between the two renderings.
 *
 * Labelled and grouped, because unlabelled rows sat flush against Method and URL and read as more of
 * the same list — and an empty set has to say so. A step declaring no headers of its own still sends
 * several, so "nothing here" is a statement about the capture, not about the request.
 */
const Headers = ({ headers }) => {
  const entries = Object.entries(headers || {});

  return (
    <div className="detail-headers">
      <div className="detail-label">Headers</div>
      {entries.length ? (
        entries.map(([name, value]) => (
          <Row key={name} label={name}>
            {[].concat(value).join(', ')}
          </Row>
        ))
      ) : (
        <div className="detail-empty">None recorded</div>
      )}
    </div>
  );
};

/**
 * §9's declared outputs — the inspection counterpart to §5.3's data edges: the edge says a value
 * moves, this says what it was.
 *
 * It sits with the **response**, directly above the body, because that is what it is read out of
 * (001 §8.1) — a value and the bytes it was extracted from belong next to each other. Above the tabs
 * it was on every one of them, including three that have nothing to do with it.
 *
 * Outputs arrive in `StepResult` rather than in the capture file, so they render on a
 * capture-disabled run too — the same reason §9 keeps assertions under one. They describe the step
 * rather than an attempt of it, which is why the caller shows them only on the final attempt.
 */
const Outputs = ({ outputs }) => {
  const entries = Object.entries(outputs || {});
  if (!entries.length) {
    return null;
  }

  return (
    <div className="detail-outputs">
      <div className="detail-label">Outputs</div>
      {entries.map(([name, value]) => (
        <Row key={name} label={name}>
          {JSON.stringify(value)}
        </Row>
      ))}
    </div>
  );
};

/**
 * 002 §11.2's `CapturedBody`, which is a tagged union — the three non-text kinds are recorded **by
 * reference** rather than inlined (001 §14.5), so there is a name to show and no content.
 *
 * The text kind goes through the app's own `CodeEditor`, which is what gives JSON its highlighting;
 * a bespoke highlighter here would be a second one to maintain and would not follow the user's
 * theme or code-font preference.
 */
const Body = ({ body }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);

  if (!body) {
    return <div className="detail-empty">No body</div>;
  }

  if (body.kind === 'binary') {
    return (
      <div className="detail-empty">{`${body.contentType || 'binary'} · ${bytes(body.byteLength)} · ${body.file}`}</div>
    );
  }

  if (body.kind === 'upload') {
    // §7.5's uploads are captured by reference: the fixture is already in the repository, and
    // naming it is the more useful record than copying it into every run.
    return (
      <div className="detail-empty">{`${body.filename} · ${body.contentType} · ${bytes(body.byteLength)}`}</div>
    );
  }

  if (body.kind === 'multipart') {
    return (
      <div className="detail-parts">
        {body.parts.map((part) => (
          <Row key={part.name} label={part.name}>
            {part.kind === 'file' ? `${part.filename} · ${bytes(part.byteLength)}` : part.value}
          </Row>
        ))}
      </div>
    );
  }

  const mode = getCodeMirrorModeBasedOnContentType(String(body.contentType || '').toLowerCase());
  const isJson = mode === 'application/ld+json';
  // A captured body is whatever went over the wire, which for JSON is usually one line.
  const value = isJson ? safeStringifyJSON(safeParseJSON(body.text), true) : body.text;

  return (
    <div className="detail-body">
      <CodeEditor
        theme={displayedTheme}
        font={get(preferences, 'font.codeFont', 'default')}
        fontSize={get(preferences, 'font.codeFontSize')}
        value={typeof value === 'string' ? value : body.text}
        mode={mode}
        enableVariableHighlighting={false}
        enableBrunoVarInfo={false}
        onEdit={() => {}}
        onRun={() => {}}
        readOnly
      />
    </div>
  );
};

const RUNNING_STATES = new Set(['running', 'retrying']);

/**
 * Whether this step is *actually* in flight, which its own state cannot answer alone.
 *
 * A node's state is the last thing the engine said about the step, so a step that announced
 * `step:start` and never announced its end reads `running` for as long as the tab is open. That is
 * true of the report and false about the world the moment the run ends — and this pane acts on it
 * three times over: the attempt it follows, whether a capture is merely late, and the spinner. The
 * run's own terminal state is the engine's answer to *is anything still in flight*, so it is the one
 * they ask.
 */
const inFlight = (node, running) => Boolean(running) && RUNNING_STATES.has(node?.state);

/**
 * How many attempts there are to choose between.
 *
 * A finished step reports `attempts` in its `StepResult`; a step still going has only the
 * `step:attempt` number the slice folds into `attempt`, and every attempt before that one has
 * already been written (see `captureState`), so both are selectable while it polls.
 *
 * A skipped step has none, and a step that has not reported yet has none *yet* — both offer attempt
 * 1, which is what the pane then reports on rather than leaving the control empty.
 */
const attemptCount = (node) => node.attempts || node.attempt || 1;

/**
 * The attempt the pane shows until one is chosen.
 *
 * The final attempt, because that is the one that decided the step: `run.ts` builds `StepResult`
 * from the last attempt's outcome, so opening a step on it is opening the step's own verdict, and a
 * poll that settled on attempt 12 opens on the response that settled it rather than on the first of
 * eleven that did not.
 *
 * While the step is still going the final attempt is the one in flight, whose capture 001 §14.5 has
 * not written yet — so the pane follows the newest attempt that *has* one, and a poll's responses
 * appear as they arrive. Nothing is settled on the first attempt of a running step; that case opens
 * on attempt 1 and reports it as unfinished.
 */
const followedAttempt = (node, running) =>
  inFlight(node, running) ? Math.max(1, (node.attempt || 1) - 1) : attemptCount(node);

/**
 * §9's attempts, as a control on the step's header rather than a tab of its own.
 *
 * Choosing an attempt re-keys the capture every tab is read from (001 §14.5 writes one file per
 * attempt, which is usually the only way to see what changed between them). As a fifth tab the
 * choice was made in one place and took effect in another, so a poll's attempts looked inert: you
 * selected attempt 3, stayed on a tab listing attempts, and saw nothing change. On the header it
 * sits beside what it selects and stays visible while it is read.
 *
 * It carries no label because it always shows a value, and that value names what it is.
 */
const AttemptSelector = ({ attempt, count, onSelect }) => (
  <select
    className="detail-attempt"
    value={attempt}
    onChange={(event) => onSelect(Number(event.target.value))}
    data-testid="flow-step-attempt"
  >
    {Array.from({ length: count }, (unused, index) => index + 1).map((number) => (
      <option key={number} value={number}>
        {`Attempt ${number}`}
      </option>
    ))}
  </select>
);

/**
 * Whether the attempt being viewed has a capture on disk yet.
 *
 * 001 §14.5 writes an attempt's file **after** that attempt settles — `step:attempt` announces the
 * request going out, `recordAttempt` runs once it comes back — so a read issued the moment a run
 * starts is certain to miss. Reading anyway and rendering the miss says "the capture could not be
 * read", which blames the reader for a file that was never going to be there yet, and the pane then
 * sits on that error because nothing re-reads when the step finishes.
 *
 * A step still in flight has a capture for every attempt *before* its current one; a step that has
 * stopped has one for each attempt it made, and a step that made none — skipped, or cancelled before
 * it dispatched — never will.
 */
const captureState = (node, attempt, running) => {
  if (!node) {
    return 'absent';
  }
  if (inFlight(node, running)) {
    return (node.attempt || 0) > attempt ? 'written' : 'pending';
  }
  if (node.attempts === 0) {
    return 'absent';
  }
  /**
   * 001 §13.2 reports `capturePath` on a step that has one, and an artifact write that failed does
   * not fail a run (§14.5) — so a step can have dispatched, been judged, and have nothing on disk.
   * Reading anyway renders that as "the capture could not be read", which blames this pane for a
   * file that was never written and leaves the reason on the run's diagnostics, unmentioned here.
   */
  return node.capturePath ? 'written' : 'unwritten';
};

/**
 * **Whether a run has captures is a property of that run, not of the run control.** 001 §13.2 reports
 * `captureDir` at `run:start` and omits it when capture was off, and §11.2's stored runs carry the
 * directory they were read from — so the directory's presence *is* the answer, for a live run and a
 * past one alike. Reading the run control's checkbox instead makes unchecking it erase the captures
 * of a run that already happened, which no setting for the *next* run should be able to do.
 */
const StepDetail = ({ stepId, node, running, runDir, iteration, height }) => {
  const dispatch = useDispatch();
  const [tab, setTab] = useState('request');
  /**
   * `null` is "no attempt chosen", which is not the same as having chosen the one the pane happens
   * to be showing: it is what keeps a running step following its newest settled attempt instead of
   * pinning to whichever number was current when it was opened.
   */
  const [chosen, setChosen] = useState(null);
  /**
   * `idle` and `failed` are distinct from a capture that loaded and simply has no request in it.
   * Collapsing them is how "the read failed" renders as "nothing was sent" — a claim about the run
   * that the pane is in no position to make.
   */
  const [read, setRead] = useState({ status: 'idle' });

  // Also on the run, because §10 can swap a past run under a step that stays selected — and attempt
  // 4 of a poll is not an attempt the run replacing it need have made.
  useEffect(() => {
    setChosen(null);
    setRead({ status: 'idle' });
  }, [stepId, runDir]);

  const attempt = chosen || (node ? followedAttempt(node, running) : 1);
  const captureStatus = captureState(node, attempt, running);

  useEffect(() => {
    if (!runDir) {
      return undefined;
    }
    // Re-runs when the step ends, because `captureStatus` is derived from the node the events fold
    // into — which is what turns a too-early read into a read that simply happens later.
    if (captureStatus !== 'written') {
      setRead((previous) => (previous.status === 'idle' ? previous : { status: 'idle' }));
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
  }, [dispatch, runDir, stepId, iteration, attempt, captureStatus]);

  // The pane's owner drags this (§9); absent, the stylesheet's own minimum stands in — which is
  // what a standalone render of this component gets.
  const sized = typeof height === 'number' ? { height } : undefined;

  if (!node) {
    return (
      <StyledWrapper style={sized}>
        <div className="detail-empty">{`${stepId} has not run in this iteration`}</div>
      </StyledWrapper>
    );
  }

  const capture = read.capture;

  /**
   * **Every tab is the chosen attempt's, or none of them is.** 001 §14.5 writes an attempt's
   * assertion and schema-validation outcomes into the attempt's own file, so reading them from the
   * capture is what makes a chosen attempt a coherent view of one call: attempt 2's request, attempt
   * 2's response, and the verdict attempt 2 was given. Reading them from `StepResult` instead put the
   * *step's* outcome — which `run.ts` builds from the final attempt — beside an earlier attempt's
   * request and response, so a poll that failed twice and then passed showed three passing attempts.
   *
   * With captures disabled there is no attempt-level record to read, and `StepResult` is all there
   * is; the pane then has one attempt to show and shows the step's own outcome, which is honest
   * because nothing else is on offer.
   */
  const perAttempt = Boolean(runDir);
  const outcomeReady = !perAttempt || read.status === 'loaded';
  const assertions = perAttempt ? capture?.assertions : node.assertions;
  const validation = perAttempt ? capture?.validation : node.validation;

  /**
   * Three things describe the step rather than an attempt of it: its status and reason, the duration
   * that spans every attempt and the delays between them, and the outputs 001 §8.1 read out of the
   * response that settled it. On the final attempt they *are* that attempt's — `run.ts` builds
   * `StepResult` from the last attempt's outcome — which is why the pane opens there and why they
   * show without qualification. On an earlier attempt they belong to a different call, and the step's
   * verdict is on its node in the graph either way.
   */
  const showsStepOutcome = attempt === attemptCount(node);
  // Pre-terminal, with nothing left to move it: the run is over and this step never reported an end.
  const unreported = !running && RUNNING_STATES.has(node.state);

  return (
    <StyledWrapper style={sized} data-testid="flow-step-detail">
      <div className="detail-header">
        <span className="detail-step">{stepId}</span>
        {perAttempt ? <AttemptSelector attempt={attempt} count={attemptCount(node)} onSelect={setChosen} /> : null}

        {/* §8.2's in-flight states, beside the attempt this pane is reading — a step still going
            shows no status here (its outcome is not its own until it settles) and no duration, so
            without this the header of a running step is indistinguishable from a finished one whose
            events were missed. It stays up across a poll's retries: `retrying` is the same request
            still in flight, and a spinner that stopped between attempts would say it had landed. */}
        {inFlight(node, running) ? (
          <IconLoader2
            className={`detail-spinner animate-spin ${node.state}`}
            size={14}
            strokeWidth={1.5}
            data-testid="flow-step-in-flight"
          />
        ) : null}

        {/* A step whose run ended without it reporting has no outcome to show, and repeating the
            last thing it said would have the pane claiming it is still going — beside a run that
            says it is over. What is known is that nothing more is coming. */}
        {showsStepOutcome && unreported ? (
          <span className="detail-status unreported" data-testid="flow-step-unreported">
            the run ended without this step reporting
          </span>
        ) : null}

        {showsStepOutcome && !unreported ? (
          <span className={`detail-status ${node.state}`}>{[node.state, node.reason].filter(Boolean).join(' · ')}</span>
        ) : null}
        {showsStepOutcome && node.durationMs !== undefined ? (
          <span className="detail-duration">{`${node.durationMs}ms`}</span>
        ) : null}
      </div>

      {/* 001 §14.6's message: the reason names the rule, this names the occurrence — which response,
          which reference, which assertion. It sits above the tabs rather than inside one because a
          step that never dispatched has no tab that would carry it. */}
      {showsStepOutcome && node.message ? (
        <div className={`detail-message ${node.state}`} data-testid="flow-step-message">
          {node.message}
        </div>
      ) : null}

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
        {/* §9: a run with no capture directory says so on the request and response tabs, rather
            than showing empty panels. Assertion and validation outcomes still render — they arrive
            in `StepResult`, so there is no excuse for losing them. */}
        {!perAttempt && (tab === 'request' || tab === 'response') ? (
          <div className="detail-empty">Captures were disabled for this run</div>
        ) : null}

        {/* A step in flight, a step that dispatched nothing, and a step whose capture never reached
            disk are three different absences, and which one it is decides where to look next. */}
        {perAttempt && captureStatus !== 'written' ? (
          <div className="detail-empty">
            {captureStatus === 'pending'
              ? `Attempt ${attempt} has not finished`
              : captureStatus === 'unwritten'
                ? 'This step ran, but its capture was not written — the run reports why'
                : NOTHING_SENT[tab]}
          </div>
        ) : null}

        {perAttempt && read.status === 'loading' ? <div className="detail-empty">Loading capture…</div> : null}

        {perAttempt && read.status === 'failed' ? (
          <div className="detail-empty">{`The capture could not be read — ${read.error}`}</div>
        ) : null}

        {tab === 'request' && read.status === 'loaded' ? (
          capture?.request ? (
            <>
              <Row label="Method">{capture.request.method}</Row>
              <Row label="URL">{capture.request.url}</Row>
              <Headers headers={capture.request.headers} />
              <Body body={capture.request.body} />
            </>
          ) : (
            <div className="detail-empty">Nothing was sent</div>
          )
        ) : null}

        {tab === 'response' ? (
          <>
            {read.status === 'loaded' && capture?.response ? (
              <>
                <Row label="Status">{`${capture.response.status} ${capture.response.statusText || ''}`}</Row>
                <Row label="Duration">{`${capture.response.responseTimeMs}ms`}</Row>
                <Headers headers={capture.response.headers} />
              </>
            ) : null}

            {showsStepOutcome ? <Outputs outputs={node.outputs} /> : null}

            {read.status === 'loaded' && capture?.response ? <Body body={capture.response.body} /> : null}
            {read.status === 'loaded' && !capture?.response ? (
              <div className="detail-empty">No response arrived</div>
            ) : null}
          </>
        ) : null}

        {tab === 'assertions' && outcomeReady ? (
          <table className="detail-table">
            <tbody>
              {(assertions || []).map((assertion, index) => (
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

        {tab === 'validation' && outcomeReady ? (
          <>
            {['request', 'response'].map((side) =>
              validation?.[side] ? (
                <div key={side}>
                  <Row label={side}>{validation[side].valid ? 'valid' : 'invalid'}</Row>
                  {validation[side].errors.map((error, index) => (
                    <Row key={index} label={error.path}>
                      {error.message}
                    </Row>
                  ))}
                </div>
              ) : null
            )}
            {validation ? null : <div className="detail-empty">No schema validation ran</div>}
          </>
        ) : null}

      </div>
    </StyledWrapper>
  );
};

export default StepDetail;
