/**
 * `bru flow run` and `bru flow validate` — 001 §14.
 *
 * The command owns a *suite*: which flows were selected, what order they run in, and what the
 * process exits with. The engine's unit is one flow and its iterations (§13.2), so everything
 * below the `runFlow` call is deliberately absent from here.
 */
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  runFlow,
  validateFlow,
  resolveFunctions,
  resolveCaptureRoot,
  resolveSuiteDirectory,
  ensureCaptureIgnored,
  listSuites,
  readSuite,
  writeSuiteManifest,
  CAPTURE_DIRNAME,
  SUITE_DIRECTORY,
  SUITE_MANIFEST_FILE
} = require('@bruno-max/flow');
const { parseEnvironment } = require('@usebruno/filestore');

const { getEnvVars } = require('../../utils/bru');
const { createPorts } = require('./ports');
const { createReporter } = require('./output');
const {
  createSuite,
  identify,
  parseReporterSpecs,
  loadReporters,
  createDispatcher
} = require('./reporters');

/** §14.2, shared by `run` and `validate`. `validate` never returns 1, since it sends nothing. */
const EXIT = { pass: 0, failed: 1, invalid: 2, usage: 3, cancelled: 4 };

/**
 * A `FlowOutcome`'s code. An interrupted run is neither a passing one nor a failing test, and a
 * flow that never ran is an authoring problem rather than a broken API, so CI can tell all three
 * apart.
 */
const exitCodeFor = (outcome) =>
  outcome === 'cancelled'
    ? EXIT.cancelled
    : outcome === 'failed'
      ? EXIT.failed
      : outcome === 'invalid'
        ? EXIT.invalid
        : EXIT.pass;

const isFlowFile = (file) => file.endsWith('.flow.yml');

const walk = (root) =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return walk(target);
      return isFlowFile(entry.name) ? [target] : [];
    });

/** A library flow is excluded from directory and glob runs, and runnable when named (§12.5). */
const isLibrary = (file) => /^\s*library:\s*true\s*$/m.test(fs.readFileSync(file, 'utf8'));

const selectFlows = (paths) => {
  const selected = [];
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    if (!fs.existsSync(resolved)) throw new Error(`no such path: ${entry}`);

    if (fs.statSync(resolved).isDirectory()) selected.push(...walk(resolved).filter((file) => !isLibrary(file)));
    else if (isFlowFile(resolved)) selected.push(resolved);
    else throw new Error(`${entry} is not a .flow.yml`);
  }
  // Path order rather than directory-read order is what makes a run reproducible across machines
  // and filesystems (§14.1).
  return [...new Set(selected)].sort();
};

