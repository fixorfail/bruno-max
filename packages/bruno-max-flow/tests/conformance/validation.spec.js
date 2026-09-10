/**
 * R4h and R8 — what `bru flow validate` refuses before anything is sent (001-C §7, 001 §14.3).
 *
 * Every scenario here is one document and one answer. The fixtures under `fixtures/flows/validation/`
 * are correct files, and each case is that file with one line changed — so what a check reports is
 * the edit and not the fixture, and a rule that stopped firing shows up as a case that stopped
 * failing rather than as a message nobody reads.
 *
 * The first case of most blocks asserts the *clean* file reports nothing at all. That is the half
 * that catches a check firing on correct flows, which is the failure mode a static checker is
 * retired for.
 */
const fs = require('fs');
const path = require('path');

const engine = require('../../src');
const { describeFlow, runFlow, validate, variant, FLOWS } = require('./harness');

const FIXTURES = path.dirname(FLOWS);
const flow = (name) => `validation/${name}`;
const file = (name) => path.join(FLOWS, 'validation', name);

const codes = (diagnostics) => diagnostics.map((entry) => entry.code).sort();
const of = (diagnostics, code) => diagnostics.filter((entry) => entry.code === code);

/** The one case `validate()` cannot express: §13.2's `params`, which the harness does not pass. */
const validateWith = (entry, options = {}) =>
  engine.validateFlow({
    entry,
    scope: { workspaceRoot: FIXTURES },
    params: options.params,
    ports: {
      readFile: async (target) => fs.promises.readFile(target),
      readSpec: async (source) => ({ text: await fs.promises.readFile(source, 'utf8'), from: 'file' })
    }
  });

const CREATED = { status: 201, body: { data: { id: 'thing-1' } } };
const STATE = { status: 200, body: { data: { state: 'ready', role: 'admin', count: 3, active: true } } };

/**
 * R4h — §10.1's request validation. The never-called row is the one that matters: a check that
 * validates after dispatch has already made the call it exists to prevent.
 */
describe('R4h — Request validation', () => {
  const responses = { getState: STATE, createThing: CREATED, createBundle: { status: 201 } };

  it('dispatches a body whose field resolves to the type the schema declares', async () => {
    const run = await runFlow(flow('r4h-request.flow.yml'), { responses });

    expect(run.outcome('create')).toBe('success');
    // §7.3: a whole-value reference keeps its native type, which is what makes the request valid.
    expect(run.call('createThing').json).toEqual({ name: 'widget', count: 3 });
  });

  it('fails the step and sends nothing when the same field is forced to a string', async () => {
    const { entry, files } = variant(flow('r4h-request.flow.yml'), (document) => {
      document.steps[1].body.count = 'about {{steps.state.count}}';
    });
    const run = await runFlow(entry, { files, responses });

    expect(run.outcome('create')).toBe('failed:invalid-request');
    expect(run.callsFor('createThing')).toHaveLength(0);
  });

  /**
   * §10.1 and R4j: what `assertions[]` holds for a step that never dispatched.
   *
   * It is **empty**, not all-passing. The distinction is invisible to `every(passed)` — an empty
   * array satisfies it vacuously, which is how R4j came to say "all pass" of an engine that reports
   * nothing — and it is the whole difference on 002 §9's assertions tab, where a list of green
   * checks says the response was inspected and found correct. Nothing was inspected: there is no
   * response to inspect, and a check that never ran has no verdict to report.
   */
  it('reports no assertions at all for a step whose request never went out', async () => {
    const { entry, files } = variant(flow('r4h-request.flow.yml'), (document) => {
      document.steps[1].body.count = 'about {{steps.state.count}}';
      document.steps[1].assert = ['res.status eq 201'];
    });
    const run = await runFlow(entry, { files, responses });

    expect(run.outcome('create')).toBe('failed:invalid-request');
    expect(run.callsFor('createThing')).toHaveLength(0);
    // Not `[{ passed: true }]` — the assertion was never evaluated, and §14.6's reason is the only
    // thing reporting on this step.
    expect(run.step('create').assertions).toEqual([]);
    expect(run.step('create').validation.request.valid).toBe(false);
  });

  it('reports no assertions for a step whose request got no response either', async () => {
    const { entry, files } = variant(flow('r4h-request.flow.yml'), (document) => {
      document.steps[1].assert = ['res.status eq 201'];
    });
    const run = await runFlow(entry, {
      files,
      responses: {
        getState: STATE,
        createThing: () => {
          throw new Error('ECONNREFUSED');
        }
      }
    });

    // The same rule one step further on: dispatch was attempted and nothing came back, so there is
    // still no response for `res.status` to address.
    expect(run.outcome('create')).toBe('failed:transport-error');
    expect(run.step('create').assertions).toEqual([]);
  });

  it('dispatches unvalidated where the step opts out', async () => {
    const { entry, files } = variant(flow('r4h-request.flow.yml'), (document) => {
      document.steps[1].body.count = 'about {{steps.state.count}}';
      document.steps[1].validateRequest = false;
    });
    const run = await runFlow(entry, { files, responses });

    expect(run.outcome('create')).toBe('success');
    expect(run.call('createThing').json.count).toBe('about 3');
  });

  it('is not applicable to an operation that declares no request body', async () => {
    const run = await runFlow(flow('r4h-request.flow.yml'), { responses });

    expect(run.outcome('state')).toBe('success');
    expect(run.callsFor('getState')).toHaveLength(1);
  });

  it('does not check the binary parts of a multipart step', async () => {
    const run = await runFlow(flow('multipart.flow.yml'), { responses });

    expect(run.outcome('bundle')).toBe('success');
    expect(run.call('createBundle').body.kind).toBe('multipart');
  });

  // §19.1 schedules `--dry-run` for v2 and `bru flow run` rejects the flag today, so the row asking
  // for the failure to be reported offline has nothing to run against.
  it.todo('reports a mistyped body offline under --dry-run, and sends nothing');
});

