/**
 * R4g2 — run identity is written before the run, not after — and R4n's implementable half
 * (001-C §7, 001 §14.4 and §14.5).
 *
 * These assert the **capture directory**, not the run result: §14.5's layout is a declared contract
 * that `listRuns` and `readCapture` (002 §11.2) read back, so a divergence between what the engine
 * writes and what the layout says has to show up here rather than as the app failing to open a run
 * the CLI produced. The write ports are the harness's in-memory filesystem, so no test touches disk.
 *
 * R4n's provenance rows are not here: §13.2 has no field carrying which environment entries are
 * `secret: true`, so there is nothing yet for the primary mechanism to track — see the note under
 * that row in 001-C.
 */
const path = require('path');

const { runFlow, variant, FLOWS } = require('./harness');

const FIXTURES = path.dirname(FLOWS);
const CAPTURE_ROOT = path.join(FIXTURES, '.bruno-runs');

const flow = (name) => `regressions/${name}`;

const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };
const THING = { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } };
const STATE = { status: 200, body: { data: { state: 'settled' } } };

describe('R4g2 — run identity is written before the run, not after', () => {
  it('writes run.json, summary.json and one directory per attempted step', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    expect(run.layout()).toEqual(['create/attempt-1.json', 'flow.json', 'flow.yml', 'inputs.json', 'run.json', 'summary.json']);
  });

  it('computes every path itself, inside the scope root', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    for (const target of run.files.paths()) {
      expect(path.isAbsolute(target)).toBe(true);
      expect(path.relative(FIXTURES, target).startsWith('..')).toBe(false);
    }
    expect(run.captureDir.startsWith(`${CAPTURE_ROOT}${path.sep}`)).toBe(true);
  });

  it('produces an identical layout through two different port stubs', async () => {
    const responses = { createThing: CREATED, getState: STATE };
    const first = await runFlow(flow('r4b-condition-false.flow.yml'), { responses });
    const second = await runFlow(flow('r4b-condition-false.flow.yml'), { responses });

    expect(first.captureDir).not.toBe(second.captureDir);
    expect(first.layout()).toEqual(second.layout());
  });

  it('names the flow even when the run produced no steps at all', async () => {
    const { entry, files } = variant(flow('r4b-condition-false.flow.yml'), (document) => {
      document.steps = [];
    });
    const run = await runFlow(entry, { files });

    expect(run.layout()).toEqual(['flow.json', 'flow.yml', 'inputs.json', 'run.json', 'summary.json']);
    // `flowHash` is the flow's own text, which §14.5 records so a reader can tell a run apart from
    // what the file says now — an exact shape, so a field added without a decision fails here.
    expect(run.files.json(path.join(run.captureDir, 'run.json'))).toEqual({
      runId: run.result.runId,
      flow: entry,
      startedAt: '1970-01-01T00:00:00.000Z',
      flowHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
  });

  describe('while the run is still going', () => {
    /** The snapshot a `SIGKILL` would freeze: §11.3's clean cancel writes a summary, so it cannot. */
    const interrupted = async () => {
      let snapshot;
      const run = await runFlow(flow('r1-dead-service.flow.yml'), {
        responses: {
          createThing: CREATED,
          getThing: (request, ctx, info) => {
            const paths = info.files.paths();
            snapshot = {
              paths,
              // Found by name rather than by rebuilding the path: the run directory's depth is
              // §14.5's business, and this assertion is about what exists mid-run, not where.
              manifest: info.files.json(paths.find((target) => target.endsWith(`${path.sep}run.json`)))
            };
            return THING;
          }
        }
      });
      return { run, snapshot };
    };

    it('has already written run.json, carrying the runId, the flow and startedAt', async () => {
      const { run, snapshot } = await interrupted();

      expect(snapshot.manifest).toEqual({
        runId: run.result.runId,
        flow: path.join(FLOWS, 'regressions/r1-dead-service.flow.yml'),
        startedAt: '1970-01-01T00:00:00.000Z',
        flowHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
    });

    it('has not written summary.json, and the captures that exist parse', async () => {
      const { run, snapshot } = await interrupted();
      const relative = snapshot.paths
        .filter((target) => target.startsWith(`${run.captureDir}${path.sep}`))
        .map((target) => path.relative(run.captureDir, target));

      expect(relative.sort()).toEqual(['create/attempt-1.json', 'flow.json', 'flow.yml', 'inputs.json', 'run.json']);
      expect(run.files.json(path.join(run.captureDir, 'create/attempt-1.json'))).toMatchObject({
        stepId: 'create',
        attempt: 1
      });
    });
  });

  /**
   * §14.5's default: a run that was given no directory opens a suite of its own, so every run in
   * the capture root sits at the same depth whichever host wrote it (§14.8.5).
   */
  describe('a run of its own opens a suite of one', () => {
    it('writes the run inside a suite, and nothing at the top level', async () => {
      const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
        responses: { createThing: CREATED, getState: STATE }
      });

      const suite = path.basename(path.dirname(run.captureDir));
      expect(path.dirname(path.dirname(run.captureDir))).toBe(CAPTURE_ROOT);
      expect(suite).toMatch(/^suite-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{4}$/);
      // Nothing was written straight into the root — everything inside it goes through the suite.
      const inRoot = run.files.paths().filter((target) => target.startsWith(`${CAPTURE_ROOT}${path.sep}`));
      expect(inRoot.length).toBeGreaterThan(0);
      for (const target of inRoot) {
        expect(path.relative(CAPTURE_ROOT, target).startsWith(`${suite}${path.sep}`)).toBe(true);
      }
    });

    // The suite is minted from the run's own id, so the pair reads as one thing.
    it('gives the suite and the run it holds the same four hex', async () => {
      const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
        responses: { createThing: CREATED, getState: STATE }
      });

      const suffix = (name) => name.slice(-4);
      expect(suffix(path.basename(path.dirname(run.captureDir)))).toBe(suffix(path.basename(run.captureDir)));
    });

    it('still writes the .gitignore entry on the first run', async () => {
      const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
        responses: { createThing: CREATED, getState: STATE }
      });

      expect(run.files.read(path.join(FIXTURES, '.gitignore')).toString('utf8')).toBe('.bruno-runs/\n');
    });

    /**
     * §14.5: nothing under the capture root is ever removed. The directory is gitignored and grows
     * with every run, and clearing it is the user's — silently deleting from a directory that may
     * be being archived is a worse failure than the growth it would save.
     */
    it('removes nothing, however many runs are already there', async () => {
      const existing = Object.fromEntries(
        Array.from({ length: 12 }, (unused, index) => {
          const stamp = String(index).padStart(2, '0');
          return [path.join(CAPTURE_ROOT, `suite-2020-01-01T00-00-${stamp}Z-aa${stamp}`, `2020-01-01T00-00-${stamp}Z-aa${stamp}`, 'run.json'), '{}'];
        })
      );
      const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
        responses: { createThing: CREATED, getState: STATE },
        captured: existing
      });

      expect(run.files.removed).toEqual([]);
      for (const target of Object.keys(existing)) expect(run.files.has(target)).toBe(true);
    });

    it('mints no suite when the host said where runs go', async () => {
      const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
        responses: { createThing: CREATED, getState: STATE },
        overrides: { capture: { dir: CAPTURE_ROOT } }
      });

      expect(path.dirname(run.captureDir)).toBe(CAPTURE_ROOT);
      expect(run.files.paths().some((target) => target.includes(`${path.sep}suite-`))).toBe(false);
    });
  });

  describe('one file per attempt', () => {
    it('writes a capture for every attempt of a retried step', async () => {
      const run = await runFlow(flow('r2-retry-optin.flow.yml'), { responses: { createThing: CREATED } });

      expect(run.layout()).toEqual([
        'create/attempt-1.json',
        'create/attempt-2.json',
        'create/attempt-3.json',
        'flow.json',
        'flow.yml',
        'inputs.json',
        'run.json',
        'summary.json'
      ]);
    });

    it('gives each attempt its own request, response, assertions and validation', async () => {
      const run = await runFlow(flow('r2-retry-optin.flow.yml'), { responses: { createThing: CREATED } });
      const second = run.files.json(path.join(run.captureDir, 'create/attempt-2.json'));

      expect(second).toMatchObject({
        stepId: 'create',
        iteration: 0,
        attempt: 2,
        request: {
          method: 'POST',
          url: 'https://regress.example.com/things',
          body: { kind: 'text', contentType: 'application/json', text: '{"name":"widget"}' }
        },
        response: { status: 201, responseTimeMs: 1 }
      });
      // The fixture asserts `res.status eq 200` against a 201, so every attempt carries the same
      // failure — an attempt file that omitted it would be a call with no verdict (002 §11.2).
      expect(second.assertions).toEqual([
        { expr: 'res.status eq 200', passed: false, expected: 200, actual: 201 }
      ]);
    });

    it('emits one step:attempt per attempt, not one per step', async () => {
      const attempts = [];
      await runFlow(flow('r2-retry-optin.flow.yml'), {
        responses: { createThing: CREATED },
        onEvent: (event) => {
          if (event.type === 'step:attempt') attempts.push(event.attempt);
        }
      });

      expect(attempts).toEqual([1, 2, 3]);
    });
  });

  it('writes no directory for a skipped step or a uses: container', async () => {
    const run = await runFlow(flow('r4-subflow-slot.flow.yml'), {
      responses: { createThing: CREATED }
    });

    // `child` is the container and dispatches nothing; `child/use` is the internal step that does.
    expect(run.layout()).toEqual([
      'child__use/attempt-1.json',
      'create/attempt-1.json',
      'flow.json',
      'flow.yml',
      'inputs.json',
      'run.json',
      'summary.json'
    ]);
  });

  it('nests per iteration only when the flow has a dataset', async () => {
    const run = await runFlow(flow('r4-dataset-slots.flow.yml'), {
      responses: { createThing: CREATED, getThing: THING }
    });

    expect(run.layout()).toEqual([
      'flow.json',
      'flow.yml',
      'inputs.json',
      'iteration-0/consume/attempt-1.json',
      'iteration-0/create/attempt-1.json',
      'iteration-1/consume/attempt-1.json',
      'iteration-1/create/attempt-1.json',
      'iteration-2/consume/attempt-1.json',
      'iteration-2/create/attempt-1.json',
      'run.json',
      'summary.json'
    ]);
  });

  it('writes nothing at all under --no-capture, and reports the same run', async () => {
    const responses = { createThing: CREATED, getState: STATE };
    const captured = await runFlow(flow('r4b-condition-false.flow.yml'), { responses });
    const bare = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses,
      overrides: { capture: { enabled: false } }
    });

    expect(bare.files.paths()).toEqual([]);
    expect(bare.captureDir).toBeUndefined();
    expect(bare.table()).toEqual(captured.table());
  });

  it('relocates the whole layout under --capture-dir', async () => {
    const elsewhere = path.join(FIXTURES, 'artifacts');
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE },
      overrides: { capture: { dir: elsewhere } }
    });

    expect(run.captureDir.startsWith(`${elsewhere}${path.sep}`)).toBe(true);
    expect(run.layout()).toEqual(['create/attempt-1.json', 'flow.json', 'flow.yml', 'inputs.json', 'run.json', 'summary.json']);
    // The .gitignore entry names the default location, so relocating the output does not earn one.
    expect(run.files.has(path.join(FIXTURES, '.gitignore'))).toBe(false);
  });

  describe('bodies', () => {
    // The upload fixtures live in the overlay rather than on disk, exactly as R4e supplies them.
    const at = (name) => path.join(FLOWS, 'regressions', 'fixtures', name);
    const uploads = {
      [at('scan.pdf')]: Buffer.from('%PDF-1.4 scan'),
      [at('invoice.pdf')]: Buffer.from('%PDF-1.4 invoice'),
      [at('a.pdf')]: Buffer.from('%PDF a'),
      [at('b.pdf')]: Buffer.from('%PDF b')
    };

    it('captures an uploaded file by reference, never by content', async () => {
      const run = await runFlow(flow('r4e-binary.flow.yml'), {
        responses: { uploadScan: { status: 201 } },
        files: uploads
      });
      const capture = run.files.json(path.join(run.captureDir, 'scan/attempt-1.json'));

      // The source as the flow wrote it, not an absolute path: `run.json` names the flow, so the
      // reference resolves, and a capture that hard-coded one machine's layout would not.
      expect(capture.request.body).toEqual({
        kind: 'upload',
        sourcePath: './fixtures/scan.pdf',
        filename: 'scan.pdf',
        contentType: 'application/pdf',
        byteLength: 13
      });
      expect(run.layout()).toEqual(['flow.json', 'flow.yml', 'inputs.json', 'run.json', 'scan/attempt-1.json', 'summary.json']);
    });

    it('captures each multipart part, with the file parts by reference', async () => {
      const run = await runFlow(flow('r4e-multipart.flow.yml'), {
        responses: { uploadInvoice: { status: 201 } },
        files: uploads
      });
      const capture = run.files.json(path.join(run.captureDir, 'upload/attempt-1.json'));

      expect(capture.request.body.kind).toBe('multipart');
      expect(capture.request.body.parts).toContainEqual({
        name: 'description',
        kind: 'field',
        value: 'Q3 invoice'
      });
      expect(capture.request.body.parts).toContainEqual(
        expect.objectContaining({ name: 'document', kind: 'file', filename: 'invoice.pdf', byteLength: 16 })
      );
      expect(JSON.stringify(capture)).not.toContain('bytes');
    });

    it('writes a binary response body out as a sibling and never inlines it', async () => {
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
      const capture = run.files.json(path.join(run.captureDir, 'consume/attempt-1.json'));

      expect(capture.response.body).toEqual({
        kind: 'binary',
        contentType: 'application/pdf',
        byteLength: 15,
        file: 'attempt-1.response.pdf'
      });
      expect(run.files.read(path.join(run.captureDir, 'consume/attempt-1.response.pdf')).toString('utf8'))
        .toBe('%PDF-1.4 report');
    });
  });
});