const findUp = (from, name) => {
  let directory = from;
  for (;;) {
    if (fs.existsSync(path.join(directory, name))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/** A path outside the working directory reads better absolute than as a chain of `..`. */
const forDisplay = (file) => {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
};

/** §7.4's boundary as seen from a directory — the collection or workspace root above it. */
const scopeIn = (directory) => {
  const collectionRoot = findUp(directory, 'bruno.json');
  const workspaceRoot = findUp(directory, 'workspace.yml') || collectionRoot || directory;
  return { workspaceRoot, collectionRoot };
};

const scopeFor = (file) => scopeIn(path.dirname(file));

const scopeRootOf = (scope) => scope.collectionRoot || scope.workspaceRoot;

/**
 * The invocations already recorded in a scope, newest first.
 *
 * `listSuites` derives the capture root from the scope root, which is exactly right until
 * `--capture-dir` moves it. A relocated root is listed here instead and read back through the
 * engine's own `readSuite`, so both spellings answer with the same entries — including the ones
 * rebuilt from run directories, which is what a suite written before `suite.json` existed is.
 */
const pastSuites = async ({ scopeRoot, captureRoot, ports }) => {
  if (captureRoot === path.join(scopeRoot, CAPTURE_DIRNAME)) return listSuites({ scopeRoot, ports });

  const entries = await fs.promises.readdir(captureRoot).catch(() => []);
  const suites = await Promise.all(
    entries
      .filter((entry) => SUITE_DIRECTORY.test(entry))
      .map((entry) => readSuite({ dir: path.join(captureRoot, entry), scopeRoot, ports }).catch(() => undefined))
  );

  return suites.filter(Boolean).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
};

/**
 * `--retry-failed`'s selection: a past invocation's roster, narrowed to the flows that did not pass.
 *
 * "Did not pass" is `failed`, `cancelled` **and** `invalid` — an invalid flow fails validation
 * again immediately and cheaply, while excluding it would let a mis-typed selection silently shrink
 * on every retry until the suite it re-runs is not the suite anybody chose.
 *
 * Everything this can refuse is refused before a flow runs and is §14.2's usage error, for the
 * reason `--global-env` and `--reporter` are checked up front: an invocation that cannot be carried
 * out should say so before it has spent ten minutes sending requests. A suite that passed entirely
 * is not one of them — nothing is wrong, there is simply nothing to re-run — so it comes back as an
 * empty selection for the caller to report and exit 0 on.
 */
const retrySelection = async ({ named, scope, captureRoot, ports }) => {
  const scopeRoot = scopeRootOf(scope);
  const suite = named
    // A path, or the bare `suite-…` name a report and a directory listing both spell — which is
    // what a person naming a suite has in front of them.
    ? await readSuite({
        dir: SUITE_DIRECTORY.test(named) ? path.join(captureRoot, named) : path.resolve(named),
        scopeRoot,
        ports
      })
    : (await pastSuites({ scopeRoot, captureRoot, ports }))[0];

  if (!suite) throw new Error(`no suite to retry in ${forDisplay(captureRoot)}`);

  const retried = suite.flows.filter((entry) => entry.outcome !== 'passed');
  // A flow the roster names that has since been renamed or deleted is skipped rather than fatal:
  // the rest of the retry is still worth running, and re-running a file that is gone is not.
  const onDisk = (entry) => fs.existsSync(entry.file);

  return {
    retryOf: path.basename(suite.dir),
    retried: retried.length,
    missing: retried.filter((entry) => !onDisk(entry)).map((entry) => entry.file),
    // Sorted rather than left in roster order: a roster rebuilt from run directories is in the
    // order the runs started, and a retry has to run in path order wherever it runs (§14.1).
    flows: retried.filter(onDisk).map((entry) => entry.file).sort()
  };
};

/**
 * §14.5's `suite.json` roster, narrowed from the records the report is written from.
 *
 * `SuiteFlowRecord` is a `FlowIdentity` plus how the flow went, and deliberately carries no
 * `RunResult`: the whole result is what `--reporter-json` writes (§14.8.3), and a second copy of it
 * here would be a second thing to keep in step with it.
 */
const rosterOf = (records) =>
  records.map((record) => ({
    file: record.file,
    id: record.id,
    name: record.name,
    tags: record.tags,
    ...(record.testId ? { testId: record.testId } : {}),
    outcome: record.outcome,
    // Absent for a flow that never opened one, which is the reason the roster is written at all.
    ...(record.result && record.result.captureDir ? { runDir: path.basename(record.result.captureDir) } : {}),
    ...(record.attempt ? { attempt: record.attempt } : {}),
    ...(record.flaky ? { flaky: true } : {})
  }));

/**
 * 002 §7.2's workspace environment, which the app selects in the run configuration and `bru` names
 * with `--global-env` — the same flag and the same file `bru run` reads, because they are the same
 * environment and a second spelling of it would be a second thing to keep in step.
 *
 * Resolved per flow rather than once for the selection: `scopeFor` walks up from each file, and a
 * selection can span two workspaces.
 *
 * **Secret values are not in the file.** A `secret: true` variable's value lives in the app's
 * encrypted store (002 §7.2), so it arrives empty here exactly as it does for `bru run --global-env`
 * — the CLI's answer for a secret is `--env-var`, a `.env`, or the process environment.
 */
const workspaceEnvironment = (name, workspaceRoot) => {
  const file = path.join(workspaceRoot, 'environments', `${name}.yml`);
  if (!fs.existsSync(file)) {
    throw new Error(`environment not found: ${forDisplay(file)}`);
  }

  return getEnvVars(parseEnvironment(fs.readFileSync(file, 'utf8'), { format: 'yml' }));
};

const asPairs = (values) =>
  Object.fromEntries(
    [].concat(values || []).map((entry) => {
      const at = String(entry).indexOf('=');
      if (at === -1) throw new Error(`expected key=value, got ${entry}`);
      return [entry.slice(0, at), entry.slice(at + 1)];
    })
  );

const builder = (yargs) =>
  yargs
    .positional('action', { describe: 'run or validate', choices: ['run', 'validate'] })
    .positional('paths', { describe: 'flow files or directories', type: 'string' })
    .option('global-env', {
      describe: 'Workspace environment to run with, by name — <workspace>/environments/<name>.yml',
      type: 'string'
    })
    .option('retry-failed', {
      describe:
        'Re-run the flows of a past suite that did not pass; with no value the newest suite under the scope\'s capture root, with one that suite directory (a path, or a bare suite-… name inside the capture root). Positional paths then only locate the scope',
      type: 'string'
    })
    .option('retries', {
      describe: 'After the selection completes, re-run flows that did not pass, up to n more times',
      type: 'number',
      default: 0
    })
    .option('env-var', { describe: 'Override a single variable (repeatable)', type: 'string' })
    .option('param', { describe: 'Supply a declared params value (repeatable)', type: 'string' })
    .option('concurrency', { describe: 'Override config.concurrency', type: 'number' })
    .option('max-run-duration', {
      describe: 'Bound the whole run in ms; elapsing takes the cancellation path and exits 4',
      type: 'number'
    })
    .option('bail', { describe: 'Stop after the first failing flow', type: 'boolean', default: false })
    .option('capture', {
      describe: 'Write .bruno-runs/ artifacts; --no-capture disables them',
      type: 'boolean',
      default: true
    })
    .option('capture-dir', { describe: 'Write captures here instead of <scope>/.bruno-runs', type: 'string' })
    .option('reporter', {
      describe: `Write a report with <module>[=<path>]; a built-in needs no path and lands in ${CAPTURE_DIRNAME}/suite-…/ (repeatable)`,
      type: 'string'
    })
    .option('reporter-junit', {
      describe: `Write a JUnit XML report; the path is optional and defaults to ${CAPTURE_DIRNAME}/suite-…/report-junit.xml`,
      type: 'string'
    })
    .option('reporter-junit-flows', {
      describe: `Write a JUnit XML report counting flows rather than steps; the path is optional and defaults to ${CAPTURE_DIRNAME}/suite-…/report-junit-flows.xml`,
      type: 'string'
    })
    .option('reporter-json', {
      describe: `Write a JSON suite report; the path is optional and defaults to ${CAPTURE_DIRNAME}/suite-…/report.json`,
      type: 'string'
    })
    .option('reporter-html', {
      describe: `Write a self-contained HTML report; the path is optional and defaults to ${CAPTURE_DIRNAME}/suite-…/report.html`,
      type: 'string'
    })
    .option('reporter-option', { describe: 'Pass key=value to every reporter (repeatable)', type: 'string' })
    .option('verbose', { describe: 'Expand sub-flows', type: 'boolean', default: false })
    .option('quiet', { describe: 'Summary and failures only', type: 'boolean', default: false })
    .option('silent', { describe: 'Write nothing to stdout', type: 'boolean', default: false })
    .option('color', { describe: 'Colourise output', type: 'boolean', default: true })
    .option('unicode', { describe: 'Use box-drawing status markers', type: 'boolean', default: true })
    .example('$0 flow run flows/checkout.flow.yml', 'Run one flow')
    .example('$0 flow run flows/ --reporter-junit', `Run a suite and write a JUnit report into ${CAPTURE_DIRNAME}/suite-…/`)
    .example('$0 flow run flows/ --global-env staging', 'Run every flow against a workspace environment')
    .example('$0 flow run --retry-failed', 'Re-run the flows of the newest suite that did not pass')
    .example('$0 flow run flows/ --retries 2', 'Re-run a flow that did not pass, up to twice more')
    .example('$0 flow validate flows/', 'Validate every flow in a directory');

const verbosityOf = (argv) => {
  if (argv.silent) return 'silent';
  if (argv.quiet) return 'quiet';
  return argv.verbose ? 'verbose' : 'normal';
};

const handler = async (argv) => {
  // Resolved once: the engine owns where a run's artefacts go, and a report defaulting somewhere
  // else would be the second answer to a question that already has one.
  const captureDir = argv.captureDir === undefined ? undefined : path.resolve(argv.captureDir);

  let flows;
  /** Set by `--retry-failed` alone: which suite this invocation is a re-run of (§14.8). */
  let retryOf;
  try {
    if (argv.retryFailed === undefined) {
      flows = selectFlows(argv.paths?.length ? argv.paths : [process.cwd()]);
    } else {
      // A positional path locates the *scope* whose capture root is read rather than the flows to
      // run — the roster names those. Walking up from the path works whether it is a directory or a
      // file, since a file has no `bruno.json` beneath it to find.
      const scope = scopeIn(path.resolve(argv.paths?.length ? argv.paths[0] : process.cwd()));
      const selection = await retrySelection({
        named: argv.retryFailed,
        scope,
        captureRoot: resolveCaptureRoot(scope, captureDir),
        ports: createPorts({ collectionPath: scopeRootOf(scope) })
      });

      if (!selection.retried) {
        console.log(`nothing to retry — every flow in ${selection.retryOf} passed`);
        process.exit(EXIT.pass);
        return;
      }

      for (const file of selection.missing) console.error(`skipping ${forDisplay(file)}: no longer on disk`);
      flows = selection.flows;
      retryOf = selection.retryOf;
    }

    if (!flows.length) throw new Error('no flows matched');
  } catch (error) {
    console.error(error.message);
    process.exit(EXIT.usage);
    return;
  }

  const reporter = createReporter({
    noColor: argv.color === false,
    unicode: argv.unicode !== false,
    verbosity: verbosityOf(argv)
  });

  const variables = {
    environment: {},
    envVarOverrides: asPairs(argv.envVar),
    processEnv: { ...process.env }
  };

  /**
   * Resolved once per scope, and before anything runs: a name that matches no file is a usage
   * error, and finding that out after the first flow has already sent requests is the version of
   * this nobody wants.
   */
  const environments = new Map();
  if (argv.globalEnv) {
    try {
      for (const file of flows) {
        const { workspaceRoot } = scopeFor(file);
        if (!environments.has(workspaceRoot)) {
          environments.set(workspaceRoot, workspaceEnvironment(argv.globalEnv, workspaceRoot));
        }
      }
    } catch (error) {
      console.error(error.message);
      process.exit(EXIT.usage);
      return;
    }
  }

  /** What a reader of a run, and of the suite's own roster, sees as its provenance (§14.5). */
  const origin = { host: 'cli', ...(argv.globalEnv ? { globalEnvironment: argv.globalEnv } : {}) };

  /**
   * §14.8's report files, loaded before anything runs and for `run` alone — a report describes a
   * suite that sent requests, and `validate` sends none. An unusable `--reporter` is a usage error
   * for the reason a missing `--global-env` is: the run that discovers it has already spent its
   * requests.
   */
  const suite = createSuite();
  const identities = new Map(flows.map((file) => [file, identify(file, scopeFor(file))]));
  // Started before the reports are set up rather than after: the invocation's own directory is
  // named after the moment it began, and that moment has to exist before anything can be told it.
  const started = suite.start([...identities.values()]);

  // The first selected flow's scope, in path order (§14.1) — a selection spanning two scopes writes
  // into the first one's, deterministically rather than into whichever ran last.
  const suiteScope = scopeFor(flows[0]);
  const suitePorts = createPorts({ collectionPath: suiteScope.collectionRoot || path.dirname(flows[0]) });
  const suiteId = randomUUID();

  let reporters = [];
  let suiteDir;
  /** Whether the directory was opened on disk — nothing is written into one that was not. */
  let suiteOpened = false;
  if (argv.action === 'run') {
    try {
      const captureRoot = resolveCaptureRoot(suiteScope, captureDir);
      /**
       * Every run lives in a suite directory (§14.5); this command opens one per invocation because
       * it batches many flows, so one folder holds every flow's run directory *and* the report
       * files. That is what lets a person or CI collect an invocation as a unit, rather than
       * reassembling it from directories interleaved with every other invocation's. The `suite-`
       * prefix keeps it out of the run naming `listRuns` and per-flow pruning key on.
       */
      suiteDir = resolveSuiteDirectory(captureRoot, started.startedAt, suiteId);
      const specs = parseReporterSpecs(argv, { cwd: process.cwd(), suiteDir });

      /**
       * Created under `--no-capture` too when a report defaults into it: the report is the artefact
       * CI collects, and where it lands cannot depend on whether the run kept its captures.
       */
      suiteOpened = argv.capture || specs.some((spec) => spec.defaulted);
      if (suiteOpened) {
        fs.mkdirSync(suiteDir, { recursive: true });
        await ensureCaptureIgnored({ scope: suiteScope, dir: captureDir, ports: suitePorts });
      }

      reporters = loadReporters(specs, { cwd: process.cwd(), options: asPairs(argv.reporterOption) });
    } catch (error) {
      console.error(error.message);
      process.exit(EXIT.usage);
      return;
    }
  }

  // With no reporters every hook is a no-op, so the suite bookkeeping below needs no second branch.
  const dispatcher = createDispatcher(reporters);
  await dispatcher.onSuiteStart(started);

  /** The record every reporter sees, closed off at the moment the flow stopped (§14.8). */
  const record = async (started, fields) => {
    const finishedAt = new Date().toISOString();
    const entry = {
      ...started,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(started.startedAt),
      ...fields
    };
    suite.flowFinished(entry);
    await dispatcher.onFlowEnd(entry);
  };

  /**
   * One attempt at one flow: validate it, run it, and record how it went (§14.3).
   *
   * Every attempt is dispatched in full — `onFlowStart`, its events, `onFlowEnd` — because a report
   * that hid the attempt that failed would hide the flakiness a retry is evidence of. Collapsing
   * them to one record per flow is `createSuite`'s job, not this one's. The outcome comes back
   * because it decides both the exit code and whether `--retries` runs this flow again.
   */
  const attempt = async (file) => {
    const scope = scopeFor(file);
    const ports = createPorts({ collectionPath: scope.collectionRoot || path.dirname(file) });
    const identity = identities.get(file);
    const started = suite.flowStarted(identity);
    await dispatcher.onFlowStart(identity);

    const diagnostics = await validateFlow({ entry: file, scope, ports, params: asPairs(argv.param) });
    reporter.diagnostics(forDisplay(file), diagnostics);
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      // A flow that never ran is still in the report: a selection whose file was mis-typed and one
      // whose API broke look identical in a report listing only what executed.
      await record(started, { outcome: 'invalid', diagnostics });
      return 'invalid';
    }

    if (argv.action === 'validate') {
      // 001 §8.6: what this flow's scripts may call, and where each of it came from. Only under
      // `validate` — a run has the whole event stream to print and does not need a preamble.
      const library = await resolveFunctions({ entry: file, scope, ports });
      reporter.functions(forDisplay(file), library.map((entry) => ({ ...entry, from: forDisplay(entry.from) })));
      // A flow that validated is all `validate` has to report, and it exits 0 on one (§14.2).
      return 'passed';
    }

    reporter.flowStarted(forDisplay(file));
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);

    try {
      const result = await runFlow({
        entry: file,
        scope,
        ports,
        variables: { ...variables, globalEnvironment: environments.get(scope.workspaceRoot) },
        params: asPairs(argv.param),
        origin,
        overrides: {
          concurrency: argv.concurrency,
          maxRunDuration: argv.maxRunDuration,
          capture: {
            enabled: argv.capture,
            // Named rather than left to default: the engine opens a suite of its own for a run that
            // names no directory, which for a selection would be one suite per flow instead of one
            // per invocation. Resolved here because a relative --capture-dir means relative to where
            // the command was typed, and the engine has no working directory (§13.2).
            dir: suiteDir
          }
        },
        signal: controller.signal,
        onEvent: (event) => {
          reporter.onEvent(event);
          dispatcher.onEvent(event, identity);
        }
      });
      reporter.flowFinished(result);
      // §14.6's run statuses are `FlowOutcome`'s, minus the `invalid` a run that happened cannot be.
      await record(started, { outcome: result.status, result, diagnostics });
      return result.status;
    } catch (error) {
      /**
       * A flow that produced no verdict at all — `runFlow` rejects rather than resolving.
       *
       * The reachable case is §12.5's required param with no value, refused before `run:start` so
       * that nothing is dispatched; a crash that escapes the run is the other, and has already
       * emitted `run:end` through the reporter by the time it lands here. Both are reported in the
       * shape of the validation errors above, because both mean the same thing to a caller: this
       * flow did not run, and the message says why. Without this they surfaced as an unhandled
       * rejection with no exit code of their own.
       */
      const refusal = { severity: 'error', code: 'run-refused', message: error.message, file };
      reporter.diagnostics(forDisplay(file), [refusal]);
      await record(started, { outcome: 'invalid', diagnostics: [...diagnostics, refusal] });
      return 'invalid';
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  };

  /** The latest outcome of each flow that ran, in path order (§14.1). */
  const outcomes = new Map();
  for (const file of flows) {
    outcomes.set(file, await attempt(file));
    // Without --bail the whole selection runs, and the exit code reflects the worst outcome
    // (§14.2) — which needs the rest to have run.
    if (argv.bail && outcomes.get(file) !== 'passed') break;
  }

  /**
   * §14.8's retries. The final attempt is the flow's outcome, so a flow that passes here turns the
   * invocation green — which is what a retry is for; the attempt it replaces is still in the report,
   * and the flow is marked `flaky`. Only flows that ran are retried, so `--bail`'s short-circuit
   * narrows this pass as well as the one above.
   */
  const retries = argv.action === 'run' ? Math.max(0, argv.retries || 0) : 0;
  for (let pass = 0; pass < retries; pass += 1) {
    const again = [...outcomes].filter(([, outcome]) => outcome !== 'passed').map(([file]) => file);
    if (!again.length) break;
    for (const file of again) outcomes.set(file, await attempt(file));
  }

  /**
   * §14.2's code, over the *final* outcomes rather than accumulated across the attempts: a flow
   * that passed on a retry is a passing flow, and a suite of those exits 0. With no retries there
   * is one outcome per flow and this is the running maximum it replaces.
   */
  const worst = [...outcomes.values()].reduce((code, outcome) => Math.max(code, exitCodeFor(outcome)), EXIT.pass);

  const result = suite.end({ exitCode: worst, retryOf });
  await dispatcher.onSuiteEnd(result);

  /**
   * §14.5's roster, written last because only now is every flow's final outcome known. A `validate`
   * invocation opens no suite directory and ran nothing, so it writes none.
   *
   * A failure to write it is reported and does not change the exit code, for the reason a throwing
   * reporter does not: this is an observation of the invocation, and CI going red over it would be
   * red for something other than the API under test.
   */
  if (suiteOpened) {
    try {
      await writeSuiteManifest({
        dir: suiteDir,
        manifest: {
          suiteId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          exitCode: worst,
          origin,
          ...(retryOf ? { retryOf } : {}),
          flows: rosterOf(result.flows)
        },
        ports: suitePorts,
        // The writers want a context and this write belongs to no run — the minimum they use.
        context: { runId: '', flow: '', scope: suiteScope, signal: new AbortController().signal }
      });
    } catch (error) {
      console.error(`could not write ${SUITE_MANIFEST_FILE}: ${error.message}`);
    }
  }

  // A reporter that threw has already said so on stderr, so only a file that exists is announced.
  if (!argv.silent) {
    for (const { name, outputPath } of reporters) {
      if (outputPath && fs.existsSync(outputPath)) console.log(`Wrote ${name} report to ${forDisplay(outputPath)}`);
    }
  }

  process.exit(worst);
};

module.exports = { builder, handler, selectFlows, retrySelection, workspaceEnvironment, exitCodeFor, EXIT };
