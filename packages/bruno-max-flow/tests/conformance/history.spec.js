/**
 * R4o — reading a run back (001-C §7, 002 §11.2 over 001 §14.5's layout).
 *
 * The round trip is the point: `listRuns` and `readCapture` are correct exactly when they recover
 * what `capture.ts` wrote, so every case here runs a flow first and reads the directory that run
 * produced rather than a hand-built fixture. A hand-built one would let the writer and the reader
 * drift together and still pass.
 */
const path = require('path');

const { runFlow, FLOWS } = require('./harness');

const FIXTURES = path.dirname(FLOWS);
const CAPTURE_ROOT = path.join(FIXTURES, '.bruno-runs');

const flow = (name) => `regressions/${name}`;

const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };
const THING = { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } };
const STATE = { status: 200, body: { data: { state: 'settled' } } };

const simple = (options = {}) =>
  runFlow(flow('r4b-condition-false.flow.yml'), {
    responses: { createThing: CREATED, getState: STATE },
    ...options
  });

describe('R4o — listRuns', () => {
  it('reports a finished run complete, with its identity and its outcome', async () => {
    const run = await simple();
    const [entry] = await run.listRuns();

    expect(entry).toEqual({
      runId: run.result.runId,
      dir: run.captureDir,
      // A run of its own opens a suite of one (§14.5), so every run has a suite to name.
      suite: path.basename(path.dirname(run.captureDir)),
      flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
      startedAt: '1970-01-01T00:00:00.000Z',
      state: 'complete',
      status: 'passed',
      summary: run.result.summary
    });
  });

  it('reports a run with no summary as interrupted, and claims no status for it', async () => {
    // What a SIGKILL leaves: §14.5 writes run.json first and summary.json last, so a directory with
    // only the first is exactly the state a process that died mid-run leaves behind.
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, '2020-01-01T00-00-00Z-dead', 'run.json')]: JSON.stringify({
          runId: 'dead',
          flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
          startedAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });

    const found = (await run.listRuns()).find((entry) => entry.runId === 'dead');
    expect(found).toMatchObject({ state: 'interrupted' });
    expect(found.status).toBeUndefined();
    expect(found.summary).toBeUndefined();
  });

  it('reports the run it is executing as running, not interrupted', async () => {
    let midRun;
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: {
        createThing: CREATED,
        getThing: async (request, ctx, info) => {
          // Inside a dispatch, so run.json is written and summary.json is not — the same shape on
          // disk as the interrupted case above, and only the registry separates them.
          midRun = await info.listRuns();
          return THING;
        }
      }
    });

    expect(midRun.find((entry) => entry.runId === run.result.runId)).toMatchObject({ state: 'running' });
    expect((await run.listRuns()).find((entry) => entry.runId === run.result.runId)).toMatchObject({
      state: 'complete'
    });
  });

  it('orders newest first by startedAt', async () => {
    const older = (id, startedAt) => ({
      [path.join(CAPTURE_ROOT, `2020-01-01T00-00-0${id}Z-aa0${id}`, 'run.json')]: JSON.stringify({
        runId: `run-${id}`,
        flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
        startedAt
      })
    });
    const run = await simple({
      captured: {
        ...older(1, '2020-03-01T00:00:00.000Z'),
        ...older(2, '2020-01-01T00:00:00.000Z'),
        ...older(3, '2020-02-01T00:00:00.000Z')
      }
    });

    expect((await run.listRuns()).map((entry) => entry.startedAt)).toEqual([
      '2020-03-01T00:00:00.000Z',
      '2020-02-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z'
    ]);
  });

  it('excludes runs of another flow in the same scope, finished or not', async () => {
    const other = path.join(FLOWS, 'regressions/r1-dead-service.flow.yml');
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, '2020-01-01T00-00-01Z-aa01', 'run.json')]: JSON.stringify({
          runId: 'other-unfinished',
          flow: other,
          startedAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });

    const mine = await run.listRuns({ flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml') });
    expect(mine.map((entry) => entry.runId)).toEqual([run.result.runId]);
    expect((await run.listRuns({ flow: other })).map((entry) => entry.runId)).toEqual(['other-unfinished']);
  });

  /**
   * §14.8.5: the CLI nests one invocation's runs beside that invocation's reports, and the app
   * writes its own at the top level. 002 §10 shows one history, so both have to be found.
   */
  it('finds a run nested in a suite directory, and says which one', async () => {
    const suite = 'suite-2020-01-01T00-00-00Z-cc00';
    const nested = path.join(CAPTURE_ROOT, suite, '2020-01-01T00-00-01Z-aa01');
    const run = await simple({
      captured: {
        [path.join(nested, 'run.json')]: JSON.stringify({
          runId: 'nested',
          flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
          startedAt: '2020-01-01T00:00:00.000Z'
        }),
        // Not a run, and the only other thing in there: the reports the suite exists to hold.
        [path.join(CAPTURE_ROOT, suite, 'report-junit.xml')]: '<testsuites/>',
        [path.join(CAPTURE_ROOT, suite, 'report.json')]: '{}'
      }
    });
    const listed = await run.listRuns();

    // Newest first across both levels — the nesting does not give a run its own ordering.
    expect(listed.map((entry) => entry.runId)).toEqual(['nested', run.result.runId]);
    expect(listed.find((entry) => entry.runId === 'nested')).toMatchObject({ suite, dir: nested });
  });

  // Runs written before §14.5 made the suite the unit still sit at the top level; a reader grouping
  // by invocation must not invent a suite for one that never had one.
  it('leaves a legacy top-level run with no suite', async () => {
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, '2020-01-01T00-00-01Z-aa01', 'run.json')]: JSON.stringify({
          runId: 'legacy',
          flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
          startedAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });
    const legacy = (await run.listRuns()).find((entry) => entry.runId === 'legacy');

    expect(legacy).not.toHaveProperty('suite');
    expect(legacy.dir).toBe(path.join(CAPTURE_ROOT, '2020-01-01T00-00-01Z-aa01'));
  });

  /**
   * §14.5 puts `origin` in the manifest for `flowHash`'s reason, and this is what that buys: a
   * history that says which host ran each entry without opening a single run.
   */
  it('reports the origin the manifest recorded, from both readers', async () => {
    const origin = { host: 'cli', environment: 'staging' };
    const run = await simple({ origin });

    expect((await run.listRuns())[0].origin).toEqual(origin);
    expect((await run.readRun()).origin).toEqual(origin);
  });

  // Runs written before the field existed, and hosts that name nothing: neither gets an invented one.
  it('leaves a run whose manifest recorded none without an origin', async () => {
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, '2020-01-01T00-00-01Z-aa01', 'run.json')]: JSON.stringify({
          runId: 'older',
          flow: path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml'),
          startedAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });
    const listed = await run.listRuns();

    expect(listed).toHaveLength(2);
    for (const entry of listed) expect(entry).not.toHaveProperty('origin');
    expect(listed.find((entry) => entry.runId === 'older').state).toBe('interrupted');
  });

  it('returns an empty list when no run has happened yet', async () => {
    const run = await simple({ overrides: { capture: { enabled: false } } });

    expect(await run.listRuns()).toEqual([]);
  });

  it('skips a directory that is not a run and one that cannot be attributed to a flow', async () => {
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, 'notes.md')]: 'not a run',
        [path.join(CAPTURE_ROOT, '2020-01-01T00-00-01Z-aa01', 'summary.json')]: '{"status":"passed"}'
      }
    });

    expect((await run.listRuns()).map((entry) => entry.runId)).toEqual([run.result.runId]);
  });
});

