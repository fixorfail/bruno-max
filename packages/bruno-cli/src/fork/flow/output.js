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
    line(`  ${painted} ${step.id.padEnd(24)} ${detail}${attempts}${why}`);
  };

  const failureBlock = (step) => {
    line();
    line(`  ${paint(31, step.id)} · ${step.reason}`);
    for (const assertion of step.assertions.filter((entry) => !entry.passed)) {
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

      if (level < LEVELS.quiet) return;
      const { summary } = result;
      line();
      line(
        `  ${summary.failed} failed · ${summary.passed} passed · ${summary.skipped} skipped`
        + (summary.cancelled ? ` · ${summary.cancelled} cancelled` : '')
      );
    },

    diagnostics: (file, entries) => {
      if (!entries.length) return;
      line();
      line(`${paint(1, file)}`);
      for (const entry of entries) {
        const label = entry.severity === 'error' ? paint(31, 'error') : paint(33, 'warning');
        line(`  ${label}  ${entry.code}  ${entry.message}`);
      }
    }
  };
};

module.exports = { createReporter, wantsColour, UNICODE_MARKS, ASCII_MARKS };
