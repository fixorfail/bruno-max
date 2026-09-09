/**
 * R12.2 — a slot leaves the flow through `exports:` (001 §12.1).
 *
 * The case §12.1 could not express before this: two branches that exclude each other, either of
 * which produces the value the caller wants. No step descends from both writers — only one of them
 * ever runs — so there is no `steps.<step>.<output>` to name, and the value the library exists to
 * produce could not cross the boundary at all.
 *
 * The fixture is deliberately joinless. A library with a join step could always have exported that
 * step's output instead; what is asserted here is a slot that nothing *inside* the flow reads.
 */
const { runFlow, validate, describeFlow } = require('./harness');

const flow = (name) => `exports/${name}`;

const SIGNED_IN = { status: 200, body: { data: { token: 'tok-1' } } };

/** Each branch posts its own `name`, so the id the caller reads says which branch produced it. */
const CHARGED = (request) => ({ status: 201, body: { data: { id: `chg-${request.body.value.name}` } } });

const responses = { signIn: SIGNED_IN, createThing: CHARGED };

/** The caller's own request, which is where the export lands as a value. */
const receipt = (run) => run.callsFor('createThing').find((call) => call.json.name === 'receipt');

describe('R12.2 — a slot-sourced export', () => {
  it('hands the caller the value the branch that ran wrote', async () => {
    const run = await runFlow(flow('caller.flow.yml'), { responses, vars: { chargeMethod: 'card' } });

    expect(run.outcome('charge/charge_card')).toBe('success');
    expect(run.outcome('charge/charge_wallet')).toBe('skipped:condition-false');
    expect(run.step('charge').outputs).toEqual({ chargeId: 'chg-card' });
    expect(receipt(run).json.ref).toBe('chg-card');
  });

  it('hands the caller the other branch\'s value when that is the one that ran', async () => {
    const run = await runFlow(flow('caller.flow.yml'), { responses, vars: { chargeMethod: 'wallet' } });

    expect(run.outcome('charge/charge_card')).toBe('skipped:condition-false');
    expect(run.outcome('charge/charge_wallet')).toBe('success');
    expect(run.step('charge').outputs).toEqual({ chargeId: 'chg-wallet' });
    expect(receipt(run).json.ref).toBe('chg-wallet');
  });

  /**
   * §11.2's rule for the root, carried across the boundary unchanged: a slot the run knows is empty
   * resolves empty, where a `steps.*` reference that resolved to nothing would skip the reader.
   */
  it('exports the empty string when no branch wrote the slot, and the caller still runs', async () => {
    const run = await runFlow(flow('caller.flow.yml'), { responses, vars: { chargeMethod: 'none' } });

    expect(run.outcome('charge/charge_card')).toBe('skipped:condition-false');
    expect(run.outcome('charge/charge_wallet')).toBe('skipped:condition-false');
    expect(run.step('charge').outputs).toEqual({ chargeId: '' });
    expect(run.outcome('receipt')).toBe('success');
    expect(receipt(run).json.ref).toBe('');
  });

  it('validates clean at both ends — the library and the call site', async () => {
    expect(await validate(flow('charge.flow.yml'))).toEqual([]);
    expect(await validate(flow('caller.flow.yml'))).toEqual([]);
  });

  /** 002 §5.6's exports panel reports the reference the file wrote, whichever root it names. */
  it('describes the export with its slot source', async () => {
    const description = await describeFlow(flow('charge.flow.yml'));

    expect(description.exports).toEqual([{ name: 'chargeId', source: 'shared.chargeId' }]);
    expect(description.slots).toEqual([
      {
        name: 'chargeId',
        writers: ['charge_card', 'charge_wallet'],
        // In declaration order, so the panel resolves the value the way the engine does: the last
        // write whose step ran.
        writes: [
          { step: 'charge_card', output: 'chargeId' },
          { step: 'charge_wallet', output: 'walletChargeId' }
        ],
        readers: []
      }
    ]);
  });
});
