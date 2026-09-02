/**
 * What the JUnit reports are built out of — 001 §14.8.1.
 *
 * Two shapes of the same report exist (`junit.js` counts steps, `junit-flows.js` counts flows), and
 * everything they disagree about is structure: which element a flow becomes, and what a count
 * counts. Everything below is the part they must *not* disagree about — how a value is made safe
 * for XML, how a duration and a timestamp are spelled, and what a reader is told about why a step
 * failed. Two copies of that would drift, and the drift would show as two reports of the same run
 * describing it differently.
 */
const path = require('path');

/** §14.6 reasons where the API answered and disagreed; everything else could not be carried out. */
const FAILURE_REASONS = new Set([
  'assertion-failed',
  'unexpected-status',
  'schema-validation-failed',
  'subflow-failed'
]);

/** Illegal in XML 1.0 at any escaping — a response body carrying one would make the file unparseable. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** xmlbuilder escapes; what it cannot do is drop a character the format has no encoding for. */
const clean = (value) => (value === undefined || value === null ? '' : String(value)).replace(ILLEGAL_XML, '');

const seconds = (ms) => (Math.max(0, ms || 0) / 1000).toFixed(3);

/** JUnit's `timestamp` is a local-looking `YYYY-MM-DDTHH:mm:ss`; readers reject the `Z` and millis. */
const timestamp = (iso) => String(iso || '').slice(0, 19);

const properties = (pairs) => {
  const property = pairs
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ '@name': clean(name), '@value': clean(value) }));
  return property.length ? { property } : undefined;
};

/** A path outside the working directory reads better absolute than as a chain of `..`. */
const forDisplay = (file, cwd) => {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') ? relative : file;
};

/**
 * Everything the step knows about why it ended that way, in the order a reader scans it: the
 * comparison that failed, then what the schema said, then the engine's own message, then where the
 * bodies are. §14.4 keeps all of it masked before it reaches here.
 */
const failureBody = (step) => {
  const lines = [];
  const failedAssertions = (step.assertions || []).filter((assertion) => !assertion.passed);

  for (const assertion of failedAssertions) {
    lines.push(`${assertion.expr}\n  expected ${JSON.stringify(assertion.expected)}\n  actual ${JSON.stringify(assertion.actual)}`);
  }

  for (const [where, result] of [['request', step.validation?.request], ['response', step.validation?.response]]) {
    for (const error of (result && result.errors) || []) lines.push(`${where} ${error.path} ${error.message}`);
  }

  // An `assertion-failed` message is the comparison expanded above, and a block that says
  // everything twice stops being read (§14.7's console output drops it for the same reason).
  if (step.message && !failedAssertions.length) lines.push(step.message);
  if (step.capturePath) lines.push(`capture ${step.capturePath}`);

  return lines.join('\n');
};

const outcomeElement = (element, { type, message, body }) => ({
  [element]: {
    '@type': clean(type),
    '@message': clean(message),
    ...(body ? { '#text': clean(body) } : {})
  }
});

/**
 * §14.5's provenance, in the order a reader scans it. Each entry is dropped when the run recorded
 * none — `properties` filters what is undefined, so an origin-less run writes nothing extra.
 */
const originProperties = (origin) =>
  (origin
    ? [
        ['host', origin.host],
        ['environment', origin.environment],
        ['globalEnvironment', origin.globalEnvironment]
      ]
    : []);

/**
 * The `<error>` a flow that never ran becomes, whichever shape is reporting it. The first
 * diagnostic names it and every one is listed, because a flow with three problems fixed one at a
 * time is three runs nobody needed to make.
 */
const diagnosticsError = (diagnostics) => {
  const first = diagnostics[0];

  return {
    type: (first && first.code) || 'invalid',
    message: (first && first.message) || 'the flow did not run',
    body: diagnostics.map((entry) => `${entry.severity} ${entry.code} ${entry.message}`).join('\n')
  };
};

module.exports = {
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
};
