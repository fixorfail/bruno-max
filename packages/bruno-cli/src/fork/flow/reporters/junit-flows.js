/**
 * The flow-level JUnit report — 001 §14.8.1.
 *
 * The same run, counted one level up: the whole invocation is one `<testsuite>` and each flow is
 * one `<testcase>`. `junit.js` answers "which step broke", which is what a person debugging wants;
 * this one answers "which flows are red", which is what a dashboard trending a suite over weeks and
 * a test-management tool holding one case per flow want. A step-level report imported into the
 * second creates a case per step, so a flow gaining a step silently creates a case nobody owns —
 * the shape has to match what the reader is counting.
 *
 * A separate reporter rather than a flag on the first one: a report's shape is its identity. CI
 * configuration names a file and a parser, not a mode, and a `--reporter-junit --flow-level` that
 * changed what `report-junit.xml` meant would rewrite the meaning of a path already wired into
 * somebody's pipeline.
 *
 * `--retries` and `--retry-failed` read exactly as they do in `junit.js`, since `junit-format.js`
 * is where that behaviour lives: a flaky flow's testcase is a pass, marked by an `attempt`/`flaky`
 * property and a `<system-out>` line rather than by an invented `<failure>`; a retried suite names
 * the one it retried as `retry_of` on `<testsuites>`.
 */
const fs = require('fs');
const os = require('os');
const xmlbuilder = require('xmlbuilder');

const {
  FAILURE_REASONS,
  clean,
  seconds,
  timestamp,
  properties,
  forDisplay,
  failureBody,
  outcomeElement,
  originProperties,
  attemptProperties,
  flakyNote,
  diagnosticsError
} = require('./junit-format');

/** One invocation is one suite here, so both elements carry the command's own name. */
const SUITE_NAME = 'bru flow run';

/** A row is a separate run of the same steps, and the label is what tells two of them apart. */
const isDataset = (result) =>
  result.iterations.length > 1 || result.iterations.some((iteration) => iteration.row);

/**
 * The steps a failed run fell on. §14.6's `decidedBy` names them, including §11.2's `skipped` step
 * that failed the run; where the engine named none, every failed step is the answer, because a
 * report that said a flow failed and would not say what failed sends the reader to the logs.
 */
const decidingSteps = (result) => {
  const named = new Set(result.decidedBy || []);
  const labelled = isDataset(result);

  return result.iterations.flatMap((iteration) =>
    iteration.steps
      .filter((step) => (named.size ? named.has(step.id) : step.status === 'failed'))
      .map((step) => ({ step, label: labelled ? `${step.id} [row ${iteration.index + 1}]` : step.id }))
  );
};

const indent = (text) => text.split('\n').map((line) => `  ${line}`).join('\n');

/**
 * One heading per deciding step with its own detail underneath, because a flow-level testcase is
 * the only place a reader of this shape will see why the flow went red.
 */
const decidingBody = (deciding) =>
  deciding
    .map(({ step, label }) => {
      const body = failureBody(step);
      return body ? `${label}\n${indent(body)}` : label;
    })
    .join('\n');

const flowProperties = (record, cwd) => {
  const result = record.result;

  return properties([
    // First, because it is what a tracker keys the case on; everything else is how a person reads it.
    ['test_id', record.testId],
    ['name', record.name],
    ['file', forDisplay(record.file, cwd)],
    // Present even when empty: a reader filtering on tags cannot tell an untagged flow from a
    // reporter that forgot to write them.
    ['tags', record.tags.join(',')],
    // Which environment a suite ran against is the first thing a CI reader asks of a red build.
    ...originProperties(result && result.origin),
    ['runId', result && result.runId],
    ['status', record.outcome],
    // A dataset flow is still one case; the count is what says the case covered more than one row.
    ['iterations', result && isDataset(result) ? result.iterations.length : undefined],
    ...attemptProperties(record)
  ]);
};

/** A flow as a testcase, plus which count it lands in. */
const testcaseFor = (record, cwd) => {
  const testcase = {
    '@name': clean(record.id),
    '@classname': clean(record.id),
    '@time': seconds(record.durationMs)
  };

  const props = flowProperties(record, cwd);
  if (props) testcase.properties = props;

  // A pass this reporter has to explain: the counts read exactly like any other pass, and the
  // note is the only place the earlier failed attempt is still visible.
  const note = flakyNote(record);
  if (note) testcase['system-out'] = clean(note);

  if (!record.result) {
    Object.assign(testcase, outcomeElement('error', diagnosticsError(record.diagnostics || [])));
    return { testcase, counted: 'errors' };
  }

  if (record.outcome === 'cancelled') {
    // Neither a pass nor a skip: a cancelled run learned nothing about the API, and reading it as
    // either would let an interrupted build report as one that had something to say.
    Object.assign(testcase, outcomeElement('error', {
      type: 'run-cancelled',
      message: 'the run was cancelled'
    }));
    return { testcase, counted: 'errors' };
  }

  if (record.outcome === 'failed') {
    const deciding = decidingSteps(record.result);
    // The API answered and disagreed only if every step the verdict fell on says so; one step that
    // could not be carried out makes the whole flow's result an error (JUnit's own distinction).
    const element = deciding.every(({ step }) => FAILURE_REASONS.has(step.reason)) ? 'failure' : 'error';

    Object.assign(testcase, outcomeElement(element, {
      type: (deciding[0] && deciding[0].step.reason) || 'failed',
      message: `${deciding.length} step(s) decided the run: ${deciding.map((entry) => entry.label).join(', ')}`,
      body: decidingBody(deciding)
    }));
    return { testcase, counted: element === 'failure' ? 'failures' : 'errors' };
  }

  return { testcase, counted: undefined };
};

const formatJUnitFlows = (suite, { hostname = os.hostname(), cwd = process.cwd() } = {}) => {
  const cases = (suite.flows || []).map((record) => testcaseFor(record, cwd));
  const counts = { failures: 0, errors: 0, skipped: 0 };
  for (const { counted } of cases) if (counted) counts[counted] += 1;

  // The two elements count the same things, because there is exactly one suite inside.
  const totals = {
    '@tests': cases.length,
    '@failures': counts.failures,
    '@errors': counts.errors,
    '@skipped': counts.skipped,
    '@time': seconds(suite.durationMs),
    '@timestamp': timestamp(suite.startedAt)
  };

  // Present only on a suite that re-ran another — a name here is what tells a reader two reports
  // for the same flows apart from two reports that just happen to agree.
  const retryProperties = properties([['retry_of', suite.retryOf]]);

  const document = {
    testsuites: {
      '@name': SUITE_NAME,
      ...totals,
      ...(retryProperties ? { properties: retryProperties } : {}),
      'testsuite': {
        '@name': SUITE_NAME,
        ...totals,
        '@hostname': clean(hostname),
        'testcase': cases.map((entry) => entry.testcase)
      }
    }
  };

  return xmlbuilder.create(document, { encoding: 'UTF-8' }).end({ pretty: true });
};

/** The parent directory is the caller's to check, before any flow runs — see `parseReporterSpecs`. */
const factory = (context) => ({
  onSuiteEnd: async (suite) => {
    await fs.promises.writeFile(context.outputPath, formatJUnitFlows(suite, { cwd: context.cwd }), 'utf8');
  }
});

module.exports = factory;
module.exports.formatJUnitFlows = formatJUnitFlows;
