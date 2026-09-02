/**
 * Regressions not owned by a single flow (001-C §7).
 *
 * Each is a minimal flow rather than a scenario, because the defect it guards is invisible in a
 * flow that works. The fixtures live under `fixtures/flows/regressions/`.
 *
 * Three of §7's rows are not engine tests and are not here: R4l pins properties of the CLI's
 * console output, R4m pins the §5.4 document schema, and R4i pins how `bru flow run` orders a
 * multi-flow selection — all of which belong to the CLI's own suite. R6 covers the exit codes an
 * engine outcome determines; `2` and `3` are the CLI's mapping of a diagnostic and a usage error.
 */
const path = require('path');

const { runFlow, validate, variant, FLOWS } = require('./harness');
const { withLibrary } = require('../../src/functions');

const flow = (name) => `regressions/${name}`;

const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };
const STATE = {
  status: 200,
  body: { data: { state: 'settled', role: 'admin', count: 0, active: true } }
};

describe('R1 — a dead service does not report green', () => {
  // Before `failOnStatusCode` this flow exited 0: the 500 passed as `success` because no schema
  // was declared for it, the missing output skipped the consumer, and nothing was recorded as a
  // failure. The step-level reason, not the exit code, is what carries the check — the flow
  // disables the downstream guard so this one is tested alone.
  it('fails the step that received the 500', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: {
        createThing: { status: 500, body: { error: { message: 'upstream unavailable' } } },
        getThing: { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } }
      }
    });

    expect(run.outcome('create')).toBe('failed:unexpected-status');
    expect(run.step('create').message).toContain('500');
    expect(run.exitCode).toBe(1);
  });
});

describe('R2 — retry does not amplify a non-idempotent failure', () => {
  const responses = { createThing: CREATED };

  it('does not retry a failed assertion by default', async () => {
    const run = await runFlow(flow('r2-retry-default.flow.yml'), { responses });

    expect(run.callsFor('createThing')).toHaveLength(1);
    expect(run.step('create').attempts).toBe(1);
    expect(run.outcome('create')).toBe('failed:assertion-failed');
  });

  it('retries when a predicate asks for it', async () => {
    const run = await runFlow(flow('r2-retry-optin.flow.yml'), { responses });

    expect(run.callsFor('createThing')).toHaveLength(3);
    expect(run.step('create').attempts).toBe(3);
  });
});

/**
 * §8.2's third script position. `shouldRetry` is the one script that runs against a response that
 * may not exist — §11.2 hands it `undefined` after a transport error — and it ran outside every
 * try/catch: a predicate reaching into a body that was not there took the whole run down, in the one
 * place a host cannot attach the failure to anything.
 */
describe('R2 — a shouldRetry that throws fails the step, not the run', () => {
  const throwing = (document) => {
    document.steps[0].retry.shouldRetry = '(res) => res.body.data.task.status === "PENDING"';
    document.steps[0].assert = [];
  };

  it('reports the step as a script error, naming what threw', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), throwing);
    const run = await runFlow(entry, { files, responses: { createThing: CREATED } });

    expect(run.outcome('create')).toBe('failed:script-error');
    expect(run.step('create').message).toMatch(/shouldRetry threw/);
  });

  /** The run reaches its own end: a poll whose predicate is wrong is one bad step, not a dead run. */
  it('still finishes the run', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), throwing);
    const run = await runFlow(entry, { files, responses: { createThing: CREATED } });

    expect(run.status).toBe('failed');
    expect(run.events.at(-1).type).toBe('run:end');
  });

  /** It fires once. A predicate that throws on every attempt must not be retried into a loop. */
  it('stops retrying rather than asking again', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), throwing);
    const run = await runFlow(entry, { files, responses: { createThing: CREATED } });

    expect(run.callsFor('createThing')).toHaveLength(1);
  });

  /**
   * §14.6's order: the first check to fail names the step. A predicate that throws after the attempt
   * had already failed explains nothing new about it.
   */
  it('leaves an earlier failure named as it was', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), (document) => {
      document.steps[0].retry.shouldRetry = '(res) => res.body.data.task.status === "PENDING"';
    });
    const run = await runFlow(entry, { files, responses: { createThing: { status: 500, body: {} } } });

    expect(run.outcome('create')).toBe('failed:unexpected-status');
  });
});

/**
 * §11.3: an interrupted run stops polling. A step that kept its schedule would go on sending
 * requests after the run was declared over — and, from the app, after a cancel that appeared to do
 * nothing for as long as the delay lasted.
 */
describe('R2 — a cancelled run stops a poll where it stands', () => {
  it('sends nothing more once the run is stopped', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), (document) => {
      document.steps[0].retry.maxAttempts = 6;
      document.steps[0].assert = [];
    });

    const run = await runFlow(entry, {
      files,
      responses: {
        createThing: (request, ctx, info) => {
          if (info.call === 2) info.abort();
          return CREATED;
        }
      }
    });

    expect(run.callsFor('createThing')).toHaveLength(2);
    expect(run.status).toBe('cancelled');
  });
});

describe('R3 — a negative test without the opt-out fails', () => {
  const forbidden = { createThing: { status: 403, body: { error: { message: 'denied' } } } };

  it('fails on the expected status when the step did not allow it', async () => {
    const run = await runFlow(flow('r3-negative-no-optout.flow.yml'), { responses: forbidden });

    expect(run.outcome('denied')).toBe('failed:unexpected-status');
    expect(run.exitCode).toBe(1);
  });

  it('warns when the opt-out carries no status assertion', async () => {
    const diagnostics = await validate(flow('r3-optout-no-assertion.flow.yml'));

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', stepId: 'denied' })
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});

describe('R4 — slot and output resolution boundaries', () => {
  it('rejects a slot read by a step that is not downstream of every writer', async () => {
    const diagnostics = await validate(flow('r4-slot-nondescendant.flow.yml'));

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', stepId: 'sibling' })
    );
  });

  // The next two rows are the pair that must not collapse into each other: an unwritten slot is
  // empty, an unproduced output skips. An implementation that unifies them breaks either cleanup
  // or the fallback join.
  it('resolves a declared but unwritten slot to empty, and runs the step', async () => {
    const run = await runFlow(flow('r4-slot-unwritten.flow.yml'), {
      responses: { createThing: CREATED }
    });

    expect(run.outcome('create')).toBe('success');
    expect(run.call('createThing').json.ref).toBe('');
  });

  it('skips a step referencing an output that was never produced', async () => {
    const run = await runFlow(flow('r4-output-unproduced.flow.yml'), {
      responses: { createThing: { status: 201, body: { data: {} } } }
    });

    expect(run.outcome('create')).toBe('success');
    expect(run.outcome('consume')).toBe('skipped:unresolved-dependency');
    expect(run.callsFor('getThing')).toHaveLength(0);
  });

  /**
   * §14.6: the reason names the rule and the message names the occurrence. Which reference went
   * unproduced is known only at materialization, and it is the whole of what the author has to fix —
   * a run reporting `unresolved-dependency` and nothing else sends them reading the file for it.
   */
  it('names the unproduced reference', async () => {
    const run = await runFlow(flow('r4-output-unproduced.flow.yml'), {
      responses: { createThing: { status: 201, body: { data: {} } } }
    });

    expect(run.step('consume').message).toContain('steps.create.thingId');
  });

  it('does not make a caller\'s slot visible inside a sub-flow', async () => {
    const diagnostics = await validate(flow('r4-subflow-slot.flow.yml'));

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).not.toHaveLength(0);
  });

  // §9.4: concurrent iterations run the same writers against different rows, so a single run-wide
  // set of slots would have the last row to finish decide every iteration's value.
  it('gives each concurrent iteration its own slots', async () => {
    const run = await runFlow(flow('r4-dataset-slots.flow.yml'), {
      responses: {
        createThing: (request) => ({ status: 201, body: { data: { id: `thing-${request.body.value.name}` } } }),
        getThing: { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } }
      }
    });

    const reads = run.callsFor('getThing');
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      const name = run.iterations[read.iteration].row.name;
      expect(read.url).toBe(`https://regress.example.com/things/thing-${name}`);
    }
  });
});

/**
 * §12.5's declared params, when a *host* runs a library flow directly rather than a `uses:` step
 * invoking it. The defaults were applied on the sub-flow path only, so the app's run configuration
 * with its inputs left empty — and `bru flow run` with no `--param` — put `{{params.x}}` on the wire
 * verbatim: `params` is a reserved root, so an unproduced one is not a `steps.*` miss and nothing
 * skips the step or reports it (§11.2).
 */
describe('R4 — a library flow run directly gets its declared defaults', () => {
  const responses = { login: { status: 200, body: { data: { access_token: 'tok', user: { id: 'u-1' } } } } };

  it('fills a param the caller left out from its default', async () => {
    const run = await runFlow('f2-login.flow.yml', { responses, params: { email: 'qa@example.com' } });

    expect(run.call('login').json).toEqual({ email: 'qa@example.com', password: 'hunter2' });
  });

  it('lets what the caller supplied win over the default', async () => {
    const run = await runFlow('f2-login.flow.yml', {
      responses,
      params: { email: 'qa@example.com', password: 'typed-in' }
    });

    expect(run.call('login').json.password).toBe('typed-in');
  });

  /** The same flow reached through `uses:` already worked, and has to keep agreeing with this one. */
  it('agrees with the same flow invoked as a sub-flow', async () => {
    const direct = await runFlow('f2-login.flow.yml', { responses, params: { email: 'qa@example.com' } });
    const invoked = await runFlow('f2-order-fulfillment.flow.yml', {
      responses: {
        ...responses,
        createOrder: { status: 201, body: { data: { id: 'ord-1', total: 100 } } }
      }
    });

    expect(invoked.call('login').json.password).toBe(direct.call('login').json.password);
  });
});

