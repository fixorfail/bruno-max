/**
 * The JUnit report — 001 §14.8.1.
 *
 * JUnit is the format CI and test-management tools already read, which is the whole of why it is
 * the primary one: nothing consuming it will be written for flows. So the mapping is chosen to fit
 * what those readers expect rather than to mirror `RunResult` — **one `<testsuite>` per
 * flow-iteration** (a dataset row is a separate run of the same steps, and a reader that merged them
 * would show one step passing and failing at once), one `<testcase>` per step, and §5.2's tags as
 * suite `<properties>` so a suite can be selected by them.
 *
 * `failure` versus `error` is the one judgement in here: JUnit's distinction is "the assertion
 * disagreed" against "the test could not be carried out", and §14.6's reasons divide cleanly along
 * it. A transport error is not a failing API, and a reader that saw one as a failure would open a
 * bug against the service.
 *
 * A step's `meta:` is carried through verbatim — one testcase `<property>` per entry, under the key
 * the author wrote — so a team's own field costs no change here. `testId` is the single key the
 * reporter renames, to `test_id`: that is the property TestRail's importer reads, and a case id
 * under any other spelling links a result to nothing.
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
  diagnosticsError
} = require('./junit-format');

const skipMessage = (step) => {
  if (!step.reason) return step.status;
  return step.message ? `${step.reason}: ${step.message}` : step.reason;
};

/** §5.3's `meta:` values reach here as they were parsed, so an id written unquoted is still a number. */
const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

/**
 * A step's own `meta:`, one property per entry in declaration order. `testId` becomes `test_id`
 * because that is what a test-management importer looks for; every other key is the author's and is
 * passed through untranslated. A structure has no attribute form, so it goes as the JSON a reader
 * can decode rather than as `[object Object]`.
 */
const metaProperties = (meta) =>
  Object.entries(meta || {}).map(([key, value]) => [
    key === 'testId' ? 'test_id' : key,
    SCALAR_TYPES.has(typeof value) ? String(value) : JSON.stringify(value)
  ]);

/**
 * A step as a testcase, plus which count it lands in.
 *
 * The `decidedBy` branch is §11.2's `failOnUnresolved`: a run goes red through a step that is
 * *skipped*, so a report that trusted the step's own status would carry a failing suite whose every
 * testcase reads green — the one shape of this a CI dashboard cannot show.
 */
const testcaseFor = (step, flowId, decidedBy) => {
  const testcase = {
    '@name': clean(step.id),
    '@classname': clean(flowId),
    '@time': seconds(step.durationMs)
  };

  const props = properties([
    ...metaProperties(step.meta),
    ['name', step.name],
    ['reason', step.reason],
    ['attempts', step.attempts > 1 ? step.attempts : undefined]
  ]);
  if (props) testcase.properties = props;

  const body = failureBody(step);

  if (step.status !== 'failed' && decidedBy.includes(step.id)) {
    Object.assign(testcase, outcomeElement('failure', {
      type: step.reason || step.status,
      message: `this ${step.status} step decided the run's status`,
      body
    }));
    return { testcase, counted: 'failures' };
  }

  if (step.status === 'failed') {
    const element = FAILURE_REASONS.has(step.reason) ? 'failure' : 'error';
    Object.assign(testcase, outcomeElement(element, {
      type: step.reason || 'failed',
      message: step.message || step.reason || 'failed',
      body
    }));
    return { testcase, counted: element === 'failure' ? 'failures' : 'errors' };
  }

  if (step.status === 'skipped' || step.status === 'cancelled') {
    testcase.skipped = { '@message': clean(skipMessage(step)) };
    return { testcase, counted: 'skipped' };
  }

  return { testcase, counted: undefined };
};

/**
 * A `uses:` container and its internals are the same work counted twice (§12's flat array holds
 * both), so the container goes and the steps that did something stay.
 */
const reportedSteps = (steps) =>
  steps.filter((step) => !(step.kind === 'subflow' && steps.some((other) => other.id.startsWith(`${step.id}/`))));

const systemOut = (result) => {
  const lines = (result.diagnostics || []).map((entry) => `${entry.severity} ${entry.code} ${entry.message}`);
  if (result.captureDir) lines.push(`capture ${result.captureDir}`);
  return lines.length ? clean(lines.join('\n')) : undefined;
};

