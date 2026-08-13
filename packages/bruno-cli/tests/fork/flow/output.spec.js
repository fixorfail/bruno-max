/**
 * R4l — console output properties (001-C §7, 001 §14.7).
 *
 * These assert **properties, never exact text**. §14.7 is deliberately not a stable format;
 * pinning its wording would make every phrasing improvement a failing test, and the real contract
 * is the exit code and the reporters.
 */
const { createReporter, wantsColour } = require('../../../src/fork/flow/output');

const ANSI = /\[/;

const capture = (options) => {
  const lines = [];
  const reporter = createReporter({ write: (line) => lines.push(line), ...options });
  return { reporter, lines, text: () => lines.join('\n') };
};

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

const failedRun = {
  runId: 'r-1',
  status: 'failed',
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0 },
  diagnostics: [],
  iterations: [
    {
      index: 0,
      status: 'failed',
      steps: [
        step(),
        step({
          id: 'verify_ledger',
          status: 'failed',
          reason: 'assertion-failed',
          assertions: [
            { expr: 'res.body.data.balance eq 9900', passed: false, expected: 9900, actual: 8900 }
          ],
          capturePath: '.bruno-runs/2026-08-07T10-14-02Z/verify_ledger/'
        })
      ]
    }
  ]
};

const runThrough = (reporter, result = failedRun) => {
  reporter.flowStarted('flows/checkout.flow.yml');
  for (const iteration of result.iterations) {
    for (const entry of iteration.steps) {
      reporter.onEvent({ type: 'step:end', id: entry.id, index: iteration.index, result: entry });
    }
  }
  reporter.flowFinished(result);
};

describe('colour', () => {
  // A colour code in an archived CI log is corruption.
  it('emits no escape sequences when stdout is not a TTY', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter);
    expect(text()).not.toMatch(ANSI);
  });

  // The convention is honoured, not just the flag.
  it('honours NO_COLOR on a TTY', () => {
    expect(wantsColour({ tty: true, noColor: false, env: { NO_COLOR: '1' } })).toBe(false);

    const { reporter, text } = capture({ tty: true, env: { NO_COLOR: '1' } });
    runThrough(reporter);
    expect(text()).not.toMatch(ANSI);
  });

  it('honours --no-color on a TTY', () => {
    const { reporter, text } = capture({ tty: true, noColor: true, env: {} });
    runThrough(reporter);
    expect(text()).not.toMatch(ANSI);
  });

  it('colours a TTY that asked for nothing else', () => {
    const { reporter, text } = capture({ tty: true, env: {} });
    runThrough(reporter);
    expect(text()).toMatch(ANSI);
  });
});

describe('the failure block', () => {
  it('names the failed step and its reason', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter);

    expect(text()).toContain('verify_ledger');
    expect(text()).toContain('assertion-failed');
  });

  it('shows expected and actual for a failing assertion', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter);

    expect(text()).toContain('9900');
    expect(text()).toContain('8900');
  });

  it('names the capture path', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter);

    expect(text()).toContain('.bruno-runs/2026-08-07T10-14-02Z/verify_ledger/');
  });

  // Only failures get a block; a passing step is one line, and a 200 KB response in a terminal
  // buries the one line that mattered.
  it('inlines no response body', () => {
    const { reporter, lines } = capture({ tty: false, env: {} });
    runThrough(reporter);

    expect(lines.filter((line) => line.includes('create_payment'))).toHaveLength(1);
  });
});

describe('verbosity', () => {
  it('writes nothing at all under --silent', () => {
    const passing = { ...failedRun, status: 'passed' };
    for (const result of [failedRun, passing]) {
      const { reporter, lines } = capture({ tty: false, env: {}, verbosity: 'silent' });
      runThrough(reporter, result);
      expect(lines).toEqual([]);
    }
  });

  it('writes the summary and failure blocks but no per-step lines under --quiet', () => {
    const { reporter, text } = capture({ tty: false, env: {}, verbosity: 'quiet' });
    runThrough(reporter);

    expect(text()).toContain('1 failed');
    expect(text()).toContain('assertion-failed');
    expect(text()).not.toContain('231ms');
  });

  // A sub-flow is one step to its caller (§12); --verbose expands it to its namespaced internals.
  it('collapses sub-flow internals by default and expands them under --verbose', () => {
    const withInternals = {
      ...failedRun,
      iterations: [
        { index: 0, status: 'passed', steps: [step({ id: 'auth', kind: 'subflow' }), step({ id: 'auth/login' })] }
      ]
    };

    const collapsed = capture({ tty: false, env: {} });
    runThrough(collapsed.reporter, withInternals);
    expect(collapsed.text()).not.toContain('auth/login');

    const expanded = capture({ tty: false, env: {}, verbosity: 'verbose' });
    runThrough(expanded.reporter, withInternals);
    expect(expanded.text()).toContain('auth/login');
  });
});

describe('markers', () => {
  it('falls back to ASCII under --no-unicode', () => {
    const { reporter, text } = capture({ tty: false, env: {}, unicode: false });
    runThrough(reporter);

    expect(text()).not.toMatch(/[✓✗○⊘]/);
    expect(text()).toMatch(/\+ create_payment/);
    expect(text()).toMatch(/x verify_ledger/);
  });
});

describe('ordering', () => {
  // Live lines appear as steps complete, so a hung run shows where it hung. The summary block is
  // what has to be deterministic.
  it('flushes each step line as it completes rather than at the end', () => {
    const { reporter, lines } = capture({ tty: false, env: {} });
    reporter.flowStarted('flows/checkout.flow.yml');
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });

    expect(lines.some((line) => line.includes('create_payment'))).toBe(true);
  });

  it('heads a dataset iteration with its row', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'iteration:start', index: 1, row: { email: 'editor@example.com' } });

    expect(text()).toContain('iteration 2');
    expect(text()).toContain('editor@example.com');
  });
});
