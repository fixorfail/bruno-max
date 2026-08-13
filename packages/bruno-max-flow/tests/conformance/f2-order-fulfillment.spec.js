/**
 * F2 — Order fulfillment with carrier fallback (001-C §4).
 *
 * Pins §9.1's `any` joins, shared slots and cleanup ordering, §11.2's rule that outputs are
 * extracted on a failure that still got a response, §12's sub-flows and §6.2's multi-service
 * bindings. Findings 4 (the cleanup race) and 5 (negative-test framing).
 */
const { runFlow } = require('./harness');

const FLOW = 'f2-order-fulfillment.flow.yml';

const responses = (overrides = {}) => ({
  login: { status: 200, body: { data: { access_token: 'tok-user', user: { id: 'cust-7' } } } },
  createOrder: { status: 201, body: { data: { id: 'ord-1' } } },
  createQuote: { status: 200, body: { data: { quote: { id: 'q_a1', amount: 4200 } } } },
  getRates: { status: 200, body: { data: { rates: [{ id: 'r_b7', amount: 3900 }] } } },
  bookShipment: { status: 200, body: { data: { order_id: 'ord-1', tracking: 'TRK-1' } } },
  cancelOrder: { status: 200, body: { data: { id: 'ord-1', state: 'cancelled' } } },
  ...overrides
});

describe('F2.1 — primary carrier healthy', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, { responses: responses() });
  });

  it('skips the fallback and books through the primary', () => {
    expect(run.table()).toEqual({
      'auth': 'success',
      'auth/login': 'success',
      'create_order': 'success',
      'quote_primary': 'success',
      'quote_fallback': 'skipped:unmet-dependency',
      'book_shipment': 'success',
      'cancel_order': 'success'
    });
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
  });

  // The slot resolving to the right branch is the point; a run where both branches happen to
  // agree proves nothing, so the two carriers return distinguishable ids throughout.
  it('books with the primary quote', () => {
    expect(run.call('bookShipment').json).toEqual({ quote_id: 'q_a1' });
    expect(run.callsFor('getRates')).toHaveLength(0);
  });

  // §12.3: a sub-flow's exports are the invoking step's outputs, and the internal step appears
  // alongside its container under a namespaced id rather than nested inside it (§13.2).
  it('reads the customer id from the sub-flow export', () => {
    expect(run.step('auth').kind).toBe('subflow');
    expect(run.step('auth/login').kind).toBe('operation');
    expect(run.step('auth').outputs).toEqual({ token: 'tok-user', userId: 'cust-7' });
    expect(run.call('createOrder').json.customer_id).toBe('cust-7');
  });

  // §6.2: three bindings, three hosts, three auth regimes.
  it('sends each request to its own binding', () => {
    expect(run.call('createOrder').url).toBe('https://orders.example.com/orders');
    expect(run.call('createQuote').url).toBe('https://carrier-a.example.com/quotes');
    expect(run.call('createOrder').auth).toEqual({ mode: 'bearer', bearer: { token: 'tok-user' } });
    expect(run.call('createQuote').auth).toEqual({
      mode: 'apikey',
      apikey: { key: 'X-Api-Key', value: 'ak_carrier_a', placement: 'header' }
    });
  });
});

describe('F2.2 — both writers write, declaration order decides', () => {
  const zeroQuote = {
    createQuote: { status: 200, body: { data: { quote: { id: 'q_a1', amount: 0 } } } }
  };

  const bookedQuote = async (overrides) => {
    const run = await runFlow(FLOW, { responses: responses(zeroQuote), ...overrides });
    return { run, quoteId: run.call('bookShipment').json.quote_id };
  };

  it('runs the fallback after the primary fails its assertion', async () => {
    const { run } = await bookedQuote();
    expect(run.table()).toEqual({
      'auth': 'success',
      'auth/login': 'success',
      'create_order': 'success',
      'quote_primary': 'failed:assertion-failed',
      'quote_fallback': 'success',
      'book_shipment': 'success',
      'cancel_order': 'success'
    });
  });

  // §11.2: a response arrived, so the primary's outputs are extracted and it writes the slot even
  // though its assertion failed. Both writers therefore ran, which is what makes this the sole
  // guard on the tiebreak.
  it('extracts the failed primary\'s outputs', async () => {
    const { run } = await bookedQuote();
    expect(run.step('quote_primary').outputs).toEqual({ quoteId: 'q_a1' });
  });

  it('gives the slot to the writer declared last', async () => {
    expect((await bookedQuote()).quoteId).toBe('r_b7');
  });

  // A completion-order implementation passes at `concurrency: 1` and fails under delay injection.
  // The fallback's `depends` already orders the two writes against each other here, so this is a
  // guard on the rule rather than a way to provoke the race.
  it('gives the slot to the same writer under every schedule', async () => {
    expect((await bookedQuote({ overrides: { concurrency: 1 } })).quoteId).toBe('r_b7');
    expect((await bookedQuote({ overrides: { concurrency: 5 } })).quoteId).toBe('r_b7');

    const delayed = await bookedQuote({
      responses: responses({
        ...zeroQuote,
        getRates: { status: 200, body: { data: { rates: [{ id: 'r_b7', amount: 3900 }] } }, delayMs: 20 }
      })
    });
    expect(delayed.quoteId).toBe('r_b7');
  });

  // The primary carrier returning a zero quote is a genuine defect: the run is correctly red even
  // though the booking succeeded.
  it('fails the run even though the booking succeeded', async () => {
    const { run } = await bookedQuote();
    expect(run.outcome('book_shipment')).toBe('success');
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });
});

describe('F2.3 — cleanup does not race the booking', () => {
  // Finding 4 in executable form. An implementation where `cancel_order` depends on
  // `create_order` passes every other assertion in this file and still voids the order
  // mid-booking; only the call log catches it.
  it('dispatches the cancellation after the booking resolves', async () => {
    const run = await runFlow(FLOW, {
      responses: responses({
        bookShipment: {
          status: 200,
          body: { data: { order_id: 'ord-1', tracking: 'TRK-1' } },
          delayMs: 20
        }
      }),
      overrides: { concurrency: 5 }
    });

    expect(run.call('cancelOrder').startedAt).toBeGreaterThan(run.call('bookShipment').settledAt);
  });
});

describe('F2.4 — sub-flow failure propagates', () => {
  let run;

  beforeAll(async () => {
    run = await runFlow(FLOW, {
      responses: responses({
        login: { status: 401, body: { error: { message: 'bad credentials' } } }
      })
    });
  });

  it('fails the invoking step and names the sub-flow\'s internal step', () => {
    expect(run.step('auth/login').status).toBe('failed');
    expect(run.step('auth/login').reason).toBe('unexpected-status');
    expect(run.step('auth').status).toBe('failed');
    expect(run.step('auth').reason).toBe('subflow-failed');
  });

  it('skips everything downstream and exits 1', () => {
    expect(run.table()).toEqual({
      'auth': 'failed:subflow-failed',
      'auth/login': 'failed:unexpected-status',
      'create_order': 'skipped:unmet-dependency',
      'quote_primary': 'skipped:unmet-dependency',
      'quote_fallback': 'skipped:unmet-dependency',
      'book_shipment': 'skipped:unmet-dependency',
      'cancel_order': 'skipped:unresolved-dependency'
    });
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  it('sends nothing beyond the failed login', () => {
    expect(run.calls.map((call) => call.operationId)).toEqual(['login']);
  });
});
