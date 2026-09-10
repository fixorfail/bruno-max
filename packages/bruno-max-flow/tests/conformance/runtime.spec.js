/**
 * Runtime semantics the engine promised and did not keep (001-C §7, R9.x).
 *
 * Each row here is a rule 001 states in one sentence and the engine answered differently: a slot
 * resolved by whichever branch the network returned first, a documented `ctx.env` that threw, a
 * reserved `req.*` root nothing could address, a preview cap that was read and dropped, a cleanup
 * window no host could see, and a run with no duration of its own. The fixtures live under
 * `fixtures/flows/regressions/`, beside §7's.
 */
const path = require('path');

const { interpolate } = require('@usebruno/common');

const { runFlow, variant, FLOWS } = require('./harness');

const flow = (name) => `regressions/${name}`;

const STATE = { status: 200, body: { data: { state: 'settled', role: 'admin', count: 0, active: true } } };

/** A promise a stub can hold a response on until something else in the run has happened. */
const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

describe('R9.1 — a slot written by two branches resolves by declaration order', () => {
  /**
   * Both writers run and both write; `hold` names the one whose response is withheld until the
   * other's `step:end` has been emitted, so it is the writer that *finishes* last. A completion-
   * order implementation gives the slot to whichever one that is.
   */
  const raced = async (hold) => {
    const other = hold === 'writer_first' ? 'writer_second' : 'writer_first';
    const { open, opened } = gate();
    const responses = {
      getState: STATE,
      getThing: async (request, ctx) => {
        if (ctx.stepId === 'writer_first' && hold === 'writer_first') await opened;
        return { status: 200, body: { data: { id: ctx.stepId === 'writer_first' ? 'from-first' : 'read-back' } } };
      },
      createThing: async () => {
        if (hold === 'writer_second') await opened;
        return { status: 201, body: { data: { id: 'from-second' } } };
      }
    };
    const run = await runFlow(flow('r9-slot-declaration-order.flow.yml'), {
      responses,
      onEvent: (event) => {
        if (event.type === 'step:end' && event.id === other) open();
      }
    });
    return run;
  };

  it('gives the slot to the writer declared last, even when the writer declared first finishes last', async () => {
    const run = await raced('writer_first');

    // The scenario did what it claims: the first-declared writer settled after the second.
    expect(run.call('getThing', 1).stepId).toBe('writer_first');
    expect(run.call('getThing', 1).settledAt).toBeGreaterThan(run.call('createThing').settledAt);

    expect(run.step('writer_first').outputs).toEqual({ thingId: 'from-first' });
    expect(run.step('writer_second').outputs).toEqual({ thingId: 'from-second' });
    expect(run.call('getThing', 2).url).toBe('https://regress.example.com/things/from-second');
    expect(run.status).toBe('passed');
  });

  /** File order is the rule precisely so a loaded CI machine and a laptop agree. */
  it('gives the slot to the same writer under the opposite schedule', async () => {
    const run = await raced('writer_second');

    expect(run.call('createThing').settledAt).toBeGreaterThan(run.call('getThing', 1).settledAt);
    expect(run.call('getThing', 2).url).toBe('https://regress.example.com/things/from-second');
  });
});

