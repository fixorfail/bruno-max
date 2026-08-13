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

  it('spends the budget on the poll rather than on wall-clock time', async () => {
    const startedAt = Date.now();
    const run = await budgeted();

    expect(run.sleeps).toEqual([1000, 1000, 1000, 1000]);
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

describe('R5 — unresolved variables never reach the wire', () => {
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