/**
 * R4u — §12.5's *required* params, when a host runs a library flow directly.
 *
 * R4 above gave the direct path its declared defaults. What it could not give a param that declares
 * none is a value, and an unsupplied one resolves to `undefined` — a `params` miss rather than a
 * `steps.*` miss, so §11.2 skips nothing and reports nothing. `{{params.email}}` went to the wire
 * verbatim and the step passed, leaving the API's rejection of a literal `{{...}}` as the only
 * evidence the run was never viable.
 *
 * `validate.ts` already refuses the same omission at a `uses:` call site, where the `with:` keys are
 * written in the file. This is the other way in, checked at the only moment it can be.
 */
describe('R4u — a required param a host never supplied stops the run', () => {
  const responses = { login: { status: 200, body: { data: { access_token: 'tok', user: { id: 'u-1' } } } } };

  it('refuses the run, naming the param', async () => {
    await expect(runFlow('f2-login.flow.yml', { responses })).rejects.toThrow(
      'no value was supplied for the required param email'
    );
  });

  /** Refused *before* `run:start`: a run nothing can attach to is worse than no run at all. */
  it('dispatches nothing and emits no run', async () => {
    const events = [];

    await expect(runFlow('f2-login.flow.yml', { responses, onEvent: (event) => events.push(event) })).rejects.toThrow();

    expect(events).toEqual([]);
  });

  it('names every missing param, not just the first', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (flow) => {
      flow.params.password = { required: true };
    });

    await expect(runFlow(entry, { responses, files })).rejects.toThrow(
      'no value was supplied for the required params email, password'
    );
  });

  /** A param with a default is supplied *by* the default — the predicate `validate.ts` already uses. */
  it('lets a required param with a default through', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (flow) => {
      flow.params.email = { required: true, default: 'fallback@example.com' };
    });

    const run = await runFlow(entry, { responses, files });

    expect(run.call('login').json.email).toBe('fallback@example.com');
  });

  it('runs as before once the param is supplied', async () => {
    const run = await runFlow('f2-login.flow.yml', { responses, params: { email: 'qa@example.com' } });

    expect(run.call('login').json.email).toBe('qa@example.com');
  });
});

/**
 * R4v — §14.4's provenance mechanism, declared: `params.<name>.secret`.
 *
 * 002 §5.6 shows a stored run the values it was started with, which means writing them down — and
 * §14.5 forbids a secret ever reaching a file buffer. The header denylist in `redact.ts` cannot
 * decide this one: a header name is not the author's to choose and a param name is, so the flow
 * declares which of its inputs are secret rather than the engine guessing from the spelling.
 */
describe('R4v — a run records what it was started with', () => {
  const responses = { login: { status: 200, body: { data: { access_token: 'tok', user: { id: 'u-1' } } } } };

  const inputsOf = (run) => JSON.parse(run.files.read(path.join(run.captureDir, 'inputs.json')).toString('utf8'));

  it('writes the params the host supplied, and the defaults it did not', async () => {
    const run = await runFlow('f2-login.flow.yml', { responses, params: { email: 'qa@example.com' } });

    expect(inputsOf(run).params).toEqual({ email: 'qa@example.com', password: 'hunter2' });
  });

  /** Masked *before* serialization: the file itself never held the value (§14.5). */
  it('masks a param the flow declares secret', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.password = { required: true, secret: true };
    });

    const run = await runFlow(entry, {
      responses,
      files,
      params: { email: 'qa@example.com', password: 'hunter2' }
    });

    expect(inputsOf(run).params).toEqual({ email: 'qa@example.com', password: '••••' });
    expect(run.files.read(path.join(run.captureDir, 'inputs.json')).toString('utf8')).not.toContain('hunter2');
  });

  /** The mask is not length-preserving, so the record does not leak how long the value was (§14.4). */
  it('masks a long secret and a short one identically', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.password = { required: true, secret: true };
    });

    const short = await runFlow(entry, { responses, files, params: { email: 'a@b.co', password: 'x' } });
    const long = await runFlow(entry, {
      responses,
      files,
      params: { email: 'a@b.co', password: 'a-very-long-credential-indeed' }
    });

    expect(inputsOf(short).params.password).toBe(inputsOf(long).params.password);
  });

  /** The step still receives the real value — masking is for what is *reported* (§13.2). */
  it('sends the real value even when it is masked in the record', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.password = { required: true, secret: true };
    });

    const run = await runFlow(entry, {
      responses,
      files,
      params: { email: 'qa@example.com', password: 'hunter2' }
    });

    expect(run.call('login').json.password).toBe('hunter2');
  });

  /**
   * §7.3's vars are recorded as the run *resolved* them, not as the file writes them: `{{$guid}}`
   * generates a fresh value per evaluation, so a record derived by re-resolving would name an id no
   * step ever used.
   */
  it('writes the vars each iteration actually resolved', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.vars = { attempt: 'first', tenant: '{{tenantId}}' };
    });

    const run = await runFlow(entry, { responses, files, params: { email: 'qa@example.com' } });

    expect(inputsOf(run).vars[0]).toMatchObject({ attempt: 'first' });
  });

  it('records a var by the value the run used, not by re-deriving it', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.vars = { runToken: '{{$guid}}' };
      doc.steps.find((step) => step.id === 'login').body.password = '{{runToken}}';
    });

    const run = await runFlow(entry, { responses, files, params: { email: 'qa@example.com' } });

    expect(inputsOf(run).vars[0].runToken).toBe(run.call('login').json.password);
  });

  /** A sub-flow's vars are its internals — only the entry flow's are the run's inputs. */
  it('records the entry flow\'s vars and not a sub-flow\'s', async () => {
    const run = await runFlow('f2-order-fulfillment.flow.yml', {
      responses: { ...responses, createOrder: { status: 201, body: { data: { id: 'ord-1', total: 100 } } } }
    });

    expect(Object.keys(inputsOf(run).vars)).toEqual(['0']);
  });

  /**
   * 002 §5.6's node reports a *live* run. Read back from the capture it would show a run in
   * progress as having been started with nothing, and under `--no-capture` there is nothing to read
   * back at all — so the values ride the event stream as well as the artifact.
   */
  it('reports the params on run:start, not only in the record', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.password = { required: true, secret: true };
    });

    const run = await runFlow(entry, {
      responses,
      files,
      params: { email: 'qa@example.com', password: 'hunter2' }
    });

    const start = run.events.find((event) => event.type === 'run:start');
    expect(start.params).toEqual({ email: 'qa@example.com', password: '••••' });
  });

  it('reports each iteration\'s vars as they resolve', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.vars = { runToken: '{{$guid}}' };
      doc.steps.find((step) => step.id === 'login').body.password = '{{runToken}}';
    });

    const run = await runFlow(entry, { responses, files, params: { email: 'qa@example.com' } });

    const reported = run.events.filter((event) => event.type === 'iteration:vars');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ index: 0 });
    expect(reported[0].vars.runToken).toBe(run.call('login').json.password);
  });

  /** A run is not anonymous just because nothing is being written down. */
  it('reports the params with capture disabled', async () => {
    const run = await runFlow('f2-login.flow.yml', {
      responses,
      params: { email: 'qa@example.com' },
      overrides: { capture: { enabled: false } }
    });

    const start = run.events.find((event) => event.type === 'run:start');
    expect(start.params).toEqual({ email: 'qa@example.com', password: 'hunter2' });
  });

  /** Absent `secret:` is the flow it always was — the flag is additive and defaults to off. */
  it('leaves a flow that declares no secrets exactly as it was', async () => {
    const run = await runFlow('f2-login.flow.yml', { responses, params: { email: 'qa@example.com' } });

    expect(inputsOf(run).params.password).toBe('hunter2');
  });
});

/**
 * R4s — §9.1's two slot shapes.
 *
 * `all` is the join: several branches may run and a reader below them must descend from every writer,
 * so the read never races a branch still in flight. `any` is the *alternative*: branches that exclude
 * each other, one of which writes, read by the steps after it on that same branch. No reader can
 * descend from every writer there, because only one writer ever runs — and the auth token of a flow
 * that reaches its API two ways is that case in nearly every flow anyone writes.
 */
describe('R4s — a slot written by alternatives', () => {
  const responses = {
    getState: STATE,
    createThing: CREATED,
    getThing: { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } }
  };

  it('lets each branch read the slot its own writer filled', async () => {
    const diagnostics = await validate(flow('r4s-alternative-slot.flow.yml'));

    expect(diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  /** The declaration is what makes it legal; the same flow under the default is the old error. */
  it('still refuses a cross-branch read where the slot did not ask for it', async () => {
    const { entry, files } = variant(flow('r4s-alternative-slot.flow.yml'), (document) => {
      document.shared = ['token'];
    });
    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'slot-not-downstream' })
    );
    // The message points at the way out rather than only at the rule.
    expect(diagnostics.find((d) => d.code === 'slot-not-downstream').message).toMatch(/writers: any/);
  });

  /** `any` still asks for something: a reader with no writer above it is reading nothing. */
  it('refuses a read that descends from no writer at all', async () => {
    const { entry, files } = variant(flow('r4s-alternative-slot.flow.yml'), (document) => {
      document.steps[2].depends = ['probe'];
    });
    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'slot-not-downstream' })
    );
  });

  it('carries the value of whichever branch ran onto every request after it', async () => {
    const run = await runFlow(flow('r4s-alternative-slot.flow.yml'), { responses });

    expect(run.outcome('use_seeded')).toBe('success');
    expect(run.outcome('signed_up')).toBe('skipped:condition-false');
    // Through the binding's auth profile, so the step itself declares no header (§6.4).
    expect(run.call('getThing').auth).toEqual({
      mode: 'apikey',
      apikey: { key: 'Authorization', value: 'Token thing-1', placement: 'header' }
    });
  });
});