describe('R9.2 — what a script\'s ctx carries', () => {
  const responses = { createThing: { status: 201, body: { data: { id: 'thing-1' } } } };
  const vars = { signingSecret: 'sekrit' };

  it('names the environment as ctx.env and the flow\'s vars as ctx.vars, in every script position', async () => {
    const run = await runFlow(flow('r9-script-context.flow.yml'), { responses, vars });

    // `when:` read both and let the step run; `shouldRetry` read both and asked for no retry.
    expect(run.outcome('sign')).toBe('success');
    expect(run.step('sign').attempts).toBe(1);
    expect(run.step('sign').outputs).toEqual({
      fromEnv: 'sekrit',
      fromVars: 'n-1',
      flat: 'sekrit:n-1',
      disjoint: true,
      afterResponse: 'sekrit:n-1:thing-1'
    });
  });

  /** The guide's flat form is not replaced — the named halves are additive. */
  it('keeps the flat form the guide teaches', async () => {
    const run = await runFlow(flow('r9-script-context.flow.yml'), { responses, vars });

    expect(run.call('createThing').json).toEqual({ name: 'n-1' });
    expect(run.step('sign').outputs.flat).toBe('sekrit:n-1');
  });

  /**
   * The set, pinned: §7.3's namespaces and `env` / `vars` beside the flat variables; `req` and
   * `res` in an output script, which runs once a request has gone out (§10.2); and for `shouldRetry`
   * (§11.1) `failures` and `outputs`, the two things belonging to the attempt being judged — with no
   * `req` or `res`, since the response is that script's own first argument. A key added to a
   * script's context is a change to what every script can see, so it is a spec change first.
   */
  it('carries exactly the namespaces, env and vars — plus req and res, or an attempt\'s own two, where each applies', async () => {
    const run = await runFlow(flow('r9-script-context-keys.flow.yml'), { responses, vars });
    const reservedIn = (context) =>
      Object.keys(context).filter((key) => !(key in context.env) && !(key in context.vars)).sort();
    const contextOf = (marker, position) => reservedIn(run.scripts.find((script) => script.source.includes(marker)).args[position]);
    const BEFORE = ['env', 'flow', 'params', 'pre', 'process', 'row', 'shared', 'steps', 'vars'];

    expect(run.outcome('probe')).toBe('success');
    expect(contextOf('ctx.vars.nonce === \'n-1\'', 0)).toEqual(BEFORE);
    expect([...run.step('probe').outputs.keys].sort()).toEqual(BEFORE);
    expect([...run.step('probe').outputs.keysAfter].sort()).toEqual([...BEFORE, 'req', 'res'].sort());
    expect(contextOf('(res, attempt, ctx) => false', 2)).toEqual([...BEFORE, 'failures', 'outputs'].sort());
  });
});

describe('R9.3 — an assertion addresses the request as sent', () => {
  const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };

  /**
   * Header names are lower-cased, as `steps.<id>.headers` are (§8.3): the step writes `X-Trace` and
   * the assertion reads `x-trace`, so one spelling addresses a header whichever side wrote it.
   */
  it('resolves req.method, req.url, req.headers (lower-cased) and req.body', async () => {
    const run = await runFlow(flow('r9-request-assertions.flow.yml'), { responses: { createThing: CREATED } });

    expect(run.outcome('create')).toBe('success');
    expect(run.step('create').assertions.map((assertion) => [assertion.expr, assertion.passed])).toEqual([
      ['req.method eq POST', true],
      ['req.url eq https://regress.example.com/things', true],
      ['req.headers[\'x-trace\'] eq t-1', true],
      ['req.headers[\'X-Trace\'] isUndefined', true],
      ['req.body.name eq widget', true]
    ]);
  });

  /**
   * §13.2's `requestHeaders` — what the host actually wrote — wins over the declared set, for the
   * reason the capture prefers it: the auth header and the content type are the host's to add, and
   * an assertion that could not see them would be checking a request that was never sent. Lower-
   * cased on the same terms: the host spelled `Authorization`, and the assertion need not know.
   */
  it('reads the headers the host reports having sent, where it reports them', async () => {
    const { entry, files } = variant(flow('r9-request-assertions.flow.yml'), (document) => {
      document.steps[0].assert = ['req.headers.authorization eq Bearer tok-1', 'req.headers[\'x-trace\'] eq t-1'];
    });
    const run = await runFlow(entry, {
      files,
      responses: {
        createThing: { ...CREATED, requestHeaders: { 'X-Trace': 't-1', 'Authorization': 'Bearer tok-1', 'Content-Type': 'application/json' } }
      }
    });

    expect(run.outcome('create')).toBe('success');
  });

  /** A reference the request cannot satisfy is a failed assertion that says so, not a crashed run. */
  it('fails an assertion on a header that was not sent, naming the actual', async () => {
    const { entry, files } = variant(flow('r9-request-assertions.flow.yml'), (document) => {
      document.steps[0].assert = ['req.headers.authorization isDefined'];
    });
    const run = await runFlow(entry, { files, responses: { createThing: CREATED } });

    expect(run.outcome('create')).toBe('failed:assertion-failed');
    expect(run.step('create').assertions).toEqual([
      { expr: 'req.headers.authorization isDefined', passed: false, expected: undefined, actual: undefined }
    ]);
  });
});

