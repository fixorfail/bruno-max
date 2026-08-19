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
