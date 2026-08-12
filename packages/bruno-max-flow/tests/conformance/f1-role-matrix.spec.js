/**
 * F1 — Role matrix (001-C §3).
 *
 * Pins §9.4 dataset iteration, §10.2 assertion context, §10.3 negative tests and §6.4 profiles
 * resolving per iteration. Findings 1 (assertions could not see `row.*`), 2 (an inserted branch
 * rewired the implicit sequence) and 3 (a dataset carrying credentials).
 *
 * F1.4 is a static assertion with no execution and lives in `fixtures.spec.js` beside the corpus's
 * other structural guards.
 */
const { runFlow } = require('./harness');

const FLOW = 'f1-role-matrix.flow.yml';

/** `fixtures/datasets/roles.csv`, in file order — iteration 0 is admin, 2 is viewer. */
const ROWS = [
  { role: 'admin', canCreate: true },
  { role: 'editor', canCreate: true },
  { role: 'viewer', canCreate: false }
];

const CREATED = { status: 201, body: { data: { id: 'prod-1' } } };
const FORBIDDEN = { status: 403, body: { error: { message: 'insufficient role' } } };

const responses = (overrides = {}) => ({
  login: (request, ctx) => ({
    status: 200,
    body: { data: { access_token: `tok-${ROWS[ctx.iteration].role}` } }
  }),
  getMe: (request, ctx) => ({
    status: 200,
    body: { data: { id: 'u-1', role: ROWS[ctx.iteration].role } }
  }),
  addProduct: (request, ctx) => (ROWS[ctx.iteration].canCreate ? CREATED : FORBIDDEN),
  getProduct: { status: 200, body: { data: { id: 'prod-1', name: 'Widget', price: 1299 } } },
  deleteProduct: { status: 204 },
  ...overrides
});

const CREATOR = {
  login: 'success',
  me: 'success',
  add_product: 'success',
  add_product_denied: 'skipped:condition-false',
  get_product: 'success',
  cleanup_leak: 'skipped:unresolved-dependency'
};

const DENIED = {
  login: 'success',
  me: 'success',
  add_product: 'skipped:condition-false',
  add_product_denied: 'success',
  get_product: 'skipped:unmet-dependency',
  cleanup_leak: 'skipped:unresolved-dependency'
};

describe('F1.1 — happy path, all three roles behave', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, { responses: responses() });
  });

  it('runs one iteration per row', () => {
    expect(run.iterations).toHaveLength(3);
    expect(run.iterations.map((iteration) => iteration.row.role)).toEqual(['admin', 'editor', 'viewer']);
  });

  it('gives the two creating roles the same table', () => {
    expect(run.table(0)).toEqual(CREATOR);
    expect(run.table(1)).toEqual(CREATOR);
  });

  it('gives the viewer the inverse table', () => {
    expect(run.table(2)).toEqual(DENIED);
  });

  // Every skip above is `condition-false` or `unmet-dependency`, and `cleanup_leak` carries
  // `failOnUnresolved: false` — so §11.2's default leaves this run green. An implementation that
  // fails the flow on *any* skip turns the whole table red.
  it('passes, and exits 0', () => {
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  // §10.3: a negative test passing is the whole point. An implementation that treats 4xx as a
  // failure regardless of assertions goes green on every other test here and wrong on this one.
  it('records the denied creation as a success on its 403', () => {
    const denied = run.step('add_product_denied', 2);
    expect(denied.status).toBe('success');
    expect(denied.reason).toBeUndefined();
    expect(denied.assertions).toEqual([
      expect.objectContaining({ expr: 'res.status eq 403', passed: true })
    ]);
  });

  // §6.4: the profile reads `{{steps.login.token}}`, which is a different value per iteration.
  it('resolves the auth profile against its own iteration', () => {
    expect(run.callsFor('getMe').map((call) => call.auth)).toEqual([
      { mode: 'bearer', token: 'tok-admin' },
      { mode: 'bearer', token: 'tok-editor' },
      { mode: 'bearer', token: 'tok-viewer' }
    ]);
  });

  it('sends the row email and never a dataset-supplied password', () => {
    expect(run.callsFor('login').map((call) => call.json.email)).toEqual([
      'admin@example.com',
      'editor@example.com',
      'viewer@example.com'
    ]);
    // Finding 3: the credential comes from the environment, not from a column.
    expect(run.call('login').json.password).toBe('hunter2');
  });

  it('interpolates the run and iteration into the product name', () => {
    const created = run.callsFor('addProduct');
    expect(created[0].json.name).toBe(`Widget ${run.result.runId}-0`);
    expect(created[1].json.name).toBe(`Widget ${run.result.runId}-1`);
    expect(created[2].json.name).toBe(`Widget ${run.result.runId}-2`);
  });

  it('reaches the deletion endpoint on no iteration', () => {
    expect(run.callsFor('deleteProduct')).toHaveLength(0);
  });
});

describe('F1.2 — the role claim is wrong for one row', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, {
      responses: responses({
        getMe: (request, ctx) => ({
          status: 200,
          body: { data: { id: 'u-1', role: ctx.iteration === 2 ? 'admin' : ROWS[ctx.iteration].role } }
        })
      })
    });
  });

  it('fails only the iteration whose claim drifted', () => {
    expect(run.outcome('me', 0)).toBe('success');
    expect(run.outcome('me', 1)).toBe('success');
    expect(run.outcome('me', 2)).toBe('failed:assertion-failed');
  });

  // Finding 1. An engine whose assertion context lacks `row.*` either throws on an unresolved
  // identifier or silently compares against `undefined`; naming both values is what rules the
  // second one out.
  it('names the expected and the actual role', () => {
    expect(run.step('me', 2).assertions).toEqual([
      { expr: 'res.body.data.role eq row.role', passed: false, expected: 'viewer', actual: 'admin' }
    ]);
  });

  it('stops the rest of that iteration and fails the run', () => {
    expect(run.table(2)).toEqual({
      login: 'success',
      me: 'failed:assertion-failed',
      add_product: 'skipped:unmet-dependency',
      add_product_denied: 'skipped:unmet-dependency',
      get_product: 'skipped:unmet-dependency',
      cleanup_leak: 'skipped:unresolved-dependency'
    });
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });
});

describe('F1.3 — RBAC is broken and the negative test catches it', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, {
      responses: responses({
        addProduct: { status: 201, body: { data: { id: 'leaked-1' } } }
      })
    });
  });

  it('fails the step that asserted the denial', () => {
    const denied = run.step('add_product_denied', 2);
    expect(denied.status).toBe('failed');
    expect(denied.reason).toBe('assertion-failed');
    expect(denied.assertions).toEqual([
      { expr: 'res.status eq 403', passed: false, expected: 403, actual: 201 }
    ]);
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  // §10.3's rule that a negative step declares `outputs:` anyway: §11.2 extracts them because a
  // response arrived, so the resource the bug created is reachable.
  it('extracts the leaked id despite the failed assertion', () => {
    expect(run.step('add_product_denied', 2).outputs).toEqual({ leakedProductId: 'leaked-1' });
  });

  // An implementation that skips cleanup here leaks a resource on exactly the run that found a bug.
  it('deletes the product the bug created', () => {
    expect(run.outcome('cleanup_leak', 2)).toBe('success');
    const deletions = run.callsFor('deleteProduct');
    expect(deletions).toHaveLength(1);
    expect(deletions[0].url).toBe('https://shop.example.com/products/leaked-1');
  });

  it('leaves the two creating roles unchanged', () => {
    expect(run.table(0)).toEqual(CREATOR);
    expect(run.table(1)).toEqual(CREATOR);
  });
});
