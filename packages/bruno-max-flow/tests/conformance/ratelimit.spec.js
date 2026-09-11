/**
 * §6.2's `rateLimit:` — per-API pacing, spec 004.
 *
 * Every assertion here is on `run.sleeps`, the sequence of durations the run asked the injected
 * clock for. That is the only place the limiter's behaviour is visible: a bucket that did nothing
 * and a bucket that paced perfectly produce the same requests in the same order, and differ solely
 * in what was waited between them.
 *
 * The fixtures under `fixtures/flows/ratelimit/` are therefore written to keep the sleep log clean —
 * no `retry:` delays, no `delayMs` stubs — because the harness clock is global and advances on
 * whatever sleeps, so an unrelated delay elsewhere in the flow would both pollute the sequence and
 * refill the bucket under it.
 */
const path = require('path');

const { runFlow, validate, variant, FLOWS } = require('./harness');

const flow = (name) => `ratelimit/${name}`;

/** §8.5's fixture scope, reused here because a connector file is where 004 §5's default lives. */
const CONNECTOR_WORKSPACE = path.join(FLOWS, 'connectors');
const CONNECTOR_SCOPE = {
  workspaceRoot: CONNECTOR_WORKSPACE,
  collectionRoot: path.join(CONNECTOR_WORKSPACE, 'collections', 'payments')
};
const connectorFlow = (name) => `connectors/collections/payments/flows/${name}`;

const OK = { status: 200, body: { ok: true } };
const PINGS = { pingA: OK, pingB: OK, pingC: OK, pingD: OK };
const ECHOES = { echoA: OK, echoB: OK };