describe('R4o — readCapture', () => {
  it('returns each attempt of a retried step separately', async () => {
    const run = await runFlow(flow('r2-retry-optin.flow.yml'), { responses: { createThing: CREATED } });

    const attempts = await Promise.all(
      [1, 2, 3].map((attempt) => run.readCapture({ stepId: 'create', attempt }))
    );

    expect(attempts.map((capture) => capture.attempt)).toEqual([1, 2, 3]);
    for (const capture of attempts) {
      expect(capture).toMatchObject({
        stepId: 'create',
        request: { method: 'POST', url: 'https://regress.example.com/things' },
        response: { status: 201 }
      });
      expect(capture.assertions).toHaveLength(1);
      expect(capture.validation).toBeDefined();
    }
  });

  it('resolves the nested layout when an iteration is named', async () => {
    const run = await runFlow(flow('r4-dataset-slots.flow.yml'), {
      responses: { createThing: CREATED, getThing: THING }
    });

    const second = await run.readCapture({ stepId: 'create', iteration: 1, attempt: 1 });
    expect(second.iteration).toBe(1);

    // Without the iteration the reader looks at the flat layout, which a dataset run does not write.
    await expect(run.readCapture({ stepId: 'create', attempt: 1 })).rejects.toThrow(/no capture/);
  });

  it('resolves a sub-flow internal through the segment the writer used', async () => {
    const run = await runFlow(flow('r4-subflow-slot.flow.yml'), { responses: { createThing: CREATED } });

    // The caller asks with the id it knows — `child/use`, as it appears in the result — and the
    // reader applies §14.5's sanitizing itself rather than making the caller spell `child__use`.
    expect(await run.readCapture({ stepId: 'child/use', attempt: 1 })).toMatchObject({ stepId: 'child/use' });
  });

  it('names a binary body rather than inlining it', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: {
        createThing: CREATED,
        getThing: {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          bytes: Buffer.from('%PDF-1.4 report'),
          body: null
        }
      }
    });

    expect((await run.readCapture({ stepId: 'consume', attempt: 1 })).response.body).toEqual({
      kind: 'binary',
      contentType: 'application/pdf',
      byteLength: 15,
      file: 'attempt-1.response.pdf'
    });
  });

  it('throws for an attempt that was never captured', async () => {
    const run = await simple();

    await expect(run.readCapture({ stepId: 'create', attempt: 2 })).rejects.toThrow(/no capture/);
    await expect(run.readCapture({ stepId: 'conditional', attempt: 1 })).rejects.toThrow(/no capture/);
  });
});