describe('R9.4 — a step:end carries a capped, masked preview', () => {
  const LONG_NAME = 'é'.repeat(300);
  const responses = {
    signIn: {
      status: 200,
      body: { data: { token: 'tok-1' } },
      requestHeaders: { 'content-type': 'application/json', 'authorization': 'Bearer seed' }
    },
    getThing: (request, ctx) =>
      ctx.stepId === 'scan'
        ? { status: 200, headers: { 'content-type': 'application/pdf' }, bytes: Buffer.from('%PDF-1.4'), body: null }
        : { status: 200, body: { data: { id: 'thing-1', name: LONG_NAME } } },
    getState: STATE
  };

  const previews = async () => {
    const run = await runFlow(flow('r9-preview.flow.yml'), { responses, secrets: ['hunter2'] });
    const ended = Object.fromEntries(
      run.events.filter((event) => event.type === 'step:end').map((event) => [event.id, event.preview])
    );
    return { run, ended };
  };

  it('previews the request as sent — request line, the headers the host wrote, and the body', async () => {
    const { ended } = await previews();

    expect(ended.sign_in.request).toMatch(/^POST https:\/\/regress\.example\.com\/sessions\n/);
    expect(ended.sign_in.request).toContain('content-type: application/json');
    expect(ended.sign_in.response).toBe('{"data":{"token":"tok-1"}}');
  });

  /** §14.4 applies on the same terms as the capture: the denylist and the run's secret values. */
  it('masks the request before it leaves the run', async () => {
    const { ended, run } = await previews();

    expect(ended.sign_in.request).toContain('authorization: ••••');
    expect(ended.sign_in.request).not.toContain('hunter2');
    expect(JSON.stringify(run.events)).not.toContain('hunter2');
  });

  it('cuts at config.capturePreviewBytes, measured in bytes, without a torn character', async () => {
    const { ended, run } = await previews();

    expect(Buffer.byteLength(ended.fetch.response, 'utf8')).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(ended.fetch.response, 'utf8')).toBeGreaterThan(200);
    expect(ended.fetch.response).not.toContain('�');
    expect(ended.fetch.response).toMatch(/^\{"data":\{"id":"thing-1","name":"é+$/);
    // The cap is the preview's alone: the attempt file keeps the whole body (§14.5, "storage is split").
    const capture = run.files.json(path.join(run.captureDir, 'fetch/attempt-1.json'));
    expect(capture.response.body.text).toBe(JSON.stringify({ data: { id: 'thing-1', name: LONG_NAME } }));
    expect(capture.response).not.toHaveProperty('preview');
    expect(capture.response).not.toHaveProperty('truncated');
  });

  it('never previews a binary response, and previews nothing for a step that sent nothing', async () => {
    const { ended } = await previews();

    expect(ended.scan).toEqual({ request: expect.stringMatching(/^GET https:\/\/regress\.example\.com\/things\/scan/) });
    expect(ended.never).toBeUndefined();
  });

  /** The default is §14.5's 8 KB when the flow sets no cap. */
  it('defaults to 8192 bytes', async () => {
    const { entry, files } = variant(flow('r9-preview.flow.yml'), (document) => {
      delete document.config.capturePreviewBytes;
    });
    const big = { status: 200, body: { data: { id: 'thing-1', name: 'x'.repeat(10000) } } };
    const run = await runFlow(entry, { files, responses: { ...responses, getThing: big }, secrets: ['hunter2'] });
    const fetched = run.events.find((event) => event.type === 'step:end' && event.id === 'fetch');

    expect(Buffer.byteLength(fetched.preview.response, 'utf8')).toBe(8192);
  });
});

describe('R9.5 — a stopped run announces its cleanup window', () => {
  const responses = {
    createThing: { status: 201, body: { data: { id: 'thing-1' } } },
    getThing: (request, ctx, info) => ({
      status: 200,
      body: { data: { id: 'thing-1', name: info.call >= 5 ? 'ready' : 'pending' } }
    }),
    getState: STATE
  };

  const cleanupEvents = (run) => run.events.filter((event) => event.type === 'run:cleanup');

  it('emits run:cleanup once, after run:start and before the first cleanup step starts', async () => {
    const run = await runFlow(flow('r4g-run-budget.flow.yml'), { responses });
    const types = run.events.map((event) => event.type);
    const announced = types.indexOf('run:cleanup');

    expect(cleanupEvents(run)).toHaveLength(1);
    expect(announced).toBeGreaterThan(types.indexOf('run:start'));
    expect(announced).toBeLessThan(run.events.findIndex((event) => event.type === 'step:start' && event.id === 'cleanup'));
    expect(types[types.length - 1]).toBe('run:end');
    expect(run.outcome('cleanup')).toBe('success');
  });

  /** The deadline is the one the engine enforces: when the run stopped, plus `config.cleanupGrace`. */
  it('names the deadline the cleanup window closes at, on the run\'s clock', async () => {
    const run = await runFlow(flow('r4g-run-budget.flow.yml'), { responses });

    // Two 1000ms delays spend the 2000ms budget; the window opens at 2000 and closes 30000 later.
    expect(run.sleeps).toEqual([1000, 1000]);
    expect(cleanupEvents(run)).toEqual([{ type: 'run:cleanup', runId: run.result.runId, deadline: 32000 }]);
  });

  /** §11.3: the signal and the budget take the identical path, this event included. */
  it('announces the window for a signal the same way as for the budget', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });
    const run = await runFlow(entry, {
      files,
      responses: {
        ...responses,
        getThing: (request, ctx, info) => {
          if (info.call === 3) info.abort();
          return { status: 200, body: { data: { id: 'thing-1', name: 'pending' } } };
        }
      }
    });
    const types = run.events.map((event) => event.type);

    expect(run.status).toBe('cancelled');
    expect(cleanupEvents(run)).toEqual([{ type: 'run:cleanup', runId: run.result.runId, deadline: 2000 + 30000 }]);
    expect(types.indexOf('run:cleanup')).toBeLessThan(
      run.events.findIndex((event) => event.type === 'step:start' && event.id === 'cleanup')
    );
    expect(run.outcome('cleanup')).toBe('success');
  });

  it('is silent on a run that was never stopped', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });
    const run = await runFlow(entry, { files, responses });

    expect(run.status).toBe('passed');
    expect(cleanupEvents(run)).toEqual([]);
  });

  /**
   * The window is a state a host shows (002 §7.1), and a run with no step eligible for it has none
   * to show: the stop goes straight to `run:end`, rather than announcing a window nothing will use.
   */
  it('is silent on a stopped run with no cleanup step, which goes straight to run:end', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      document.steps = document.steps.filter((step) => step.id !== 'cleanup');
    });
    const run = await runFlow(entry, { files, responses });
    const types = run.events.map((event) => event.type);

    expect(run.status).toBe('cancelled');
    expect(run.outcome('await_ready')).toBe('cancelled:run-cancelled');
    expect(run.outcome('follow_up')).toBe('skipped:run-cancelled');
    expect(cleanupEvents(run)).toEqual([]);
    expect(types[types.length - 1]).toBe('run:end');
  });

  /**
   * A cleanup step still to come from a sub-flow in flight is one the window is for: the entry
   * flow here declares none, and the fixture it invokes is the one whose `cleanup` step runs.
   */
  it('announces the window for a cleanup step inside a sub-flow that is still running', async () => {
    const entry = path.join(FLOWS, 'regressions', 'r9-cleanup-in-subflow.variant.flow.yml');
    const files = {
      [entry]: [
        'version: 1',
        'config:',
        '  maxRunDuration: 2000',
        'steps:',
        '  - id: inner',
        '    uses: ./r4g-run-budget.flow.yml',
        ''
      ].join('\n')
    };
    const run = await runFlow(entry, { files, responses });

    expect(run.status).toBe('cancelled');
    expect(run.outcome('inner/await_ready')).toBe('cancelled:run-cancelled');
    expect(run.outcome('inner/cleanup')).toBe('success');
    expect(cleanupEvents(run)).toEqual([{ type: 'run:cleanup', runId: run.result.runId, deadline: 32000 }]);
  });
});