describe('R8.1 — The graph a document declares', () => {
  it('says nothing at all about a well-formed flow', async () => {
    expect(await validate(flow('graph.flow.yml'))).toEqual([]);
  });

  it('reports two steps sharing an id', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].id = 'create';
    });

    expect(codes(await validate(entry, { files }))).toContain('duplicate-step-id');
  });

  it('reports a depends mapping carrying neither all: nor any:', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].depends = { on: 'create' };
    });
    const [complaint] = of(await validate(entry, { files }), 'invalid-depends');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('neither');
  });

  /** An empty list normalizes to no edges, which is an unconditional root that runs first. */
  it('reports a join whose list is empty', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].depends = { any: [] };
    });

    expect(of(await validate(entry, { files }), 'invalid-depends')[0].message).toContain('root');
  });

  /** A status the vocabulary does not have matches nothing, so the step waits for an outcome that
   * never comes and is skipped as `unmet-dependency` — for a reason that names the step above it. */
  it('reports a status the vocabulary does not have, and lists the ones it has', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].depends = [{ on: 'create', status: ['succeeded'] }];
    });
    const [complaint] = of(await validate(entry, { files }), 'invalid-dependency-status');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('success, failed, skipped, cancelled');
  });

  it('suggests the status a near miss was reaching for', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].depends = [{ on: 'create', status: ['sucess'] }];
    });

    expect(of(await validate(entry, { files }), 'invalid-dependency-status')[0].message)
      .toContain('did you mean success?');
  });

  /**
   * The cycle error names one step. What an author needs is the rest of the flow: every step below
   * a cycle is a step no scheduler will ever reach, and nothing else says so.
   */
  it('names every step a cycle leaves unreachable, beside the cycle itself', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[0].depends = ['read_back'];
    });
    const diagnostics = await validate(entry, { files });

    expect(of(diagnostics, 'cyclic-dependency')).toHaveLength(1);
    expect(of(diagnostics, 'unreachable-step').map((entry_) => entry_.stepId).sort()).toEqual([
      'create',
      'read_back',
      'sign_in'
    ]);
  });
});

describe('R8.2 — Names that have to resolve', () => {
  it('reports a reference to an output the ancestor does not produce', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].headers.Authorization = 'Bearer {{steps.sign_in.tokne}}';
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-output-reference');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('did you mean token?');
  });

  /** §12.2: a sub-flow's exports are the invoking step's outputs, with no re-declaration here. */
  it('treats a sub-flow export as an output of the step that invokes it', async () => {
    expect(await validate(flow('parent.flow.yml'))).toEqual([]);
  });

  it('reports an exports entry naming an output no step produces', async () => {
    const { entry, files } = variant(flow('login.flow.yml'), (document) => {
      document.exports.token = 'steps.login.access_token';
    });

    expect(of(await validate(entry, { files }), 'unknown-export')).toHaveLength(1);
  });

  /**
   * §12.1's other root. A slot is exportable because an export resolves after the schedule has
   * ended, which is the case two exclusive branches have no other way to publish (R12.2).
   */
  it('accepts an exports entry naming a declared slot, and does not then call the slot unread', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.meta.library = true;
      document.exports = { thingId: 'shared.thingId' };
    });

    expect(await validate(entry, { files })).toEqual([]);
  });

  it('reports an exports entry naming a slot nothing declares', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.exports = { thingId: 'shared.thingid' };
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-export');

    expect(complaint.message).toContain('did you mean thingId?');
  });

  /** A sub-path into a slot: a miss inside one leaves the placeholder, which must not be a value. */
  it('reports an exports entry reaching into a slot rather than naming it whole', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.exports = { id: 'shared.thingId.value' };
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-export');

    expect(complaint.message).toContain('an export names a whole slot, as shared.<slot>');
  });

  it('reports a shared: entry publishing an output the step does not produce', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].shared = { thingId: 'thingid' };
    });

    expect(of(await validate(entry, { files }), 'invalid-shared-entry')[0].message).toContain('did you mean thingId?');
  });

  it('reports a shared: entry publishing into a slot nothing declares', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.shared = ['other'];
      document.steps[2].pathParams.id = '{{shared.other}}';
    });
    const diagnostics = await validate(entry, { files });

    expect(of(diagnostics, 'invalid-shared-entry')[0].message).toContain('thingId');
  });
});

