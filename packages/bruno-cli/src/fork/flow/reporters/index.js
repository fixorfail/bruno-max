/**
 * Report files — 001 §14.8.
 *
 * A report covers the *selection*, not a flow: CI gates on one file per invocation and a
 * test-management import reads one document, so the accumulator below belongs to the command rather
 * than to the engine, whose unit ends at one flow and its iterations (§13.2).
 *
 * Reporters see `FlowEvent` and `RunResult` and nothing else. The engine masks secrets before it
 * emits either (§14.4), so every report file is redacted by construction and nothing here re-applies
 * the policy — reaching past those two shapes for a request or a capture is what would break it.
 *
 * **A reporter sees every attempt, and `onSuiteEnd` sees one final record per flow.** Under
 * `--retries` a flow that failed runs again, and each attempt dispatches `onFlowStart`, its
 * `onEvent` stream and `onFlowEnd` in full — a report that hid the attempt that failed would hide
 * the flakiness the retry is evidence of. The accumulator below is where the attempts collapse:
 * `onSuiteEnd`'s `flows` carries the last one per flow (§14.8), which is why a reporter that folds
 * `onFlowEnd` records into a list of its own must key that list on the flow's `id` too.
 */
const fs = require('fs');
const path = require('path');
const { flowIdentity } = require('@bruno-max/flow');

/** Resolved relative to this file, so a built-in name never depends on where `bru` was typed. */
const BUILT_INS = { 'junit': './junit', 'junit-flows': './junit-flows', 'json': './json', 'html': './html' };

/** `--reporter-junit <path>` is `--reporter junit=<path>`, spelled the way `bru run` spells it. */
const SUGAR = [
  ['junit', 'reporterJunit'],
  ['junit-flows', 'reporterJunitFlows'],
  ['json', 'reporterJson'],
  ['html', 'reporterHtml']
];

/**
 * What a built-in is called when the command names no path. They share one directory, so each says
 * which format it is rather than relying on the extension to carry it.
 */
const DEFAULT_FILES = {
  'junit': 'report-junit.xml',
  'junit-flows': 'report-junit-flows.xml',
  'json': 'report.json',
  'html': 'report.html'
};

const HOOKS = ['onSuiteStart', 'onFlowStart', 'onEvent', 'onFlowEnd', 'onSuiteEnd'];

const EMPTY_STEPS = { total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 };

/**
 * What a report calls a flow — §5.2's identity and its `meta:`, from the engine's one spelling of
 * both (the roster written beside the report derives them the same way, so the two agree by
 * construction rather than by two rules happening to match).
 *
 * The file's text is read here rather than a description asked for, because a report is written for
 * flows that never parsed too — an unreadable file has no properties, which is the same answer as
 * one that declares none, and it still needs a row.
 */
const identify = (file, scope) => {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    // Unreadable at this instant; `validateFlow` reports why, and the record still names the file.
  }

  return flowIdentity(scope.collectionRoot || scope.workspaceRoot, file, source);
};

const summarize = (records) => {
  // `flaky` is counted beside `passed` rather than instead of it: a flaky flow passed, and the four
  // outcome counts have to keep adding up to `total` for a report to be readable as one.
  const flows = { total: records.length, passed: 0, failed: 0, cancelled: 0, invalid: 0, flaky: 0 };
  const steps = { ...EMPTY_STEPS };

  for (const record of records) {
    flows[record.outcome] += 1;
    if (record.flaky) flows.flaky += 1;
    // A flow that never ran contributes no steps rather than zeroes: the flow counts already say it.
    if (!record.result) continue;
    for (const key of Object.keys(steps)) steps[key] += record.result.summary[key] || 0;
  }

  return { flows, steps };
};

/**
 * The suite as it accumulates, and the one clock the report is timed by — injected so a golden
 * assertion is possible without one.
 */
const createSuite = ({ now = () => new Date() } = {}) => {
  const records = [];
  let startedAt;

  return {
    start: (flows) => {
      startedAt = now().toISOString();
      return { startedAt, flows };
    },
    flowStarted: (identity) => ({ ...identity, startedAt: now().toISOString() }),
    /**
     * One record per flow, keyed on §5.2's identity: a `--retries` attempt **replaces** the flow's
     * record rather than adding a second one, because §14.8's rule is that the final attempt is the
     * flow's outcome. Replacing in place also keeps the roster in path order (§14.1) — a retry is a
     * re-run of a flow the suite already listed, not a new entry at the end of it.
     */
    flowFinished: (record) => {
      const at = records.findIndex((existing) => existing.id === record.id);
      if (at === -1) {
        records.push(record);
        return;
      }

      const previous = records[at];
      records[at] = {
        ...record,
        attempt: (previous.attempt || 1) + 1,
        // Only ever set when true, and only against the attempt just before: a flow is retried only
        // while it has not passed, so the previous outcome is the whole of the history that matters.
        ...(previous.outcome !== 'passed' && record.outcome === 'passed' ? { flaky: true } : {})
      };
    },
    end: ({ exitCode, retryOf }) => {
      const finishedAt = now().toISOString();
      return {
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        flows: records,
        summary: summarize(records),
        // The only thing tying a retry to what it re-ran: it opened a suite directory and a report
        // of its own, being a new invocation rather than an edit of the old one.
        ...(retryOf ? { retryOf } : {}),
        exitCode
      };
    }
  };
};

