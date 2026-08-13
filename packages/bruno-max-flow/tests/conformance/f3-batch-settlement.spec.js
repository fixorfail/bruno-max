/**
 * F3 — Batch settlement with privilege escalation (001-C §5).
 *
 * Pins §7.3's typed whole-value interpolation, §8.1's structured outputs, and §6.4's lexical
 * profiles and ancestor rule. Findings 6 (interpolation stringified everything) and 7 (structured
 * outputs unspecified).
 */
const { runFlow, validate, variant } = require('./harness');

const FLOW = 'f3-batch-settlement.flow.yml';

/**
 * The id is what `batchId` extracts and what the `label` assertion embeds, and the 12-element
 * array is what `itemCount` counts, so both are pinned here rather than left to the fixture.
 */
const BATCH = {
  id: 'B-42',
  ref: 'BATCH-2026-08-06/EU/0042',
  items: Array.from({ length: 12 }, (unused, index) => ({ id: `i-${index}`, amount: 100 })),
  reconciled: true,
  tags: ['eu', 'monthly']
};

const responses = (overrides = {}) => ({
  login: { status: 200, body: { data: { access_token: 'tok-user', user: { id: 'op-1' } } } },
  getOpenBatch: { status: 200, body: { data: { batch: BATCH } } },
  elevate: { status: 200, body: { data: { access_token: 'tok-elevated' } } },
  submitSettlement: { status: 202, body: { data: { id: 'set-1', state: 'accepted' } } },
  createRecord: { status: 201, body: { data: { id: 'rec-1' } } },
  ...overrides
});

/**
 * F3.1 asserts that a boolean and an array survive a whole-value reference, and number is the
 * common case but not the only one. `audit-v1.yml` carries `reconciled` and `tags` for exactly
 * this, deliberately without examples so §7.1 does not seed them into every other request.
 */
const withTypedFields = () =>
  variant(FLOW, (flow) => {
    const batch = flow.steps.find((step) => step.id === 'get_batch');
    batch.outputs.reconciled = 'data.batch.reconciled';
    batch.outputs.tags = 'data.batch.tags';

    const record = flow.steps.find((step) => step.id === 'create_audit_record');
    record.body.reconciled = '{{steps.get_batch.reconciled}}';
    record.body.tags = '{{steps.get_batch.tags}}';
  });

describe('F3.1 — types survive a whole-value reference', () => {
  let run;

  beforeAll(async () => {
    const { entry, files } = withTypedFields();
    run = await runFlow(entry, { responses: responses(), files });
  });

  it('passes every step', () => {
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  // Finding 6. A stringifying implementation passes `region` and `label` and fails only on the
  // typed fields, so those are asserted by identity — a loose comparison lets the defect through.
  it('sends a number as a number', () => {
    const body = run.call('createRecord').json;
    expect(body.item_count).toBe(12);
    expect(typeof body.item_count).toBe('number');
  });

  it('sends a boolean and an array unflattened', () => {
    const body = run.call('createRecord').json;
    expect(body.reconciled).toBe(true);
    expect(typeof body.reconciled).toBe('boolean');
    expect(body.tags).toEqual(['eu', 'monthly']);
    expect(Array.isArray(body.tags)).toBe(true);
  });

  it('leaves a string a string and stringifies an embedded reference', () => {
    const body = run.call('createRecord').json;
    expect(body.region).toBe('EU');
    expect(body.label).toBe('batch B-42 (EU)');
  });
});

describe('F3.2 — one derivation, two consumers', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, { responses: responses() });
  });

  it('gives both consumers the derived region', () => {
    expect(run.call('submitSettlement').json).toEqual({ region: 'EU', sequence: '0042' });
    expect(run.call('createRecord').json.region).toBe('EU');
  });

  it('substitutes the batch id into the settlement path', () => {
    expect(run.call('submitSettlement').url).toBe('https://billing.example.com/batches/B-42/settlement');
  });

  // Counting invocations is what distinguishes a structured output from three scripts that happen
  // to agree (§8.1). The count is the whole assertion: `RunScript` takes a `FlowContext` (§13.2),
  // so which step ran a script is not something the port is told.
  it('runs the output script exactly once', () => {
    expect(run.scripts.filter((script) => script.source.includes('itemCount'))).toHaveLength(1);
  });

  it('keeps the derived value structured on the step result', () => {
    expect(run.step('get_batch').outputs).toEqual({
      batchId: 'B-42',
      batch: { region: 'EU', sequence: '0042', itemCount: 12 }
    });
  });
});

describe('F3.3 — the auth token changes mid-flow', () => {
  // §13.2 hands the host a declarative `auth`, so what a scenario reads as "the Authorization
  // header" is asserted on the resolved profile the engine computed.
  it('authorizes the escalation with the credential being escalated', async () => {
    const run = await runFlow(FLOW, { responses: responses() });

    expect(run.call('getOpenBatch').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-user' } });
    expect(run.call('elevate').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-user' } });
    expect(run.call('createRecord').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-user' } });
    expect(run.call('submitSettlement').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-elevated' } });
  });
});

describe('F3.4 — a profile\'s step reference is a real dependency', () => {
  // Without §6.4's ancestor rule this is a 401 at run time that reads like a credentials problem.
  it('fails validation when the elevating step is not an ancestor', async () => {
    const { entry, files } = variant(FLOW, (flow) => {
      flow.steps.find((step) => step.id === 'submit_settlement').depends = ['get_batch'];
    });

    const diagnostics = await validate(entry, { files });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

    expect(errors).not.toHaveLength(0);
    expect(errors).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        stepId: 'submit_settlement',
        message: expect.stringContaining('elevated-token')
      })
    );
    expect(errors.map((error) => error.message).join('\n')).toContain('steps.elevate');
  });

  it('validates the committed fixture clean', async () => {
    const diagnostics = await validate(FLOW);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});
