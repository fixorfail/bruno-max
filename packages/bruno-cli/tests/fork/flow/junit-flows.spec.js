/**
 * The flow-level JUnit report — 001 §14.8.1.
 *
 * The step-level shape's specs pin what a step becomes; these pin the level above it, where the
 * whole invocation is one suite and a flow — however many steps and however many dataset rows it
 * ran — is exactly one testcase. That collapsing is the entire point of the shape, so what is
 * asserted here is mostly that nothing about a flow's internals can change the count.
 */
const path = require('path');

const { formatJUnitFlows } = require('../../../src/fork/flow/reporters/junit-flows');

const ROOT = path.resolve('/w');
const CHECKOUT = path.join(ROOT, 'flows', 'checkout.flow.yml');
const ENVIRONMENT = { cwd: ROOT, hostname: 'ci-box' };

const attributesIn = (xml) =>
  Object.fromEntries([...xml.matchAll(/([\w.:_-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));

const rootAttributes = (xml) => attributesIn(xml.match(/<testsuites\s[^>]*>/)[0]);
const suiteAttributes = (xml) => attributesIn(xml.match(/<testsuite\s[^>]*>/)[0]);

const decode = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const propertiesIn = (chunk) =>
  Object.fromEntries(
    [...chunk.matchAll(/<property name="([^"]*)" value="([^"]*)"\/>/g)].map(([, name, value]) => [name, decode(value)])
  );

/** `<testsuites>`' own properties are the ones written before the nested `<testsuite `. */
const rootProperties = (xml) => propertiesIn(xml.split('<testsuite ')[0]);

const casesOf = (xml) =>
  xml
    .split(/(?=<testcase )/)
    .slice(1)
    .map((piece) => {
      const selfClosing = piece.match(/^<testcase[^>]*\/>/);
      return selfClosing ? selfClosing[0] : piece.split('</testcase>')[0];
    });

const step = (over = {}) => ({
  id: 'create_payment',
  kind: 'operation',
  status: 'success',
  attempts: 1,
  durationMs: 231,
  assertions: [],
  outputs: {},
  ...over
});

const run = (over = {}) => ({
  runId: 'r-1',
  status: 'passed',
  iterations: [{ index: 0, status: 'passed', steps: [step()] }],
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 },
  diagnostics: [],
  ...over
});

const record = (over = {}) => ({
  file: CHECKOUT,
  id: 'flows/checkout',
  name: 'Checkout happy path',
  tags: ['checkout', 'smoke'],
  startedAt: '2026-09-02T10:00:00.000Z',
  finishedAt: '2026-09-02T10:00:02.500Z',
  durationMs: 2500,
  outcome: 'passed',
  diagnostics: [],
  result: run(),
  ...over
});

const suite = (flows, over = {}) => ({
  startedAt: '2026-09-02T10:00:00.000Z',
  finishedAt: '2026-09-02T10:00:06.000Z',
  durationMs: 6000,
  flows,
  summary: {
    flows: { total: flows.length, passed: flows.length, failed: 0, cancelled: 0, invalid: 0 },
    steps: { total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 }
  },
  exitCode: 0,
  ...over
});

const format = (flows, over) => formatJUnitFlows(suite(flows, over), ENVIRONMENT);

const failedRun = (steps, over = {}) =>
  run({
    status: 'failed',
    iterations: [{ index: 0, status: 'failed', steps }],
    ...over
  });

describe('the document', () => {
  it('is one suite of the whole invocation, one testcase per flow', () => {
    const xml = format([
      record(),
      record({
        id: 'flows/refunds',
        outcome: 'failed',
        result: failedRun([
          step({ id: 'refund', status: 'failed', reason: 'assertion-failed' }),
          step({ id: 'later', status: 'skipped', reason: 'unmet-dependency' })
        ])
      })
    ]);

    expect(xml.match(/<testsuite /g)).toHaveLength(1);
    expect(casesOf(xml).map((testcase) => attributesIn(testcase.split('>')[0]).name)).toEqual([
      'flows/checkout',
      'flows/refunds'
    ]);

    // Two flows, one of them red — the steps underneath change nothing about either count.
    const counts = { name: 'bru flow run', tests: '2', failures: '1', errors: '0', skipped: '0' };
    expect(rootAttributes(xml)).toMatchObject(counts);
    expect(suiteAttributes(xml)).toMatchObject({ ...counts, hostname: 'ci-box' });
  });

  it('writes seconds and a millisecond-free timestamp', () => {
    const xml = format([record()]);
    expect(rootAttributes(xml)).toMatchObject({ time: '6.000', timestamp: '2026-09-02T10:00:00' });
    expect(attributesIn(casesOf(xml)[0])).toMatchObject({ time: '2.500', classname: 'flows/checkout' });
  });
});

describe('a testcase', () => {
  it('names the flow, its file, its tags and the run it came from', () => {
    expect(propertiesIn(casesOf(format([record()]))[0])).toEqual({
      name: 'Checkout happy path',
      file: path.join('flows', 'checkout.flow.yml'),
      tags: 'checkout,smoke',
      runId: 'r-1',
      status: 'passed'
    });
  });

  // First of the properties, because it is what a tracker keys the case on.
  it('leads with the flow\'s case id when it declares one', () => {
    const properties = propertiesIn(casesOf(format([record({ testId: 'C9000' })]))[0]);
    expect(properties.test_id).toBe('C9000');
    expect(Object.keys(properties)[0]).toBe('test_id');
  });

  it('writes no case id for a flow that declares none', () => {
    expect(propertiesIn(casesOf(format([record()]))[0])).not.toHaveProperty('test_id');
  });

  // Present even when empty: a reader filtering on tags cannot tell an untagged flow from a
  // reporter that forgot to write them.
  it('writes an empty tags property rather than omitting it', () => {
    expect(propertiesIn(casesOf(format([record({ tags: [] })]))[0]).tags).toBe('');
  });

  it('names the host and the environments the run was started with', () => {
    const xml = format([
      record({ result: run({ origin: { host: 'cli', globalEnvironment: 'staging' } }) })
    ]);
    expect(propertiesIn(casesOf(xml)[0])).toMatchObject({ host: 'cli', globalEnvironment: 'staging' });
  });

  // A dataset flow is one case however many rows it ran; the count is what says so, and the row is
  // named in the body so a reader knows which one broke.
  it('collapses a dataset run into one case that says how many rows it covered', () => {
    const xml = format([
      record({
        outcome: 'failed',
        result: run({
          status: 'failed',
          decidedBy: ['verify'],
          iterations: [
            { index: 0, status: 'passed', row: { role: 'admin' }, steps: [step()] },
            {
              index: 1,
              status: 'failed',
              row: { role: 'viewer' },
              steps: [step({ id: 'verify', status: 'failed', reason: 'assertion-failed', message: 'forbidden' })]
            }
          ]
        })
      })
    ]);

    const [testcase] = casesOf(xml);
    expect(casesOf(xml)).toHaveLength(1);
    expect(propertiesIn(testcase)).toMatchObject({ iterations: '2' });
    expect(testcase).toContain('verify [row 2]');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', failures: '1' });
  });

  // JUnit's own distinction, applied to the verdict rather than to one step: the API answered and
  // disagreed only if every step the run fell on says so.
  it('is a failure when every deciding step disagreed and an error when one could not run', () => {
    const disagreed = format([
      record({
        outcome: 'failed',
        result: failedRun(
          [step({ id: 'verify', status: 'failed', reason: 'assertion-failed' })],
          { decidedBy: ['verify'] }
        )
      })
    ]);
    const unreachable = format([
      record({
        outcome: 'failed',
        result: failedRun(
          [
            step({ id: 'verify', status: 'failed', reason: 'assertion-failed' }),
            step({ id: 'reach', status: 'failed', reason: 'transport-error' })
          ],
          { decidedBy: ['verify', 'reach'] }
        )
      })
    ]);

    expect(disagreed).toContain('<failure type="assertion-failed" message="1 step(s) decided the run: verify">');
    expect(unreachable).toContain('<error type="assertion-failed" message="2 step(s) decided the run: verify, reach">');
    expect(suiteAttributes(disagreed)).toMatchObject({ failures: '1', errors: '0' });
    expect(suiteAttributes(unreachable)).toMatchObject({ failures: '0', errors: '1' });
  });

  it('expands each deciding step underneath its own heading', () => {
    const xml = format([
      record({
        outcome: 'failed',
        result: failedRun(
          [
            step({
              id: 'verify',
              status: 'failed',
              reason: 'assertion-failed',
              assertions: [{ expr: 'res.body.balance eq 9900', passed: false, expected: 9900, actual: 8900 }],
              capturePath: '.bruno-runs/r-1/verify/'
            })
          ],
          { decidedBy: ['verify'] }
        )
      })
    ]);

    // The heading opens the body and the step's own detail follows it; the exact leading whitespace
    // is xmlbuilder's to decide once it indents the text node.
    expect(xml).toMatch(/<failure[^>]*>verify\n/);
    expect(xml).toContain('res.body.balance eq 9900');
    expect(xml).toContain('expected 9900');
    expect(xml).toContain('capture .bruno-runs/r-1/verify/');
  });

  /**
   * §11.2's `failOnUnresolved` fails a run through a step that is *skipped*, so the verdict has to
   * come from `decidedBy` rather than from what the steps say about themselves.
   */
  it('reports a skipped step that decided the run', () => {
    const xml = format([
      record({
        outcome: 'failed',
        result: failedRun(
          [step({ id: 'verify', status: 'skipped', reason: 'unresolved-dependency', message: 'never produced' })],
          { decidedBy: ['verify'] }
        )
      })
    ]);

    expect(xml).toContain('<error type="unresolved-dependency" message="1 step(s) decided the run: verify">');
    expect(xml).toContain('never produced');
  });

  // A run the engine named no deciding step for still has to say what broke, or the reader is sent
  // to the logs for something the report was holding.
  it('falls back to every failed step when the run named none', () => {
    const xml = format([
      record({
        outcome: 'failed',
        result: failedRun([
          step({ id: 'first', status: 'failed', reason: 'assertion-failed' }),
          step({ id: 'second', status: 'failed', reason: 'assertion-failed' }),
          step({ id: 'third', status: 'success' })
        ])
      })
    ]);

    expect(xml).toContain('message="2 step(s) decided the run: first, second"');
  });

  it('is an error when the run was cancelled', () => {
    const xml = format([
      record({ outcome: 'cancelled', result: run({ status: 'cancelled' }) })
    ]);

    expect(xml).toContain('<error type="run-cancelled" message="the run was cancelled"/>');
    expect(suiteAttributes(xml)).toMatchObject({ tests: '1', errors: '1', failures: '0', skipped: '0' });
  });

  it('is an error naming every diagnostic when the flow never ran', () => {
    const xml = format([
      record({
        outcome: 'invalid',
        result: undefined,
        durationMs: 0,
        diagnostics: [
          { severity: 'error', code: 'unknown-operation', message: 'no operation createPaymnt', file: CHECKOUT },
          { severity: 'error', code: 'unknown-api', message: 'no api ledger', file: CHECKOUT }
        ]
      })
    ]);

    expect(xml).toContain('<error type="unknown-operation" message="no operation createPaymnt">');
    expect(xml).toContain('error unknown-api no api ledger');
    expect(propertiesIn(casesOf(xml)[0])).toMatchObject({ status: 'invalid' });
    expect(suiteAttributes(xml)).toMatchObject({ tests: '1', errors: '1' });
  });
});

describe('sanitizing', () => {
  // A body carrying a NUL or a vertical tab would make the file unparseable at any escaping, and a
  // report a CI server cannot read is worse than one that lost a character.
  it('strips characters XML 1.0 cannot encode, in text and in attributes', () => {
    const xml = format([
      record({
        name: 'Checkout\u0007',
        outcome: 'failed',
        result: failedRun(
          [step({ id: 'verify', status: 'failed', reason: 'script-error', message: 'bad\u0000 \u000bvalue here' })],
          { decidedBy: ['verify'] }
        )
      })
    ]);

    expect(xml).toContain('bad value here');
    expect(propertiesIn(casesOf(xml)[0]).name).toBe('Checkout');
    // Nothing illegal survived anywhere in the document.
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml)).toBe(false);
  });
});