describe('R4d — file sources', () => {
  // Fixtures come through the stubbed `ReadFile` port, never from disk: §7.4 has the engine touch
  // no `fs`, and a conformance run supplies them in memory exactly as a host would from a file.
  const at = (name) => path.join(FLOWS, 'regressions', 'fixtures', name);

  const files = {
    [at('catalog.json')]: JSON.stringify({ items: [{ sku: 'SKU-1' }, { sku: 'SKU-2' }] }),
    [at('thing.json')]: JSON.stringify({ name: 'from a file' }),
    [at('admin.json')]: JSON.stringify({ name: 'the admin variant' })
  };

  const responses = {
    createThing: CREATED,
    signIn: { status: 200, body: { data: { token: 'tok-1', role: 'admin' } } }
  };

  it('navigates a parsed !file var', async () => {
    const run = await runFlow(flow('r4d-file-sources.flow.yml'), { responses, files });

    expect(run.call('createThing').json.name).toBe('SKU-1');
  });

  it('merges a bodyFile as the step\'s inline layer', async () => {
    const run = await runFlow(flow('r4d-file-sources.flow.yml'), { responses, files });

    expect(run.call('createThing', 2).json).toEqual({ name: 'from a file' });
    expect(run.status).toBe('passed');
  });

  it('interpolates the path first, then reads the file', async () => {
    const run = await runFlow(flow('r4d-body-file-interpolated.flow.yml'), { responses, files });

    expect(run.call('createThing').json).toEqual({ name: 'the admin variant' });
  });

  it('rejects a step carrying both body: and bodyFile:', async () => {
    const { entry, files: variantFiles } = variant(flow('r4d-file-sources.flow.yml'), (document) => {
      document.steps.find((step) => step.id === 'from_file').body = { name: 'inline too' };
    });

    const diagnostics = await validate(entry, { files: { ...files, ...variantFiles } });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', stepId: 'from_file' })
    );
  });

  // The containment row asserts on the port, not on the outcome — a run that reads the file and
  // then rejects it has already read it (§7.4).
  it('never calls the port for a path escaping the scope root', async () => {
    const { entry, files: variantFiles } = variant(flow('r4d-file-sources.flow.yml'), (document) => {
      document.steps.find((step) => step.id === 'from_file').bodyFile = '../../../../../../etc/passwd';
    });

    const run = await runFlow(entry, { responses, files: { ...files, ...variantFiles } });

    expect(run.outcome('from_file')).toBe('failed:file-read-failed');
    expect(run.reads.some((read) => read.includes('passwd'))).toBe(false);
  });

  it('fails the step with a file-read reason when the fixture is missing', async () => {
    const { entry, files: variantFiles } = variant(flow('r4d-file-sources.flow.yml'), (document) => {
      document.steps.find((step) => step.id === 'from_file').bodyFile = './fixtures/absent.json';
    });

    const run = await runFlow(entry, { responses, files: { ...files, ...variantFiles } });

    expect(run.outcome('from_file')).toBe('failed:file-read-failed');
  });
});

describe('R4e — multipart and binary bodies', () => {
  const at = (name) => path.join(FLOWS, 'regressions', 'fixtures', name);
  const INVOICE = Buffer.from('%PDF-1.4 invoice {{not interpolated}}');
  const SCAN = Buffer.from('%PDF-1.4 scan {{also not interpolated}}');

  const files = {
    [at('invoice.pdf')]: INVOICE,
    [at('a.pdf')]: Buffer.from('%PDF a'),
    [at('b.pdf')]: Buffer.from('%PDF b'),
    [at('scan.pdf')]: SCAN,
    [at('manifest.csv')]: 'sku\nSKU-1\n'
  };

  const partsOf = (call) => call.body.parts;
  const partNamed = (call, name) => partsOf(call).filter((part) => part.name === name);

  describe('multipart', () => {
    let call;

    beforeAll(async () => {
      const run = await runFlow(flow('r4e-multipart.flow.yml'), {
        responses: { uploadInvoice: { status: 201 } },
        files
      });
      call = run.call('uploadInvoice');
    });

    it('assembles one part per key', () => {
      expect(call.body.kind).toBe('multipart');
      expect(partNamed(call, 'document')[0].kind).toBe('file');
      expect(partNamed(call, 'description')[0]).toMatchObject({ kind: 'field', value: 'Q3 invoice' });
    });

    it('carries the file bytes and the basename as the filename', () => {
      const document = partNamed(call, 'document')[0];
      expect(document.file.bytes.equals(INVOICE)).toBe(true);
      expect(document.file.filename).toBe('invoice.pdf');
    });

    // The spec's `encoding` is better evidence than a file suffix, so it wins over inference.
    it('takes the part content type from the operation\'s encoding', () => {
      expect(partNamed(call, 'document')[0].file.contentType).toBe('application/x-pdf');
    });

    // A part typed `object` is sent as JSON, matching OpenAPI's default encoding rather than
    // flattening it to a string.
    it('serializes an object part as JSON', () => {
      const metadata = partNamed(call, 'metadata')[0];
      expect(metadata.contentType).toBe('application/json');
      expect(JSON.parse(metadata.value)).toEqual({ tenant: 'acme' });
    });

    it('sends an array as repeated parts under one name', () => {
      expect(partNamed(call, 'attachments')).toHaveLength(2);
      expect(partNamed(call, 'attachments').map((part) => part.file.filename)).toEqual(['a.pdf', 'b.pdf']);
    });

    it('honours a filename override on the tag', async () => {
      const { entry, files: variantFiles } = variant(flow('r4e-multipart.flow.yml'), (document) => {
        document.steps[0].body.document = { path: './fixtures/invoice.pdf', filename: 'signed.pdf' };
      });
      // The projected model strips the tag, so the variant re-tags the node it wrote back.
      const text = variantFiles[entry].replace('document:\n', 'document: !file\n');
      const run = await runFlow(entry, {
        responses: { uploadInvoice: { status: 201 } },
        files: { ...files, ...variantFiles, [entry]: text }
      });

      expect(partNamed(run.call('uploadInvoice'), 'document')[0].file.filename).toBe('signed.pdf');
    });

    // §7.1 never seeds a binary property, so a required part nobody supplied has to be caught
    // rather than sent as a zero-byte upload that looks deliberate.
    it('refuses to dispatch when a required binary part is missing', async () => {
      const { entry, files: variantFiles } = variant(flow('r4e-multipart.flow.yml'), (document) => {
        delete document.steps[0].body.document;
      });

      const run = await runFlow(entry, {
        responses: { uploadInvoice: { status: 201 } },
        files: { ...files, ...variantFiles }
      });

      expect(run.callsFor('uploadInvoice')).toHaveLength(0);
    });
  });

  describe('raw binary', () => {
    const scanResponses = { uploadScan: { status: 201 } };

    it('sends the exact bytes, byte for byte', async () => {
      const run = await runFlow(flow('r4e-binary.flow.yml'), { responses: scanResponses, files });
      const { body } = run.call('uploadScan');

      expect(body.kind).toBe('binary');
      expect(body.file.bytes.equals(SCAN)).toBe(true);
    });

    // A PDF containing `{{` is not unusual, and interpolating it would produce a file that is
    // subtly wrong rather than obviously broken.
    it('runs no interpolation over the bytes', async () => {
      const run = await runFlow(flow('r4e-binary.flow.yml'), { responses: scanResponses, files });

      expect(run.call('uploadScan').body.file.bytes.toString()).toContain('{{also not interpolated}}');
    });

    // `bodyFile:` and `body: !file` are one form with two spellings, not two behaviours.
    it('produces an identical request from body: !file', async () => {
      const viaBodyFile = await runFlow(flow('r4e-binary.flow.yml'), { responses: scanResponses, files });

      const { entry, files: variantFiles } = variant(flow('r4e-binary.flow.yml'), (document) => {
        delete document.steps[0].bodyFile;
        document.steps[0].body = './fixtures/scan.pdf';
      });
      const text = variantFiles[entry].replace('body: ', 'body: !file ');
      const viaTag = await runFlow(entry, {
        responses: scanResponses,
        files: { ...files, ...variantFiles, [entry]: text }
      });

      expect(viaTag.call('uploadScan').body).toEqual(viaBodyFile.call('uploadScan').body);
    });
  });

  describe('an ambiguous operation', () => {
    const bundleResponses = { createBundle: { status: 201 } };

    it('assembles multipart when the step says so', async () => {
      const run = await runFlow(flow('r4e-ambiguous.flow.yml'), { responses: bundleResponses, files });

      expect(run.call('createBundle').body.kind).toBe('multipart');
    });

    // The same body, the other declared type: assert the two produce different wire formats.
    it('assembles JSON from the same body under the other content type', async () => {
      const { entry, files: variantFiles } = variant(flow('r4e-ambiguous.flow.yml'), (document) => {
        document.steps[0].contentType = 'application/json';
        document.steps[0].body = { name: 'autumn', manifest: 'inline' };
      });

      const run = await runFlow(entry, { responses: bundleResponses, files: { ...files, ...variantFiles } });

      expect(run.call('createBundle').body.kind).toBe('json');
      expect(run.call('createBundle').json).toEqual({ name: 'autumn', manifest: 'inline' });
    });

    // The regression test for the rejected alternative: an implementation that guesses multipart
    // from the presence of a `!file` silently changes the wire format when someone edits a value.
    it('infers nothing from the body\'s shape when contentType is absent', async () => {
      const { entry, files: variantFiles } = variant(flow('r4e-ambiguous.flow.yml'), (document) => {
        delete document.steps[0].contentType;
      });

      const run = await runFlow(entry, { responses: bundleResponses, files: { ...files, ...variantFiles } });

      expect(run.callsFor('createBundle')).toHaveLength(0);
      expect(run.outcome('bundle')).toBe('failed:invalid-request');
    });
  });
});