describe('R8.3 — Expressions parse and their operators exist', () => {
  /**
   * `parseAssertion` takes the first token that *is* an operator, so a misspelled one is not found
   * at all and the whole line becomes an expression asserted for truthiness — which passes every
   * time, because a non-empty string is truthy.
   */
  it('reports an operator the dialect does not have', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].assert = ['res.status equals 201'];
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-operator');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('equals');
  });

  it('reports an unknown operator written in the expanded form', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].assert = [{ expr: 'res.status', op: 'equalTo', value: 201 }];
    });

    expect(of(await validate(entry, { files }), 'unknown-operator')).toHaveLength(1);
  });

  it('leaves a bare expression alone, which is a legal assertion', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].assert = ['res.body.data.id', 'res.body.data.id isDefined'];
    });

    expect(of(await validate(entry, { files }), 'unknown-operator')).toEqual([]);
  });

  /** §9.3: a condition is evaluated before the request is built, so there is no response to read. */
  it('reports a when: reading the response', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].when = 'res.status eq 201';
    });
    const [complaint] = of(await validate(entry, { files }), 'condition-reads-response');

    expect(complaint.severity).toBe('error');
    expect(complaint.stepId).toBe('read_back');
  });
});

/**
 * R8.4 — §7.1's structural drift. Value drift flows through by design; a step overriding a field the
 * operation's schema has no such property for is caught here, because otherwise the request carries
 * a field the API ignores and the test passes while asserting nothing meaningful.
 */
describe('R8.4 — Inline overrides against the operation schema', () => {
  const drift = (mutate) => variant(flow('overrides.flow.yml'), mutate);

  it('says nothing about overrides that name what the schema declares', async () => {
    expect(await validate(flow('overrides.flow.yml'))).toEqual([]);
  });

  it('reports a top-level body field the schema does not have', async () => {
    const { entry, files } = drift((document) => {
      document.steps[0].body.referance = 'ref-2';
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-field');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('body.referance');
    expect(complaint.message).toContain('did you mean reference?');
  });

  /** A schema lifted out of a document is a fragment of it, and nearly every real one is a `$ref`. */
  it('follows a $ref into a nested object', async () => {
    const { entry, files } = drift((document) => {
      document.steps[0].body.customer.emial = 'qa@example.com';
    });

    expect(of(await validate(entry, { files }), 'unknown-field')[0].message).toContain('body.customer.emial');
  });

  it('checks the items of an array against the schema they declare', async () => {
    const { entry, files } = drift((document) => {
      document.steps[0].body.lines[0].quantitiy = 3;
    });

    expect(of(await validate(entry, { files }), 'unknown-field')[0].message).toContain('body.lines[].quantitiy');
  });

  /** A schema that documents nothing about its own keys cannot tell a typo from a field. */
  it('leaves a free-form object alone', async () => {
    const { entry, files } = drift((document) => {
      document.steps[0].body.metadata = { whatever: 'the api takes' };
    });

    expect(await validate(entry, { files })).toEqual([]);
  });

  it('reports a query parameter the operation does not declare', async () => {
    const { entry, files } = drift((document) => {
      document.steps[0].query = { dryrun: true };
    });

    expect(of(await validate(entry, { files }), 'unknown-field')[0].message).toContain('did you mean dryRun?');
  });

  it('reports a path parameter the template does not name', async () => {
    const { entry, files } = drift((document) => {
      document.steps[1].pathParams = { order_id: 'order-1' };
    });

    expect(of(await validate(entry, { files }), 'unknown-field')[0].message).toContain('/orders/{orderId}');
  });

  /**
   * `parameters:` is optional in OpenAPI and routinely left off. A document naming none of an
   * endpoint's query parameters cannot tell a typo from one it did not write down, so what a check
   * would report there is the document's silence — at every step that reaches the operation.
   */
  it('says nothing where the operation documents no parameters of that kind', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].query = { trace: 'on' };
    });

    expect(of(await validate(entry, { files }), 'unknown-field')).toEqual([]);
  });
});