describe('--retries and --retry-failed', () => {
  it('names the retried suite on <testsuites> when the suite retried one', () => {
    const xml = format([record()], { retryOf: 'suite-20260901-ab12' });
    expect(rootProperties(xml)).toEqual({ retry_of: 'suite-20260901-ab12' });
  });

  it('writes no retry_of property for a suite that did not retry', () => {
    expect(rootProperties(format([record()]))).toEqual({});
  });

  it('carries the attempt and flaky properties on a flow that passed after retrying', () => {
    const xml = format([record({ attempt: 2, flaky: true })]);
    expect(propertiesIn(casesOf(xml)[0])).toMatchObject({ attempt: '2', flaky: 'true' });
  });

  it('carries attempt alone for a retry that produced no flakiness', () => {
    const properties = propertiesIn(casesOf(format([record({ attempt: 2 })]))[0]);
    expect(properties.attempt).toBe('2');
    expect(properties).not.toHaveProperty('flaky');
  });

  it('writes neither property for a flow that ran once', () => {
    const properties = propertiesIn(casesOf(format([record()]))[0]);
    expect(properties).not.toHaveProperty('attempt');
    expect(properties).not.toHaveProperty('flaky');
  });

  // A flaky flow turned CI green on retry, so it has to read as a pass here too — never as an
  // invented <failure> or <error> for the attempt that missed.
  it('counts a flaky flow as a pass, and mentions it in system-out', () => {
    const xml = format([record({ attempt: 2, flaky: true, outcome: 'passed' })]);
    expect(suiteAttributes(xml)).toMatchObject({ failures: '0', errors: '0', skipped: '0' });
    expect(xml).not.toContain('<failure');
    expect(xml).not.toContain('<error');
    expect(xml).toMatch(/<system-out>[^<]*flaky[^<]*attempt 2[^<]*<\/system-out>/);
  });
});