const resolveModule = (module, cwd) => {
  if (BUILT_INS[module]) return BUILT_INS[module];

  // A path is resolved against where the command was typed; anything else is a package name, looked
  // up from there rather than from the CLI's own tree — a reporter is the user's dependency.
  const asPath = module.startsWith('.') || path.isAbsolute(module) ? path.resolve(cwd, module) : undefined;
  try {
    return asPath ? require.resolve(asPath) : require.resolve(module, { paths: [cwd] });
  } catch {
    throw new Error(`cannot resolve reporter ${module}`);
  }
};

/**
 * `--reporter <module>[=<path>]` and its per-format sugar, in the order they were written.
 *
 * A built-in needs no path: `--reporter-junit` on its own writes `report-junit.xml` into the
 * invocation's suite directory, beside the runs it describes, which is the whole of what most
 * invocations want and spares CI a path it would only have to keep in step with `--capture-dir`.
 * A custom reporter has no filename of its own to default to, so it must say where its output goes.
 *
 * Every error here is a usage error the caller turns into exit 3, and all of them are raised before
 * a flow runs: finding out that a report cannot be written after a suite has spent ten minutes
 * sending requests is the version of this nobody wants (the same reason `bru run` checks the output
 * directory up front).
 */
const parseReporterSpecs = (argv, { cwd, suiteDir }) => {
  const entries = [
    ...[].concat(argv.reporter || []).map(String),
    // A bare `--reporter-junit` reaches yargs as an empty string, which is the request to default.
    ...SUGAR.flatMap(([name, flag]) => (argv[flag] === undefined ? [] : [`${name}=${argv[flag]}`]))
  ];

  return entries.map((entry) => {
    // The *first* `=` splits: an output path may contain one, a module name may not.
    const at = entry.indexOf('=');
    const module = at === -1 ? entry : entry.slice(0, at);
    const target = at === -1 ? '' : entry.slice(at + 1).trim();
    const builtIn = Boolean(BUILT_INS[module]);

    if (!target && !builtIn) {
      throw new Error(`custom reporter ${module} needs an output path: --reporter ${module}=<path>`);
    }

    const outputPath = target ? path.resolve(cwd, target) : path.join(suiteDir, DEFAULT_FILES[module]);
    // The suite directory is created before the run, so only a path the command typed is checked here.
    if (target && !fs.existsSync(path.dirname(outputPath))) {
      throw new Error(`output directory ${path.dirname(outputPath)} does not exist`);
    }

    return { name: module, module: resolveModule(module, cwd), outputPath, defaulted: !target };
  });
};

const loadReporters = (specs, { cwd, options }) =>
  specs.map((spec) => {
    const exported = require(spec.module);
    // `module.exports = factory` is what the built-ins write; `.default` is what a bundler emits.
    const factory = typeof exported === 'function' ? exported : exported && exported.default;
    if (typeof factory !== 'function') {
      throw new Error(`reporter ${spec.name} does not export a function`);
    }

    return {
      name: spec.name,
      outputPath: spec.outputPath,
      reporter: factory({ outputPath: spec.outputPath, cwd, options }) || {}
    };
  });

/**
 * One object carrying every hook, fanned out to each reporter in declaration order.
 *
 * A reporter that throws is named on stderr and the run carries on: a report is an observation of a
 * suite, and letting a broken one change the exit code would make CI red for a reason that has
 * nothing to do with the API under test.
 */
const createDispatcher = (reporters, { stderr = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  /**
   * Hooks are queued rather than merely awaited, because `onEvent` cannot be: the engine calls its
   * consumer synchronously and ignores what it returns (§13.2), so an asynchronous reporter would
   * otherwise still be writing a step when `onFlowEnd` arrived. The chain is what makes "in the
   * order they happened" true of the report as well as of the run.
   */
  let queue = Promise.resolve();

  const dispatch = (hook, ...args) => {
    queue = queue.then(async () => {
      for (const { name, reporter } of reporters) {
        if (typeof reporter[hook] !== 'function') continue;
        try {
          await reporter[hook](...args);
        } catch (error) {
          stderr(`reporter ${name}: ${error.message}`);
        }
      }
    });
    return queue;
  };

  return Object.fromEntries(HOOKS.map((hook) => [hook, (...args) => dispatch(hook, ...args)]));
};

module.exports = { createSuite, identify, parseReporterSpecs, loadReporters, createDispatcher };
