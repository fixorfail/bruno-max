/**
 * The JUnit report — 001 §14.3.
 *
 * Unlike §14.7's console output this **is** a stable format: CI and test-management importers read
 * it, so the element names, the counts and the property names are pinned rather than sampled. The
 * assertions below read the document back rather than diffing a golden string, so the mapping is
 * what is asserted and the whitespace is not.
 */
const path = require('path');

const { formatJUnit } = require('../../../src/fork/flow/reporters/junit');

const ROOT = path.resolve('/w');
const CHECKOUT = path.join(ROOT, 'flows', 'checkout.flow.yml');
const ENVIRONMENT = { cwd: ROOT, hostname: 'ci-box' };

const attributesIn = (xml) =>
  Object.fromEntries([...xml.matchAll(/([\w.:_-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));

const rootAttributes = (xml) => attributesIn(xml.match(/<testsuites\s[^>]*>/)[0]);

const suitesOf = (xml) =>
  xml
    .split(/(?=<testsuite )/)
    .slice(1)
    .map((chunk) => chunk.split('</testsuite>')[0]);

const suiteAttributes = (chunk) => attributesIn(chunk.match(/<testsuite\s[^>]*>/)[0]);

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

const casesOf = (chunk) =>
  chunk
    .split(/(?=<testcase )/)
    .slice(1)
    .map((piece) => {
      const selfClosing = piece.match(/^<testcase[^>]*\/>/);
      return selfClosing ? selfClosing[0] : piece.split('</testcase>')[0];
    });

/** Suite properties are the ones written before the first testcase. */
const suiteProperties = (chunk) => propertiesIn(chunk.split('<testcase')[0]);

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

const format = (flows, over) => formatJUnit(suite(flows, over), ENVIRONMENT);

describe('the document', () => {
  it('carries every flow in one testsuites element, with the counts summed', () => {
    const xml = format([
      record(),
      record({
        id: 'flows/refunds',
        outcome: 'failed',
        result: run({
          status: 'failed',
          iterations: [
            {
              index: 0,
              status: 'failed',
              steps: [
                step({ id: 'refund', status: 'failed', reason: 'assertion-failed' }),
                step({ id: 'transport', status: 'failed', reason: 'transport-error' }),
                step({ id: 'later', status: 'skipped', reason: 'unmet-dependency' })
              ]
            }
          ]
        })
      })
    ]);

    expect(suitesOf(xml)).toHaveLength(2);
    expect(rootAttributes(xml)).toMatchObject({
      name: 'bru flow run',
      tests: '4',
      failures: '1',
      errors: '1',
      skipped: '1'
    });
  });

  // Seconds to three decimals and a `YYYY-MM-DDTHH:mm:ss` stamp: readers reject the `Z` and millis.
  it('writes seconds and a millisecond-free timestamp', () => {
    const xml = format([record()]);
    expect(rootAttributes(xml)).toMatchObject({ time: '6.000', timestamp: '2026-09-02T10:00:00' });
    expect(suiteAttributes(suitesOf(xml)[0])).toMatchObject({
      time: '2.500',
      timestamp: '2026-09-02T10:00:00',
      hostname: 'ci-box'
    });
    expect(attributesIn(casesOf(suitesOf(xml)[0])[0])).toMatchObject({ time: '0.231' });
  });
});

describe('a suite', () => {
  it('names the flow, its tags and the run it came from', () => {
    const properties = suiteProperties(suitesOf(format([record()]))[0]);
    expect(properties).toEqual({
      flow: 'flows/checkout',
      name: 'Checkout happy path',
      file: path.join('flows', 'checkout.flow.yml'),
      tags: 'checkout,smoke',
      runId: 'r-1',
      status: 'passed'
    });
  });

  // A tracker importing a suite at a time matches the flow on this one; a step-level `test_id`
  // would only ever match a step.
  it('carries the flow\'s own case id beside the steps\'', () => {
    const properties = suiteProperties(suitesOf(format([record({ testId: 'C9000' })]))[0]);
    expect(properties.test_id).toBe('C9000');
    expect(Object.keys(properties).slice(0, 2)).toEqual(['flow', 'test_id']);
  });

  it('writes no case id for a flow that declares none', () => {
    expect(suiteProperties(suitesOf(format([record()]))[0])).not.toHaveProperty('test_id');
  });

  // Present even when empty: a reader filtering on tags cannot otherwise tell an untagged flow from
  // a reporter that forgot to write them.
  it('writes an empty tags property rather than omitting it', () => {
    expect(suiteProperties(suitesOf(format([record({ tags: [] })]))[0]).tags).toBe('');
  });

  // Which environment a suite ran against is the first thing a CI reader asks of a red build.
  it('names the host and the environments the run was started with', () => {
    const xml = format([
      record({
        result: run({ origin: { host: 'cli', environment: 'local', globalEnvironment: 'staging' } })
      })
    ]);

    expect(suiteProperties(suitesOf(xml)[0])).toMatchObject({
      host: 'cli',
      environment: 'local',
      globalEnvironment: 'staging'
    });
  });

  // A run that recorded no provenance writes none, rather than empty attributes a reader would
  // have to tell apart from a run against no environment at all.
  it('writes no origin properties for a run that recorded none', () => {
    const properties = suiteProperties(suitesOf(format([record()]))[0]);
    expect(properties).not.toHaveProperty('host');
    expect(properties).not.toHaveProperty('environment');
    expect(properties).not.toHaveProperty('globalEnvironment');
  });

  it('omits the environments a run did not name', () => {
    const xml = format([record({ result: run({ origin: { host: 'cli' } }) })]);
    const properties = suiteProperties(suitesOf(xml)[0]);
    expect(properties.host).toBe('cli');
    expect(properties).not.toHaveProperty('globalEnvironment');
  });

  it('carries the run\'s warnings and capture directory as system-out', () => {
    const xml = format([
      record({
        result: run({
          diagnostics: [{ severity: 'warning', code: 'undeclared-dependency', message: 'reads steps.a.body' }],
          captureDir: '/w/.bruno-runs/r-1'
        })
      })
    ]);
    expect(xml).toContain('warning undeclared-dependency reads steps.a.body');
    expect(xml).toContain('capture /w/.bruno-runs/r-1');
  });

  // A row is a separate run of the same steps; merging them would show one step passing and failing
  // at once, so each iteration is its own suite and says which row it was.
  it('splits a dataset run into one suite per row', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            { index: 0, status: 'passed', row: { role: 'admin', tier: 'gold' }, steps: [step()] },
            { index: 1, status: 'passed', row: { role: 'viewer', tier: 'free' }, steps: [step()] }
          ]
        })
      })
    ]);

    const suites = suitesOf(xml);
    expect(suites.map((chunk) => suiteAttributes(chunk).name)).toEqual([
      'flows/checkout [row 1]',
      'flows/checkout [row 2]'
    ]);
    expect(suiteProperties(suites[0])).toMatchObject({ 'iteration': '1', 'row.role': 'admin', 'row.tier': 'gold' });
    expect(suiteProperties(suites[1])).toMatchObject({ 'iteration': '2', 'row.role': 'viewer' });
  });
});