describe('R4b — failOnUnresolved fires on one reason only', () => {
  const responses = {
    createThing: { status: 201, body: { data: {} } },
    getThing: { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } },
    getState: STATE
  };

  it('fails the run on an unresolved dependency', async () => {
    const run = await runFlow(flow('r4-output-unproduced.flow.yml'), { responses });

    expect(run.outcome('consume')).toBe('skipped:unresolved-dependency');
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  /**
   * The verdict names the step it fell on. This is the only rule that fails a run through a step
   * that is not itself failed, so `summary` counts a red run as entirely green and grey — and the
   * hosts cannot work out which step it was, because `failOnUnresolved` is a per-step flag that
   * `StepResult` does not carry.
   */
  describe('the verdict names the steps that decided it', () => {
    it('names the skipped step that failed the run', async () => {
      const run = await runFlow(flow('r4-output-unproduced.flow.yml'), { responses });

      expect(run.result.decidedBy).toEqual(['consume']);
      expect(run.result.summary.failed).toBe(0);
    });

    it('names the failed step of an ordinary failure', async () => {
      const run = await runFlow(flow('r1-dead-service.flow.yml'), {
        responses: { ...responses, createThing: { status: 500, body: {} } }
      });

      expect(run.result.decidedBy).toEqual(['create']);
    });

    it('names nothing on a run that passed', async () => {
      const run = await runFlow(flow('r4b-unmet-dependency.flow.yml'), { responses });

      expect(run.status).toBe('passed');
      expect(run.result.decidedBy).toEqual([]);
    });

    /** The interrupt decided it; the steps it cut short did nothing to deserve naming. */
    it('names nothing on a cancelled run', async () => {
      const run = await runFlow(flow('r4b-cancelled.flow.yml'), {
        responses: {
          createThing: (request, ctx, info) => {
            info.abort();
            return CREATED;
          },
          getState: STATE
        }
      });

      expect(run.status).toBe('cancelled');
      expect(run.result.decidedBy).toEqual([]);
    });

    it('goes quiet with the run when the rule is opted out of', async () => {
      const { entry, files } = variant(flow('r4-output-unproduced.flow.yml'), (document) => {
        document.config.failOnUnresolved = false;
      });
      const run = await runFlow(entry, { responses, files });

      expect(run.status).toBe('passed');
      expect(run.result.decidedBy).toEqual([]);
    });
  });

  // The middle two rows are the ones that matter. A blanket "any skip fails" implementation
  // passes the row above and the overrides below, and only these reveal that conditional and
  // fallback branches were collateral damage.
  it('leaves a false condition green', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    expect(run.outcome('conditional')).toBe('skipped:condition-false');
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  it('leaves an unmet dependency green', async () => {
    const run = await runFlow(flow('r4b-unmet-dependency.flow.yml'), {
      responses: { createThing: CREATED }
    });

    expect(run.outcome('fallback')).toBe('skipped:unmet-dependency');
    // The dependency that was not met, and what it did instead — §14.6's message beside its reason.
    expect(run.step('fallback').message).toBe('primary success');
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  it('reports a cancelled run as cancelled', async () => {
    const run = await runFlow(flow('r4b-cancelled.flow.yml'), {
      responses: {
        createThing: (request, ctx, info) => {
          info.abort();
          return CREATED;
        },
        getState: STATE
      }
    });

    expect(run.outcome('later')).toBe('skipped:run-cancelled');
    expect(run.status).toBe('cancelled');
    expect(run.exitCode).toBe(4);
  });

  describe('the two overrides', () => {
    const unresolved = 'r4-output-unproduced.flow.yml';

    it('goes green under a flow-level opt-out', async () => {
      const { entry, files } = variant(flow(unresolved), (document) => {
        document.config.failOnUnresolved = false;
      });
      const run = await runFlow(entry, { responses, files });

      expect(run.outcome('consume')).toBe('skipped:unresolved-dependency');
      expect(run.status).toBe('passed');
      expect(run.exitCode).toBe(0);
    });

    it('goes green under a step-level opt-out while the flow default stays true', async () => {
      const { entry, files } = variant(flow(unresolved), (document) => {
        document.steps.find((step) => step.id === 'consume').failOnUnresolved = false;
      });
      const run = await runFlow(entry, { responses, files });

      expect(run.outcome('consume')).toBe('skipped:unresolved-dependency');
      expect(run.status).toBe('passed');
      expect(run.exitCode).toBe(0);
    });
  });
});

describe('R4g — the whole-run budget', () => {
  // Fake timers drive the clock: the poll's retry delays are what consume the budget, so the run
  // stops without a second of wall-clock time passing.
  const responses = {
    createThing: CREATED,
    getThing: (request, ctx, info) => ({
      status: 200,
      body: { data: { id: 'thing-1', name: info.call >= 5 ? 'ready' : 'pending' } }
    }),
    getState: STATE
  };

  const budgeted = () => runFlow(flow('r4g-run-budget.flow.yml'), { responses });

  it('takes the cancellation path rather than a distinct one', async () => {
    const run = await budgeted();

    expect(run.outcome('follow_up')).toBe('skipped:run-cancelled');
    expect(run.status).toBe('cancelled');
    expect(run.exitCode).toBe(4);
  });

  // This is the whole point of a budget the engine owns over a SIGKILL from the CI runner, which
  // leaves the resources the flow created behind.
  it('still runs a step whose depends accepts cancelled', async () => {
    const run = await budgeted();

    expect(run.outcome('cleanup')).toBe('success');
    expect(run.calls.map((call) => call.stepId)).toContain('cleanup');
  });

  it('spends the budget on the poll rather than on wall-clock time, and stops when it is spent', async () => {
    const startedAt = Date.now();
    const run = await budgeted();

    // Two delays consume the 2000ms budget; the poll stops there rather than serving out the rest
    // of its schedule against a run that is already over (§11.3).
    expect(run.sleeps).toEqual([1000, 1000]);
    expect(run.outcome('await_ready')).toBe('cancelled:run-cancelled');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  // The bound is off unless asked for: flows differ by orders of magnitude and a wrong default
  // would fail long polls that were working.
  it('runs to completion with no maxRunDuration set', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      delete document.config.maxRunDuration;
    });

    const run = await runFlow(entry, { responses, files });

    expect(run.outcome('follow_up')).toBe('success');
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  // An unattended run has no second interrupt to bound it, so the cleanup window is a deadline of
  // its own rather than an open phase.
  it('abandons cleanup once the grace window has passed', async () => {
    const { entry, files } = variant(flow('r4g-run-budget.flow.yml'), (document) => {
      document.config.cleanupGrace = 0;
    });

    const run = await runFlow(entry, { responses, files });

    expect(run.outcome('cleanup')).toBe('skipped:run-cancelled');
    expect(run.status).toBe('cancelled');
  });
});

/**
 * R4h — §11.1's `maxDuration`, the step's own budget. `maxAttempts × (timeout + delay)` is the
 * wall-clock a poll can otherwise take, and on the schedules polls actually use that is tens of
 * minutes: a flow that set the bound and got nothing was a flow with no bound at all.
 */
describe('R4h — a step\'s own budget', () => {
  const pending = { status: 200, body: { data: { id: 'thing-1', name: 'pending' } } };

  it('ends the poll when the budget elapses, whatever maxAttempts allows', async () => {
    const run = await runFlow(flow('r4h-step-budget.flow.yml'), {
      responses: { createThing: CREATED, getThing: pending, getState: STATE }
    });

    expect(run.outcome('await_ready')).toBe('failed:max-duration-exceeded');
    // 5000ms of budget over 2000ms delays: three attempts, and the fourth is never scheduled.
    expect(run.step('await_ready').attempts).toBe(3);
    expect(run.step('await_ready').message).toMatch(/5000ms budget/);
  });

  /** The budget bounds the step; it does not end the run, which is §11.3's separate bound. */
  it('leaves the rest of the flow to run', async () => {
    const run = await runFlow(flow('r4h-step-budget.flow.yml'), {
      responses: { createThing: CREATED, getThing: pending, getState: STATE }
    });

    expect(run.outcome('follow_up')).toBe('success');
    expect(run.status).toBe('failed');
  });

  /** A poll that settles inside its budget is judged on what it settled as, not on the clock. */
  it('says nothing about a step that finished in time', async () => {
    const run = await runFlow(flow('r4h-step-budget.flow.yml'), {
      responses: {
        createThing: CREATED,
        getThing: (request, ctx, info) => ({
          status: 200,
          body: { data: { id: 'thing-1', name: info.call >= 2 ? 'ready' : 'pending' } }
        }),
        getState: STATE
      }
    });

    expect(run.outcome('await_ready')).toBe('success');
    expect(run.status).toBe('passed');
  });

  /** Unset, it bounds nothing: flows differ by orders of magnitude and a default would fail polls. */
  it('is off unless the step asks for it', async () => {
    const { entry, files } = variant(flow('r4h-step-budget.flow.yml'), (document) => {
      delete document.steps[1].maxDuration;
      document.steps[1].retry.maxAttempts = 4;
    });

    const run = await runFlow(entry, {
      files,
      responses: { createThing: CREATED, getThing: pending, getState: STATE }
    });

    expect(run.outcome('await_ready')).toBe('failed:retries-exhausted');
    expect(run.step('await_ready').attempts).toBe(4);
  });

  /**
   * §11.1 aborts the attempt in flight when the budget elapses, and the request timeout is the
   * mechanism: the step is handed whichever of the two runs out first, so it cannot sit inside one
   * attempt past the budget that governs it.
   */
  it('bounds each attempt by whatever is left of the budget', async () => {
    const { entry, files } = variant(flow('r4h-step-budget.flow.yml'), (document) => {
      document.steps[1].timeout = 60000;
    });

    const run = await runFlow(entry, {
      files,
      responses: { createThing: CREATED, getThing: pending, getState: STATE }
    });

    const timeouts = run.callsFor('getThing').map((call) => call.timeoutMs);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(5000);
    expect(timeouts).toEqual([...timeouts].sort((left, right) => right - left));
  });
});

describe('R4c — generated data is stable where it must be', () => {
  const responses = {
    createThing: CREATED,
    signIn: { status: 200, body: { data: { token: 'tok-1', role: 'admin' } } }
  };

  // The first two are the pair that must both hold: an implementation can satisfy either alone by
  // picking the wrong evaluation scope, and only running both catches it.
  it('binds one generated identity per iteration', async () => {
    const run = await runFlow(flow('r4c-generated-vars.flow.yml'), { responses });

    const signups = run.callsFor('createThing').map((call) => call.json.email);
    const logins = run.callsFor('signIn').map((call) => call.json.email);

    expect(signups).toHaveLength(2);
    expect(logins).toEqual(signups);
    expect(signups[0]).not.toEqual(signups[1]);
    expect(signups[0]).toMatch(/^qa\+.+@example\.com$/);
  });

  it('generates independently for each inline occurrence', async () => {
    const run = await runFlow(flow('r4c-inline-generated.flow.yml'), { responses });
    const body = run.call('createThing').json;

    expect(body.name).not.toEqual(body.ref);
  });

  // Bruno's interpolator stringifies mock output, so the engine has to resolve whole-value
  // references itself (§7.3).
  it('sends a generated number as a JSON number', async () => {
    const run = await runFlow(flow('r4c-inline-generated.flow.yml'), { responses });

    expect(typeof run.call('createThing').json.count).toBe('number');
  });

  it('rejects a var that reads step state', async () => {
    const diagnostics = await validate(flow('r4c-vars-steps-ref.flow.yml'));

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).not.toHaveLength(0);
  });
});

describe('R4c2 — how a bare operand resolves', () => {
  const responses = {
    signIn: { status: 200, body: { data: { token: 'tok-1', role: 'admin' } } },
    getState: STATE
  };

  it('resolves literals, reserved roots and quoted strings', async () => {
    const run = await runFlow(flow('r4c2-literals.flow.yml'), { responses });

    expect(run.step('state').assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(run.outcome('state')).toBe('success');
    expect(run.status).toBe('passed');
  });

  // The load-bearing row. An implementation that resolves any bare word against the variable scope
  // passes every other row and silently turns a string comparison into a variable lookup.
  it('reads a bare word as a string and not as the flow var of that name', async () => {
    const run = await runFlow(flow('r4c2-bare-word.flow.yml'), { responses });

    expect(run.step('state').assertions).toEqual([
      { expr: 'res.body.data.state eq status', passed: false, expected: 'status', actual: 'settled' }
    ]);
    expect(run.outcome('state')).toBe('failed:assertion-failed');
  });

  it('reads a braced operand as the flow var', async () => {
    const run = await runFlow(flow('r4c2-braced-var.flow.yml'), { responses });

    expect(run.step('state').assertions).toEqual([
      {
        expr: 'res.body.data.state eq {{status}}',
        passed: false,
        expected: 'pending',
        actual: 'settled'
      }
    ]);
  });

  it('matches a reserved root only as a whole first segment', async () => {
    const run = await runFlow(flow('r4c2-root-prefix.flow.yml'), { responses });

    expect(run.step('state').assertions).toEqual([
      { expr: 'res.body.data.role eq rowrole', passed: false, expected: 'rowrole', actual: 'admin' }
    ]);
  });
});

describe('R4j — run:start names the capture directory', () => {
  // Reporting it only in `RunResult` would mean a consumer could not open a *running* step's
  // capture, which is exactly what 002 §9 does — and the engine knows the directory before the
  // first step, since §14.5 writes run.json into it at run start.
  it('carries captureDir, matching the one the result reports', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE }
    });
    const started = run.result;
    const event = run.events.find((entry) => entry.type === 'run:start');

    expect(event.captureDir).toBe(started.captureDir);
    expect(event.captureDir).toEqual(expect.any(String));
    // Still the *run* directory, not the suite holding it: §14.5 nesting a run changed where the
    // directory is, not what `captureDir` names.
    expect(path.basename(path.dirname(event.captureDir))).toMatch(/^suite-/);
    expect(run.files.has(path.join(event.captureDir, 'run.json'))).toBe(true);
  });

  it('omits it when capture is disabled', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE },
      overrides: { capture: { enabled: false } }
    });

    expect(run.events.find((entry) => entry.type === 'run:start').captureDir).toBeUndefined();
  });
});

