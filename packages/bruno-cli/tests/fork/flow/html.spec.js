/**
 * R4l — HTML reporter (001 §14.1).
 *
 * The fixture below exercises every shape the reporter must render: a dataset-driven flow with a
 * failed step (assertions + a schema error), a skipped step and a sub-flow internal, plus a second
 * flow that never ran (`outcome: 'invalid'`) and carries only diagnostics. Assertions check
 * properties — escaping, presence, counts — never the exact markup, so a markup tweak doesn't
 * become a failing test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const reporterFactory = require('../../../src/fork/flow/reporters/html');
const { formatHtml } = reporterFactory;

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
      testId: 'C9000',
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
                meta: { testId: 'TC-200', owner: 'payments <script>alert(2)</script>' },
                message: 'unexpected balance <script>alert(1)</script>',
                assertions: [
                  { expr: 'res.body.data.balance eq 9900', passed: false, expected: 9900, actual: 8900 }
                ],
                validation: {
                  response: { valid: false, errors: [{ path: '/data/balance', message: 'must be integer', keyword: 'type' }] }
                },
                capturePath: '.bruno-runs/2026-09-01T10-00-00Z/verify_ledger/'
              }),
              step({
                id: 'archive_receipt',
                status: 'skipped',
                reason: 'unresolved-dependency',
                message: 'never produced: steps.create_payment.token',
                attempts: 0,
                durationMs: 0
              }),
              step({ id: 'auth', kind: 'subflow' }),
              step({ id: 'auth/login', name: 'Login', durationMs: 40 })
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
        summary: { total: 6, passed: 4, failed: 1, skipped: 1, cancelled: 0 },
        diagnostics: [],
        captureDir: '.bruno-runs/2026-09-01T10-00-00Z',
        origin: { host: 'cli', globalEnvironment: 'staging' }
      }
    },
    {
      file: '/outside/flows/missing-param.flow.yml',
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
        },
        {
          severity: 'error',
          code: 'run-refused',
          message: 'runFlow refused: missing required param',
          file: '/repo/flows/missing-param.flow.yml'
        }
      ]
    }
  ],
  summary: {
    flows: { total: 2, passed: 0, failed: 1, cancelled: 0, invalid: 1 },
    steps: { total: 6, passed: 4, failed: 1, skipped: 1, cancelled: 0 }
  },
  exitCode: 1
};

const env = { now: () => 1735689600000, command: 'bru flow run flows/', cwd: '/repo' };

describe('formatHtml', () => {
  it('references no external URL', () => {
    const html = formatHtml(suite, env);

    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes a hostile message rather than emitting it raw', () => {
    const html = formatHtml(suite, env);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders every flow\'s tags as chips', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('class="chip">smoke');
    expect(html).toContain('class="chip">regression');
  });

  it('renders the flow\'s own testId as the first chip in its header', () => {
    const html = formatHtml(suite, env);
    const checkoutHeader = html.slice(html.indexOf('checkout'), html.indexOf('<div class="iteration"'));

    expect(checkoutHeader).toContain('class="chip">testId: C9000');
    expect(checkoutHeader.indexOf('testId: C9000')).toBeLessThan(checkoutHeader.indexOf('class="chip">smoke'));
  });

  it('renders no testId chip in a flow header that declared none', () => {
    const html = formatHtml(suite, env);
    const missingParamSection = html.slice(html.indexOf('missing-param'));

    expect(missingParamSection).not.toContain('testId:');
  });

  it('renders chips for the origin fields the host supplied', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('class="chip">host: cli');
    expect(html).toContain('class="chip">globalEnvironment: staging');
    expect(html).not.toContain('environment:');
  });

  it('renders no origin chips for a flow with no result', () => {
    const html = formatHtml(suite, env);
    const missingParamSection = html.slice(html.indexOf('missing-param'));

    expect(missingParamSection).not.toContain('class="chip">host:');
  });

  it('shows a flow\'s file relative to env.cwd when it is inside cwd', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('class="flow-file">flows/checkout.flow.yml');
    expect(html).not.toContain('/repo/flows/checkout.flow.yml');
  });

  it('shows a flow\'s file absolute when it falls outside env.cwd', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('class="flow-file">/outside/flows/missing-param.flow.yml');
  });

  it('renders a step\'s meta entries as key: value chips', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('class="chip">testId: TC-200');
    expect(html).toContain('class="chip">owner: payments');
  });

  it('escapes a meta value rather than emitting it raw', () => {
    const html = formatHtml(suite, env);

    expect(html).not.toContain('owner: payments <script>alert(2)</script>');
    expect(html).toContain('owner: payments &lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('names every step id', () => {
    const html = formatHtml(suite, env);

    for (const id of ['create_payment', 'verify_ledger', 'archive_receipt', 'auth', 'auth/login']) {
      expect(html).toContain(id);
    }
  });

  it('shows the failed assertion\'s expected and actual values', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('9900');
    expect(html).toContain('8900');
  });

  it('shows the schema validation error', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('/data/balance');
    expect(html).toContain('must be integer');
  });

  it('shows the capture path for a failed step', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('.bruno-runs/2026-09-01T10-00-00Z/verify_ledger/');
  });

  it('shows the skip reason and message', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('unresolved-dependency');
    expect(html).toContain('never produced: steps.create_payment.token');
  });

  it('captions a dataset iteration with its row', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('a@example.com');
    expect(html).toContain('b@example.com');
  });

  it('shows diagnostics for a flow that never ran', () => {
    const html = formatHtml(suite, env);

    expect(html).toContain('missing-required-param');
    expect(html).toContain('required param &quot;accountId&quot; was not supplied');
  });

  it('matches the fixture\'s summary counts', () => {
    const html = formatHtml(suite, env);
    const cardValue = (label) => {
      const match = html.match(new RegExp(`<div class="card-value">(\\d+)</div>\\s*<div class="card-label">${label}</div>`));
      return match && Number(match[1]);
    };

    expect(cardValue('Failed')).not.toBeNull();
    // Both groups (flows and steps) contribute a "Failed" card; both must equal the fixture's counts.
    const failedCards = [...html.matchAll(/<div class="card-value">(\d+)<\/div>\s*<div class="card-label">Failed<\/div>/g)].map(
      (match) => Number(match[1])
    );
    expect(failedCards).toEqual([suite.summary.flows.failed, suite.summary.steps.failed]);

    expect(html).toContain('<div class="card-value">2</div>'); // flows total
    expect(html).toContain('<div class="card-value">6</div>'); // steps total
  });

  it('is deterministic given the same suite and env', () => {
    expect(formatHtml(suite, env)).toBe(formatHtml(suite, env));
  });
});

describe('the factory', () => {
  it('writes formatHtml\'s output to context.outputPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-flow-html-'));
    const outputPath = path.join(dir, 'report.html');

    const reporter = reporterFactory({ outputPath, cwd: dir, options: {} });
    await reporter.onSuiteEnd(suite);

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toContain('<!doctype html>');
    expect(written).toContain('checkout');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('--retries and --retry-failed', () => {
  const retried = {
    ...suite,
    retryOf: 'suite-20260901-ab12',
    flows: [
      { ...suite.flows[0], outcome: 'passed', attempt: 2, flaky: true },
      suite.flows[1]
    ]
  };

  it('names the retried suite in the header when retryOf is set', () => {
    const html = formatHtml(retried, env);

    expect(html).toContain('retry of suite-20260901-ab12');
  });

  it('writes no retry line for a suite that did not retry', () => {
    const html = formatHtml(suite, env);

    expect(html).not.toContain('retry of');
  });

  // The flaky badge sits beside the ordinary pass badge, not in place of it — the counts already
  // say the flow passed, so this only has to say it wasn't a clean pass. Sliced from the section
  // start rather than a text search, because `badge-flaky` also names a CSS rule earlier in the page.
  it('shows a distinct flaky badge beside the pass badge on a flow that passed after retrying', () => {
    const html = formatHtml(retried, env);
    const checkoutSection = html.slice(html.indexOf('<section class="flow">'), html.indexOf('<div class="iteration"'));

    expect(checkoutSection).toContain('<span class="badge badge-passed">');
    expect(checkoutSection).toContain('<span class="badge badge-flaky">Flaky</span>');
  });

  it('notes the attempt a retried flow passed on', () => {
    const html = formatHtml(retried, env);

    expect(html).toContain('class="chip">attempt 2');
  });

  it('shows no flaky badge or attempt note for a flow that ran once', () => {
    const html = formatHtml(suite, env);

    expect(html).not.toContain('<span class="badge badge-flaky">');
    expect(html).not.toContain('class="chip">attempt');
  });
});