describe('R4n — redaction reaches the capture directory', () => {
  const run = () =>
    runFlow(flow('r4n-redaction.flow.yml'), {
      responses: {
        createThing: {
          ...CREATED,
          headers: {
            'content-type': 'application/json',
            'set-cookie': ['session=abc; HttpOnly', 'trace=def'],
            'x-trace-id': 'trace-1'
          }
        }
      }
    });

  const captureOf = async () => {
    const finished = await run();
    return finished.files.json(path.join(finished.captureDir, 'create/attempt-1.json'));
  };

  it('masks a credential written straight into the flow file', async () => {
    expect((await captureOf()).request.headers.Authorization).toBe('••••');
  });

  it('masks config.redactHeaders alongside the built-in denylist', async () => {
    expect((await captureOf()).request.headers['X-Legacy-Key']).toBe('••••');
  });

  it('masks every value of a repeated response header', async () => {
    expect((await captureOf()).response.headers['set-cookie']).toEqual(['••••', '••••']);
  });

  it('leaves a header that is not on the list alone', async () => {
    const capture = await captureOf();

    expect(capture.request.headers['X-Trace-Id']).toBe('trace-1');
    expect(capture.response.headers['x-trace-id']).toBe('trace-1');
  });

  // A host that reports a request on a surface of its own — 002 §8.5's network log — masks the
  // same set the capture does only if it is told the run's policy rather than guessing it.
  it('hands the run policy to the dispatch port', async () => {
    const finished = await run();

    expect(finished.callsFor('createThing')[0].redactHeaders).toEqual(['X-Legacy-Key']);
  });

  /**
   * §13.2 leaves auth, content type and cookies to the host, so the headers it reports having
   * written are the request that was actually sent — and §14.4 masks them on the same terms as any
   * other, rather than treating host-added headers as exempt.
   */
  it('masks the headers the host reports writing, not only the declared ones', async () => {
    const finished = await runFlow(flow('r4n-redaction.flow.yml'), {
      responses: {
        createThing: {
          ...CREATED,
          requestHeaders: {
            'Authorization': 'Bearer minted_by_the_host',
            'Content-Type': 'application/json',
            'X-Trace-Id': 'trace-1'
          }
        }
      }
    });
    const capture = finished.files.json(path.join(finished.captureDir, 'create/attempt-1.json'));

    expect(capture.request.headers.Authorization).toBe('••••');
    expect(capture.request.headers['Content-Type']).toBe('application/json');
    expect(capture.request.headers['X-Trace-Id']).toBe('trace-1');
    // The declared-only set is replaced, not merged into: what went out is the whole record.
    expect(capture.request.headers['X-Legacy-Key']).toBeUndefined();
  });

  it('does not preserve the secret\'s length', async () => {
    const capture = await captureOf();

    expect(capture.request.headers.Authorization).toHaveLength(4);
    expect(JSON.stringify(capture)).not.toContain('sk_live');
  });
});