describe('R8.5 — Media types, files and parts', () => {
  it('says nothing about a multipart step that selects its media type and supplies its file', async () => {
    expect(await validate(flow('multipart.flow.yml'))).toEqual([]);
  });

  it('reports contentType: on an operation that declares one request media type', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[1].contentType = 'application/json';
    });

    expect(of(await validate(entry, { files }), 'unexpected-content-type')).toHaveLength(1);
  });

  it('reports contentType: naming a media type the operation does not declare', async () => {
    const { entry, files } = variant(flow('multipart.flow.yml'), (document) => {
      document.steps[0].contentType = 'application/xml';
    });

    expect(of(await validate(entry, { files }), 'unknown-media-type')[0].message).toContain('multipart/form-data');
  });

  it('reports an operation declaring several media types with the step naming none', async () => {
    const { entry, files } = variant(flow('multipart.flow.yml'), (document) => {
      delete document.steps[0].contentType;
    });

    expect(of(await validate(entry, { files }), 'ambiguous-media-type')).toHaveLength(1);
  });

  /** §5.4's row where the schema and validation see the same characters and must disagree. */
  it('reports a format: binary part written as text', async () => {
    expect(of(await validate(flow('multipart-text-part.flow.yml')), 'missing-binary-part')).toHaveLength(1);
  });

  it('reports a required binary part nobody supplied', async () => {
    const [complaint] = of(await validate(flow('attachment.flow.yml')), 'missing-binary-part');

    expect(complaint.message).toContain('document');
  });

  it('reports a !file where the media type does not accept one', async () => {
    expect(of(await validate(flow('file-in-json.flow.yml')), 'file-not-allowed')).toHaveLength(1);
  });

  it('says nothing about a raw payload taken from a bodyFile', async () => {
    expect(await validate(flow('binary.flow.yml'))).toEqual([]);
  });

  it('reports the multipart-only tag options on a raw payload', async () => {
    expect(of(await validate(flow('binary-options.flow.yml')), 'binary-file-options')).toHaveLength(1);
  });

  it('reports a single-payload media type with no file at all', async () => {
    const { entry, files } = variant(flow('binary.flow.yml'), (document) => {
      delete document.steps[0].bodyFile;
      document.steps[0].body = { name: 'widget' };
    });

    expect(of(await validate(entry, { files }), 'missing-binary-body')).toHaveLength(1);
  });
});

describe('R8.6 — Paths, and the tags that name them', () => {
  it('says nothing about paths that resolve inside the scope root', async () => {
    expect(await validate(flow('files.flow.yml'))).toEqual([]);
  });

  /**
   * Containment is not hypothetical hygiene: flows are committed and shared, so one arriving on a
   * teammate's branch runs on your machine with your credentials.
   */
  it('reports a path that climbs out of the scope root', async () => {
    const { entry, files } = variant(flow('files.flow.yml'), (document) => {
      document.steps[0].bodyFile = '../../../../../../.ssh/id_rsa';
    });
    const [complaint] = of(await validate(entry, { files }), 'path-outside-scope');

    expect(complaint.severity).toBe('error');
    expect(complaint.stepId).toBe('create');
  });

  it('reports a dataset that is not there', async () => {
    const { entry, files } = variant(flow('files.flow.yml'), (document) => {
      document.dataset = './data/nowhere.csv';
    });

    expect(of(await validate(entry, { files }), 'missing-file')).toHaveLength(1);
  });

  /** §7.4 resolves an interpolated path when the step materializes, so there is nothing to look up. */
  it('leaves a path an earlier step selects alone', async () => {
    const { entry, files } = variant(flow('files.flow.yml'), (document) => {
      document.steps[0].bodyFile = './fixtures/{{row.name}}.json';
    });

    expect(of(await validate(entry, { files }), 'missing-file')).toEqual([]);
  });

  /** §5.4: the tag has three options, and a fourth is a typo that uploads under the wrong name. */
  it('refuses a !file mapping carrying an option the tag does not have', async () => {
    const [complaint] = await validate(flow('file-option-typo.flow.yml'));

    expect(complaint.code).toBe('parse-error');
    expect(complaint.message).toContain('filenmae');
    expect(complaint.line).toBeGreaterThan(0);
  });

  it('accepts !... in a merge layer, where there is a seeded key to remove', async () => {
    expect(await validate(flow('drop.flow.yml'))).toEqual([]);
  });

  it('reports !... anywhere else, where it drops nothing and reads as null', async () => {
    const [complaint] = of(await validate(flow('drop-misplaced.flow.yml')), 'misplaced-drop');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('vars.legacy');
  });
});