const iterationSuite = (record, iteration, result, { cwd, hostname }) => {
  const decidedBy = result.decidedBy || [];
  const steps = reportedSteps(iteration.steps);
  const cases = steps.map((step) => testcaseFor(step, record.id, decidedBy));
  const counts = { failures: 0, errors: 0, skipped: 0 };
  for (const { counted } of cases) if (counted) counts[counted] += 1;

  // A row is a separate run of the same flow, and `[row N]` is what makes two suites of the same
  // name distinguishable to a reader that keys on it.
  const rowed = Boolean(iteration.row) || result.iterations.length > 1;
  const number = iteration.index + 1;

  /**
   * An iteration has no clock of its own. With one there is nothing between the flow's wall clock
   * and the iteration's, so the flow's is the truer number; with several, the steps' own durations
   * are the only division available.
   */
  const durationMs = result.iterations.length === 1
    ? record.durationMs
    : iteration.steps.reduce((total, step) => total + (step.durationMs || 0), 0);

  const out = systemOut(result);

  return {
    '@name': clean(rowed ? `${record.id} [row ${number}]` : record.id),
    '@tests': cases.length,
    '@failures': counts.failures,
    '@errors': counts.errors,
    '@skipped': counts.skipped,
    '@time': seconds(durationMs),
    '@timestamp': timestamp(record.startedAt),
    '@hostname': clean(hostname),
    'properties': properties([
      ['flow', record.id],
      // The flow's own case id, beside the steps' — a tracker importing a suite at a time matches
      // the flow on this one, where a step-level `test_id` would only ever match a step.
      ['test_id', record.testId],
      ['name', record.name],
      ['file', forDisplay(record.file, cwd)],
      // Present even when empty: a reader filtering on tags cannot tell an untagged flow from a
      // reporter that forgot to write them.
      ['tags', record.tags.join(',')],
      ['runId', result.runId],
      ['status', iteration.status],
      // Which environment a suite ran against is the first thing a CI reader asks of a red build.
      ...originProperties(result.origin),
      ...(iteration.row
        ? [['iteration', number], ...Object.entries(iteration.row).map(([key, value]) => [`row.${key}`, String(value)])]
        : [])
    ]),
    'testcase': cases.map((entry) => entry.testcase),
    ...(out ? { 'system-out': out } : {})
  };
};

/**
 * A flow that never ran still gets a suite: a selection whose flow was mis-typed and a selection
 * whose flow failed look identical in a report that only lists what executed, and the first is the
 * one nobody notices.
 */
const invalidSuite = (record, { cwd, hostname }) => {
  const diagnostics = record.diagnostics || [];

  return {
    '@name': clean(record.id),
    '@tests': 1,
    '@failures': 0,
    '@errors': 1,
    '@skipped': 0,
    '@time': seconds(record.durationMs),
    '@timestamp': timestamp(record.startedAt),
    '@hostname': clean(hostname),
    'properties': properties([
      ['flow', record.id],
      ['test_id', record.testId],
      ['name', record.name],
      ['file', forDisplay(record.file, cwd)],
      ['tags', record.tags.join(',')],
      ['status', record.outcome]
    ]),
    'testcase': [
      {
        '@name': clean(record.id),
        '@classname': clean(record.id),
        '@time': seconds(record.durationMs),
        ...outcomeElement('error', diagnosticsError(diagnostics))
      }
    ]
  };
};

const formatJUnit = (suite, { hostname = os.hostname(), cwd = process.cwd() } = {}) => {
  const environment = { cwd, hostname };
  const suites = (suite.flows || []).flatMap((record) =>
    record.result
      ? record.result.iterations.map((iteration) => iterationSuite(record, iteration, record.result, environment))
      : [invalidSuite(record, environment)]
  );

  const total = (attribute) => suites.reduce((sum, entry) => sum + entry[attribute], 0);

  const document = {
    testsuites: {
      '@name': 'bru flow run',
      '@tests': total('@tests'),
      '@failures': total('@failures'),
      '@errors': total('@errors'),
      '@skipped': total('@skipped'),
      '@time': seconds(suite.durationMs),
      '@timestamp': timestamp(suite.startedAt),
      'testsuite': suites
    }
  };

  return xmlbuilder.create(document, { encoding: 'UTF-8' }).end({ pretty: true });
};

/** The parent directory is the caller's to check, before any flow runs — see `parseReporterSpecs`. */
const factory = (context) => ({
  onSuiteEnd: async (suite) => {
    await fs.promises.writeFile(context.outputPath, formatJUnit(suite, { cwd: context.cwd }), 'utf8');
  }
});

module.exports = factory;
module.exports.formatJUnit = formatJUnit;
