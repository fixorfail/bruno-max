/**
 * F4 — Partner item acceptance (001-C §6).
 *
 * Pins §6.3's per-step base URL resolution, §8.1's script-form filtering, §11.1's polling and
 * `retries-exhausted`, and §6.2's three bindings with three auth regimes. Findings 9 (`[?]`
 * unusable in a path) and 11 (base URLs produced by a step).
 */
const { runFlow, validate, variant } = require('./harness');

const FLOW = 'f4-partner-acceptance.flow.yml';
const TENANT_FLOW = 'f4-tenant-parent.flow.yml';

const PARTNERSHIPS = [
  { id: 'ps-1', status: 'pending', role: 'owner' },
  { id: 'ps-2', status: 'active', role: 'owner' },
  { id: 'ps-3', status: 'active', role: 'member' }
];

const responses = (overrides = {}) => ({
  login: { status: 200, body: { data: { access_token: 'tok-user', user: { id: 'op-1' } } } },
  listPartnerships: { status: 200, body: { data: { partnerships: PARTNERSHIPS } } },
  getPartnership: {
    status: 200,
    body: { data: { partnership: { id: 'ps-2', account: { id: 'acct-9' } } } }
  },
  createItem: { status: 201, body: { data: { item: { id: 'item-3' } } } },
  getItemStatus: [
    { status: 200, body: { data: { status: 'pending' } } },
    { status: 200, body: { data: { status: 'pending' } } },
    { status: 200, body: { data: { status: 'initiated' } } }
  ],
  getHandoff: { status: 200, body: { data: { handoff: { ref: 'ho-77' } } } },
  createSession: { status: 200, body: { data: { session_token: 'tok-partner' } } },
  acceptItem: { status: 200, body: { data: { status: 'accepted' } } },
  ...overrides
});

const pendingForever = { status: 200, body: { data: { status: 'pending' } } };

describe('F4.1 — happy path across three services', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, { responses: responses() });
  });

  it('passes every step', () => {
    expect(run.table()).toEqual({
      'login': 'success',
      'login/login': 'success',
      'partnerships': 'success',
      'partnership_details': 'success',
      'create_item': 'success',
      'await_initiated': 'success',
      'handoff': 'success',
      'exchange_handoff': 'success',
      'accept_item': 'success'
    });
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  // Finding 9: the filter is a script because `[?]` cannot express it in a declarative path.
  it('locates the matching partnership rather than the first', () => {
    expect(run.step('partnerships').outputs).toEqual({ partnershipId: 'ps-2' });
    expect(run.call('getPartnership').url).toBe('https://user.example.com/partnerships/ps-2');
  });

  it('polls until the item is initiated and no further', () => {
    expect(run.callsFor('getItemStatus')).toHaveLength(3);
    expect(run.step('await_initiated').attempts).toBe(3);
  });

  // §6.3: each binding resolves its own base URL, so one run reaches four distinct hosts.
  it('sends each request to the base URL of its own binding', () => {
    expect(run.call('createItem').url).toBe('https://user.example.com/items');
    expect(run.call('getItemStatus').url).toBe('https://items.example.com/items/item-3/status');
    expect(run.call('createSession').url).toBe('https://external.example.com/sessions/ho-77');
    expect(run.call('acceptItem').url).toBe('https://items.example.com/items/item-3/accept');
  });

  // A step-level `auth:` overriding a binding's `auth: none` must not leak backwards onto the
  // binding's other steps.
  it('leaves the unauthenticated binding unauthenticated', () => {
    expect(run.call('acceptItem').auth).toEqual({ mode: 'bearer', token: 'tok-partner' });
    expect(run.call('getItemStatus').auth).toEqual({ mode: 'none' });
    expect(run.call('getHandoff').auth).toEqual({ mode: 'none' });
    expect(run.call('createSession').auth).toEqual({ mode: 'none' });
  });
});