describe('a testcase', () => {
  const singleStep = (over) =>
    casesOf(
      suitesOf(
        format([
          record({ result: run({ iterations: [{ index: 0, status: 'passed', steps: [step(over)] }] }) })
        ])
      )[0]
    )[0];

  // A step's `meta:` is the author's, and it arrives here as it was written. Only `testId` is
  // renamed, because `test_id` is the property a test-management importer reads.
  it('carries every meta entry, and names testId the way an importer reads it', () => {
    const testcase = singleStep({
      meta: { testId: 'C1234', owner: 'payments', flaky: false, links: ['a'] },
      name: 'Create a payment'
    });

    expect(attributesIn(testcase.split('>')[0])).toMatchObject({
      name: 'create_payment',
      classname: 'flows/checkout'
    });
    expect(propertiesIn(testcase)).toEqual({
      test_id: 'C1234',
      owner: 'payments',
      flaky: 'false',
      links: '["a"]',
      name: 'Create a payment'
    });
  });

  // Values are verbatim as parsed, so an id written unquoted reaches here as a number.
  it('writes a numeric case id as the id it is', () => {
    expect(propertiesIn(singleStep({ meta: { testId: 1234 } }))).toEqual({ test_id: '1234' });
  });

  it('writes no properties at all for a step that declares no meta', () => {
    const testcase = singleStep({});
    expect(propertiesIn(testcase)).toEqual({});
    expect(testcase).not.toContain('<properties>');
  });

  // JUnit's own distinction: the API answered and disagreed, against work that could not be carried
  // out at all. A transport error read as a failure would open a bug against the service.
  it('is a failure when the API disagreed and an error when it could not be reached', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            {
              index: 0,
              status: 'failed',
              steps: [
                step({
                  id: 'verify',
                  status: 'failed',
                  reason: 'assertion-failed',
                  message: 'balance mismatch',
                  assertions: [{ expr: 'res.body.balance eq 9900', passed: false, expected: 9900, actual: 8900 }],
                  capturePath: '.bruno-runs/r-1/verify/'
                }),
                step({ id: 'reach', status: 'failed', reason: 'transport-error', message: 'ECONNREFUSED' })
              ]
            }
          ]
        })
      })
    ]);

    const [verify, reach] = casesOf(suitesOf(xml)[0]);
    expect(verify).toContain('<failure type="assertion-failed" message="balance mismatch">');
    expect(verify).toContain('res.body.balance eq 9900');
    expect(verify).toContain('expected 9900');
    expect(verify).toContain('actual 8900');
    expect(verify).toContain('capture .bruno-runs/r-1/verify/');
    // The message of an assertion failure is the comparison the block already expands, so it is in
    // the attribute and nowhere else; a step with no assertions still carries its message in the body.
    expect(verify.match(/balance mismatch/g)).toHaveLength(1);
    expect(reach.match(/ECONNREFUSED/g)).toHaveLength(2);
    expect(reach).toContain('<error type="transport-error" message="ECONNREFUSED">');
    expect(suiteAttributes(suitesOf(xml)[0])).toMatchObject({ failures: '1', errors: '1' });
  });

  it('lists the schema errors that failed the step', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            {
              index: 0,
              status: 'failed',
              steps: [
                step({
                  status: 'failed',
                  reason: 'schema-validation-failed',
                  validation: {
                    response: { valid: false, errors: [{ path: '/data/id', message: 'must be string' }] }
                  }
                })
              ]
            }
          ]
        })
      })
    ]);

    expect(xml).toContain('response /data/id must be string');
  });

  it('is skipped when the step did not run, and says why', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            {
              index: 0,
              status: 'passed',
              steps: [step({ status: 'skipped', reason: 'condition-false', message: 'when: false' })]
            }
          ]
        })
      })
    ]);

    expect(casesOf(suitesOf(xml)[0])[0]).toContain('<skipped message="condition-false: when: false"/>');
    expect(suiteAttributes(suitesOf(xml)[0])).toMatchObject({ skipped: '1' });
  });

  /**
   * §11.2's `failOnUnresolved` fails a run through a step that is *skipped*, so trusting the step's
   * own status would produce a failing suite whose every testcase reads green — the one shape a CI
   * dashboard cannot show.
   */
  it('is a failure when a skipped step decided the run\'s status', () => {
    const xml = format([
      record({
        outcome: 'failed',
        result: run({
          status: 'failed',
          decidedBy: ['verify'],
          iterations: [
            {
              index: 0,
              status: 'failed',
              decidedBy: ['verify'],
              steps: [
                step({
                  id: 'verify',
                  status: 'skipped',
                  reason: 'unresolved-dependency',
                  message: 'steps.create_payment.paymentId never produced'
                })
              ]
            }
          ]
        })
      })
    ]);

    const [testcase] = casesOf(suitesOf(xml)[0]);
    expect(testcase).toContain('<failure type="unresolved-dependency"');
    expect(testcase).toContain('decided the run');
    expect(testcase).not.toContain('<skipped');
    expect(suiteAttributes(suitesOf(xml)[0])).toMatchObject({ failures: '1', skipped: '0' });
  });

  // §12's flat array holds the container and its internals; counting both counts the same work twice.
  it('drops a sub-flow container and keeps the steps that did the work', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            {
              index: 0,
              status: 'passed',
              steps: [
                step({ id: 'auth', kind: 'subflow' }),
                step({ id: 'auth/login' }),
                step({ id: 'auth/refresh' }),
                step({ id: 'pay' })
              ]
            }
          ]
        })
      })
    ]);

    const names = casesOf(suitesOf(xml)[0]).map((testcase) => attributesIn(testcase.split('>')[0]).name);
    expect(names).toEqual(['auth/login', 'auth/refresh', 'pay']);
    expect(suiteAttributes(suitesOf(xml)[0])).toMatchObject({ tests: '3' });
  });

  it('keeps a sub-flow container that has no internals to stand in for it', () => {
    const xml = format([
      record({
        result: run({
          iterations: [
            { index: 0, status: 'failed', steps: [step({ id: 'auth', kind: 'subflow', status: 'failed', reason: 'subflow-failed' })] }
          ]
        })
      })
    ]);

    expect(casesOf(suitesOf(xml)[0])).toHaveLength(1);
  });

  it('reports the attempts a retried step took', () => {
    const xml = format([
      record({ result: run({ iterations: [{ index: 0, status: 'passed', steps: [step({ attempts: 3 })] }] }) })
    ]);
    expect(propertiesIn(casesOf(suitesOf(xml)[0])[0])).toMatchObject({ attempts: '3' });
  });
});