describe('R8.7 — What a uses: step may carry', () => {
  it('says nothing about a call site carrying only what §12.4 permits', async () => {
    expect(await validate(flow('parent.flow.yml'))).toEqual([]);
  });

  /** Replaying a sequence replays every side effect it already committed. */
  it('reports a retry: on a uses: step', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      document.steps[0].retry = { maxAttempts: 3 };
    });
    const [complaint] = of(await validate(entry, { files }), 'invalid-subflow-field');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('retry');
  });

  it('reports every other field that addresses one response', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      document.steps[0].auth = 'user-token';
      document.steps[0].body = { name: 'widget' };
      document.steps[0].timeout = 1000;
    });

    expect(of(await validate(entry, { files }), 'invalid-subflow-field')).toHaveLength(3);
  });

  it('reports a dataset: in a sub-flow, and reports it against the sub-flow', async () => {
    const { entry, files } = variant(flow('login.flow.yml'), (child) => {
      child.dataset = './data/rows.csv';
    });
    const parent = variant(flow('parent.flow.yml'), (document) => {
      document.steps[0].uses = './login.variant.flow.yml';
    });
    const diagnostics = await validate(parent.entry, { files: { ...files, ...parent.files } });
    const [complaint] = of(diagnostics, 'subflow-dataset');

    expect(complaint.file).toBe(entry);
  });

  /** A `uses:` naming a file that is not there is a document to report on, not a crash. */
  it('reports a uses: target that does not resolve', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      document.steps[0].uses = './nowhere.flow.yml';
    });

    expect(of(await validate(entry, { files }), 'unresolved-subflow')).toHaveLength(1);
  });

  it('suggests the param a misspelled with: key was reaching for', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      document.steps[0].with = { emial: 'qa@example.com', email: 'qa@example.com' };
    });

    expect(of(await validate(entry, { files }), 'unknown-param')[0].message).toContain('did you mean email?');
  });
});

describe('R8.8 — Declared and never used', () => {
  it('warns about an output nothing in the flow reads', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[0].outputs.role = 'data.role';
    });
    const [complaint] = of(await validate(entry, { files }), 'unused-output');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('sign_in.role');
  });

  it('warns about a slot no step publishes into', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      delete document.steps[1].shared;
    });
    const [complaint] = of(await validate(entry, { files }), 'slot-without-writer');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('thingId');
  });

  it('warns about a slot nothing reads', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.steps[2].pathParams.id = 'thing-1';
    });

    expect(of(await validate(entry, { files }), 'unused-slot')).toHaveLength(1);
  });
});

describe('R8.9 — Reserved names and the library flag', () => {
  /** §7.3: the namespace shadows the variable, and nothing at run time says so. */
  it('warns about a var named for a namespace', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.vars = { flow: 'checkout' };
    });
    const [complaint] = of(await validate(entry, { files }), 'shadowed-reserved-name');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('vars.flow');
  });

  /**
   * §12.5's lint. The flag is explicit rather than inferred from `params:`, and the cost of that is
   * the flow that forgets it — which a directory run fires and reports as a missing param that says
   * nothing about the cause.
   */
  it('warns about a required param with no default in a flow that is not a library', async () => {
    const { entry, files } = variant(flow('login.flow.yml'), (document) => {
      document.meta.library = false;
    });
    const [complaint] = of(await validate(entry, { files }), 'required-param-without-library');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('email');
  });

  it('says nothing where the flag is set', async () => {
    expect(await validate(flow('login.flow.yml'))).toEqual([]);
  });

  /** §13.2's `params`: the check sees what the run it is validating would actually supply. */
  it('says nothing where the host supplies the param', async () => {
    const unmarked = variant(flow('login.flow.yml'), (document) => {
      document.meta.library = false;
    });
    fs.writeFileSync(unmarked.entry, unmarked.files[unmarked.entry]);
    try {
      const without = await validateWith(unmarked.entry);
      const supplied = await validateWith(unmarked.entry, { params: { email: 'qa@example.com' } });

      expect(codes(without)).toEqual(['required-param-without-library']);
      expect(supplied).toEqual([]);
    } finally {
      fs.unlinkSync(unmarked.entry);
    }
  });
});