describe('R9.6 — a run reports its own duration', () => {
  const responses = {
    createThing: { status: 201, body: { data: { id: 'thing-1' } } },
    getThing: (request, ctx, info) => ({
      status: 200,
      body: { data: { id: 'thing-1', name: info.call >= 5 ? 'ready' : 'pending' } }
    }),
    getState: STATE
  };

  it('measures run:start to run:end on the injected clock', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });
    const run = await runFlow(entry, { files, responses });

    // The harness clock advances only in `sleep`, so the four retry delays are the whole run.
    expect(run.sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(run.result.duration).toBe(4000);
    expect(run.events.find((event) => event.type === 'run:end').result.duration).toBe(4000);
  });

  /** §14.5's `summary.json` carries the outcome, which is `RunResult` — duration included. */
  it('writes it into summary.json', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });
    const run = await runFlow(entry, { files, responses });

    expect(run.files.json(path.join(run.captureDir, 'summary.json')).duration).toBe(4000);
  });

  it('covers the cleanup window of a cancelled run', async () => {
    const run = await runFlow(flow('r4g-run-budget.flow.yml'), { responses });

    expect(run.status).toBe('cancelled');
    expect(run.result.duration).toBe(2000);
  });
});

/**
 * A stub that holds its response for `delayMs` and answers the signal it was given: it refuses
 * outright when the request arrives already aborted, and rejects the way a host's transport does
 * when the abort lands while the response is still pending.
 *
 * The harness's own stubs ignore `ctx.signal` entirely, which is precisely why the two rules below
 * were invisible: every scenario asserting a cleanup step passed against a signal no one read.
 */