describe('a flow that never ran', () => {
  // A selection whose file was mis-typed and one whose API broke look identical in a report that
  // lists only what executed, and the first is the one nobody notices.
  it('is a suite of one error naming every diagnostic', () => {
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

    const [chunk] = suitesOf(xml);
    expect(suiteAttributes(chunk)).toMatchObject({ tests: '1', errors: '1', failures: '0', skipped: '0' });
    expect(suiteProperties(chunk)).toMatchObject({ status: 'invalid' });
    expect(chunk).toContain('<error type="unknown-operation" message="no operation createPaymnt">');
    expect(chunk).toContain('error unknown-api no api ledger');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', errors: '1' });
  });
});

describe('sanitizing', () => {
  // A body carrying a NUL or a vertical tab would make the file unparseable at any escaping, and a
  // report a CI server cannot read is worse than one that lost a character.
  it('strips characters XML 1.0 cannot encode, in text and in attributes', () => {
    const hostile = 'bad\u0000 \u000bvalue here';
    const xml = format([
      record({
        name: 'Checkout\u0007',
        result: run({
          iterations: [
            {
              index: 0,
              status: 'failed',
              steps: [step({ status: 'failed', reason: 'script-error', message: hostile })]
            }
          ]
        })
      })
    ]);

    expect(xml).toContain('bad value here');
    expect(xml).toMatch(/message="bad value here"/);
    expect(suiteProperties(suitesOf(xml)[0]).name).toBe('Checkout');
    // Nothing illegal survived anywhere in the document.
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml)).toBe(false);
  });
});