describe('R4j — an auth profile arrives as Bruno Auth', () => {
  // Authored flat, delivered nested (§6.4). The flat form reached `ExecuteRequest` unchanged until
  // the app tried to hand it to `setAuthHeaders`, which reads `auth.bearer.token` — so the one
  // shape §6.4 promises a host could reuse was the one shape it could not.
  let auth;

  beforeAll(async () => {
    const run = await runFlow(flow('r4j-auth-shapes.flow.yml'), { responses: { createThing: CREATED } });
    auth = run.callsFor('createThing').map((call) => call.auth);
  });

  it('nests each mode under a key named for it', () => {
    expect(auth[0]).toEqual({ mode: 'bearer', bearer: { token: 'tok-session' } });
    expect(auth[1]).toEqual({ mode: 'basic', basic: { username: 'ops', password: 'hunter2' } });
    expect(auth[2]).toEqual({ mode: 'apikey', apikey: { key: 'X-Api-Key', value: 'ak_1', placement: 'header' } });
    expect(auth[3]).toEqual({
      mode: 'oauth2',
      oauth2: { grantType: 'client_credentials', clientId: 'cid', clientSecret: 'sec' }
    });
  });

  it('carries a field the mode does not define rather than dropping it', () => {
    expect(auth[4]).toEqual({ mode: 'bearer', bearer: { token: 'tok-carrier', tokenPrefix: 'Token' } });
  });

  it('leaves `none` with no sibling key', () => {
    expect(auth[5]).toEqual({ mode: 'none' });
  });
});

/**
 * §13.2's stream terminates. A host resolves its promise at `run:start` and watches events from
 * there, so a run that rejects without a `run:end` leaves it with a run that is running forever and
 * a cancel with nothing to cancel — which is what the app showed for any error escaping a step.
 */
describe('R4x — a run that fails on its own always ends', () => {
  // A binding whose document is not there: the specs load inside the run, after `run:start`, and
  // `bru flow validate` reports this before a run (§14.3) — so arriving here means nobody validated.
  // It stands in for any engine failure that is not a step's own.
  const missingSpec = (document) => {
    document.apis['regress-api'] = '../../specs/not-here.yml';
  };

  it('emits run:end before the failure reaches the caller', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), missingSpec);
    const events = [];

    await expect(
      runFlow(entry, { files, responses: { createThing: CREATED }, onEvent: (event) => events.push(event) })
    ).rejects.toThrow();

    const ended = events.filter((event) => event.type === 'run:end');
    expect(ended).toHaveLength(1);
    expect(ended[0].result.status).toBe('failed');
  });

  /** The reason is on the result rather than only in a thrown string, so a host can render it. */
  it('says what happened, as a diagnostic on the result', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), missingSpec);
    const events = [];

    await runFlow(entry, {
      files,
      responses: { createThing: CREATED },
      onEvent: (event) => events.push(event)
    }).catch(() => {});

    const [{ result }] = events.filter((event) => event.type === 'run:end');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'run-failed', message: expect.any(String) })
    ]);
  });

  /**
   * The one failure that *was* thrown past its step. A step that announced `step:start` and never
   * announced its end leaves a host drawing it as in flight for as long as the tab is open — so it
   * is reported the way every other shape materialization refuses is (§14.6).
   */
  it('fails the step, not the run, when its operation is not in the spec', async () => {
    const { entry, files } = variant(flow('r2-retry-optin.flow.yml'), (document) => {
      document.steps[0].operation = 'regress-api#noSuchOperation';
    });
    const run = await runFlow(entry, { files, responses: { createThing: CREATED } });

    expect(run.outcome('create')).toBe('failed:invalid-request');
    expect(run.step('create').message).toMatch(/noSuchOperation/);
    expect(run.events.at(-1).type).toBe('run:end');
  });
});