describe('R8.10 — Which operation a reference names', () => {
  /**
   * Not a committed fixture: `fixtures.spec.js` requires every operation in the corpus to declare an
   * `operationId` and every committed `operation:` to name one, which is exactly the document §6.1's
   * fallback exists for. So the scenario supplies the same spec with the id stripped.
   */
  const withoutOperationId = () => {
    const source = path.join(FIXTURES, 'specs', 'validation-v1.yml');
    const entry = file('endpoints.flow.yml');
    return {
      entry,
      files: {
        [source]: fs.readFileSync(source, 'utf8').replace('      operationId: refundOrder\n', ''),
        [entry]: [
          'version: 1',
          'apis:',
          '  orders-api: ../../specs/validation-v1.yml',
          'config:',
          '  baseUrl: "{{ordersBaseUrl}}"',
          'steps:',
          '  - id: refund',
          '    operation: "orders-api#POST /orders/{orderId}/refund"',
          '    pathParams:',
          '      orderId: order-1',
          ''
        ].join('\n')
      }
    };
  };

  it('resolves an operation the document gives no id, by method and path', async () => {
    const { entry, files } = withoutOperationId();

    expect(await validate(entry, { files })).toEqual([]);
  });

  it('resolves it to the same method and path the graph draws', async () => {
    const { entry, files } = withoutOperationId();
    const description = await describeFlow(entry, { files });

    expect(description.nodes[0].operation).toEqual({
      api: 'orders-api',
      method: 'POST',
      path: '/orders/{orderId}/refund',
      operationId: undefined
    });
  });

  /**
   * §6.1 normalizes by the same rules `openapi-sync.js` applies, so flows and openapi-sync agree on
   * what a path *is*. The corpus is asserted here; the other half of §6.1's guarantee — the same
   * corpus asserted against `normalizeUrlPath` in `bruno-electron` — is not written yet.
   */
  it.each([
    ['POST /orders/{orderId}/refund/', 'a trailing slash'],
    ['POST //orders/{orderId}//refund', 'collapsed slashes'],
    ['POST https://validate.example.com/orders/{orderId}/refund', 'an origin'],
    ['POST /orders/{orderId}/refund?dryRun=true', 'a query'],
    ['post /orders/{orderId}/refund', 'a lowercase method']
  ])('resolves %s — %s', async (reference) => {
    const { entry, files } = withoutOperationId();
    files[entry] = files[entry].replace('POST /orders/{orderId}/refund', reference);

    expect(await validate(entry, { files })).toEqual([]);
  });

  it('reports a reference that matches no operation at all', async () => {
    const { entry, files } = withoutOperationId();
    files[entry] = files[entry].replace('POST /orders/{orderId}/refund', 'DELETE /orders/{orderId}');

    expect(of(await validate(entry, { files }), 'unknown-operation')).toHaveLength(1);
  });

  /** §6.5: an index built by assignment keeps the last, and the step calls the other endpoint. */
  it('reports an operation id the document declares twice', async () => {
    const [complaint] = of(await validate(flow('duplicate-operation.flow.yml')), 'ambiguous-operation');

    expect(complaint.severity).toBe('error');
    expect(complaint.stepId).toBe('open');
  });
});

/**
 * R8.11 — §8.2's two named objects, which §7.3's table does not carry.
 *
 * `env` and `vars` are not interpolation namespaces — `{{env}}` resolves to a variable of that name
 * like any other. They are the objects a script's context puts *above* the flat spread of variables,
 * so a variable so named is reachable from a request and invisible to every script that reads it.
 */
/**
 * §8.2: `bru` is not in a flow script's scope, and the check exists so the author finds that out
 * from `bru flow validate` rather than from a `ReferenceError` in the middle of a run.
 *
 * The position coverage is the point. An author porting a `.bru` script writes `bru.setVar` wherever
 * that script had it, and a check wired into one script position and not the others is one that
 * reports the tidy cases and misses the rest.
 */
describe('R8.9b — bru in a flow script', () => {
  const warned = async (edit) => {
    const { entry, files } = variant(flow('graph.flow.yml'), edit);
    return of(await validate(entry, { files }), 'bru-unavailable');
  };

  it('warns from a shouldRetry predicate, naming what to use instead', async () => {
    const [complaint] = await warned((document) => {
      document.steps[1].retry = { maxAttempts: 2, shouldRetry: '(res) => bru.setVar("x", res.status)' };
    });

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('outputs:');
    expect(complaint.message).toContain('shared:');
  });

  it.each([
    ['an outputs: script', (document) => {
      document.steps[1].outputs = { token: { script: '(res) => bru.getVar("t")' } };
    }],
    ['a when: script', (document) => {
      document.steps[1].when = [{ script: '(ctx) => bru.getEnvVar("live") === "1"' }];
    }],
    ['a pre: script', (document) => {
      document.steps[1].pre = { nonce: '() => bru.setVar("n", 1)' };
    }],
    // §8.6's block is flat: every key but `use` is a definition.
    ['a functions: entry', (document) => {
      document.functions = { sign: '() => bru.interpolate("{{x}}")' };
    }]
  ])('warns from %s', async (_label, edit) => {
    expect(await warned(edit)).toHaveLength(1);
  });

  it('says nothing about a script that does not reach for it', async () => {
    const quiet = await warned((document) => {
      document.steps[1].outputs = { token: { script: '(res) => res.body.data.id' } };
    });

    expect(quiet).toEqual([]);
  });

  it('says nothing about a variable whose name merely contains bru', async () => {
    const quiet = await warned((document) => {
      document.steps[1].outputs = { token: { script: '(res, ctx) => ctx.brunoRef + ctx.bru_key' } };
    });

    expect(quiet).toEqual([]);
  });
});

