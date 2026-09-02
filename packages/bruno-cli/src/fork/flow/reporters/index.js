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
 */
const fs = require('fs');
const path = require('path');
const { readFlowProperties } = require('@bruno-max/flow');

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

/** §5.2: a flow's identity is its path relative to the scope root with `.flow.yml` removed. */
const identityOf = (file, scope) => {
  const root = scope.collectionRoot || scope.workspaceRoot;
  return path.relative(root, file).replace(/\.flow\.yml$/, '').split(path.sep).join('/');
};

/**
 * What a report calls a flow.
 *
 * `meta:` is read from the file's text rather than from a description, because a report is written
 * for flows that never parsed too — an unreadable file has no properties, which is the same answer
 * as one that declares none, and it still needs a row.
 */
const identify = (file, scope) => {
  let properties;
  try {
    properties = readFlowProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unreadable at this instant; `validateFlow` reports why, and the record still names the file.
  }

  return {
    file,
    id: identityOf(file, scope),
    name: (properties && properties.name) || path.basename(file).replace(/\.flow\.yml$/, ''),
    tags: (properties && properties.tags) || [],
    // Absent rather than empty when the flow declares none: a report writes the property only for a
    // flow a tracker actually has a case for.
    ...(properties && properties.testId ? { testId: properties.testId } : {})
  };
};

const summarize = (records) => {
  const flows = { total: records.length, passed: 0, failed: 0, cancelled: 0, invalid: 0 };
  const steps = { ...EMPTY_STEPS };

  for (const record of records) {
    flows[record.outcome] += 1;
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
    flowFinished: (record) => {
      records.push(record);
    },
    end: ({ exitCode }) => {
      const finishedAt = now().toISOString();
      return {
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        flows: records,
        summary: summarize(records),
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
