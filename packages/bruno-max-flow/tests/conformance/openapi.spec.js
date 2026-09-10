/**
 * The engine against a document written the way real ones are — 001 §19.2.
 *
 * The rest of the corpus is minimal by design: schemas inline, an `operationId` on every operation,
 * no extension anywhere. Real documents are none of those things, and each construct they carry is
 * a way for the engine to do nothing quietly — a body seeded from a schema it never followed, a
 * step addressed by an identity it never indexed, a reference that leaves the file.
 *
 * The fixtures are `specs/r19-*.yml` and `flows/openapi/r19-*.flow.yml`.
 */
const { runFlow, validate, describeFlow, variant } = require('./harness');

const flow = (name) => `openapi/${name}`;

const CREATED = { status: 201, body: {} };

describe('R19.1 — a request body seeded through a $ref', () => {
  /**
   * §7.1 seeds from the operation's request schema, and nearly every real operation writes that
   * schema as a reference. A seed that stopped at the reference would send an empty body from a
   * step that looks complete, which is the shape of failure no assertion in a flow can see.
   */
  it('seeds a body through the reference the operation names', async () => {
    const run = await runFlow(flow('r19-ref-body.flow.yml'), {
      responses: { r19CreateInvoice: { status: 201, body: { invoice: { id: 'inv-1', status: 'open' } } } }
    });

    expect(run.outcome('create_invoice')).toBe('success');
    expect(run.call('r19CreateInvoice').json).toEqual({
      // The example and the default are §7.1's two reasons to seed a value rather than a placeholder.
      reference: 'INV-1',
      amount: 0,
      currency: 'USD',
      // A ref inside a ref: following the outer one and stopping would leave this key absent.
      customer: { id: '' }
    });
  });

  it('leaves out an optional property that carries neither example nor default', async () => {
    const run = await runFlow(flow('r19-ref-body.flow.yml'), {
      responses: { r19CreateInvoice: { status: 201, body: { invoice: { id: 'inv-1', status: 'open' } } } }
    });

    expect(Object.keys(run.call('r19CreateInvoice').json)).not.toContain('note');
    expect(Object.keys(run.call('r19CreateInvoice').json.customer)).not.toContain('tier');
  });

  it('reports nothing about a flow whose bodies are all seeded', async () => {
    expect(await validate(flow('r19-ref-body.flow.yml'))).toEqual([]);
  });

  it('still names a field the referenced schema does not declare', async () => {
    const { entry, files } = variant(flow('r19-ref-body.flow.yml'), (document) => {
      document.steps[0].body = { custmer: { id: 'c-1' } };
    });

    expect(await validate(entry, { files })).toEqual([
      expect.objectContaining({ code: 'unknown-field', message: expect.stringContaining('customer') })
    ]);
  });

  /**
   * §7.5 seeds no placeholder for a file, and a part is only recognizable as one once its reference
   * is followed — otherwise the seed invents an empty field, which satisfies the check that the
   * required part was supplied and uploads zero bytes.
   */
  it('seeds no placeholder for a binary part reached through a reference', async () => {
    const run = await runFlow(flow('r19-multipart-ref.flow.yml'), { responses: { r19UploadDocument: CREATED } });

    expect(run.outcome('upload')).toBe('failed:invalid-request');
    expect(run.step('upload').message).toContain('the required part document has no file');
    expect(run.callsFor('r19UploadDocument')).toEqual([]);
  });

  it('reports the missing part at validate time as well', async () => {
    expect(await validate(flow('r19-multipart-ref.flow.yml'))).toEqual([
      expect.objectContaining({ code: 'missing-binary-part' })
    ]);
  });
});