describe('R8.11 — Names a script’s context shadows', () => {
  it('warns about a var named env, naming what a script reads instead', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.vars = { env: 'staging' };
    });
    const [complaint] = of(await validate(entry, { files }), 'shadowed-reserved-name');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('vars.env');
    expect(complaint.message).toContain('ctx.env');
  });

  it('warns about a param named vars', async () => {
    const { entry, files } = variant(flow('login.flow.yml'), (document) => {
      document.params.vars = { default: 'none' };
    });
    const [complaint] = of(await validate(entry, { files }), 'shadowed-reserved-name');

    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('params.vars');
    expect(complaint.message).toContain('ctx.vars');
  });

  /** §7.3's own namespaces keep their own reason: the namespace shadows the variable in `{{...}}` too. */
  it('keeps the namespace wording for the names §7.3 reserves', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.vars = { flow: 'checkout', env: 'staging' };
    });
    const complaints = of(await validate(entry, { files }), 'shadowed-reserved-name');

    expect(complaints).toHaveLength(2);
    expect(complaints.find((entry_) => entry_.message.includes('vars.flow')).message).toContain('namespace');
  });

  it('says nothing about a variable named neither', async () => {
    const { entry, files } = variant(flow('graph.flow.yml'), (document) => {
      document.vars = { environment: 'staging' };
    });

    expect(await validate(entry, { files })).toEqual([]);
  });
});

/**
 * R8.12 — an export a caller does not read.
 *
 * **Nothing is reported, and the silence is the requirement.** A library's `exports:` are declared
 * for callers it has not met, so a flow reading three of six is the shape a shared library is *for*
 * — a warning there fires on almost every call site, is ignored by everyone, and spends the
 * attention the diagnostics that mean something are asking for.
 *
 * This is §8.5's rule for connector-supplied outputs, one noun over: both are a declaration made
 * once for every consumer, and neither consumer is at fault for using part of it.
 *
 * The signal that would have been lost with it is not lost. A read that *is* a typo names an output
 * the sub-flow does not export, which is `unknown-output-reference` against the step that reads it —
 * an error, at the position the mistake was typed.
 */
describe('R8.12 — An export nothing at the call site reads', () => {
  it('says nothing where the caller reads the export as the step\u2019s own output', async () => {
    expect(await validate(flow('parent.flow.yml'))).toEqual([]);
  });

  it('says nothing where the caller reads none of them either', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      delete document.steps[1].headers;
    });

    expect(await validate(entry, { files })).toEqual([]);
  });

  /** The half that stayed: a read naming something the sub-flow does not export is still an error. */
  it('still reports a read of an export the sub-flow does not declare', async () => {
    const { entry, files } = variant(flow('parent.flow.yml'), (document) => {
      document.steps[1].headers.Authorization = 'Bearer {{steps.auth.tokne}}';
    });
    const [complaint] = of(await validate(entry, { files }), 'unknown-output-reference');

    expect(complaint.severity).toBe('error');
    expect(complaint.stepId).toBe('create');
    expect(complaint.message).toContain('did you mean token?');
  });
});

/**
 * R8.13 — §6.4's signing modes against a step's own `headers:`.
 *
 * Which of the two wins is the host's and not the flow's, and the hosts do not agree: `aws4` deletes
 * an `Authorization` it finds and signs over what is left, while the digest interceptor skips its
 * challenge entirely for a request that already carries one. Either way the request goes out as
 * something nobody wrote and the API answers 401, which reads as a credentials problem.
 */