/**
 * §14.5's artifact writes must never fail a run — a flow that passed did pass, whatever the disk did
 * afterwards. Swallowed *silently*, though, the step is left with no request and no response to show
 * and nothing saying why, which reads as a step that never sent anything.
 */
describe('R4y — a capture that could not be written says so', () => {
  const refusingAttempts = { failWrites: (target) => target.includes('attempt-') && 'EACCES: permission denied' };

  it('reports it against the run rather than failing the run', async () => {
    const run = await runFlow(flow('r2-retry-default.flow.yml'), {
      ...refusingAttempts,
      responses: { createThing: CREATED }
    });

    expect(run.result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'capture-write-failed',
        stepId: 'create',
        message: expect.stringMatching(/EACCES/)
      })
    ]);
  });

  /** The step's own outcome is what it did, not what the disk did after it. */
  it('leaves the step judged on its own outcome, with no capture to point at', async () => {
    const run = await runFlow(flow('r2-retry-default.flow.yml'), {
      ...refusingAttempts,
      responses: { createThing: CREATED }
    });

    expect(run.step('create').capturePath).toBeUndefined();
    expect(run.outcome('create')).toBe('failed:assertion-failed');
  });

  it('says nothing about a run whose captures were written', async () => {
    const run = await runFlow(flow('r2-retry-default.flow.yml'), { responses: { createThing: CREATED } });

    expect(run.result.diagnostics).toEqual([]);
    expect(run.step('create').capturePath).toBeDefined();
  });
});

/**
 * R4r — §10.1's schema checks against a document written the way real ones are.
 *
 * A schema lifted out of an OpenAPI document is a fragment of it, and `#/components/schemas/X`
 * resolves against the root of whatever is being validated. Handed the fragment alone, the validator
 * cannot resolve the first `$ref` it meets — and it says so by refusing to compile, which took the
 * whole run with it. Every other fixture here inlines its schemas, which is why nothing caught it.
 */
describe('R4r — a spec whose schemas are refs', () => {
  const created = { status: 201, body: { task: { id: 'task-1', status: 'PENDING' } } };

  it('validates through the ref rather than failing to compile', async () => {
    const run = await runFlow(flow('r4r-schema-refs.flow.yml'), {
      responses: {
        createTask: created,
        getTask: { status: 200, body: { task: { id: 'task-1', status: 'SUCCESS' } } },
        // The chain step is this fixture's ambiguous-oneOf case, asserted on its own below.
        getChain: { status: 200, body: { chain: {} } }
      }
    });

    expect(run.outcome('create')).toBe('success');
    expect(run.outcome('await_task')).toBe('success');
  });

  /** Through the *nested* ref too: resolving the outer one and stopping would pass anything here. */
  it('rejects a response that the referenced schema forbids', async () => {
    const run = await runFlow(flow('r4r-schema-refs.flow.yml'), {
      responses: {
        createTask: created,
        getTask: { status: 200, body: { task: { id: 'task-1' } } },
        getChain: { status: 200, body: { chain: {} } }
      }
    });

    expect(run.outcome('await_task')).toBe('failed:schema-validation-failed');
    expect(run.step('await_task').message).toMatch(/status/);
    expect(run.step('await_task').validation.response.errors[0].path).toBe('/task');
  });

  it('validates a request body written the same way', async () => {
    const { entry, files } = variant(flow('r4r-schema-refs.flow.yml'), (document) => {
      document.steps[0].body = { name: 42 };
    });
    const run = await runFlow(entry, {
      files,
      responses: { createTask: created, getChain: { status: 200, body: { chain: {} } } }
    });

    expect(run.outcome('create')).toBe('failed:invalid-request');
  });

  /**
   * `oneOf` fails in two opposite ways and says the same sentence for both. More than one branch
   * matching is a statement about the *document* — two schemas that both accept the payload, which is
   * what happens when neither declares `required` and both allow extras — and a reader told only
   * "must match exactly one" goes looking for the fault in their response.
   */
  it('says when a oneOf failed because more than one branch matched', async () => {
    const run = await runFlow(flow('r4r-schema-refs.flow.yml'), {
      responses: {
        createTask: created,
        getTask: { status: 200, body: { task: { id: 'task-1', status: 'SUCCESS' } } },
        getChain: { status: 200, body: { task: { id: 'task-1', status: 'SUCCESS' }, companies: [] } }
      }
    });

    expect(run.outcome('read_chain')).toBe('failed:schema-validation-failed');
    expect(run.step('read_chain').message).toMatch(/2 of them matched/);
  });

  /**
   * A schema the validator will not compile is a statement about the document, not about the
   * response — so it fails the check on the step rather than being thrown past it, where it ends the
   * run with nothing to say about any step.
   */
  it('fails the step, not the run, when a schema cannot be compiled', async () => {
    const { entry, files } = variant(flow('r4r-schema-refs.flow.yml'), (document) => {
      document.steps = [document.steps[1]];
    });
    const run = await runFlow(entry, {
      files: {
        ...files,
        [path.join(FLOWS, '..', 'specs', 'regressions-refs-v1.yml')]: [
          'openapi: 3.0.3',
          'info: { title: Broken, version: 1.0.0 }',
          'servers: [{ url: https://regress.example.com }]',
          'paths:',
          '  /tasks/{task_id}:',
          '    get:',
          '      operationId: getTask',
          '      responses:',
          '        \'200\':',
          '          description: The task',
          '          content:',
          '            application/json:',
          '              schema:',
          '                $ref: \'#/components/schemas/NotThere\''
        ].join('\n')
      },
      responses: { getTask: { status: 200, body: { task: {} } } }
    });

    expect(run.outcome('await_task')).toBe('failed:schema-validation-failed');
    expect(run.step('await_task').message).toMatch(/could not be compiled/);
    expect(run.events.at(-1).type).toBe('run:end');
  });

  /**
   * Ajv reports the rule that was broken and nothing about where, which over a bundled OpenAPI
   * document is a message that sends the reader grepping for a keyword legal almost everywhere it
   * appears. `nullable` beside `anyOf` rather than beside a `type` is the shape that produces it:
   * every ancestor of the offending node fails identically, the root included, so the unlocated
   * message describes the whole document.
   */
  it('names where in the schema a compile failure is, and only the deepest node', async () => {
    const { entry, files } = variant(flow('r4r-schema-refs.flow.yml'), (document) => {
      document.steps = [document.steps[1]];
    });
    const run = await runFlow(entry, {
      files: {
        ...files,
        [path.join(FLOWS, '..', 'specs', 'regressions-refs-v1.yml')]: [
          'openapi: 3.0.3',
          'info: { title: Broken, version: 1.0.0 }',
          'servers: [{ url: https://regress.example.com }]',
          'paths:',
          '  /tasks/{task_id}:',
          '    get:',
          '      operationId: getTask',
          '      responses:',
          '        \'200\':',
          '          description: The task',
          '          content:',
          '            application/json:',
          '              schema:',
          '                type: object',
          '                properties:',
          '                  fine: { type: string, nullable: true }',
          '                  broken:',
          '                    anyOf: [{ type: string }]',
          '                    nullable: true'
        ].join('\n')
      },
      responses: { getTask: { status: 200, body: { task: {} } } }
    });

    const { message } = run.step('await_task');

    expect(message).toContain('"nullable" cannot be used without "type"');
    expect(message).toContain('/properties/broken');
    // The node that is actually wrong, not every ancestor that fails because of it — and not the
    // sibling that is spelled correctly.
    expect(message).not.toContain('/properties/fine');
    expect(message).not.toMatch(/at \/properties,/);
  });
});

describe('R5 — unresolved variables never reach the wire', () => {
  const responses = { login: { status: 200, body: { data: { access_token: 'tok', user: { id: 'u-1' } } } } };

  // Bruno's interpolator leaves an unresolved placeholder in place, which is correct for a user
  // variable and wrong for engine state (§11.2).
  it('sends an empty string rather than the placeholder', async () => {
    const run = await runFlow(flow('r4-slot-unwritten.flow.yml'), {
      responses: { createThing: CREATED }
    });

    const body = run.call('createThing').json;
    expect(body.ref).toBe('');
    expect(body.ref).not.toBe('{{shared.carrierRef}}');
  });

  /**
   * A declared param is engine state by the same rule, and was the one root that did not follow it:
   * an optional param with no default put `{{params.x}}` on the wire, where the API rejects it for a
   * reason that names the field rather than the placeholder. R4u refuses the *required* case before
   * the run; this is the case that legitimately has no value.
   */
  it('sends an empty string for a declared param nobody supplied', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.password = { required: false };
    });

    const run = await runFlow(entry, { responses, files, params: { email: 'qa@example.com' } });

    expect(run.call('login').json.password).toBe('');
  });

  /**
   * A name the flow never declared is a typo, not an empty value — and nothing else catches it,
   * since `references.ts` scans only `steps` and `shared`. Blanking it would destroy the only
   * evidence that reaches the wire.
   */
  it('keeps the placeholder for a param the flow does not declare', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.steps.find((step) => step.id === 'login').body.password = '{{params.passwrd}}';
    });

    const run = await runFlow(entry, { responses, files, params: { email: 'qa@example.com' } });

    expect(run.call('login').json.password).toBe('{{params.passwrd}}');
  });

  /** A miss on a sub-path of a value that *is* there says the shape differs, not that it is empty. */
  it('keeps the placeholder for a sub-path of a param that was supplied', async () => {
    const { entry, files } = variant('f2-login.flow.yml', (doc) => {
      doc.params.profile = { required: false };
      doc.steps.find((step) => step.id === 'login').body.password = '{{params.profile.secret}}';
    });

    const run = await runFlow(entry, {
      responses,
      files,
      params: { email: 'qa@example.com', profile: { name: 'qa' } }
    });

    expect(run.call('login').json.password).toBe('{{params.profile.secret}}');
  });
});