describe('R19.3 — vendor extensions', () => {
  /**
   * `x-` keys are legal anywhere in a document and tools emit them freely. The path-item ones are
   * the hazard: they sit where the methods sit, so anything reading the item by key rather than by
   * method meets `x-owner` as if it were an operation.
   */
  it('indexes only the methods of a path item that also carries an extension', async () => {
    const description = await describeFlow(flow('r19-ref-body.flow.yml'));

    expect(description.diagnostics).toEqual([]);
    expect(description.nodes.map((node) => node.operation)).toEqual([
      { api: 'real', method: 'POST', path: '/r19/invoices', operationId: 'r19CreateInvoice' }
    ]);
  });

  it('carries no extension into the request it materializes', async () => {
    const run = await runFlow(flow('r19-ref-body.flow.yml'), {
      responses: { r19CreateInvoice: { status: 201, body: { invoice: { id: 'inv-1', status: 'open' } } } }
    });
    const call = run.call('r19CreateInvoice');

    expect(Object.keys(call.headers)).toEqual([]);
    expect(call.query).toEqual([]);
    expect(Object.keys(call.json)).not.toContain('x-nullable');
  });

  /** A parameter carrying an extension is still the parameter it declares, by name and location. */
  it('holds a step to a parameter declared beside an extension', async () => {
    const { entry, files } = variant(flow('r19-ref-body.flow.yml'), (document) => {
      document.steps[0].query = { tenat: 'acme' };
    });

    expect(await validate(entry, { files })).toEqual([
      expect.objectContaining({ code: 'unknown-field', message: expect.stringContaining('query.tenat') })
    ]);
  });
});

describe('R19.4 — a schema that refers to itself', () => {
  /**
   * A schema that reaches itself has no finite seed. Terminating is the whole requirement: the seed
   * stops at the reference that closes the cycle and the step sends what it had, rather than
   * descending until the stack runs out and taking the run with it.
   */
  it('stops at the reference that closes a direct cycle', async () => {
    const run = await runFlow(flow('r19-cycles.flow.yml'), {
      responses: { r19CreateTree: CREATED, r19CreateLedger: CREATED }
    });

    expect(run.outcome('create_tree')).toBe('success');
    expect(run.call('r19CreateTree').json).toEqual({ label: '' });
  });

  it('stops at a cycle closed through a second schema', async () => {
    const run = await runFlow(flow('r19-cycles.flow.yml'), {
      responses: { r19CreateTree: CREATED, r19CreateLedger: CREATED }
    });

    expect(run.outcome('create_ledger')).toBe('success');
    expect(run.call('r19CreateLedger').json).toEqual({ id: '', entry: { amount: 0 } });
  });

  it('validates a flow bound to a cyclic document without diverging', async () => {
    expect(await validate(flow('r19-cycles.flow.yml'))).toEqual([]);
  });
});

describe('R19.2 — a step addressed by method and path', () => {
  /**
   * §6.1's second identity. A document that names none of its operations offers a step nothing else
   * to address, and both readers of a bound document — `bru flow validate` and a description — have
   * to resolve it the same way the run would.
   */
  it('resolves a step addressed by method and path', async () => {
    const description = await describeFlow(flow('r19-endpoint-fallback.flow.yml'));

    expect(description.diagnostics).toEqual([]);
    expect(description.nodes.map((node) => node.operation)).toEqual([
      { api: 'legacy', method: 'GET', path: '/r19/things', operationId: undefined },
      { api: 'legacy', method: 'POST', path: '/r19/things', operationId: undefined }
    ]);
  });

  it('reports nothing about a flow that addresses every step that way', async () => {
    expect(await validate(flow('r19-endpoint-fallback.flow.yml'))).toEqual([]);
  });

  it('still holds such a step to the operation it resolved to', async () => {
    const { entry, files } = variant(flow('r19-endpoint-fallback.flow.yml'), (document) => {
      document.steps[1].body = { nmae: 'widget' };
    });

    expect(await validate(entry, { files })).toEqual([
      expect.objectContaining({ code: 'unknown-field', message: expect.stringContaining('name') })
    ]);
  });

  it('names the reference that resolved to nothing', async () => {
    const { entry, files } = variant(flow('r19-endpoint-fallback.flow.yml'), (document) => {
      document.steps[0].operation = 'legacy#DELETE /r19/things';
    });

    expect(await validate(entry, { files })).toEqual([
      expect.objectContaining({ code: 'unknown-operation', message: expect.stringContaining('DELETE /r19/things') })
    ]);
  });
});