/**
 * §14.5's flow snapshot. A run directory names its flow by path, and the file the path names moves
 * on — so without this, reading a run back means painting its outcomes onto whatever the flow says
 * today. Written by the engine rather than by a host, so a `bru` run records what an app run does.
 */
describe('the flow as it was when the run started', () => {
  it('writes the graph and the text the run executed', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    const description = run.files.json(path.join(run.captureDir, 'flow.json'));
    expect(description.nodes.map((node) => node.id)).toEqual(
      run.result.iterations[0].steps.map((step) => step.id)
    );

    const source = run.files.read(path.join(run.captureDir, 'flow.yml')).toString('utf8');
    expect(source).toContain('steps:');
  });

  /** Same argument as `run.json`'s: a run that died before its first step still has to be readable. */
  it('has written it before the first step, not at the end', async () => {
    let midRun;
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: {
        createThing: CREATED,
        getThing: (request, ctx, info) => {
          midRun = info.files.paths().map((target) => path.basename(target));
          return THING;
        }
      }
    });

    expect(midRun).toEqual(expect.arrayContaining(['flow.json', 'flow.yml']));
    expect(run.files.has(path.join(run.captureDir, 'flow.json'))).toBe(true);
  });

  it('records the digest of that text in run.json', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    const { flowHash } = run.files.json(path.join(run.captureDir, 'run.json'));
    const source = run.files.read(path.join(run.captureDir, 'flow.yml')).toString('utf8');
    expect(flowHash).toBe(require('crypto').createHash('sha256').update(source).digest('hex'));
  });

  /**
   * Reported as well as written: a watcher drawing the *current* file would redraw the run it is
   * watching the moment someone edited that file, which 002 §4.3 makes a two-second operation.
   */
  it('reports the same graph on run:start', async () => {
    let started;
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE },
      onEvent: (event) => {
        if (event.type === 'run:start') started = event;
      }
    });

    expect(started.description).toEqual(run.files.json(path.join(run.captureDir, 'flow.json')));
  });

  /** A run that records nothing has nothing to report either, and the event says so by omission. */
  it('writes none of it under --no-capture, and reports none', async () => {
    let started;
    const bare = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE },
      overrides: { capture: { enabled: false } },
      onEvent: (event) => {
        if (event.type === 'run:start') started = event;
      }
    });

    expect(bare.files.paths().filter((target) => target.includes('.bruno-runs'))).toEqual([]);
    expect(started.description).toBeUndefined();
  });
});