describe('R4o — readRun', () => {
  it('recovers every step result the run recorded', async () => {
    const run = await simple();
    const stored = await run.readRun();

    expect(stored.runId).toBe(run.result.runId);
    expect(stored.state).toBe('complete');
    expect(stored.status).toBe(run.result.status);
    // The detail half of the split: `listRuns` reports counts, this reports the steps themselves.
    expect(stored.result.iterations[0].steps.map((step) => step.id)).toEqual(
      run.result.iterations[0].steps.map((step) => step.id)
    );
  });

  it('answers which of the given steps have a capture', async () => {
    const run = await simple();
    const stored = await run.readRun({ stepIds: ['create', 'consume'] });

    // `consume` is skipped by its condition, so it dispatched nothing and has no directory.
    expect(stored.capturedSteps).toEqual(['create']);
  });

  it('finds a sub-flow internal by its namespaced id, which the directory name does not carry', async () => {
    const run = await runFlow(flow('r4-subflow-slot.flow.yml'), {
      responses: { createThing: CREATED, getThing: THING, getState: STATE }
    });
    const stored = await run.readRun({ stepIds: ['create', 'child/use', 'child'] });

    // §14.5 writes `child/use` as `child__use`, so a reader inverting the name would answer this
    // wrongly for a step genuinely called `child__use`. Asking by id is what makes it decidable.
    expect(stored.capturedSteps).toEqual(['create', 'child/use']);
  });

  it('reports a run with no summary as interrupted and still names its flow', async () => {
    const run = await simple();
    run.files.remove(path.join(run.captureDir, 'summary.json'));

    const stored = await run.readRun({ stepIds: ['create'] });

    expect(stored.state).toBe('interrupted');
    // §10: the captures are the only evidence of what happened, and it must not claim an outcome.
    expect(stored.capturedSteps).toEqual(['create']);
    expect(stored.status).toBeUndefined();
    expect(stored.result).toBeUndefined();
    // §10: the captures are the only evidence of what happened, and it must not claim an outcome.
    expect(stored.flow).toContain('r4b-condition-false.flow.yml');
  });

  it('refuses a directory that is not a run', async () => {
    const run = await simple();

    await expect(run.readRun({ dir: path.join(CAPTURE_ROOT, 'not-a-run') })).rejects.toThrow(/not a run directory/);
  });
});