/**
 * R19.6 — §7.1 over a composed schema.
 *
 * The same silent shape R19.1 closed, one construct along: `seedFromSchema` switched on `type`, and
 * a composed schema usually declares none — so `allOf` and `oneOf` bodies seeded nothing and the
 * step sent an empty request while looking complete. `validate/operation.ts` composed them all
 * along, so validation and seeding disagreed about what such an operation's body even was.
 */
describe('R19.6 — a composed request body', () => {
  const responses = { r19CreatePayment: CREATED, r19CreateRefund: CREATED };

  it('seeds every branch of an allOf, and unions their required names', async () => {
    const run = await runFlow(flow('r19-composed-body.flow.yml'), { responses });

    expect(run.outcome('intersection')).toBe('success');
    // Money + Payer + the inline branch. `note` is optional and carries no example, so §7.1 leaves
    // it out exactly as it would in an uncomposed schema.
    expect(run.call('r19CreatePayment').json).toEqual({
      amount: 0,
      currency: '',
      payerId: '',
      reference: ''
    });
  });

  it('seeds the first branch of a oneOf, not a merge of the alternatives', async () => {
    const run = await runFlow(flow('r19-composed-body.flow.yml'), { responses });

    expect(run.outcome('alternatives')).toBe('success');
    // `Money` is first; a merge would have carried `voucherCode` too and satisfied neither branch.
    const sent = run.call('r19CreateRefund').json;

    expect(sent).toEqual({ amount: 0, currency: '' });
    expect(sent).not.toHaveProperty('voucherCode');
  });

  it('sends a body that its own operation would accept', async () => {
    // The seed is only worth having if §10.1 accepts it: a merged `oneOf` would fail the schema the
    // engine itself chose, which is the failure mode this rule exists to avoid.
    const run = await runFlow(flow('r19-composed-body.flow.yml'), { responses });

    expect(run.step('intersection').validation?.request?.valid).not.toBe(false);
    expect(run.step('alternatives').validation?.request?.valid).not.toBe(false);
  });
});

describe('R19.5 — a $ref into another document', () => {
  /**
   * The engine reads one document per binding, so a reference out of it resolves to nothing — and
   * every field check falls silent, exactly as it does for an operation that genuinely declares a
   * free-form body. `external-schema-ref` is what tells the two apart: without it a step checked
   * against nothing looks validated, and the failure arrives one dispatch later blaming a schema
   * rather than the file boundary that caused it.
   */
  it('warns that the schema is in another document, naming the reference', async () => {
    const [complaint, ...rest] = await validate(flow('r19-external-ref.flow.yml'));

    expect(complaint.code).toBe('external-schema-ref');
    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('another document');
    // One per step, not one per unreadable field — the boundary is the fact, not each consequence.
    expect(rest).toEqual([]);
  });

  it('still cannot check a field, which is what the warning is for', async () => {
    const { entry, files } = variant(flow('r19-external-ref.flow.yml'), (document) => {
      document.steps[0].body = { urll: 'https://hooks.example.com/inbound' };
    });
    const codes = (await validate(entry, { files })).map((issue) => issue.code);

    // The misspelling is undetectable — no schema was read — so the warning is the only thing
    // standing between the author and a run-time failure naming Ajv instead of the document.
    expect(codes).toEqual(['external-schema-ref']);
  });

  it('says nothing of the kind about a document that resolves its own references', async () => {
    const codes = (await validate(flow('r19-ref-body.flow.yml'))).map((issue) => issue.code);

    expect(codes).not.toContain('external-schema-ref');
  });

  it('fails the step at run time, blaming the schema rather than the file boundary', async () => {
    const run = await runFlow(flow('r19-external-ref.flow.yml'), { responses: { r19RegisterWebhook: CREATED } });

    expect(run.outcome('register')).toBe('failed:invalid-request');
    expect(run.step('register').message).toContain('could not be compiled');
  });
});
