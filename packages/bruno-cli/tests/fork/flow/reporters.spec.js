/**
 * The reporter runtime — 001 §14.3.
 *
 * What is asserted here is the contract a *custom* reporter is written against, so it is pinned:
 * the suite's arithmetic, what `--reporter` accepts and rejects before a request is sent, and the
 * promise that a broken reporter is an observation problem rather than a run one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSuite,
  identify,
  parseReporterSpecs,
  loadReporters,
  createDispatcher
} = require('../../../src/fork/flow/reporters');

const summary = (over = {}) => ({ total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, ...over });

const identity = (over = {}) => ({
  file: path.join('/w', 'flows', 'checkout.flow.yml'),
  id: 'flows/checkout',
  name: 'Checkout',
  tags: ['smoke'],
  ...over
});

describe('the suite accumulator', () => {
  // The clock is injected so the arithmetic is assertable without one.
  const clock = (...isos) => {
    const times = [...isos];
    return () => new Date(times.length > 1 ? times.shift() : times[0]);
  };

  it('counts flows by outcome and sums every run\'s step summary', () => {
    const suite = createSuite({ now: clock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:04.000Z') });
    suite.start([identity()]);

    suite.flowFinished({
      ...identity(),
      startedAt: '2026-09-02T10:00:00.000Z',
      finishedAt: '2026-09-02T10:00:01.000Z',
      durationMs: 1000,
      outcome: 'passed',
      diagnostics: [],
      result: { summary: summary({ total: 3, passed: 3 }) }
    });
    suite.flowFinished({
      ...identity({ id: 'flows/refunds' }),
      startedAt: '2026-09-02T10:00:01.000Z',
      finishedAt: '2026-09-02T10:00:02.000Z',
      durationMs: 1000,
      outcome: 'failed',
      diagnostics: [],
      result: { summary: summary({ total: 2, passed: 1, failed: 1 }) }
    });
    // A flow that never ran contributes to the flow counts and to no step count.
    suite.flowFinished({
      ...identity({ id: 'flows/broken' }),
      startedAt: '2026-09-02T10:00:02.000Z',
      finishedAt: '2026-09-02T10:00:02.000Z',
      durationMs: 0,
      outcome: 'invalid',
      diagnostics: [{ severity: 'error', code: 'unknown-operation', message: 'no such operation', file: 'x' }]
    });

    const result = suite.end({ exitCode: 1 });

    expect(result.summary.flows).toEqual({ total: 3, passed: 1, failed: 1, cancelled: 0, invalid: 1 });
    expect(result.summary.steps).toEqual(summary({ total: 5, passed: 4, failed: 1 }));
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBe(4000);
    expect(result.flows).toHaveLength(3);
  });

  it('stamps a flow with the suite\'s clock', () => {
    const suite = createSuite({ now: clock('2026-09-02T10:00:00.000Z') });
    suite.start([]);
    expect(suite.flowStarted(identity())).toEqual({ ...identity(), startedAt: '2026-09-02T10:00:00.000Z' });
  });
});

describe('flow identity', () => {
  let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-identity-'));
    fs.mkdirSync(path.join(root, 'flows', 'shared'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'flows', 'checkout.flow.yml'),
      'version: 1\nmeta:\n  name: Checkout happy path\n  tags: [checkout, smoke]\n'
    );
    fs.writeFileSync(path.join(root, 'flows', 'shared', 'login.flow.yml'), 'version: 1\n');
    fs.writeFileSync(
      path.join(root, 'flows', 'tracked.flow.yml'),
      'version: 1\nmeta:\n  name: Tracked\n  testId: C9000\n'
    );
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // §5.2: the path relative to the scope root with the extension removed, and posix separators
  // wherever it ran — a report keyed on a Windows id would not match one written on CI.
  it('is the scope-relative path, and meta.name where the file declares one', () => {
    expect(identify(path.join(root, 'flows', 'checkout.flow.yml'), { workspaceRoot: root })).toEqual({
      file: path.join(root, 'flows', 'checkout.flow.yml'),
      id: 'flows/checkout',
      name: 'Checkout happy path',
      tags: ['checkout', 'smoke']
    });
  });

  it('falls back to the file\'s stem and no tags', () => {
    expect(identify(path.join(root, 'flows', 'shared', 'login.flow.yml'), { workspaceRoot: root })).toEqual({
      file: path.join(root, 'flows', 'shared', 'login.flow.yml'),
      id: 'flows/shared/login',
      name: 'login',
      tags: []
    });
  });

  // The flow's own case id, for the report property a tracker keys on.
  it('carries the case id a flow declares, and nothing when it declares none', () => {
    expect(identify(path.join(root, 'flows', 'tracked.flow.yml'), { workspaceRoot: root }).testId).toBe('C9000');
    expect(identify(path.join(root, 'flows', 'checkout.flow.yml'), { workspaceRoot: root }))
      .not.toHaveProperty('testId');
  });

  // A collection root is the nearer scope, so the same file is `refund` inside its collection.
  it('prefers the collection root over the workspace root', () => {
    const scope = { workspaceRoot: root, collectionRoot: path.join(root, 'flows') };
    expect(identify(path.join(root, 'flows', 'checkout.flow.yml'), scope).id).toBe('checkout');
  });
});

describe('--reporter', () => {
  let cwd;
  let suiteDir;
  const parse = (argv, over) => parseReporterSpecs(argv, { cwd, suiteDir, ...over });

  beforeAll(() => {
    // Realpath, because `require.resolve` answers with one and macOS's tmpdir is a symlink.
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reporters-')));
    suiteDir = path.join(cwd, '.bruno-runs', 'suite-2026-09-02T10-00-00Z-ab12');
    fs.mkdirSync(path.join(cwd, 'out'));
  });

  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

  // The common invocation: CI collects the capture root already, so a built-in needs no path and
  // the one it would have been given is one more thing to keep in step with --capture-dir. The three
  // share a directory, so each file says which format it is.
  it('defaults a built-in into the invocation\'s suite directory', () => {
    const specs = parse({ reporter: ['junit', 'junit-flows', 'json', 'html'] });
    expect(specs.map((spec) => [spec.name, spec.outputPath, spec.defaulted])).toEqual([
      ['junit', path.join(suiteDir, 'report-junit.xml'), true],
      ['junit-flows', path.join(suiteDir, 'report-junit-flows.xml'), true],
      ['json', path.join(suiteDir, 'report.json'), true],
      ['html', path.join(suiteDir, 'report.html'), true]
    ]);
  });

  // A bare `--reporter-junit` reaches yargs as an empty string rather than as an absent flag.
  it('defaults the sugar flags given with no value', () => {
    expect(parse({ reporterJunit: '' })).toEqual([
      { name: 'junit', module: './junit', outputPath: path.join(suiteDir, 'report-junit.xml'), defaulted: true }
    ]);
  });

  // --capture-dir moves the run's artefacts, and the report follows them rather than staying put.
  it('follows the suite directory it is given', () => {
    const elsewhere = path.join(cwd, 'artifacts', 'suite-2026-09-02T10-00-00Z-ab12');
    const [spec] = parse({ reporterJunit: '' }, { suiteDir: elsewhere });
    expect(spec.outputPath).toBe(path.join(elsewhere, 'report-junit.xml'));
  });

  it('resolves a named path against the working directory', () => {
    expect(parse({ reporter: 'junit=out/results.xml' })).toEqual([
      { name: 'junit', module: './junit', outputPath: path.join(cwd, 'out', 'results.xml'), defaulted: false }
    ]);
  });

  // The FIRST `=` splits — an output path may contain one, a module name may not.
  it('splits on the first = so a path may contain another', () => {
    const [spec] = parse({ reporter: 'junit=out/build=42.xml' });
    expect(spec.outputPath).toBe(path.join(cwd, 'out', 'build=42.xml'));
  });

  it('accepts the per-format sugar and repeated --reporter together', () => {
    const specs = parse({
      reporter: ['junit=out/a.xml'],
      reporterJunitFlows: '',
      reporterJson: 'out/b.json',
      reporterHtml: 'out/c.html'
    });
    expect(specs.map((spec) => [spec.name, spec.module])).toEqual([
      ['junit', './junit'],
      ['junit-flows', './junit-flows'],
      ['json', './json'],
      ['html', './html']
    ]);
  });

  it('resolves a relative module path against the working directory', () => {
    fs.writeFileSync(path.join(cwd, 'my-reporter.js'), 'module.exports = () => ({});\n');
    const [spec] = parse({ reporter: './my-reporter.js=out/custom.txt' });
    expect(spec).toEqual({
      name: './my-reporter.js',
      module: path.join(cwd, 'my-reporter.js'),
      outputPath: path.join(cwd, 'out', 'custom.txt'),
      defaulted: false
    });
  });

  // Every one of these is a usage error the handler turns into exit 3, raised before a flow runs.
  // A custom reporter has no filename of its own to default to, so it must say where its output goes.
  it('refuses a custom reporter with no output path', () => {
    expect(() => parse({ reporter: './my-reporter.js' }))
      .toThrow('custom reporter ./my-reporter.js needs an output path: --reporter ./my-reporter.js=<path>');
  });

  it('refuses a module it cannot resolve', () => {
    expect(() => parse({ reporter: 'no-such-reporter=out/a.xml' }))
      .toThrow(/cannot resolve reporter no-such-reporter/);
  });

  it('refuses a named output path whose directory does not exist', () => {
    expect(() => parse({ reporter: 'junit=nowhere/a.xml' }))
      .toThrow(/output directory .* does not exist/);
  });

  it('refuses a module that does not export a function', () => {
    fs.writeFileSync(path.join(cwd, 'not-a-factory.js'), 'module.exports = { onSuiteEnd: 1 };\n');
    const specs = parse({ reporter: './not-a-factory.js=out/x.txt' });
    expect(() => loadReporters(specs, { cwd, options: {} }))
      .toThrow(/does not export a function/);
  });
});

describe('the dispatcher', () => {
  const hooks = ['onSuiteStart', 'onFlowStart', 'onEvent', 'onFlowEnd', 'onSuiteEnd'];

  it('names a throwing reporter on stderr and carries on', async () => {
    const errors = [];
    const seen = [];
    const dispatcher = createDispatcher(
      [
        { name: 'broken', reporter: { onFlowEnd: () => { throw new Error('disk full'); } } },
        { name: 'good', reporter: { onFlowEnd: (value) => seen.push(value) } }
      ],
      { stderr: (line) => errors.push(line) }
    );

    await dispatcher.onFlowEnd('record');

    expect(errors).toEqual(['reporter broken: disk full']);
    expect(seen).toEqual(['record']);
  });

  it('awaits a hook that returns a promise and reports its rejection', async () => {
    const errors = [];
    const dispatcher = createDispatcher(
      [{ name: 'slow', reporter: { onSuiteEnd: async () => { throw new Error('write failed'); } } }],
      { stderr: (line) => errors.push(line) }
    );

    await dispatcher.onSuiteEnd({});

    expect(errors).toEqual(['reporter slow: write failed']);
  });

  /**
   * The engine calls `onEvent` synchronously and ignores what it returns (§13.2), so the handler
   * cannot await it. A reporter that writes asynchronously must still see the step before the flow
   * that contained it ended.
   */
  it('finishes an un-awaited hook before the next one starts', async () => {
    const seen = [];
    const dispatcher = createDispatcher([
      {
        name: 'slow',
        reporter: {
          onEvent: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            seen.push('onEvent');
          },
          onFlowEnd: () => seen.push('onFlowEnd')
        }
      }
    ]);

    dispatcher.onEvent({ type: 'step:end' });
    await dispatcher.onFlowEnd({});

    expect(seen).toEqual(['onEvent', 'onFlowEnd']);
  });

  it('drives a reporter module loaded from disk through every hook in order', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-custom-reporter-')));
    fs.writeFileSync(
      path.join(cwd, 'trace.js'),
      `module.exports = (context) => {
        const calls = (globalThis.__flowReporterTrace = []);
        calls.push(['created', context.outputPath, context.options.who, context.cwd]);
        const hook = (name) => (first) => { calls.push([name, first]); };
        return {
          onSuiteStart: hook('onSuiteStart'),
          onFlowStart: hook('onFlowStart'),
          onEvent: hook('onEvent'),
          onFlowEnd: hook('onFlowEnd'),
          onSuiteEnd: hook('onSuiteEnd')
        };
      };\n`
    );

    const specs = parseReporterSpecs({ reporter: `./trace.js=${path.join(cwd, 'out.txt')}` }, { cwd, suiteDir: cwd });
    const reporters = loadReporters(specs, { cwd, options: { who: 'me' } });
    const dispatcher = createDispatcher(reporters);

    for (const hook of hooks) await dispatcher[hook](hook);

    expect(globalThis.__flowReporterTrace).toEqual([
      ['created', path.join(cwd, 'out.txt'), 'me', cwd],
      ...hooks.map((hook) => [hook, hook])
    ]);

    delete globalThis.__flowReporterTrace;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
