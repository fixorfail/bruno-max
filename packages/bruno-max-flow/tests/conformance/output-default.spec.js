/**
 * §8.1's `default:` on a declared output — R8.16, R9.16, R9.17 and R10.9.
 *
 * An output that is not produced skips every reader with `unresolved-dependency`, and under the default
 * `failOnUnresolved` that fails the run. That is right for a value that must be there and wrong for one
 * that is optional by design. `default:` is the opt-out for one output, and these pin how far it goes:
 * it fills exactly the "not produced" case of extraction, and nothing that is not extraction.
 */
const fs = require('fs');
const path = require('path');

const { normalizeFlow, parseDocument } = require('../../src/document');
const { applyFlowEdits } = require('../../src/edit');
const { runFlow, validate, variant, FLOWS } = require('./harness');
const { changedLines } = require('./lines');

const FIXTURE = 'regressions/r9-output-default.flow.yml';
const LIBRARY = path.join(FLOWS, 'regressions', 'r9-output-default-library.flow.yml');
const CALLER = 'regressions/r9-output-default-caller.flow.yml';

/** A company with no approval policy: no `meta.hash`, no tags, no policy, and a `null` reviewer. */
const NO_POLICY = {
  status: 200,
  body: { data: { state: 'settled', role: 'admin', count: 0, active: true }, meta: { reviewer: null } }
};
const CREATED = { status: 201, body: { data: { id: 'payable-1' } } };
const responses = (state = NO_POLICY) => ({ getState: state, createThing: CREATED });

const of = (diagnostics, code) => diagnostics.filter((entry) => entry.code === code);
const sentBy = (run, stepId) => run.calls.find((call) => call.stepId === stepId);

describe('R9.16 — An output default fills a value that was not produced', () => {
  it('fills a path that selects nothing, and the reader runs', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });

    expect(run.step('approvals').outputs.approvalHash).toBe('');
    expect(run.outcome('create_payable')).toBe('success');
    expect(sentBy(run, 'create_payable').request.body.value).toEqual({ name: 'payable', ref: '' });
  });

  it('leaves the same path with no default unproduced, and its reader skips', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });

    expect('bareHash' in run.step('approvals').outputs).toBe(false);
    expect(run.outcome('read_bare')).toBe('skipped:unresolved-dependency');
  });

  it('uses the value the response gave, null included, rather than the default', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });
    const hashed = await runFlow(FIXTURE, {
      responses: responses({ status: 200, body: { meta: { hash: 'h-1', reviewer: 'r-1' }, data: {} } })
    });

    expect(run.step('approvals').outputs.reviewer).toBeNull();
    expect(hashed.step('approvals').outputs.approvalHash).toBe('h-1');
    expect(hashed.step('approvals').outputs.reviewer).toBe('r-1');
  });

  it('produces a null default as null', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });
    const { outputs } = run.step('approvals');

    expect('nextCursor' in outputs).toBe(true);
    expect(outputs.nextCursor).toBeNull();
  });

  it('fills a script that returns undefined', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });

    expect(run.step('approvals').outputs.computed).toBe('fallback');
  });

  /** §8.2: a throw is a failure to report, and a default would hide it as a value. */
  it('does not fill a script that throws, which still fails the step', async () => {
    const { entry, files } = variant(FIXTURE, (document) => {
      document.steps[0].outputs.computed = { script: '(res) => { throw new Error(\'no policy\') }', default: 'fallback' };
    });
    const run = await runFlow(entry, { files, responses: responses() });

    expect(run.outcome('approvals')).toBe('failed:script-error');
    expect('computed' in run.step('approvals').outputs).toBe(false);
  });

  /** §7.3: a whole-value reference injects the value, so a list or mapping default arrives as one. */
  it('keeps the type of a list or mapping default through a whole-value reference', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });

    expect(run.outcome('send_shapes')).toBe('success');
    expect(sentBy(run, 'send_shapes').request.body.value).toEqual({
      name: 'fallback',
      tags: ['approved', 'pending'],
      policy: { kind: 'none', steps: 0 }
    });
  });

  /** §12.1: an output with a default is produced, so its export is — the approvals-hash library. */
  it('produces a library export whose output has a default, so the caller runs', async () => {
    const run = await runFlow(CALLER, { responses: responses() });

    expect(run.outcome('create_payable')).toBe('success');
    expect(sentBy(run, 'create_payable').request.body.value).toEqual({ name: 'payable', ref: '' });
  });

  it('skips the caller, as before, when the library output has no default', async () => {
    const library = fs.readFileSync(LIBRARY, 'utf8').replace('{ path: meta.hash, default: \'\' }', 'meta.hash');
    const run = await runFlow(CALLER, { files: { [LIBRARY]: library }, responses: responses() });

    expect(run.outcome('create_payable')).toBe('skipped:unresolved-dependency');
    expect(run.status).toBe('failed');
  });

  /**
   * 006 §4: a default fills each iteration's outputs, which come from extraction. It does not fill the
   * published outputs of a loop that had no deciding iteration — `matched` stays the guard for those.
   */
  describe('on a looped step', () => {
    const LOOP_FIXTURE = 'loops/retrieve-or-create.flow.yml';
    const ok = (body) => ({ status: 200, body });
    const loopResponses = (members) => ({
      loopListVendors: ok({ data: ['v1', 'v2'].map((id) => ({ id, attributes: { is_customer: false, is_vendor: true } })) }),
      loopGetVendor: (request) => {
        const id = new URL(request.url).pathname.split('/').pop();
        return ok({ data: { members: Array.from({ length: members[id] || 0 }) } });
      },
      loopCreateVendor: { status: 201, body: { data: { id: 'new' } } }
    });
    const withDefault = () => variant(LOOP_FIXTURE, (document) => {
      document.steps.find((step) => step.id === 'find_vendor_with_member').outputs = {
        partnershipId: { path: 'data.id', default: 'unknown' }
      };
    });
    it('leaves the declared output absent when no iteration matched, and matched false', async () => {
      const { entry, files } = withDefault();
      const run = await runFlow(entry, { files, responses: loopResponses({ v1: 0, v2: 0 }) });
      const loop = run.step('find_vendor_with_member');

      expect(loop.loop.matched).toBe(false);
      expect(loop.outputs).toEqual({});
      expect(run.outcome('read_partner')).toBe('skipped:condition-false');
    });

    it('fills the output of the matching iteration, which came from extraction', async () => {
      const { entry, files } = withDefault();
      const run = await runFlow(entry, { files, responses: loopResponses({ v1: 0, v2: 1 }) });

      expect(run.step('find_vendor_with_member').loop.matched).toBe(true);
      expect(run.step('find_vendor_with_member').outputs.partnershipId).toBe('unknown');
    });
  });
});