describe('004 §7 — a declared limit paces what goes out', () => {
  it('spaces four ready steps a second apart', async () => {
    const run = await runFlow(flow('spacing.flow.yml'), { responses: PINGS });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(4);
    // Three waits for four requests: the first is entitled to go at once.
    expect(run.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('lets a burst allowance through before it starts spacing', async () => {
    const run = await runFlow(flow('burst.flow.yml'), { responses: PINGS });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(4);
    // burst: 3 — three tokens are there to be taken, and only the fourth waits for one.
    expect(run.sleeps).toEqual([1000]);
  });

  it('reports the wait beside the step, and out of the attempt', async () => {
    const run = await runFlow(flow('spacing.flow.yml'), { responses: PINGS });

    // Whichever step went first waited for nothing; the rest waited their turn.
    const waits = ['a', 'b', 'c', 'd'].map((id) => run.step(id).rateLimitWaitMs);
    expect(waits.filter((wait) => wait === undefined)).toHaveLength(1);
    expect(waits.filter((wait) => wait === 1000)).toHaveLength(3);

    // §14.5's attempt record answers "how long did the API take", so the pacing is not in it.
    const paced = ['a', 'b', 'c', 'd'].find((id) => run.step(id).rateLimitWaitMs === 1000);
    const capture = await run.readCapture({ stepId: paced, attempt: 1 });
    expect(capture.rateLimitWaitMs).toBe(1000);
    expect(capture.durationMs).toBe(0);
  });
});

describe('004 §3 — a bucket belongs to one API document', () => {
  it('leaves an unlimited binding alone', async () => {
    const run = await runFlow(flow('two-apis.flow.yml'), { responses: { ...PINGS, ...ECHOES } });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(4);
    // Only the second request to the paced document waits; neither echo does.
    expect(run.sleeps).toEqual([1000]);
  });

  it('shares one bucket between two aliases for the same document', async () => {
    const run = await runFlow(flow('alias-pair.flow.yml'), { responses: PINGS });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(3);
    // The second alias declares no limit of its own and is paced by the first's all the same.
    expect(run.sleeps).toEqual([1000, 1000]);
  });

  it('paces a sub-flow out of the same bucket as its caller', async () => {
    const run = await runFlow(flow('subflow.flow.yml'), { responses: PINGS });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(3);
    expect(run.sleeps).toEqual([1000, 1000]);
  });
});

describe('004 §7 — every attempt takes a token', () => {
  it('paces a retry as it paces a first attempt', async () => {
    const run = await runFlow(flow('retry.flow.yml'), {
      responses: { pingA: { status: 500, body: { error: 'boom' } } }
    });

    expect(run.outcome('flaky')).toBe('failed:retries-exhausted');
    expect(run.calls).toHaveLength(3);
    // The fixture's retry delay is 0, so every entry here is the limiter's.
    expect(run.sleeps).toEqual([1000, 1000]);
    expect(run.step('flaky').rateLimitWaitMs).toBe(2000);
    expect((await run.readCapture({ stepId: 'flaky', attempt: 2 })).rateLimitWaitMs).toBe(1000);
    expect((await run.readCapture({ stepId: 'flaky', attempt: 1 })).rateLimitWaitMs).toBeUndefined();
  });
});

describe('004 §7 — a wait the run has no time for is refused', () => {
  it('ends the step on its budget rather than waiting the hour out', async () => {
    const run = await runFlow(flow('deadline.flow.yml'), { responses: PINGS });

    expect(run.outcome('second')).toBe('failed:max-duration-exceeded');
    // The request was never sent: the step spent its whole budget queueing for a token.
    expect(run.calls).toHaveLength(1);
    expect(run.sleeps).toEqual([1000]);
  });
});

describe('004 §8 — --no-rate-limit', () => {
  it('ignores every declared limit', async () => {
    const run = await runFlow(flow('spacing.flow.yml'), {
      responses: PINGS,
      overrides: { rateLimit: { enabled: false } }
    });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(4);
    expect(run.sleeps).toEqual([]);
  });
});

describe('004 §6 — validation', () => {
  it('accepts a well-formed limit', async () => {
    expect(await validate(flow('spacing.flow.yml'))).toEqual([]);
  });

  it('warns when two flows bind one document at different rates', async () => {
    const diagnostics = await validate(flow('conflict.flow.yml'));

    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'conflicting-rate-limit' })
    ]);
  });

  it('takes the stricter of two disagreeing rates', async () => {
    const run = await runFlow(flow('conflict.flow.yml'), { responses: PINGS });

    expect(run.status).toBe('passed');
    expect(run.calls).toHaveLength(2);
    // The child asks for two a second; the parent's one a second governs both.
    expect(run.sleeps).toEqual([1000]);
  });

  it('refuses a limit that is not a number', async () => {
    const { entry, files } = variant(flow('spacing.flow.yml'), (document) => {
      document.apis.paced.rateLimit = { requests: '{{rps}}' };
    });

    expect(await validate(entry, { files })).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'invalid-rate-limit' })])
    );
  });

  it('refuses the scalar shorthand an author reaches for first', async () => {
    const { entry, files } = variant(flow('spacing.flow.yml'), (document) => {
      document.apis.paced.rateLimit = 5;
    });

    expect(await validate(entry, { files })).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'invalid-rate-limit' })])
    );
  });
});

describe('004 §5 — a connector file declares a service\'s rate once', () => {
  it('paces a flow that declares no limit of its own', async () => {
    const run = await runFlow(connectorFlow('rate-limit-inherit.flow.yml'), {
      scope: CONNECTOR_SCOPE,
      responses: PINGS
    });

    expect(run.status).toBe('passed');
    expect(run.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('defers to a flow that declares one', async () => {
    const run = await runFlow(connectorFlow('rate-limit-override.flow.yml'), {
      scope: CONNECTOR_SCOPE,
      responses: PINGS
    });

    expect(run.status).toBe('passed');
    // The flow's own burst covers all four steps; the connector file's single token would not have.
    expect(run.sleeps).toEqual([]);
  });

  it('names a misspelt binding property in a connector file', async () => {
    const diagnostics = await validate(connectorFlow('rate-limit-inherit.flow.yml'), {
      scope: CONNECTOR_SCOPE,
      files: {
        [path.join(CONNECTOR_SCOPE.collectionRoot, 'flows', 'connectors.yml')]: [
          'version: 1',
          'apis:',
          '  paced:',
          '    source: ../../../../../specs/paced-v1.yml',
          '    ratelimit:',
          '      requests: 1',
          'connectors: {}'
        ].join('\n')
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'unknown-property', message: expect.stringContaining('rateLimit') })
      ])
    );
  });
});