/**
 * §14.5's two halves as a host takes them on its own: §14.8's report files default into the same
 * directory — under `--no-capture` too, where no run ever creates it — so the CLI resolves the path
 * and writes the ignore entry itself, through these rather than through a rule of its own.
 */
describe('the capture root, resolved without a run', () => {
  const {
    resolveCaptureRoot,
    resolveSuiteDirectory,
    ensureCaptureIgnored,
    RUN_DIRECTORY,
    SUITE_DIRECTORY
  } = require('../../src/capture');

  const IGNORE = path.join(FIXTURES, '.gitignore');

  /** The two ports `ensureCaptureIgnored` takes, over a map, so nothing here touches disk. */
  const memoryPorts = (seed = {}) => {
    const written = new Map(Object.entries(seed));
    return {
      written,
      ports: {
        readFile: async (target) => {
          if (!written.has(target)) throw new Error(`no such file: ${target}`);
          return Buffer.from(written.get(target));
        },
        writeFile: async (target, data) => {
          written.set(target, data.toString('utf8'));
        }
      }
    };
  };

  // §7.4's boundary: a flow inside a collection is owned by the collection, and its runs go there
  // rather than beside every other collection's in the workspace.
  it('sits under the collection root when there is one', () => {
    expect(resolveCaptureRoot({ workspaceRoot: '/w', collectionRoot: '/w/api' })).toBe(
      path.join('/w/api', '.bruno-runs')
    );
    expect(resolveCaptureRoot({ workspaceRoot: '/w' })).toBe(path.join('/w', '.bruno-runs'));
  });

  it('is whatever --capture-dir said, when it said anything', () => {
    expect(resolveCaptureRoot({ workspaceRoot: '/w', collectionRoot: '/w/api' }, '/tmp/runs')).toBe('/tmp/runs');
  });

  it('names a suite directory the way it names a run, prefixed', () => {
    const suite = resolveSuiteDirectory('/w/.bruno-runs', '2026-08-05T14:22:01.123Z', 'a3f9c1d2');

    expect(suite).toBe(path.join('/w/.bruno-runs', 'suite-2026-08-05T14-22-01Z-a3f9'));
  });

  /**
   * The prefix is load-bearing, not decoration: a suite directory shares the capture root with the
   * runs, so a name that matched `RUN_DIRECTORY` would be listed by `listRuns` as a run and deleted
   * by the engine's own pruning.
   */
  it('gives it a name no run directory can have', () => {
    const name = path.basename(resolveSuiteDirectory('/w/.bruno-runs', '2026-08-05T14:22:01.123Z', 'a3f9c1d2'));

    expect(SUITE_DIRECTORY.test(name)).toBe(true);
    expect(RUN_DIRECTORY.test(name)).toBe(false);
    // And the other way round, so the two patterns are disjoint rather than merely unequal here.
    expect(SUITE_DIRECTORY.test('2026-08-05T14-22-01Z-a3f9')).toBe(false);
    expect(RUN_DIRECTORY.test('2026-08-05T14-22-01Z-a3f9')).toBe(true);
  });

  it('writes the ignore entry where there is no .gitignore yet', async () => {
    const { written, ports } = memoryPorts();
    await ensureCaptureIgnored({ scope: { workspaceRoot: FIXTURES }, ports });

    expect(written.get(IGNORE)).toBe('.bruno-runs/\n');
  });

  it('adds it to an existing .gitignore on a line of its own', async () => {
    const { written, ports } = memoryPorts({ [IGNORE]: 'node_modules' });
    await ensureCaptureIgnored({ scope: { workspaceRoot: FIXTURES }, ports });

    expect(written.get(IGNORE)).toBe('node_modules\n.bruno-runs/\n');
  });

  // An author who deleted the line meant to, and a second run is not the moment to argue.
  it('leaves an entry that is already there alone, in either spelling', async () => {
    for (const existing of ['.bruno-runs/\n', '.bruno-runs\n']) {
      const { written, ports } = memoryPorts({ [IGNORE]: existing });
      await ensureCaptureIgnored({ scope: { workspaceRoot: FIXTURES }, ports });

      expect(written.get(IGNORE)).toBe(existing);
    }
  });

  // The entry names the default location, so relocating the output does not earn one.
  it('writes nothing when the output was relocated', async () => {
    const { written, ports } = memoryPorts();
    await ensureCaptureIgnored({ scope: { workspaceRoot: FIXTURES }, dir: '/tmp/runs', ports });

    expect(written.size).toBe(0);
  });
});