const answersTheSignal = (spec, delayMs) => (request, ctx) =>
  new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error('the request was aborted before it went out'));
      return;
    }
    const timer = setTimeout(() => resolve(spec), delayMs);
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('the request was aborted'));
      },
      { once: true }
    );
  });

describe('R9.7 — a cleanup step is dispatched with a live signal, bounded by the grace window', () => {
  const responses = {
    createThing: { status: 201, body: { data: { id: 'thing-1' } } },
    getState: STATE
  };

  /**
   * `await_ready` spends the whole 2000ms budget in retry delays, so `cleanup` — the one step whose
   * `depends` accepts `cancelled` — is scheduled entirely inside §11.3's grace window.
   */
  const cleanupRun = (holdFor, edit) => {
    const polled = { status: 200, body: { data: { id: 'thing-1', name: 'pending' } } };
    const cleaned = answersTheSignal({ status: 200, body: { data: { id: 'thing-1', name: 'released' } } }, holdFor);
    const getThing = (request, ctx, info) =>
      ctx.stepId === 'cleanup' ? cleaned(request, ctx, info) : polled;

    if (!edit) return runFlow(flow('r4g-run-budget.flow.yml'), { responses: { ...responses, getThing } });

    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), edit);
    return runFlow(entry, { files, responses: { ...responses, getThing } });
  };

  it('hands the cleanup step a signal that is not already aborted, so its request goes out', async () => {
    const run = await cleanupRun(5);

    expect(run.status).toBe('cancelled');
    expect(run.outcome('await_ready')).toBe('cancelled:run-cancelled');
    // The run's own signal is aborted throughout this step; a dispatch that inherited it could not
    // have reached a response at all.
    expect(run.outcome('cleanup')).toBe('success');
    expect(run.calls.map((call) => call.stepId)).toContain('cleanup');
  });

  it('aborts a cleanup request that outlives the grace window, at the deadline', async () => {
    const run = await cleanupRun(2000, (document) => {
      document.config.cleanupGrace = 20;
    });

    // The window is announced and enforced from one value: `stoppedAt` plus the grace.
    expect(run.events.filter((event) => event.type === 'run:cleanup')).toEqual([
      { type: 'run:cleanup', runId: run.result.runId, deadline: 2000 + 20 }
    ]);
    // Aborted rather than left to run out its 2000ms hold — and the abort belongs to the stop that
    // opened the window, so §14.6 calls it `cancelled` and not a transport failure.
    expect(run.outcome('cleanup')).toBe('cancelled:run-cancelled');
    expect(run.status).toBe('cancelled');
  });
});