/**
 * The flow as it was — 001 §14.5's snapshot, read back. The failure this closes is silent: a run
 * whose flow has since been edited was drawn onto the current graph, so a renamed step's outcome and
 * captures simply vanished from the view and a step added since appeared as one that never ran.
 */
describe('R4o — a run is read against the flow it executed', () => {
  it('returns the graph and the text the run was started from', async () => {
    const run = await simple();
    const stored = await run.readRun();

    expect(stored.description.nodes.map((node) => node.id)).toEqual(
      run.result.iterations[0].steps.map((step) => step.id)
    );
    expect(stored.source).toContain('steps:');
  });

  /**
   * The payoff: the caller's ids are today's graph, and a step renamed since is not in it. With a
   * snapshot the reader asks about the ids the run actually had, so its captures stay reachable.
   */
  it('finds the captures even when the caller asks about the wrong ids', async () => {
    const run = await simple();
    const stored = await run.readRun({ stepIds: ['renamed-since', 'added-since'] });

    expect(stored.capturedSteps).toEqual(['create']);
  });

  /** A run written before snapshots has no ids of its own, so the caller's list is all there is. */
  it('falls back to the caller list for a run with no snapshot', async () => {
    const run = await simple();
    run.files.remove(path.join(run.captureDir, 'flow.json'));

    const stored = await run.readRun({ stepIds: ['create'] });

    expect(stored.description).toBeUndefined();
    expect(stored.capturedSteps).toEqual(['create']);
  });
});

describe('R4o — listRuns reports whether the flow has changed since', () => {
  const entry = path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml');

  // The directory name's suffix is four hex characters (§14.5), and `listRuns` filters on that — so
  // a seeded run has to be named the way the writer would have named it.
  const seeded = (runId, manifest) => ({
    [path.join(CAPTURE_ROOT, `2020-01-01T00-00-00Z-${runId}`, 'run.json')]: JSON.stringify({
      runId,
      flow: entry,
      startedAt: '2020-01-01T00:00:00.000Z',
      ...manifest
    })
  });

  it('reports the run it just made as unchanged, and a run of older text as changed', async () => {
    const run = await simple({ captured: seeded('edad', { flowHash: 'a'.repeat(64) }) });
    const listed = await run.listRuns({ flow: entry });
    const by = (runId) => listed.find((candidate) => candidate.runId === runId);

    expect(by(run.result.runId).flowChanged).toBe(false);
    expect(by('edad').flowChanged).toBe(true);
  });

  /**
   * Unknown, not unchanged. A run that predates the snapshot cannot be compared, and reporting it as
   * matching would put a claim on the oldest half of every history that nothing can support.
   */
  it('leaves a run with no recorded digest unknown', async () => {
    const run = await simple({ captured: seeded('01de', {}) });
    const listed = await run.listRuns({ flow: entry });

    expect(listed.find((candidate) => candidate.runId === '01de').flowChanged).toBeUndefined();
  });

  it('leaves every run unknown when there is no flow to compare against', async () => {
    const run = await simple();

    // Listing a scope rather than one flow: there is no single file to be changed *from*.
    expect((await run.listRuns()).every((candidate) => candidate.flowChanged === undefined)).toBe(true);
  });
});

/**
 * §14.5's `suite.json` — reading an invocation back rather than one run.
 *
 * The manifest exists because the run directories cannot answer the question on their own: a flow
 * that failed validation never opens one, so a reader scanning them silently drops exactly the
 * flows a rerun most wants. Both halves are exercised here — the manifest when a host wrote one,
 * and the reconstruction when nothing did, which every single-flow run produces.
 */