describe('R6 — exit codes', () => {
  it('exits 0 when every step passed', async () => {
    const run = await runFlow(flow('r4b-condition-false.flow.yml'), {
      responses: { createThing: CREATED, getState: STATE }
    });

    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  it('exits 1 on a step failure', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: {
        createThing: { status: 500, body: { error: { message: 'upstream unavailable' } } },
        getThing: { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } }
      }
    });

    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  it('exits 4 on a cancelled run', async () => {
    const run = await runFlow(flow('r4b-cancelled.flow.yml'), {
      responses: {
        createThing: (request, ctx, info) => {
          info.abort();
          return CREATED;
        },
        getState: STATE
      }
    });

    expect(run.status).toBe('cancelled');
    expect(run.exitCode).toBe(4);
  });

  // The `2` a CLI reports for an invalid file is its mapping of this: an error-severity
  // diagnostic from the entry every host shares.
  it('reports an invalid flow as an error diagnostic rather than a run', async () => {
    const diagnostics = await validate(flow('r4-slot-nondescendant.flow.yml'));

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).not.toHaveLength(0);
  });
});

/**
 * R4t — 001 §8.6's script library.
 *
 * The three positions §8.2 defines all evaluate through one port, so what has to be proven is that
 * the *library* reaches that port composed: from the flow's own block, from a library document it
 * includes, and from a raw JS file that document includes. A run is the only place this shows —
 * nothing about a flow's shape says whether `maskCard` resolves.
 */
describe('R4t — a script library', () => {
  const created = { status: 201, body: { data: { id: 'card-4111111111111234', name: 'widget' } } };

  it('calls a function the flow declares, and one two files away', async () => {
    const run = await runFlow(flow('r4t-functions.flow.yml'), { responses: { createThing: created } });

    expect(run.outcome('create')).toBe('success');
    // `label` is the flow's own and calls `lastFour`, which the JS file the library document
    // includes declares — so a passing value proves the whole chain shares one scope.
    expect(run.step('create').outputs.labelled).toBe('widget-1234');
  });

  /** The flow has the last word on a name, the way a step's own `outputs:` overrides §8.5's. */
  it('lets the flow override a function its library declares', async () => {
    const run = await runFlow(flow('r4t-functions.flow.yml'), { responses: { createThing: created } });

    expect(run.step('create').outputs.masked).toBe('flow:1234');
  });

  /**
   * A library that cannot be read fails every script position at once, so it is caught statically
   * rather than reported as whichever step ran first.
   */
  it('reports a library file that does not resolve, before anything runs', async () => {
    const { entry, files } = variant(flow('r4t-functions.flow.yml'), (document) => {
      document.functions.use = ['./lib/not-here.js'];
    });

    expect(await validate(entry, { files })).toContainEqual(
      expect.objectContaining({ code: 'unresolved-function-library', severity: 'error' })
    );
  });

  /** It becomes a declaration: a name that is not an identifier is a prelude that does not parse. */
  it('reports a name that cannot be a declaration', async () => {
    const { entry, files } = variant(flow('r4t-functions.flow.yml'), (document) => {
      document.functions['last-four'] = '(v) => v';
    });

    expect(await validate(entry, { files })).toContainEqual(
      expect.objectContaining({ code: 'invalid-function-name', severity: 'error' })
    );
  });

  /** Shadowing what §8.2 hands a script is legal JavaScript, and nobody means it twice. */
  it('warns about a function named after a script argument', async () => {
    const { entry, files } = variant(flow('r4t-functions.flow.yml'), (document) => {
      document.functions.res = '(v) => v';
    });

    const diagnostics = await validate(entry, { files });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'function-shadows-script-argument', severity: 'warning' })
    );
    expect(diagnostics.some((entry_) => entry_.severity === 'error')).toBe(false);
  });

  /**
   * Composition is invisible to a host (§13.2), so a flow that declares no library must reach
   * `RunScript` as the source it was written as — byte for byte, or §8.2's "no new execution
   * environment" stops being a statement anyone can check.
   */
  it('hands the host the untouched source when there is no library', () => {
    const source = '(res) => res.body.id';

    expect(withLibrary('', source)).toBe(source);
    expect(withLibrary('var lastFour = ((v) => v);', source)).toContain(source);
  });

  /** A flow with no library composes to the source it was written as — the common case pays nothing. */
  it('leaves a flow without one exactly as it was', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE }
    });

    expect(run.outcome('create')).toBe('success');
  });
});

/**
 * R4w — 001 §8.7's values computed before the request.
 *
 * What has to be proven is that the position runs where the spec puts it and that its namespace is
 * step-local: the first is only visible in a request that was actually built from it, and the second
 * only in a step that computes nothing and reads `{{pre.*}}` anyway.
 */
describe('R4w — values computed before the request', () => {
  const created = { status: 201, body: { data: { id: 'thing-1' } } };
  const fetched = { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } };
  const responses = { createThing: created, getThing: fetched };

  it('puts a computed value on the wire, through the step\'s own {{pre.*}}', async () => {
    const run = await runFlow(flow('r4w-pre.flow.yml'), { responses });

    expect(run.outcome('sign')).toBe('success');
    // `tag` is a §8.6 library function and `ctx.steps` is the run's state, so the value proves both
    // reach a position that runs before the request.
    expect(run.call('getThing', 1).headers['X-Signature']).toBe('sig:thing-1');
    expect(run.call('getThing', 1).headers['X-Correlation-Id']).toBe('corr-1');
  });

  it('promotes one with from: pre, under its own name and under another', async () => {
    const run = await runFlow(flow('r4w-pre.flow.yml'), { responses });

    expect(run.step('sign').outputs).toMatchObject({ correlationId: 'corr-1', traceId: 'sig:thing-1' });
  });

  /**
   * The whole reason the namespace is step-local rather than published into `steps.<id>.*`: a
   * reference in another step names that step's own values, and there are none.
   */
  it('is step-local — another step\'s {{pre.*}} names nothing', async () => {
    const run = await runFlow(flow('r4w-pre.flow.yml'), { responses });

    expect(run.outcome('verify')).toBe('success');
    // What crossed the boundary did so as an output.
    expect(run.call('getThing', 2).headers['X-Promoted']).toBe('corr-1');
    // An ordinary miss, left in place — §7.3's rule for a reference nothing defined.
    expect(run.call('getThing', 2).headers['X-Leaked']).toBe('{{pre.signature}}');
  });

  /** §8.2's rule, one position along — and no request is sent. */
  it('fails the step when a pre script throws, and stops the ones after it', async () => {
    const run = await runFlow(flow('r4w-pre-throws.flow.yml'), { responses });

    expect(run.outcome('create')).toBe('failed:script-error');
    expect(run.step('create').message).toContain('pre.first');
    expect(run.step('create').message).toContain('nope');
    expect(run.calls).toHaveLength(0);
    expect(run.step('create').outputs.second).toBeUndefined();
  });

  /** `when:` is the cheaper question and runs first, so there is nothing to compute for. */
  it('computes nothing for a step its condition skipped', async () => {
    const run = await runFlow(flow('r4w-pre-skipped.flow.yml'), { responses });

    expect(run.outcome('never')).toBe('skipped:condition-false');
    expect(run.scripts).toHaveLength(0);
  });

  /**
   * §8.1's string form is a path into the response, not an interpolation — it selects nothing and
   * leaves the output unset, which is the mistake the shape invites and therefore the one reported.
   */
  it('warns on an interpolation written where a path belongs', async () => {
    const { entry, files } = variant(flow('r4w-pre.flow.yml'), (document) => {
      document.steps[1].outputs.correlationId = '{{pre.correlationId}}';
    });

    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interpolation-in-output-path', severity: 'warning' })
    );
  });

  it('reports a from: pre naming a value the step does not compute', async () => {
    const { entry, files } = variant(flow('r4w-pre.flow.yml'), (document) => {
      document.steps[1].outputs.traceId = { from: 'pre', path: 'notComputed' };
    });

    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unknown-pre-value', severity: 'error' })
    );
  });
});

/**
 * R4f — §7.6's jar scoping.
 *
 * The engine decides *which* jar a request uses and nothing else: parsing `Set-Cookie`, domain
 * matching and expiry stay in each host's implementation (§13.2). So what is asserted here is the
 * jar identity handed to the dispatch port, made observable by the harness playing the host — a
 * `Cookie` echoed from whatever jar the engine named.
 *
 * That split is the reason this is an engine test at all. If jar scoping were left to the hosts, the
 * CLI and the app could disagree about whether iteration two is a fresh session, which is the
 * divergence goal 4 exists to prevent.
 */