describe('R9.8 — a request in flight when the run is cancelled is `cancelled`, not a transport error', () => {
  /**
   * `follow_up` aborts the run from inside its own dispatch and then waits on the signal it was
   * handed, which is §11.3's "in-flight requests are aborted" with nothing else happening at the
   * same time to explain the outcome.
   */
  const cancelledInFlight = () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });
    return runFlow(entry, {
      files,
      responses: {
        createThing: { status: 201, body: { data: { id: 'thing-1' } } },
        getThing: (request, ctx, info) => ({
          status: 200,
          body: { data: { id: 'thing-1', name: info.call >= 5 ? 'ready' : 'pending' } }
        }),
        getState: (request, ctx, info) =>
          new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('the request was aborted')), { once: true });
            info.abort();
          })
      }
    });
  };

  it('reports the step the cancel interrupted as cancelled · run-cancelled', async () => {
    const run = await cancelledInFlight();

    expect(run.outcome('follow_up')).toBe('cancelled:run-cancelled');
    expect(run.status).toBe('cancelled');
    expect(run.exitCode).toBe(4);
  });

  /** A step that ran to a verdict before the stop keeps it — the cancel renames nothing behind it. */
  it('leaves the steps that had already settled alone', async () => {
    const run = await cancelledInFlight();

    expect(run.outcome('create')).toBe('success');
    expect(run.outcome('await_ready')).toBe('success');
  });
});

describe('R9.9 — §10.1\'s request check reaches urlencoded and multipart bodies', () => {
  // A `count` of its own: the shared STATE reports 0, and the schema's `minimum: 1` is what makes
  // the seat count a value the check has an opinion about.
  const responses = {
    getState: { status: 200, body: { data: { state: 'settled', role: 'admin', count: 3, active: true } } },
    createSubscription: { status: 201 },
    createBundle: { status: 201 }
  };

  const formRun = (edit) => {
    if (!edit) return runFlow(flow('r9-form-bodies.flow.yml'), { responses });
    const { entry, files } = variant(flow('r9-form-bodies.flow.yml'), edit);
    return runFlow(entry, { files, responses });
  };

  it('dispatches a form body whose fields resolve to the types the schema declares', async () => {
    const run = await formRun();

    expect(run.outcome('subscribe')).toBe('success');
    expect(run.outcome('bundle')).toBe('success');
    // §7.5 flattens the form to strings for the wire; the check ran against the values instead,
    // which is the only reading under which a schema-typed integer can ever pass.
    expect(run.call('createSubscription').body).toEqual({
      kind: 'urlencoded',
      fields: [{ name: 'plan', value: 'pro' }, { name: 'seats', value: '3' }]
    });
  });

  it('fails a urlencoded step whose field breaks the schema, and sends nothing', async () => {
    const run = await formRun((document) => {
      document.steps[1].body.plan = 'enterprise';
    });

    expect(run.outcome('subscribe')).toBe('failed:invalid-request');
    expect(run.callsFor('createSubscription')).toHaveLength(0);
    expect(run.step('subscribe').message).toMatch(/plan/);
  });

  it('fails a multipart step whose non-binary part breaks the schema, and sends nothing', async () => {
    const run = await formRun((document) => {
      document.steps[2].body.name = 42;
    });

    expect(run.outcome('bundle')).toBe('failed:invalid-request');
    expect(run.callsFor('createBundle')).toHaveLength(0);
    expect(run.step('bundle').message).toMatch(/name/);
  });

  /** §10.1's carve-out: the file part is skipped, so a schema requiring it never reports it missing. */
  it('checks neither the binary part nor the request of a step that opted out', async () => {
    const run = await formRun((document) => {
      document.steps[1].body.plan = 'enterprise';
      document.steps[1].validateRequest = false;
    });

    expect(run.outcome('bundle')).toBe('success');
    expect(run.call('createBundle').body.parts.map((part) => part.name)).toEqual(['name', 'manifest']);
    expect(run.outcome('subscribe')).toBe('success');
    expect(run.call('createSubscription').body.fields).toContainEqual({ name: 'plan', value: 'enterprise' });
  });
});

