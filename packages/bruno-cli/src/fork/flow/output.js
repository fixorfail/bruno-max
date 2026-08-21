/**
 * Console output — 001 §14.7.
 *
 * Stdout is for humans; reporters are for machines. Nothing here is a stable format — only the exit
 * code (§14.2) and the reporter files are — so what this module owes is a handful of properties
 * rather than a wording: no ANSI where a log file will keep it, a failure block that names the step
 * and why, and a summary in declaration order however the live lines interleaved.
 *
 * Colour and the writer are injected rather than reached for, so the properties are assertable
 * without a terminal.
 */
const UNICODE_MARKS = { success: '✓', failed: '✗', skipped: '○', cancelled: '⊘' };

// A Windows console printing mojibake is worse than a plain character (§14.7).
const ASCII_MARKS = { success: '+', failed: 'x', skipped: '-', cancelled: '!' };

const LEVELS = { silent: 0, quiet: 1, normal: 2, verbose: 3 };

const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/**
 * `NO_COLOR` is honoured as a convention rather than as one more flag, and a non-TTY never gets
 * escapes at all: a colour code in an archived CI log is corruption.
 */
const wantsColour = ({ tty, noColor, env = process.env }) => Boolean(tty) && !noColor && !env.NO_COLOR;

const createReporter = ({
  write = (line) => process.stdout.write(`${line}\n`),
  tty = Boolean(process.stdout.isTTY),
  noColor = false,
  unicode = true,
  verbosity = 'normal',
  env = process.env
} = {}) => {
  const colour = wantsColour({ tty, noColor, env });
  const marks = unicode ? UNICODE_MARKS : ASCII_MARKS;
  const level = LEVELS[verbosity] === undefined ? LEVELS.normal : LEVELS[verbosity];

  const paint = (code, text) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
  const line = (text = '') => {
    if (level > LEVELS.silent) write(text);
  };

  const stepLine = (step) => {
    if (level < LEVELS.normal) return;
    // A sub-flow is one step to its caller (§12); --verbose expands it to its internal steps.
    if (level < LEVELS.verbose && step.id.includes('/')) return;

    const mark = marks[step.status];
    const painted
      = step.status === 'failed' ? paint(31, mark) : step.status === 'success' ? paint(32, mark) : paint(90, mark);
    // A step that did not run has no duration worth printing, and one that ran and failed has no
    // use for the word "skipped" in front of its reason.
    const detail = step.status === 'skipped' ? `skipped · ${step.reason}` : duration(step.durationMs);
    const attempts = step.attempts > 1 ? `  ${step.attempts} attempts` : '';
    const why = step.status === 'failed' ? `  ${step.reason}` : '';
    // A skip gets its message on its own line, because a skip has no failure block to carry it and
    // `unresolved-dependency` on its own names nothing to go and fix (§14.6). A failure's message is
    // in the block below, where the assertions and schema errors that go with it already are.
    const note = step.status === 'skipped' && step.message ? `  ${paint(90, step.message)}` : '';
    line(`  ${painted} ${step.id.padEnd(24)} ${detail}${attempts}${why}${note}`);
  };

  const failureBlock = (step) => {
    line();
    line(`  ${paint(31, step.id)} · ${step.reason}`);
    const failedAssertions = step.assertions.filter((entry) => !entry.passed);
    // §14.6's message, except where the lines below already are it: an `assertion-failed` message is
    // the same comparison the block expands underneath, and a block that says everything twice
    // stops being read.
    if (step.message && !failedAssertions.length) line(`    ${step.message}`);
    for (const assertion of failedAssertions) {
      line(`    ${assertion.expr}`);
      line(`      expected  ${JSON.stringify(assertion.expected)}`);
      line(`      actual    ${JSON.stringify(assertion.actual)}`);
    }
    for (const error of step.validation?.request?.errors || []) {
      line(`    request ${error.path} ${error.message}`);
    }
    if (step.capturePath) line(`    capture  ${step.capturePath}`);
  };

  return {
    /** Driven by the §13.2 event stream, so a hung run shows where it hung. */
    onEvent: (event) => {
      if (event.type === 'iteration:start' && event.row) {
        line(`  iteration ${event.index + 1} · ${Object.values(event.row).join(' · ')}`);
      }
      if (event.type === 'step:end') stepLine(event.result);
    },

    flowStarted: (file) => {
      line();
      line(paint(1, file));
      line();
    },

    flowFinished: (result) => {
      // The summary lists steps in declaration order however the live lines interleaved, so
      // anything diffed or archived has a deterministic form.
      const failures = result.iterations.flatMap((iteration) =>
        iteration.steps.filter((step) => step.status === 'failed')
      );
      for (const step of failures) failureBlock(step);

      /**
       * §11.2's `failOnUnresolved` fails a run through a step that is *skipped*, so a red run can
       * have no failure block at all and a summary line reading `0 failed`. §13.2's `decidedBy` names
       * the steps the verdict fell on; the ones with a block above already said it.
       *
       * The reason and message are repeated from the step's own line because `--quiet` prints no
       * step lines, and a CI log that names a step without saying what it did is a lookup nobody can
       * perform after the fact.
       */
      const steps = result.iterations.flatMap((iteration) => iteration.steps);
      const decided = (result.decidedBy || [])
        .filter((id) => !failures.some((step) => step.id === id))
        .map((id) => steps.find((step) => step.id === id))
        .filter(Boolean);

      for (const step of decided) {
        line();
        line(`  ${paint(31, `run ${result.status}`)} · ${step.id} ${step.status} · ${step.reason}`);
        if (step.message) line(`    ${step.message}`);
      }

      if (level < LEVELS.quiet) return;
      const { summary } = result;
      line();
      line(
        `  ${summary.failed} failed · ${summary.passed} passed · ${summary.skipped} skipped`
        + (summary.cancelled ? ` · ${summary.cancelled} cancelled` : '')
      );
    },

    /**
     * 001 §8.6's library, listed under `bru flow validate`.
     *
     * §8.5 names the cost a shared declaration pays — what a step can do is no longer visible by
     * reading the step — and answers it by printing what resolved and where it came from. A library
     * is the same trade over arbitrary code, so it is answered the same way: the functions a script
     * may call, and the file each one came from.
     *
     * Nothing is printed for a flow that declares none, which is most of them.
     */
    functions: (file, entries) => {
      if (!entries.length || level < LEVELS.normal) return;
      line();
      line(`${paint(1, file)}`);
      for (const entry of entries) {
        // A raw source file declares whatever it declares, and nothing here parses JavaScript to
        // find out — so it is listed as the file it is rather than as names it might not have.
        const name = entry.name || paint(90, '(source)');
        line(`  ${name.padEnd(24)} ${paint(90, entry.from)}`);
      }
    },

    diagnostics: (file, entries) => {
      if (!entries.length) return;
      line();
      line(`${paint(1, file)}`);
      for (const entry of entries) {
        const label = entry.severity === 'error' ? paint(31, 'error') : paint(33, 'warning');
        // The line the rule fired on, when the engine could anchor it (§13.2). A diagnostic over a
        // hundred-step flow is close to unusable without one, and the file heading is already above.
        const where = entry.line === undefined ? '' : `${paint(90, `${entry.line}:${entry.column}`)}  `;
        line(`  ${label}  ${where}${entry.code}  ${entry.message}`);
      }
    }
  };
};

module.exports = { createReporter, wantsColour, UNICODE_MARKS, ASCII_MARKS };