describe('R4f — cookie jar scoping', () => {
  const created = { status: 201, body: { data: { id: 'thing-1' } }, setCookie: 'sid=a' };
  const fetched = { status: 200, body: { data: { id: 'thing-1', name: 'widget' } } };

  it('shares one jar across every step of a run', async () => {
    const run = await runFlow(flow('r4f-cookies.flow.yml'), {
      responses: { createThing: created, getThing: fetched }
    });

    expect(run.outcome('read')).toBe('success');
    // Neither step declares anything: §8's named-output model cannot carry a cookie the flow never
    // asked for, which is why §7.6 exists.
    expect(run.call('getThing', 1).cookie).toBe('sid=a');
    expect(run.call('getThing', 2).cookie).toBe('sid=a');
    expect(new Set(run.calls.map((entry) => entry.jar)).size).toBe(1);
  });

  /**
   * The load-bearing rule. A role matrix logging in as three users across three rows shares one
   * session under a run-wide jar: row two sends row one's cookie, the server answers as the wrong
   * user, and the flow passes having tested one identity three times.
   */
  it('gives each dataset iteration its own jar', async () => {
    const run = await runFlow(flow('r4f-cookies-dataset.flow.yml'), {
      responses: {
        createThing: (request) => ({
          status: 201,
          body: { data: { id: 'thing-1' } },
          setCookie: `sid=${request.body.value.name}`
        }),
        getThing: fetched
      }
    });

    const reads = run.calls.filter((entry) => entry.operationId === 'getThing');
    expect(reads).toHaveLength(3);
    // Each read carries the session its own row established, and no other.
    expect(reads.map((entry) => entry.cookie).sort()).toEqual(['sid=alpha', 'sid=beta', 'sid=gamma']);
    expect(new Set(run.calls.map((entry) => entry.jar)).size).toBe(3);
  });

  /**
   * Run repeatedly, because this is the failure a sequential test cannot see: a run-wide jar passes
   * the ordered case and fails intermittently under concurrency, where the jar is shared mutable
   * state between iterations in flight together.
   */
  it('keeps them isolated under parallel, on every run', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await runFlow(flow('r4f-cookies-dataset.flow.yml'), {
        responses: {
          createThing: (request) => ({
            status: 201,
            body: { data: { id: 'thing-1' } },
            setCookie: `sid=${request.body.value.name}`
          }),
          getThing: fetched
        }
      });

      const byIteration = new Map();
      for (const entry of run.calls.filter((call) => call.operationId === 'getThing')) {
        byIteration.set(entry.iteration, entry.cookie);
      }

      // Row n's read carries row n's session — the assertion a run-wide jar fails on timing alone.
      expect([...byIteration.values()].sort()).toEqual(['sid=alpha', 'sid=beta', 'sid=gamma']);
    }
  });

  /** §12.3 is not violated: a jar is ambient transport configuration, not anything the flow names. */
  it('hands a sub-flow the caller\'s jar, in both directions', async () => {
    const run = await runFlow(flow('r4f-cookies-subflow.flow.yml'), {
      responses: { createThing: created, getThing: fetched }
    });

    expect(run.outcome('read')).toBe('success');
    // The sub-flow received the Set-Cookie; the caller's later step sees it.
    expect(run.call('getThing', 1).cookie).toBe('sid=a');
    expect(new Set(run.calls.map((entry) => entry.jar)).size).toBe(1);
  });
});

/**
 * §13.2's results carry the step's `name:` and `meta:` alongside its id, because a report keyed on
 * either has to key every row: a suite where the skipped and sub-flow rows lost their case id would
 * import into a test manager as a partially unrecognised run.
 */
describe('a step result carries the step\'s name and meta', () => {
  const RESPONSES = {
    login: { status: 200, body: { data: { access_token: 'tok-user', user: { id: 'cust-7' } } } },
    createOrder: { status: 201, body: { data: { id: 'ord-1' } } },
    createQuote: { status: 200, body: { data: { quote: { id: 'q_a1', amount: 4200 } } } },
    getRates: { status: 200, body: { data: { rates: [{ id: 'r_b7', amount: 3900 }] } } },
    bookShipment: { status: 200, body: { data: { order_id: 'ord-1', tracking: 'TRK-1' } } },
    cancelOrder: { status: 200, body: { data: { id: 'ord-1', state: 'cancelled' } } }
  };

  let run;

  beforeAll(async () => {
    // The sub-flow is labelled in its own file, which is where the assertion below has to come
    // from: an internal step's metadata is the sub-flow's to declare, not the caller's.
    const library = variant('f2-login.flow.yml', (document) => {
      Object.assign(document.steps[0], { name: 'Sign in', meta: { testId: 'C0001' } });
    });
    const caller = variant('f2-order-fulfillment.flow.yml', (document) => {
      const step = (id) => document.steps.find((entry) => entry.id === id);
      step('auth').uses = './f2-login.variant.flow.yml';
      Object.assign(step('auth'), { name: 'Authenticate', meta: { testId: 'C1000' } });
      Object.assign(step('create_order'), {
        name: 'Create the order',
        meta: { testId: 2001, owner: 'payments', tags: ['smoke'] }
      });
      Object.assign(step('quote_fallback'), { name: 'Fallback quote', meta: { testId: 'C3000' } });
    });

    run = await runFlow(caller.entry, {
      responses: RESPONSES,
      files: { ...library.files, ...caller.files }
    });
  });

  it('labels a step that ran, without coercing what it declared', () => {
    expect(run.outcome('create_order')).toBe('success');
    expect(run.step('create_order')).toMatchObject({
      name: 'Create the order',
      meta: { testId: 2001, owner: 'payments', tags: ['smoke'] }
    });
  });

  it('labels a step that never ran', () => {
    expect(run.outcome('quote_fallback')).toBe('skipped:unmet-dependency');
    expect(run.step('quote_fallback')).toMatchObject({ name: 'Fallback quote', meta: { testId: 'C3000' } });
  });

  it('labels a sub-flow internal from its own file, and the container from the caller', () => {
    expect(run.step('auth/login')).toMatchObject({ name: 'Sign in', meta: { testId: 'C0001' } });
    expect(run.step('auth')).toMatchObject({ name: 'Authenticate', meta: { testId: 'C1000' } });
  });

  // A key opened and left empty is not a label, and `StepResult.name` is read straight into a JUnit
  // testcase property — "null" there would be a name nobody wrote.
  it('leaves a step whose name: says nothing without one', async () => {
    const { entry, files } = variant(flow('r1-dead-service.flow.yml'), (document) => {
      document.steps.find((step) => step.id === 'create').name = null;
      document.steps.find((step) => step.id === 'consume').name = '   ';
    });
    const bare = await runFlow(entry, { files, responses: { createThing: CREATED, getThing: STATE } });

    expect(bare.step('create')).not.toHaveProperty('name');
    expect(bare.step('consume')).not.toHaveProperty('name');
  });

  it('says nothing for a step that declares none', () => {
    expect(run.step('quote_primary').name).toBeUndefined();
    expect(run.step('quote_primary')).not.toHaveProperty('meta');
  });

  // The stream and the result are two views of one outcome (§13.2), so a reporter reading events
  // and one reading `RunResult` must not see different rows. Compared as a set, because a sub-flow
  // internal ends before the container it is inside and the two views order that pair differently.
  it('reports the same labels on step:end as on the result', () => {
    const label = (step) => `${step.id}|${step.name}|${JSON.stringify(step.meta)}`;
    const ended = run.events.filter((event) => event.type === 'step:end');

    expect(ended.map((event) => label(event.result)).sort()).toEqual(
      run.iterations[0].steps.map(label).sort()
    );
    // §13.2 requires every event to survive the clone, which a verbatim mapping has to as well.
    expect(structuredClone(ended.find((event) => event.result.id === 'auth/login').result).meta).toEqual({
      testId: 'C0001'
    });
  });
});

/**
 * §13.2's `origin` — who started a run and against what.
 *
 * The engine records it and reads no part of it. Reported in three places because three different
 * readers need it at three different moments: the manifest for a history that has not opened the
 * run (§14.5), `run:start` for a view watching one in flight (002 §10), and the result for a
 * reporter writing it out (§14.8). All three are the same object, so none can contradict another.
 */
describe('a run records where it came from', () => {
  const ORIGIN = { host: 'cli', environment: 'staging', globalEnvironment: 'shared' };

  const started = (run) => run.events.find((event) => event.type === 'run:start');

  it('reports it on the stream, on the result and in the manifest', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE },
      origin: ORIGIN
    });

    expect(started(run).origin).toEqual(ORIGIN);
    expect(run.result.origin).toEqual(ORIGIN);
    expect(run.files.json(path.join(run.captureDir, 'run.json')).origin).toEqual(ORIGIN);
  });

  // A host reporting only which side it ran from says nothing about environments, and an absent
  // name must not become an empty one.
  it('carries only what the host named', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE },
      origin: { host: 'app' }
    });

    expect(run.result.origin).toEqual({ host: 'app' });
    expect(run.result.origin).not.toHaveProperty('environment');
  });

  it('says nothing at all when the host named nothing', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE }
    });

    expect(run.result).not.toHaveProperty('origin');
    expect(started(run)).not.toHaveProperty('origin');
    expect(run.files.json(path.join(run.captureDir, 'run.json'))).not.toHaveProperty('origin');
  });

  // §13.2 requires every event to survive the clone; these are plain strings, so it does.
  it('survives the clone the event stream requires', async () => {
    const run = await runFlow(flow('r1-dead-service.flow.yml'), {
      responses: { createThing: CREATED, getThing: STATE },
      origin: ORIGIN
    });

    expect(structuredClone(started(run)).origin).toEqual(ORIGIN);
  });
});