describe('R8.13 — A header a signing mode computes', () => {
  const signed = (mutate) => variant(flow('signing.flow.yml'), mutate);

  it('says nothing about a header the mode computes nothing for', async () => {
    expect(await validate(flow('signing.flow.yml'))).toEqual([]);
  });

  it('warns where the step sets the header the signature goes into', async () => {
    const { entry, files } = signed((document) => {
      document.steps[0].headers.Authorization = 'Bearer {{legacyToken}}';
    });
    const [complaint] = of(await validate(entry, { files }), 'signed-header-override');

    expect(complaint.severity).toBe('warning');
    expect(complaint.stepId).toBe('create');
    expect(complaint.message).toContain('awsv4');
    expect(complaint.message).toContain('never reaches the wire');
  });

  /** A header name is case-insensitive on the wire, and an author writing one is not choosing a spelling. */
  it('warns on the other headers awsv4 computes, whatever their case', async () => {
    const { entry, files } = signed((document) => {
      document.steps[0].headers['x-amz-date'] = '20240101T000000Z';
      document.steps[0].headers['X-Amz-Security-Token'] = '{{sessionToken}}';
    });

    expect(of(await validate(entry, { files }), 'signed-header-override')).toHaveLength(2);
  });

  /** §6.4's per-field override is the documented way to hand one call a pre-signed token. */
  it('says nothing where the profile is not a signing mode', async () => {
    const { entry, files } = signed((document) => {
      document.authProfiles.signer = { mode: 'bearer', token: '{{legacyToken}}' };
      document.steps[0].headers.Authorization = 'Bearer {{legacyToken}}';
    });

    expect(await validate(entry, { files })).toEqual([]);
  });

  it('tells a digest step what its header actually does, which is suppress the handshake', async () => {
    const { entry, files } = signed((document) => {
      document.authProfiles.signer = { mode: 'digest', username: 'qa', password: '{{digestPassword}}' };
      document.steps[0].headers.Authorization = 'Digest {{precomputed}}';
    });
    const [complaint] = of(await validate(entry, { files }), 'signed-header-override');

    expect(complaint.message).toContain('skips the challenge handshake');
  });

  it('names X-WSSE for a wsse profile, and not Authorization', async () => {
    const { entry, files } = signed((document) => {
      document.authProfiles.signer = { mode: 'wsse', username: 'qa', password: '{{wssePassword}}' };
      document.steps[0].headers.Authorization = 'Bearer {{legacyToken}}';
      document.steps[0].headers['X-WSSE'] = 'UsernameToken ...';
    });
    const complaints = of(await validate(entry, { files }), 'signed-header-override');

    expect(complaints).toHaveLength(1);
    expect(complaints[0].message).toContain('X-WSSE');
  });

  /** oauth1 is the one mode whose header is conditional: `placement:` can send it elsewhere entirely. */
  it('says nothing where an oauth1 profile places its parameters outside the header', async () => {
    const { entry, files } = signed((document) => {
      document.authProfiles.signer = {
        mode: 'oauth1',
        consumerKey: 'key',
        consumerSecret: '{{consumerSecret}}',
        placement: 'query'
      };
      document.steps[0].headers.Authorization = 'Bearer {{legacyToken}}';
    });

    expect(await validate(entry, { files })).toEqual([]);
  });
});

/**
 * R8.14 — §6.4's implicit `collection` profile is never in a flow's own `authProfiles:` block; it
 * is the host's to supply at run time (`RunOptions.authProfiles.collection`, materialize.ts).
 * Validation has no such input, so the question it can answer is narrower: does this *scope* have a
 * collection at all to inherit one from? A `collectionRoot` says yes, and whether the host actually
 * passed the profile is left for the run to report. No `collectionRoot` means there is no collection
 * to inherit from, and `auth: collection` stays `unknown-auth-profile`.
 */
describe('R8.14 — The implicit collection profile at validate time', () => {
  const COLLECTION_SCOPE = { workspaceRoot: FIXTURES, collectionRoot: path.join(FLOWS, 'validation') };

  it('does not flag auth: collection — on a binding or a step — in a scope with a collectionRoot', async () => {
    expect(await validate(flow('collection-auth.flow.yml'), { scope: COLLECTION_SCOPE })).toEqual([]);
  });

  it('still reports unknown-auth-profile in a workspace-only scope, naming the missing collection', async () => {
    const diagnostics = of(await validate(flow('collection-auth.flow.yml')), 'unknown-auth-profile');

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => entry.stepId).sort()).toEqual(['on_step', 'through_binding']);
    for (const complaint of diagnostics) {
      expect(complaint.severity).toBe('error');
      expect(complaint.message).toContain('collection');
      expect(complaint.message).toContain('no collection to inherit an auth profile from');
    }
  });

  /** §6.4: a flow's own `collection` profile wins over the implicit one — resolution order is unchanged. */
  it('uses a flow-declared collection profile instead, in either scope', async () => {
    const { entry, files } = variant(flow('collection-auth.flow.yml'), (document) => {
      document.authProfiles = { collection: { mode: 'bearer', token: '{{collectionToken}}' } };
    });

    expect(await validate(entry, { files })).toEqual([]);
    expect(await validate(entry, { files, scope: COLLECTION_SCOPE })).toEqual([]);
  });

  it('leaves an unrelated unknown profile name reported the same way as before', async () => {
    const { entry, files } = variant(flow('collection-auth.flow.yml'), (document) => {
      document.steps[1].auth = 'nonexistent';
    });
    const [complaint] = of(await validate(entry, { files, scope: COLLECTION_SCOPE }), 'unknown-auth-profile');

    expect(complaint.stepId).toBe('on_step');
    expect(complaint.message).toBe('on_step authenticates with nonexistent, which is not declared');
  });
});
