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

  // §14.7's TTY/CI table: FORCE_COLOR is a TTY-column convention, not a way to put escapes into a
  // log that was never going to a terminal.
  it('honours FORCE_COLOR over NO_COLOR on a TTY', () => {
    expect(wantsColour({ tty: true, noColor: false, env: { FORCE_COLOR: '1', NO_COLOR: '1' } })).toBe(true);

    const { reporter, text } = capture({ tty: true, env: { FORCE_COLOR: '1', NO_COLOR: '1' } });
    runThrough(reporter);
    expect(text()).toMatch(ANSI);
  });

  it('treats FORCE_COLOR=0 as an explicit opt-out on a TTY', () => {
    expect(wantsColour({ tty: true, noColor: false, env: { FORCE_COLOR: '0' } })).toBe(false);
  });

  // An archived CI log must never contain escape sequences (R4l) — FORCE_COLOR does not get to
  // override that, however it is conventionally used elsewhere.
  it('never colours off a TTY, even under FORCE_COLOR', () => {
    expect(wantsColour({ tty: false, noColor: false, env: { FORCE_COLOR: '1' } })).toBe(false);

    const { reporter, text } = capture({ tty: false, env: { FORCE_COLOR: '1' } });
    runThrough(reporter);
    expect(text()).not.toMatch(ANSI);
  });

  it('lets --no-color win over FORCE_COLOR — the flag is the stronger, more immediate signal', () => {
    expect(wantsColour({ tty: true, noColor: true, env: { FORCE_COLOR: '1' } })).toBe(false);
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

describe('the operation column', () => {
  // §14.7's sample identifies a step by its operation, not the id alone: `POST /payments`, read
  // from `step:start`, is what the flow file names rather than a resolved URL.
  it('shows the operation named at step:start', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'create_payment', index: 0, operation: 'POST /payments' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });

    expect(text()).toContain('POST /payments');
  });

  // A step:end the reporter never saw start — nothing in a run emits one, but the column falls back
  // to the id rather than going blank.
  it('falls back to the id when no step:start was seen', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });

    expect(text()).toContain('create_payment');
  });

  /**
   * §14.7's sample column for a `uses:` step. A step names `operation:` or `uses:` and never
   * neither (§5.3), so a `step:start` with no operation is a sub-flow — and the id is already in
   * the column beside it, which is why printing it twice says nothing.
   */
  it('names a sub-flow and its internal step count, rather than repeating the id', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'auth', index: 0, steps: 2 });
    reporter.onEvent({ type: 'step:end', id: 'auth', index: 0, result: step({ id: 'auth' }) });

    expect(text()).toContain('sub-flow (2 steps)');
    expect(text()).not.toMatch(/auth\s+auth/);
  });

  it('counts a one-step sub-flow in the singular', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'auth', index: 0, steps: 1 });
    reporter.onEvent({ type: 'step:end', id: 'auth', index: 0, result: step({ id: 'auth' }) });

    expect(text()).toContain('sub-flow (1 step)');
  });

  // An engine older than `step:start.steps` still says which steps are sub-flows by naming no
  // operation, and the kind is worth printing without the count.
  it('names a sub-flow without a count when step:start carried none', () => {
    const { reporter, text } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'auth', index: 0 });
    reporter.onEvent({ type: 'step:end', id: 'auth', index: 0, result: step({ id: 'auth' }) });

    expect(text()).toContain('sub-flow');
    expect(text()).not.toContain('steps)');
  });

  // The in-flight row is rewritten in place by the step:end above it, so the two must carry the
  // same column or the rewrite reads as the label changing mid-step.
  it('names the sub-flow on the in-flight row too', () => {
    const { reporter, text } = capture({ tty: true, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'auth', index: 0, steps: 2 });

    expect(text()).toContain('sub-flow (2 steps)');
  });
});

describe('verbose previews and passing assertions', () => {
  const preview = { request: 'POST /payments HTTP/1.1\nAuthorization: ••••', response: '{"status":"created"}' };
  const passing = step({ assertions: [{ expr: 'res.status eq 201', passed: true, expected: 201, actual: 201 }] });

  it('adds nothing beyond the step line by default', () => {
    const { reporter, lines } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: passing, preview });

    expect(lines.some((line) => line.includes('res.status eq 201'))).toBe(false);
    expect(lines.some((line) => line.includes('"status":"created"'))).toBe(false);
  });

  it('inlines the request and response preview under --verbose', () => {
    const { reporter, text } = capture({ tty: false, env: {}, verbosity: 'verbose' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: passing, preview });

    expect(text()).toContain('POST /payments HTTP/1.1');
    expect(text()).toContain('Authorization: ••••');
    expect(text()).toContain('"status":"created"');
  });

  it('prints passing assertions under --verbose', () => {
    const { reporter, text } = capture({ tty: false, env: {}, verbosity: 'verbose' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: passing, preview });

    expect(text()).toContain('res.status eq 201');
  });

  // The preview arrives already cut to `capturePreviewBytes` and already masked (§9.4) — the
  // reporter must never re-truncate to something larger or otherwise reshape it.
  it('prints exactly the preview text it was given, never more', () => {
    const alreadyTruncated = { request: 'POST /payments HTTP/1.1\n{"amount":100' };
    const { reporter, text } = capture({ tty: false, env: {}, verbosity: 'verbose' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: passing, preview: alreadyTruncated });

    expect(text()).toContain('{"amount":100');
    expect(text()).not.toContain('{"amount":100}');
  });

  it('says nothing about a preview when the event carried none', () => {
    const { reporter, lines } = capture({ tty: false, env: {}, verbosity: 'verbose' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: passing });

    expect(lines.some((line) => line.includes('→') || line.includes('←'))).toBe(false);
  });
});