describe('R4o — listSuites', () => {
  const ENTRY = path.join(FLOWS, 'regressions/r4b-condition-false.flow.yml');

  /** A run directory as §14.5 names one, with whatever files the case is about. */
  const seedRun = (suite, name, files) =>
    Object.fromEntries(
      Object.entries(files).map(([file, content]) => [
        path.join(CAPTURE_ROOT, suite, name, file),
        typeof content === 'string' ? content : JSON.stringify(content)
      ])
    );

  it('reads a run of its own back as the suite of one it minted', async () => {
    const run = await simple();

    expect(await run.listSuites()).toEqual([
      {
        dir: path.dirname(run.captureDir),
        startedAt: '1970-01-01T00:00:00.000Z',
        flows: [
          {
            file: ENTRY,
            // §5.2's identity: relative to the scope root, `.flow.yml` stripped, posix separators.
            id: 'flows/regressions/r4b-condition-false',
            name: 'R4b — condition-false does not fail the run',
            tags: [],
            outcome: 'passed',
            runDir: path.basename(run.captureDir)
          }
        ],
        // Rebuilt from run directories, so it cannot claim to be the whole selection.
        partial: true
      }
    ]);
  });

  it('names a flow by its stem when the run kept no snapshot to read `meta:` from', async () => {
    const run = await simple();
    run.files.remove(path.join(run.captureDir, 'flow.yml'));

    expect((await run.listSuites())[0].flows[0]).toMatchObject({
      name: 'r4b-condition-false',
      tags: []
    });
  });

  /**
   * The whole reason the manifest is written: an `invalid` flow fails validation before anything
   * opens a run directory, so it is in the roster or it is nowhere.
   */
  it('prefers the manifest, which names flows that never ran', async () => {
    const suite = 'suite-2020-01-01T00-00-00Z-bb00';
    const run = await simple({
      captured: {
        ...seedRun(suite, '2020-01-01T00-00-00Z-bb00', {
          'run.json': { runId: 'ran', flow: ENTRY, startedAt: '2020-01-01T00:00:00.000Z' },
          'summary.json': { status: 'failed' }
        }),
        [path.join(CAPTURE_ROOT, suite, 'suite.json')]: JSON.stringify({
          suiteId: 'bb00',
          startedAt: '2020-01-01T00:00:00.000Z',
          finishedAt: '2020-01-01T00:00:09.000Z',
          exitCode: 1,
          retryOf: 'suite-2019-01-01T00-00-00Z-aa00',
          flows: [
            { file: ENTRY, id: 'flows/regressions/r4b-condition-false', name: 'ran', tags: [], outcome: 'failed', runDir: '2020-01-01T00-00-00Z-bb00' },
            { file: path.join(FLOWS, 'regressions/r1-dead-service.flow.yml'), id: 'flows/regressions/r1-dead-service', name: 'never ran', tags: ['smoke'], outcome: 'invalid' }
          ]
        })
      }
    });

    const listed = (await run.listSuites()).find((entry) => entry.dir === path.join(CAPTURE_ROOT, suite));
    expect(listed).not.toHaveProperty('partial');
    expect(listed).toMatchObject({ suiteId: 'bb00', exitCode: 1, retryOf: 'suite-2019-01-01T00-00-00Z-aa00' });
    expect(listed.flows.map((flow) => [flow.name, flow.outcome])).toEqual([
      ['ran', 'failed'],
      ['never ran', 'invalid']
    ]);
    // The flow that never ran has no directory to point at, which is what the manifest is for.
    expect(listed.flows[1]).not.toHaveProperty('runDir');
  });

  it('orders newest first by startedAt', async () => {
    const seeded = (id, startedAt) => ({
      [path.join(CAPTURE_ROOT, `suite-2020-01-01T00-00-0${id}Z-cc0${id}`, 'suite.json')]: JSON.stringify({
        suiteId: `cc0${id}`,
        startedAt,
        finishedAt: startedAt,
        exitCode: 0,
        flows: []
      })
    });
    const run = await simple({
      captured: { ...seeded(1, '2020-03-01T00:00:00.000Z'), ...seeded(2, '2020-01-01T00:00:00.000Z'), ...seeded(3, '2020-02-01T00:00:00.000Z') }
    });

    expect((await run.listSuites()).map((entry) => entry.startedAt)).toEqual([
      '2020-03-01T00:00:00.000Z',
      '2020-02-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z'
    ]);
  });

  /**
   * 002 §10's interrupted run: `run.json` with no `summary.json` is what a killed process leaves,
   * and nobody recorded an outcome for it. Calling it `cancelled` would put a flow in the roster on
   * the strength of a guess — and a rerun would act on it.
   */
  it('leaves an interrupted run out of the rebuilt roster, but still dates the suite by it', async () => {
    const suite = 'suite-2020-01-01T00-00-00Z-dd00';
    const run = await simple({
      captured: seedRun(suite, '2020-01-01T00-00-00Z-dd00', {
        'run.json': { runId: 'dead', flow: ENTRY, startedAt: '2020-01-01T00:00:00.000Z' }
      })
    });

    const listed = (await run.listSuites()).find((entry) => entry.dir === path.join(CAPTURE_ROOT, suite));
    expect(listed).toMatchObject({ startedAt: '2020-01-01T00:00:00.000Z', flows: [], partial: true });
  });

  // §14.8.5's reports share the directory with the runs, and on their own they say nothing about
  // what was selected or when it started.
  it('skips a suite directory holding nothing that can be attributed to a run', async () => {
    const suite = 'suite-2020-01-01T00-00-00Z-ee00';
    const run = await simple({
      captured: {
        [path.join(CAPTURE_ROOT, suite, 'report-junit.xml')]: '<testsuites/>',
        [path.join(CAPTURE_ROOT, suite, 'suite.json')]: 'not json at all'
      }
    });

    expect((await run.listSuites()).map((entry) => entry.dir)).toEqual([path.dirname(run.captureDir)]);
  });

  /**
   * What an interrupted `--retries` invocation leaves: two run directories for one flow, and no
   * manifest to say which was final. §14.8's rule is that the last attempt is the outcome.
   */
  it('rebuilds one line per flow, the last attempt winning', async () => {
    const suite = 'suite-2020-01-01T00-00-00Z-ff00';
    const run = await simple({
      captured: {
        ...seedRun(suite, '2020-01-01T00-00-01Z-ff01', {
          'run.json': { runId: 'first', flow: ENTRY, startedAt: '2020-01-01T00:00:01.000Z' },
          'summary.json': { status: 'failed' }
        }),
        ...seedRun(suite, '2020-01-01T00-00-02Z-ff02', {
          'run.json': { runId: 'second', flow: ENTRY, startedAt: '2020-01-01T00:00:02.000Z' },
          'summary.json': { status: 'passed' }
        })
      }
    });

    const listed = (await run.listSuites()).find((entry) => entry.dir === path.join(CAPTURE_ROOT, suite));
    expect(listed.flows).toHaveLength(1);
    expect(listed.flows[0]).toMatchObject({ outcome: 'passed', runDir: '2020-01-01T00-00-02Z-ff02' });
  });

  // The runs each say who started them, so the suite around them is not the place to lose it.
  it('reports the origin the runs recorded', async () => {
    const run = await simple({ origin: { host: 'app', environment: 'staging' } });

    expect((await run.listSuites())[0].origin).toEqual({ host: 'app', environment: 'staging' });
  });

  it('returns an empty list when nothing has been run in the scope yet', async () => {
    const run = await simple({ overrides: { capture: { enabled: false } } });

    expect(await run.listSuites()).toEqual([]);
  });
});

describe('R4o — readSuite', () => {
  it('answers for one directory exactly what the listing says about it', async () => {
    const run = await simple();

    expect(await run.readSuite()).toEqual((await run.listSuites())[0]);
  });

  // A caller naming a directory has named something; an empty roster would report a mistyped path
  // as an invocation that ran nothing.
  it('refuses a directory that is not a suite', async () => {
    const run = await simple();

    await expect(run.readSuite({ dir: path.join(CAPTURE_ROOT, 'suite-2020-01-01T00-00-00Z-0000') })).rejects.toThrow(
      /is not a suite directory/
    );
  });
});