describe('F4.2 — no partnership matches', () => {
  const unmatched = {
    listPartnerships: {
      status: 200,
      body: {
        data: {
          partnerships: [
            { id: 'ps-1', status: 'pending', role: 'owner' },
            { id: 'ps-3', status: 'active', role: 'member' }
          ]
        }
      }
    }
  };

  /** The same fixture with its `isDefined` assertion removed — F4.2's backstop half. */
  const withoutAssertion = (mutate) =>
    variant(FLOW, (flow) => {
      const step = flow.steps.find((entry) => entry.id === 'partnerships');
      delete step.assert;
      if (mutate) mutate(flow);
    });

  it('fails at the step that does the locating', async () => {
    const run = await runFlow(FLOW, { responses: responses(unmatched) });

    // The requirement is that the partnership be *located*, so failing one step later would
    // report that the flow could not proceed instead of why.
    expect(run.outcome('partnerships')).toBe('failed:assertion-failed');
    expect(run.step('partnerships').assertions).toEqual([
      expect.objectContaining({ expr: 'steps.partnerships.partnershipId isDefined', passed: false })
    ]);
    expect(run.outcome('partnership_details')).toBe('skipped:unmet-dependency');
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  // §8.1: a `find()` returning `undefined` yields no output. An implementation that coerces it to
  // `"undefined"` sends a request to `/partnerships/undefined` and gets a confusing 404 instead.
  it('produces no output and dispatches nothing for the consumer', async () => {
    const run = await runFlow(FLOW, { responses: responses(unmatched) });

    expect(run.step('partnerships').outputs).toEqual({});
    expect(run.callsFor('getPartnership')).toHaveLength(0);
  });

  it('still fails the run through failOnUnresolved when nobody asserted', async () => {
    const { entry, files } = withoutAssertion();
    const run = await runFlow(entry, { responses: responses(unmatched), files });

    expect(run.outcome('partnerships')).toBe('success');
    expect(run.outcome('partnership_details')).toBe('skipped:unresolved-dependency');
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  // The flag must change only the flow's verdict, never which steps ran.
  it('changes the verdict and not the schedule when switched off', async () => {
    const strict = withoutAssertion();
    const lenient = withoutAssertion((flow) => {
      flow.config = { ...flow.config, failOnUnresolved: false };
    });

    const strictRun = await runFlow(strict.entry, { responses: responses(unmatched), files: strict.files });
    const lenientRun = await runFlow(lenient.entry, {
      responses: responses(unmatched),
      files: lenient.files
    });

    expect(lenientRun.table()).toEqual(strictRun.table());
    expect(lenientRun.status).toBe('passed');
    expect(lenientRun.exitCode).toBe(0);
  });
});

describe('F4.3 — the poll never settles', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, { responses: responses({ getItemStatus: pendingForever }) });
  });

  // An off-by-one in the `maxAttempts` cap is invisible at any other count, and §11.1 makes the
  // cap a hard guarantee rather than a hint.
  it('stops at exactly maxAttempts', () => {
    expect(run.callsFor('getItemStatus')).toHaveLength(30);
    expect(run.step('await_initiated').attempts).toBe(30);
  });

  it('fails with retries-exhausted and names the awaited state', () => {
    expect(run.outcome('await_initiated')).toBe('failed:retries-exhausted');
    expect(run.step('await_initiated').assertions).toEqual([
      expect.objectContaining({ expr: 'res.body.data.status eq initiated', passed: false })
    ]);
  });

  it('skips everything downstream and exits 1', () => {
    expect(run.outcome('handoff')).toBe('skipped:unmet-dependency');
    expect(run.outcome('exchange_handoff')).toBe('skipped:unmet-dependency');
    expect(run.outcome('accept_item')).toBe('skipped:unmet-dependency');
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  it('waits n - 1 times', () => {
    expect(run.sleeps).toHaveLength(29);
  });

  describe('the delay sequence', () => {
    // Jitter is off by default, so there is nothing to bound rather than assert — every row but
    // the last is an exact sequence.
    const withRetry = (retry) =>
      variant(FLOW, (flow) => {
        const step = flow.steps.find((entry) => entry.id === 'await_initiated');
        step.retry = { ...retry, shouldRetry: step.retry.shouldRetry };
      });

    const sleepsFor = async (retry) => {
      const { entry, files } = withRetry(retry);
      const polled = await runFlow(entry, { responses: responses({ getItemStatus: pendingForever }), files });
      return polled.sleeps;
    };

    it('repeats the base delay under the default backoff', async () => {
      expect(await sleepsFor({ maxAttempts: 4, delay: 1000 })).toEqual([1000, 1000, 1000]);
    });

    it('doubles under exponential backoff', async () => {
      expect(await sleepsFor({ maxAttempts: 6, delay: 1000, backoff: 'exponential' })).toEqual([
        1000, 2000, 4000, 8000, 16000
      ]);
    });

    it('caps each wait at maxDelay', async () => {
      expect(
        await sleepsFor({ maxAttempts: 6, delay: 1000, backoff: 'exponential', maxDelay: 5000 })
      ).toEqual([1000, 2000, 4000, 5000, 5000]);
    });

    it('caps at the 30 s default when no maxDelay is set', async () => {
      const sleeps = await sleepsFor({ maxAttempts: 12, delay: 5000, backoff: 'exponential' });
      expect(sleeps).toHaveLength(11);
      for (const sleep of sleeps) {
        expect(sleep).toBeLessThanOrEqual(30000);
      }
    });

    // A delay applied before the *first* attempt rather than before each retry is a bug that never
    // changes an outcome, only every run's duration.
    it('never waits when a step does not retry', async () => {
      expect(await sleepsFor({ maxAttempts: 1, delay: 1000 })).toEqual([]);
    });

    it('bounds rather than fixes each wait under full jitter', async () => {
      const sleeps = await sleepsFor({
        maxAttempts: 6,
        delay: 1000,
        backoff: 'exponential',
        jitter: 'full'
      });
      expect(sleeps).toHaveLength(5);
      sleeps.forEach((sleep, index) => {
        expect(sleep).toBeGreaterThanOrEqual(0);
        expect(sleep).toBeLessThanOrEqual(2 ** index * 1000);
      });
    });

    it('costs no wall-clock time', async () => {
      const startedAt = Date.now();
      await sleepsFor({ maxAttempts: 12, delay: 5000, backoff: 'exponential' });
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });
  });
});

describe('F4.4 — per-tenant subdomains', () => {
  const tenantResponses = {
    createWorkspace: { status: 201, body: { data: { workspace: { id: 'ws-1', subdomain: 'acme' } } } },
    getSettings: { status: 200, body: { data: { settings: { timezone: 'Europe/Berlin' } } } }
  };

  let run;

  beforeAll(async () => {
    run = await runFlow(TENANT_FLOW, { responses: tenantResponses });
  });

  it('resolves the unbound alias from the spec', () => {
    expect(run.call('createWorkspace').url).toBe('https://api.example.com/workspaces');
  });

  // Two aliases over the same document resolve to two different hosts in one run (§6.3).
  it('resolves the tenant alias from a value the run produced', () => {
    expect(run.call('getSettings', 1).url).toBe('https://acme.example.com/settings');
  });

  it('resolves the sub-flow\'s own binding from its declared param', () => {
    expect(run.call('getSettings', 2).url).toBe('https://acme.example.com/settings');
    expect(run.status).toBe('passed');
  });

  // A step that resolves its base URL from a value the run has not produced does not fail
  // cleanly — it sends a real request to a malformed host (§6.3).
  it('fails validation when the producing step is not an ancestor', async () => {
    const { entry, files } = variant(TENANT_FLOW, (flow) => {
      flow.steps.find((step) => step.id === 'workspace_settings').depends = [];
    });

    const diagnostics = await validate(entry, { files });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

    expect(errors).not.toHaveLength(0);
    expect(errors).toContainEqual(
      expect.objectContaining({ severity: 'error', stepId: 'workspace_settings' })
    );
    expect(errors.map((error) => error.message).join('\n')).toContain('steps.create_workspace');
  });
});