describe('R10.9 — A connector output carries its default, and a step entry replaces it whole', () => {
  const WORKSPACE_ROOT = path.join(FLOWS, 'connectors');
  const COLLECTION_ROOT = path.join(WORKSPACE_ROOT, 'collections', 'payments');
  const SCOPE = { workspaceRoot: WORKSPACE_ROOT, collectionRoot: COLLECTION_ROOT };
  const COLLECTION_FILE = path.join(COLLECTION_ROOT, 'flows', 'connectors.yml');
  const INHERIT = 'connectors/collections/payments/flows/inherit.flow.yml';
  const RESPONSES = {
    signIn: { status: 200, body: { data: { token: 'tok-1', role: 'admin' } } },
    getThing: { status: 200, body: { data: { id: 'thing-1', name: 'Widget' } } },
    createThing: { status: 201, body: { data: { id: 'thing-2' } } }
  };
  /** A thing with no name, so `data.name` selects nothing. */
  const UNNAMED = { ...RESPONSES, getThing: { status: 200, body: { data: { id: 'thing-1' } } } };
  const connectorFile = (hint) => ({
    [COLLECTION_FILE]: [
      'version: 1',
      'apis:',
      '  things: ../../../../../specs/regressions-v1.yml',
      'connectors:',
      '  things#getThing:',
      `    hint: ${hint}`
    ].join('\n')
  });

  it('fills a connector output that was not produced with the connector\'s default', async () => {
    const files = connectorFile('{ path: data.name, default: \'none\' }');

    expect(await validate(INHERIT, { scope: SCOPE, files })).toEqual([]);
    const run = await runFlow(INHERIT, { scope: SCOPE, files, responses: UNNAMED });

    expect(run.step('get_thing').outputs.hint).toBe('none');
  });

  it('uses the step\'s own entry of the same name, with no default, in place of the connector\'s', async () => {
    const { entry, files } = variant(INHERIT, (document) => {
      document.steps.find((step) => step.id === 'get_thing').outputs = { hint: 'data.name' };
    });
    const run = await runFlow(entry, {
      scope: SCOPE,
      files: { ...files, ...connectorFile('{ path: data.name, default: \'none\' }') },
      responses: UNNAMED
    });

    expect('hint' in run.step('get_thing').outputs).toBe(false);
  });

  it('reports an interpolated default in the connector file', async () => {
    const files = connectorFile('{ path: data.name, default: \'{{steps.sign_in.token}}\' }');
    const [complaint] = of(await validate(INHERIT, { scope: SCOPE, files }), 'output-default-interpolated');

    expect(complaint.severity).toBe('error');
    expect(complaint.file).toBe(COLLECTION_FILE);
  });
});

