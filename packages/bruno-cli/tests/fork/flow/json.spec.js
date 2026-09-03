/**
 * R4l — JSON reporter (001 §14.1).
 *
 * `formatJson` is the whole contract: a pretty-printed `SuiteResult` with a format marker in
 * front. The factory is a thin `fs.writeFileSync` wrapper around it, checked once at the bottom.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const reporterFactory = require('../../../src/fork/flow/reporters/json');
const { formatJson } = reporterFactory;

const step = (over = {}) => ({
  id: 'create_payment',
  kind: 'operation',
  status: 'success',
  attempts: 1,
  durationMs: 120,
  assertions: [],
  outputs: {},
  ...over
});

const suite = {
  startedAt: '2026-09-01T10:00:00.000Z',
  finishedAt: '2026-09-01T10:00:06.000Z',
  durationMs: 6000,
  flows: [
    {
      file: '/repo/flows/checkout.flow.yml',
      id: 'checkout',
      name: 'Checkout',
      tags: ['smoke', 'regression'],
      startedAt: '2026-09-01T10:00:00.000Z',
      finishedAt: '2026-09-01T10:00:05.000Z',
      durationMs: 5000,
      outcome: 'failed',
      diagnostics: [],
      result: {
        runId: 'r-1',
        status: 'failed',
        iterations: [
          {
            index: 0,
            row: { email: 'a@example.com' },
            status: 'failed',
            steps: [
              step(),
              step({
                id: 'verify_ledger',
                status: 'failed',
                reason: 'assertion-failed',
                name: 'Verify ledger balance',
                meta: { testId: 'TC-200', owner: 'payments', priority: 1 },
                assertions: [{ expr: 'res.body.data.balance eq 9900', passed: false, expected: 9900, actual: 8900 }]
              })
            ],
            decidedBy: ['verify_ledger']
          },
          {
            index: 1,
            row: { email: 'b@example.com' },
            status: 'passed',
            steps: [step({ name: 'Create payment' })]
          }
        ],
        decidedBy: ['verify_ledger'],
        summary: { total: 3, passed: 2, failed: 1, skipped: 0, cancelled: 0 },
        diagnostics: [],
        captureDir: '.bruno-runs/2026-09-01T10-00-00Z'
      }
    },
    {
      file: '/repo/flows/missing-param.flow.yml',
      id: 'missing-param',
      name: 'Missing Param',
      tags: [],
      startedAt: '2026-09-01T10:00:05.000Z',
      finishedAt: '2026-09-01T10:00:05.000Z',
      durationMs: 0,
      outcome: 'invalid',
      diagnostics: [
        {
          severity: 'error',
          code: 'missing-required-param',
          message: 'required param "accountId" was not supplied',
          file: '/repo/flows/missing-param.flow.yml',
          path: '/params/accountId'
        }
      ]
    }
  ],
  summary: {
    flows: { total: 2, passed: 0, failed: 1, cancelled: 0, invalid: 1 },
    steps: { total: 3, passed: 2, failed: 1, skipped: 0, cancelled: 0 }
  },
  exitCode: 1
};

describe('formatJson', () => {
  it('leads with the format markers, before any suite field', () => {
    const text = formatJson(suite);

    expect(text.indexOf('"format"')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('"format"')).toBeLessThan(text.indexOf('"formatVersion"'));
    expect(text.indexOf('"formatVersion"')).toBeLessThan(text.indexOf('"startedAt"'));
  });

  it('stamps the bruno-flow-suite marker and version 1', () => {
    const parsed = JSON.parse(formatJson(suite));

    expect(parsed.format).toBe('bruno-flow-suite');
    expect(parsed.formatVersion).toBe(1);
  });

  it('round-trips the suite losslessly underneath the markers', () => {
    const parsed = JSON.parse(formatJson(suite));
    const rest = { ...parsed };
    delete rest.format;
    delete rest.formatVersion;

    expect(rest).toEqual(suite);
  });

  it('carries every flow, in order', () => {
    const parsed = JSON.parse(formatJson(suite));

    expect(parsed.flows.map((flow) => flow.id)).toEqual(['checkout', 'missing-param']);
  });

  it('carries every iteration and every step, including name and meta', () => {
    const parsed = JSON.parse(formatJson(suite));
    const [checkout] = parsed.flows;

    expect(checkout.result.iterations).toHaveLength(2);

    const verifyLedger = checkout.result.iterations[0].steps.find((entry) => entry.id === 'verify_ledger');
    expect(verifyLedger.name).toBe('Verify ledger balance');
    expect(verifyLedger.meta).toEqual({ testId: 'TC-200', owner: 'payments', priority: 1 });

    const secondIteration = checkout.result.iterations[1].steps[0];
    expect(secondIteration.name).toBe('Create payment');
    expect(secondIteration.meta).toBeUndefined();
  });

  it('round-trips a step\'s meta values verbatim, string and number alike', () => {
    const parsed = JSON.parse(formatJson(suite));
    const verifyLedger = parsed.flows[0].result.iterations[0].steps.find((entry) => entry.id === 'verify_ledger');

    expect(verifyLedger.meta.testId).toBe('TC-200');
    expect(verifyLedger.meta.owner).toBe('payments');
    expect(verifyLedger.meta.priority).toBe(1);
  });

  it('carries an invalid flow with no result, alongside its diagnostics', () => {
    const parsed = JSON.parse(formatJson(suite));
    const invalid = parsed.flows.find((flow) => flow.id === 'missing-param');

    expect(invalid.result).toBeUndefined();
    expect(invalid.diagnostics).toHaveLength(1);
    expect(invalid.diagnostics[0].code).toBe('missing-required-param');
  });

  it('pretty-prints with two-space indentation', () => {
    const text = formatJson(suite);

    expect(text).toContain('\n  "format"');
  });
});

describe('the factory', () => {
  it('writes formatJson\'s output to context.outputPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-flow-json-'));
    const outputPath = path.join(dir, 'report.json');

    const reporter = reporterFactory({ outputPath, cwd: dir, options: {} });
    await reporter.onSuiteEnd(suite);

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toBe(formatJson(suite));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('--retries and --retry-failed fields', () => {
  const retried = {
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:00:03.000Z',
    durationMs: 3000,
    retryOf: 'suite-20260901-ab12',
    flows: [
      {
        file: '/repo/flows/checkout.flow.yml',
        id: 'checkout',
        name: 'Checkout',
        tags: [],
        startedAt: '2026-09-01T10:00:00.000Z',
        finishedAt: '2026-09-01T10:00:02.000Z',
        durationMs: 2000,
        outcome: 'passed',
        attempt: 2,
        flaky: true,
        diagnostics: [],
        result: {
          runId: 'r-2',
          status: 'passed',
          iterations: [{ index: 0, status: 'passed', steps: [step()] }],
          summary: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 },
          diagnostics: []
        }
      }
    ],
    summary: {
      flows: { total: 1, passed: 1, failed: 0, cancelled: 0, invalid: 0, flaky: 1 },
      steps: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 }
    },
    exitCode: 0
  };

  // The fields are additive to SuiteResult and FlowRunRecord — this reporter needs no code change
  // to carry them, only a check that spreading the suite doesn't quietly drop any of them.
  it('carries retryOf, attempt, flaky and the flaky summary count through untouched', () => {
    const parsed = JSON.parse(formatJson(retried));

    expect(parsed.retryOf).toBe('suite-20260901-ab12');
    expect(parsed.flows[0].attempt).toBe(2);
    expect(parsed.flows[0].flaky).toBe(true);
    expect(parsed.summary.flows.flaky).toBe(1);
  });

  // flaky is counted beside passed, not instead of it, so the flow counts must still add up.
  it('counts a flaky flow beside passed, so the flow counts still sum to total', () => {
    const parsed = JSON.parse(formatJson(retried));
    const { total, passed, failed, cancelled, invalid } = parsed.summary.flows;

    expect(passed + failed + cancelled + invalid).toBe(total);
  });

  it('adds none of the retry fields for a suite that carries none', () => {
    const parsed = JSON.parse(formatJson(suite));

    expect(parsed).not.toHaveProperty('retryOf');
    expect(parsed.flows[0]).not.toHaveProperty('attempt');
    expect(parsed.flows[0]).not.toHaveProperty('flaky');
    expect(parsed.summary.flows).not.toHaveProperty('flaky');
  });
});
