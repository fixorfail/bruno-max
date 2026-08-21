/**
 * `bru flow run` and `bru flow validate` — 001 §14.
 *
 * The command owns a *suite*: which flows were selected, what order they run in, and what the
 * process exits with. The engine's unit is one flow and its iterations (§13.2), so everything
 * below the `runFlow` call is deliberately absent from here.
 */
const fs = require('fs');
const path = require('path');
const { runFlow, validateFlow, resolveFunctions } = require('@bruno-max/flow');
const { parseEnvironment } = require('@usebruno/filestore');

const { getEnvVars } = require('../../utils/bru');
const { createPorts } = require('./ports');
const { createReporter } = require('./output');

/** §14.2, shared by `run` and `validate`. `validate` never returns 1, since it sends nothing. */
const EXIT = { pass: 0, failed: 1, invalid: 2, usage: 3, cancelled: 4 };

/** An interrupted run is neither a passing one nor a failing test, so CI can tell them apart. */
const exitCodeFor = (status) =>
  status === 'cancelled' ? EXIT.cancelled : status === 'failed' ? EXIT.failed : EXIT.pass;

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
  let directory = path.dirname(from);
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

const scopeFor = (file) => {
  const collectionRoot = findUp(file, 'bruno.json');
  const workspaceRoot = findUp(file, 'workspace.yml') || collectionRoot || path.dirname(file);
  return { workspaceRoot, collectionRoot };
};

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
    .option('verbose', { describe: 'Expand sub-flows', type: 'boolean', default: false })
    .option('quiet', { describe: 'Summary and failures only', type: 'boolean', default: false })
    .option('silent', { describe: 'Write nothing to stdout', type: 'boolean', default: false })
    .option('color', { describe: 'Colourise output', type: 'boolean', default: true })
    .option('unicode', { describe: 'Use box-drawing status markers', type: 'boolean', default: true })
    .example('$0 flow run flows/checkout.flow.yml', 'Run one flow')
    .example('$0 flow run flows/ --global-env staging', 'Run every flow against a workspace environment')
    .example('$0 flow validate flows/', 'Validate every flow in a directory');

const verbosityOf = (argv) => {
  if (argv.silent) return 'silent';
  if (argv.quiet) return 'quiet';
  return argv.verbose ? 'verbose' : 'normal';
};

const handler = async (argv) => {
  let flows;
  try {
    flows = selectFlows(argv.paths?.length ? argv.paths : [process.cwd()]);
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

  let worst = EXIT.pass;
  const worsen = (code) => {
    worst = Math.max(worst, code);
  };

  for (const file of flows) {
    const scope = scopeFor(file);
    const ports = createPorts({ collectionPath: scope.collectionRoot || path.dirname(file) });

    const diagnostics = await validateFlow({ entry: file, scope, ports, params: asPairs(argv.param) });
    reporter.diagnostics(forDisplay(file), diagnostics);
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      worsen(EXIT.invalid);
      if (argv.bail) break;
      continue;
    }

    if (argv.action === 'validate') {
      // 001 §8.6: what this flow's scripts may call, and where each of it came from. Only under
      // `validate` — a run has the whole event stream to print and does not need a preamble.
      const library = await resolveFunctions({ entry: file, scope, ports });
      reporter.functions(forDisplay(file), library.map((entry) => ({ ...entry, from: forDisplay(entry.from) })));
      continue;
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
        overrides: {
          concurrency: argv.concurrency,
          maxRunDuration: argv.maxRunDuration,
          capture: {
            enabled: argv.capture,
            // Resolved here rather than in the engine: a relative --capture-dir means relative to
            // where the command was typed, and the engine has no working directory (§13.2).
            dir: argv.captureDir === undefined ? undefined : path.resolve(argv.captureDir)
          }
        },
        signal: controller.signal,
        onEvent: reporter.onEvent
      });
      reporter.flowFinished(result);
      worsen(exitCodeFor(result.status));
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }

    // Without --bail the whole selection runs, and the exit code reflects the worst outcome
    // (§14.2) — which needs the rest to have run.
    if (argv.bail && worst !== EXIT.pass) break;
  }

  process.exit(worst);
};

module.exports = { builder, handler, selectFlows, workspaceEnvironment, exitCodeFor, EXIT };