describe('R8.16 — An output default is a literal', () => {
  const withOutput = (value) => variant(FIXTURE, (document) => {
    document.steps[0].outputs.approvalHash = value;
  });

  it('accepts the fixture, which uses every kind of default', async () => {
    expect(await validate(FIXTURE)).toEqual([]);
    expect(await validate(CALLER)).toEqual([]);
  });

  it('reports a default that holds a reference, which is never interpolated', async () => {
    const { entry, files } = withOutput({ path: 'meta.hash', default: '{{steps.a.b}}' });
    const diagnostics = await validate(entry, { files });
    const [complaint] = of(diagnostics, 'output-default-interpolated');

    expect(complaint.severity).toBe('error');
    expect(complaint.message).toContain('{{steps.a.b}}');
    // Reported once, under its own code: the schema states the rule and the check owns it.
    expect(of(diagnostics, 'schema-violation')).toEqual([]);
  });

  it('reports a reference inside a list or mapping default', async () => {
    const { entry, files } = withOutput({ path: 'meta.hash', default: { tags: ['{{params.tag}}'] } });

    expect(of(await validate(entry, { files }), 'output-default-interpolated')).toHaveLength(1);
  });

  /**
   * The shorthand is the path itself, so there is nowhere to write a default — a `default:` beside it
   * is a mapping, which is the long form. What the schema has to say is about a key a mapping lacks.
   */
  it('has no shorthand form: a default needs the mapping, and a misspelt key is unknown-property', async () => {
    const { entry, files } = withOutput({ path: 'meta.hash', defualt: '' });
    const [complaint] = of(await validate(entry, { files }), 'unknown-property');

    expect(complaint.message).toContain('defualt');
    expect(complaint.message).toContain('did you mean default?');
  });
});

describe('R9.17 — default: survives normalization and an edit', () => {
  const read = () => fs.readFileSync(path.join(FLOWS, FIXTURE), 'utf8');
  const outputsOf = (text) => normalizeFlow(parseDocument(text), path.join(FLOWS, FIXTURE)).steps[0].outputs;
  const named = (outputs, name) => outputs.find((output) => output.name === name);

  it('normalizes every source with its default, and tells a null default from none', () => {
    const outputs = outputsOf(read());

    expect(named(outputs, 'approvalHash')).toEqual({ name: 'approvalHash', from: 'body', path: 'meta.hash', hasDefault: true, default: '' });
    expect(named(outputs, 'nextCursor')).toEqual({
      name: 'nextCursor', from: 'headers', path: 'x-next-cursor', hasDefault: true, default: null
    });
    expect(named(outputs, 'computed')).toEqual({
      name: 'computed', from: 'body', script: '(res) => undefined', hasDefault: true, default: 'fallback'
    });
    expect(named(outputs, 'tags').default).toEqual(['approved', 'pending']);
    expect(named(outputs, 'bareHash')).toEqual({ name: 'bareHash', from: 'body', path: 'meta.hash' });
  });

  it('keeps default: when a step edit names another field', () => {
    const text = read();
    const result = applyFlowEdits(text, [{ kind: 'step.patch', id: 'approvals', patch: { set: { timeout: 5000 } } }]);

    expect(result.ok).toBe(true);
    expect(changedLines(text, result.text).removed).toEqual([]);
    expect(named(outputsOf(result.text), 'nextCursor')).toEqual(expect.objectContaining({ hasDefault: true, default: null }));
  });

  it('writes default: when a step edit rewrites outputs:', () => {
    const outputs = { approvalHash: { path: 'meta.hash', default: 'none' }, cursor: { from: 'headers', path: 'x-next-cursor', default: null } };
    const result = applyFlowEdits(read(), [{ kind: 'step.patch', id: 'approvals', patch: { set: { outputs } } }]);

    expect(result.ok).toBe(true);
    expect(named(outputsOf(result.text), 'approvalHash').default).toBe('none');
    expect(named(outputsOf(result.text), 'cursor')).toEqual(expect.objectContaining({ hasDefault: true, default: null }));
  });
});