describe('R9.10 — a host supplies the implicit collection profile', () => {
  const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };
  const responses = { createThing: CREATED, getThing: { status: 200, body: { data: { id: 'thing-1' } } }, getState: STATE };
  const collection = { fields: { mode: 'bearer', token: '{{collectionToken}}' } };

  it('resolves auth: collection — on a binding or a step — from RunOptions.authProfiles', async () => {
    const run = await runFlow(flow('r9-host-auth-profiles.flow.yml'), {
      responses,
      vars: { collectionToken: 'tok-collection' },
      authProfiles: { collection }
    });

    expect(run.status).toBe('passed');
    expect(run.call('createThing').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-collection' } });
    expect(run.call('getThing').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-collection' } });
    expect(run.call('getState').auth).toEqual({ mode: 'none' });
  });

  /** §14.4: a credential the host's profile resolves to is a secret the run learned, and is masked. */
  it('masks the credential the host profile resolved to', async () => {
    const run = await runFlow(flow('r9-host-auth-profiles.flow.yml'), {
      responses: { ...responses, createThing: { ...CREATED, body: { data: { id: 'thing-1', echo: 'tok-collection' } } } },
      vars: { collectionToken: 'tok-collection' },
      authProfiles: { collection }
    });

    expect(JSON.stringify(run.events)).not.toContain('tok-collection');
  });

  /** Resolved third: the flow's own `authProfiles:` entry of the same name wins over the host's. */
  it('lets a flow-declared collection profile win over the host\'s', async () => {
    const { entry, files } = variant(flow('r9-host-auth-profiles.flow.yml'), (document) => {
      document.authProfiles = { collection: { mode: 'basic', username: 'ops', password: 'hunter2' } };
    });
    const run = await runFlow(entry, { files, responses, authProfiles: { collection } });

    expect(run.status).toBe('passed');
    expect(run.call('createThing').auth).toEqual({ mode: 'basic', basic: { username: 'ops', password: 'hunter2' } });
  });

  /** And below what a caller declared: a sub-flow inherits the caller's profile before the host's. */
  it('resolves a caller\'s profile ahead of the host\'s inside a sub-flow', async () => {
    const entry = path.join(FLOWS, 'regressions', 'r9-host-auth-caller.variant.flow.yml');
    const files = {
      [entry]: [
        'version: 1',
        'authProfiles:',
        '  collection: { mode: bearer, token: tok-caller }',
        'steps:',
        '  - id: inner',
        '    uses: ./r9-host-auth-profiles.flow.yml',
        ''
      ].join('\n')
    };
    const run = await runFlow(entry, { files, responses, authProfiles: { collection } });

    expect(run.status).toBe('passed');
    expect(run.call('createThing').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-caller' } });
  });

  /** A workspace-scoped run supplies nothing, and a profile found nowhere is what it always was. */
  it('still fails unknown-auth-profile when no host profile is supplied', async () => {
    const run = await runFlow(flow('r9-host-auth-profiles.flow.yml'), { responses });

    expect(run.outcome('through_binding')).toBe('failed:invalid-request');
    expect(run.step('through_binding').message).toContain('no auth profile named collection');
    expect(run.callsFor('createThing')).toEqual([]);
  });

  /**
   * §6.4's third rank: the collection flow that "declares no `authProfiles` at all and
   * authenticates exactly as the collection does" names nothing anywhere, so nothing is what it
   * writes — and the collection's own auth is still what goes out.
   */
  const implicit = flow('r9-implicit-collection-auth.flow.yml');

  it('sends the host\'s collection profile from a step that names no auth at all', async () => {
    const run = await runFlow(implicit, {
      responses,
      vars: { collectionToken: 'tok-collection' },
      authProfiles: { collection }
    });

    expect(run.status).toBe('passed');
    expect(run.call('createThing').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-collection' } });
  });

  /** The opt-out, for the step that must not carry the collection's credentials. */
  it('lets auth: none opt a step out of the collection default', async () => {
    const run = await runFlow(implicit, {
      responses,
      vars: { collectionToken: 'tok-collection' },
      authProfiles: { collection }
    });

    expect(run.call('getState').auth).toEqual({ mode: 'none' });
  });

  /** Nothing named and nothing supplied — a workspace-scoped run — falls to the fourth rank. */
  it('sends none when nothing names a profile and the host supplied none', async () => {
    const run = await runFlow(implicit, { responses });

    expect(run.status).toBe('passed');
    expect(run.call('createThing').auth).toEqual({ mode: 'none' });
  });
});

describe('R9.11 — the dispatch port receives the scope the request was interpolated against', () => {
  const responses = { createThing: (request, ctx) => ({ status: 201, body: { data: { id: `id-${ctx.stepId}` } } }) };

  /** Snapshotted at dispatch: the namespaces are the run's live state, and `steps` grows afterwards. */
  const dispatched = async () => {
    const seen = {};
    const run = await runFlow(flow('r9-dispatch-variables.flow.yml'), {
      responses: {
        createThing: (request, ctx) => {
          seen[ctx.stepId] = structuredClone(ctx.variables);
          return responses.createThing(request, ctx);
        }
      }
    });
    return { run, seen };
  };

  it('carries the environment, the flow\'s vars and every namespace, as one map', async () => {
    const { run, seen } = await dispatched();

    expect(run.status).toBe('passed');
    expect(seen.second).toMatchObject({
      regressBaseUrl: 'https://regress.example.com',
      nonce: 'n-1',
      steps: { first: { thingId: 'id-first', ok: true } },
      pre: { stamp: 'stamp-n-1' },
      shared: { handle: 'id-first' },
      flow: { runId: run.result.runId, iteration: 0 },
      row: {},
      params: {}
    });
    expect(seen.second.process).toEqual({ env: {} });
    // `pre` is the step's own: the first step computed nothing.
    expect(seen.first.pre).toEqual({});
    expect(seen.first.steps).toEqual({});
  });

  /** The same map interpolation used: a host resolving its own value against it gets the request's answer. */
  it('resolves a host\'s own template exactly as the request body was resolved', async () => {
    const { run, seen } = await dispatched();
    const template = '{{nonce}}/{{steps.first.thingId}}/{{pre.stamp}}/{{shared.handle}}/{{flow.iteration}}';

    expect(interpolate(template, seen.second)).toBe('n-1/id-first/stamp-n-1/id-first/0');
    expect(run.call('createThing', 2).json).toEqual({ name: 'n-1/id-first/stamp-n-1/id-first/0' });
  });
});

describe('R9.12 — a uses: step announces how many steps its sub-flow runs', () => {
  const responses = {
    createThing: { status: 201, body: { data: { id: 'thing-1' } } },
    getThing: { status: 200, body: { data: { id: 'thing-1' } } },
    login: { status: 200, body: { data: { access_token: 'tok-1', user: { id: 'u-1' } } } }
  };

  const started = (run) => Object.fromEntries(run.events.filter((event) => event.type === 'step:start').map((event) => [event.id, event]));

  it('carries the sub-flow\'s own step count, a nested sub-flow counting as one', async () => {
    const run = await runFlow(flow('r9-subflow-step-count.flow.yml'), { responses });
    const events = started(run);

    expect(run.status).toBe('passed');
    expect(events.inner.steps).toBe(2);
    expect(events['inner/sign_in'].steps).toBe(1);
  });

  it('says nothing for an operation step', async () => {
    const run = await runFlow(flow('r9-subflow-step-count.flow.yml'), { responses });
    const events = started(run);

    expect(events.follow_up).toEqual({ type: 'step:start', id: 'follow_up', index: 0, operation: 'regress-api#getThing' });
    expect('steps' in events.follow_up).toBe(false);
    expect('steps' in events['inner/make']).toBe(false);
  });
});