describe('TTY in-place updates', () => {
  const CURSOR_UP = new RegExp(`${String.fromCharCode(27)}\\[\\d+A`);
  const ANY_ESCAPE = new RegExp(String.fromCharCode(27));

  // §14.7's TTY column: an in-flight step is shown before it completes.
  it('shows an in-flight line when a step starts on a TTY', () => {
    const { reporter, lines } = capture({ tty: true, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'create_payment', index: 0, operation: 'POST /payments' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('create_payment');
  });

  // Updated in place rather than appended a second time — the row a viewer is already reading
  // does not scroll away underneath them, and cursor control is how that row is found again.
  it('rewrites the in-flight line in place with cursor control, rather than appending a second one', () => {
    const { reporter, lines } = capture({ tty: true, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'create_payment', index: 0, operation: 'POST /payments' });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });

    expect(lines.filter((line) => line.includes('create_payment'))).toHaveLength(2);
    expect(lines[1]).toMatch(CURSOR_UP);
  });

  // §14.7's CI column: no in-flight line, and no cursor control ever — an archived log is
  // append-only.
  it('shows no in-flight line and uses no cursor control off a TTY', () => {
    const { reporter, lines } = capture({ tty: false, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'create_payment', index: 0, operation: 'POST /payments' });
    expect(lines).toEqual([]);

    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });
    expect(lines.some((line) => ANY_ESCAPE.test(line))).toBe(false);
  });

  // Under `concurrency > 1` steps finish out of the order they started (§14.7) — each rewrite
  // must still land on its own row rather than clobbering whichever row is now on top.
  it('rewrites each of several concurrent in-flight steps at its own row', () => {
    const { reporter, lines } = capture({ tty: true, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'create_payment', index: 0, operation: 'POST /payments' });
    reporter.onEvent({ type: 'step:start', id: 'create_refund', index: 0, operation: 'POST /refunds' });
    reporter.onEvent({ type: 'step:end', id: 'create_refund', index: 0, result: step({ id: 'create_refund' }) });
    reporter.onEvent({ type: 'step:end', id: 'create_payment', index: 0, result: step() });

    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('create_refund');
    expect(lines[3]).toContain('create_payment');
  });

  // A collapsed sub-flow internal never gets a placeholder either — the same rule step:end
  // already applies would otherwise flash it on screen before hiding it again.
  it('shows no in-flight line for a collapsed sub-flow internal', () => {
    const { reporter, lines } = capture({ tty: true, env: {} });
    reporter.onEvent({ type: 'step:start', id: 'auth/login', index: 0, operation: 'POST /auth/login' });

    expect(lines).toEqual([]);
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

/**
 * 001 §8.5's resolved outputs, listed under `bru flow validate` beside the library above.
 *
 * The cost §8.5 names is locality: a connector file declares an operation's outputs for every flow
 * that targets it, so a step publishes names it does not mention. What is contractual here is that
 * every resolved name appears with the layer that had the last say and the file that layer is —
 * never the wording it is printed in, for the reason at the top of this file.
 */
describe('the resolved outputs of each step', () => {
  const steps = [
    {
      id: 'get_thing',
      outputs: [
        { name: 'thingId', from: 'body', path: 'data.id', origin: 'workspace', file: 'flows/connectors.yml' },
        { name: 'title', from: 'body', path: 'data.name', origin: 'collection', file: 'payments/flows/connectors.yml' },
        { name: 'own', from: 'body', path: 'data.slug', origin: 'inline', file: 'flows/checkout.flow.yml' }
      ]
    },
    { id: 'hand_off', outputs: [] }
  ];

  it('names each output, the layer it was declared in and the file that layer is', () => {
    const { reporter, text } = capture({});

    reporter.outputs('flows/checkout.flow.yml', steps);

    expect(text()).toContain('get_thing');
    expect(text()).toContain('thingId');
    expect(text()).toContain('workspace');
    expect(text()).toContain('flows/connectors.yml');
    expect(text()).toContain('title');
    expect(text()).toContain('collection');
    expect(text()).toContain('payments/flows/connectors.yml');
    expect(text()).toContain('own');
    expect(text()).toContain('inline');
  });

  /** A `uses:` step publishes its sub-flow's exports and declares none of its own (§12). */
  it('leaves out a step that resolved nothing rather than printing it empty', () => {
    const { reporter, text } = capture({});

    reporter.outputs('flows/checkout.flow.yml', steps);

    expect(text()).not.toContain('hand_off');
  });

  it('prints nothing for a flow whose steps resolve none', () => {
    const { reporter, lines } = capture({});

    reporter.outputs('flows/checkout.flow.yml', [{ id: 'hand_off', outputs: [] }]);

    expect(lines).toEqual([]);
  });

  // A colour code in an archived CI log is corruption (§14.7's CI column).
  it('emits no escape sequences when stdout is not a TTY', () => {
    const { reporter, text } = capture({ tty: false, env: { FORCE_COLOR: '1' } });

    reporter.outputs('flows/checkout.flow.yml', steps);

    expect(text()).not.toMatch(ANSI);
  });

  /** --quiet is failures and the summary; a listing is neither. */
  it('says nothing under --quiet', () => {
    const { reporter, lines } = capture({ verbosity: 'quiet' });

    reporter.outputs('flows/checkout.flow.yml', steps);

    expect(lines).toEqual([]);
  });

  /** §14.7's `--silent`: the exit code is the whole result. */
  it('writes nothing under --silent', () => {
    const { reporter, lines } = capture({ verbosity: 'silent' });

    reporter.outputs('flows/checkout.flow.yml', steps);

    expect(lines).toEqual([]);
  });
});

/**
 * 001 §14.7's `bru flow list`.
 *
 * The columns are asserted as properties — a name, a kind, a step count, tags and the whole path —
 * rather than as a table drawn character for character, for the reason at the top of this file. The
 * one rule worth pinning exactly is §5.2's display name, because it is the only thing here a reader
 * could get wrong by looking at one row at a time: what a flow is called depends on the others being
 * listed beside it.
 */
describe('the flow listing', () => {
  const row = (id, over = {}) => ({ id, file: `${id}.flow.yml`, library: false, steps: 1, tags: [], ...over });

  /** The first cell of each row between the header and the blank line above the count. */
  const names = (lines) => lines.slice(1, lines.indexOf('')).map((line) => line.trim().split(/\s+/)[0]);

  it('shows a flow by the final segment of its id, and its whole path in the file column', () => {
    const { reporter, lines, text } = capture({});

    reporter.listing([row('flows/checkout', { steps: 6, tags: ['checkout', 'smoke'] })]);

    expect(names(lines)).toEqual(['checkout']);
    expect(text()).toContain('flows/checkout.flow.yml');
    expect(text()).toContain('6');
    expect(text()).toContain('checkout, smoke');
  });

  /** §5.2: as much of the path as tells them apart, and only for the ids that collide. */
  it('widens the ids that share a stem, and leaves the others at their final segment', () => {
    const { reporter, lines } = capture({});

    reporter.listing([row('flows/shared/login'), row('ops/login'), row('flows/checkout')]);

    expect(names(lines)).toEqual(['shared/login', 'ops/login', 'checkout']);
  });

  it('widens only as far as it must, so two ids that differ at the root show three segments', () => {
    const { reporter, lines } = capture({});

    reporter.listing([row('a/shared/login'), row('b/shared/login')]);

    expect(names(lines)).toEqual(['a/shared/login', 'b/shared/login']);
  });

  /**
   * §12.5's column: a library flow is skipped by a directory run, and a flow silently not running is
   * what marking it exists to prevent.
   */
  it('marks a library flow and counts the libraries among the flows', () => {
    const { reporter, text } = capture({});

    reporter.listing([row('flows/checkout'), row('flows/shared/login', { library: true })]);

    expect(text()).toContain('library');
    expect(text()).toContain('2 flows');
    expect(text()).toContain('1 library');
  });

  it('counts one flow in the singular', () => {
    const { reporter, text } = capture({});

    reporter.listing([row('flows/checkout')]);

    expect(text()).toContain('1 flow');
  });

  it('prints a placeholder rather than an empty column for a flow with no tags', () => {
    const { reporter, text } = capture({});

    reporter.listing([row('flows/checkout')]);

    expect(text()).toContain('—');
  });

  // A Windows console printing mojibake is worse than a plain character (§14.7).
  it('falls back to ASCII for that placeholder under --no-unicode', () => {
    const { reporter, text } = capture({ unicode: false });

    reporter.listing([row('flows/checkout')]);

    expect(text()).not.toContain('—');
  });

  /**
   * Columns are padded before they are painted, so a colour code never counts towards a width — the
   * failure mode is a table that lines up in a terminal and is ragged in every archived log.
   */
  it('lines the columns up identically with colour on and off', () => {
    const rows = [row('flows/checkout', { steps: 6 }), row('flows/shared/login', { library: true })];
    const strip = (line) => line.replace(/\[\d+m/g, '');

    const plain = capture({ tty: true, noColor: true, env: {} });
    const painted = capture({ tty: true, env: {} });
    plain.reporter.listing(rows);
    painted.reporter.listing(rows);

    expect(painted.lines.map(strip)).toEqual(plain.lines);
    expect(plain.text()).not.toMatch(ANSI);
  });

  /** §14.7's `--silent`: the exit code is the whole result. */
  it('writes nothing under --silent', () => {
    const { reporter, lines } = capture({ verbosity: 'silent' });

    reporter.listing([row('flows/checkout')]);

    expect(lines).toEqual([]);
  });
});
