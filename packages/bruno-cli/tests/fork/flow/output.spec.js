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

  /**
   * §14.6's message. `assertion-failed` names the rule that fired; the message is the only thing in
   * a CI log that says which call, which field, which value — and a block that omitted it would send
   * the reader to a capture directory the machine may not have kept.
   */
  it('carries the message that goes with the reason', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter, {
      ...failedRun,
      iterations: [
        {
          index: 0,
          status: 'failed',
          steps: [step({ status: 'failed', reason: 'unexpected-status', message: 'expected a successful status, got 503' })]
        }
      ]
    });

    expect(text()).toContain('expected a successful status, got 503');
  });

  /** A skip has no failure block, so its message rides its own line or is lost. */
  it('explains a skip on its step line', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    runThrough(reporter, {
      ...failedRun,
      iterations: [
        {
          index: 0,
          status: 'failed',
          steps: [
            step({
              status: 'skipped',
              reason: 'unresolved-dependency',
              message: 'never produced: steps.create_payment.token'
            })
          ]
        }
      ]
    });

    expect(text()).toContain('never produced: steps.create_payment.token');
  });

  // Only failures get a block; a passing step is one line, and a 200 KB response in a terminal
  // buries the one line that mattered.
  it('inlines no response body', () => {
    const { reporter, lines } = capture({ tty: false, env: {} });
    runThrough(reporter);

    expect(lines.filter((line) => line.includes('create_payment'))).toHaveLength(1);
  });
});

/**
 * §11.2's `failOnUnresolved` is the one rule that fails a run through a step that is not itself
 * failed — so the run is red, every count reads green, and no failure block is printed at all.
 */
describe('the verdict', () => {
  const skipDecided = {
    ...failedRun,
    decidedBy: ['archive_receipt'],
    summary: { total: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0 },
    iterations: [
      {
        index: 0,
        status: 'failed',
        steps: [
          step(),
          step({
            id: 'archive_receipt',
            status: 'skipped',
            reason: 'unresolved-dependency',
            message: 'never produced: steps.create_payment.token'
          })
        ]
      }
    ]
  };

  /**
   * `--quiet` prints no step lines and this run has no failure block, so anything naming the step
   * here came from the verdict — which is the property, stated without depending on wording.
   */
  it('names the step a red run with no failed step fell on, and what it did', () => {
    const { reporter, text } = capture({ tty: false, env: {}, verbosity: 'quiet' });
    runThrough(reporter, skipDecided);

    expect(text()).toContain('archive_receipt');
    expect(text()).toContain('unresolved-dependency');
    expect(text()).toContain('never produced: steps.create_payment.token');
  });

  /** A failed step already has a block; naming it twice is how a block stops being read. */
  it('does not repeat a step its failure block already named', () => {
    const { reporter, lines } = capture({ tty: false, env: {}, verbosity: 'quiet' });
    runThrough(reporter, { ...failedRun, decidedBy: ['verify_ledger'] });

    const named = lines.filter((entry) => entry.includes('verify_ledger') && entry.includes('assertion-failed'));
    expect(named).toHaveLength(1);
  });

  it('says nothing about the steps of a run that passed', () => {
    const { reporter, lines } = capture({ tty: false, env: {}, verbosity: 'quiet' });
    runThrough(reporter, {
      ...failedRun,
      status: 'passed',
      decidedBy: [],
      iterations: [{ index: 0, status: 'passed', steps: [step()] }]
    });

    expect(lines.filter((entry) => entry.includes('create_payment'))).toHaveLength(0);
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

describe('diagnostics', () => {
  const entry = (over = {}) => ({
    severity: 'error',
    code: 'unknown-operation',
    message: 'noSuchOp is not an operation in regressions-v1.yml',
    file: 'flows/checkout.flow.yml',
    stepId: 'create',
    ...over
  });

  it('names the line a diagnostic was anchored to', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.diagnostics('flows/checkout.flow.yml', [entry({ line: 12, column: 5 })]);

    expect(text()).toContain('12:5');
    expect(text()).toContain('unknown-operation');
  });

  // Not every check can anchor — one about the document as a whole has no node to point at — and a
  // reporter that printed `undefined:undefined` would be worse than one that prints nothing.
  it('says nothing about a position when the engine had none', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.diagnostics('flows/checkout.flow.yml', [entry({ line: undefined, column: undefined })]);

    expect(text()).not.toContain('undefined');
    expect(text()).toContain('unknown-operation');
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

/**
 * 001 §8.6's library, listed under `bru flow validate`. §8.5's locality argument applies to it with
 * more force — an output resolved from a file you did not know about is a value, a *function* is
 * arbitrary code — so what resolved and where it came from is printed rather than left to be found
 * by opening every file the flow names.
 */
describe('the resolved script library', () => {
  const library = [
    { name: 'lastFour', from: 'flows/shared/functions.yml' },
    { name: 'maskCard', from: 'flows/checkout.flow.yml' },
    { from: 'flows/lib/text.js' }
  ];

  it('names each function and the file it was declared in', () => {
    const { reporter, text } = capture({});

    reporter.functions('flows/checkout.flow.yml', library);

    expect(text()).toContain('lastFour');
    expect(text()).toContain('flows/shared/functions.yml');
    expect(text()).toContain('maskCard');
  });

  /** Nothing here parses JavaScript, so a raw source file is listed as the file it is. */
  it('lists a raw source file rather than names it does not know', () => {
    const { reporter, text } = capture({});

    reporter.functions('flows/checkout.flow.yml', library);

    expect(text()).toContain('flows/lib/text.js');
    expect(text()).toContain('(source)');
  });

  it('prints nothing for a flow that declares none', () => {
    const { reporter, lines } = capture({});

    reporter.functions('flows/checkout.flow.yml', []);

    expect(lines).toEqual([]);
  });

  /** --quiet is failures and the summary; a listing is neither. */
  it('says nothing under --quiet', () => {
    const { reporter, lines } = capture({ verbosity: 'quiet' });

    reporter.functions('flows/checkout.flow.yml', library);

    expect(lines).toEqual([]);
  });
});
