/**
 * L1–L8, L10 and L11 — step loops (006-C).
 *
 * Every scenario is a fixture under `fixtures/flows/loops/` and a table of what the stubbed API
 * answers. The five fixtures are the five loops that 006 §1 names, so a loop that a flow cannot
 * express shows here as a fixture that cannot be written. A case that needs a flow with one line
 * changed uses `variant()`, as the validation cases do.
 *
 * Assertions are on what went to the wire, in the order it went: a loop that built its request once
 * and sent it three times passes every assertion on a result, and fails the first one on a path.
 */
const path = require('path');

const engine = require('../../src');
const { runFlow, validate, describeFlow, variant, FLOWS } = require('./harness');

const flow = (name) => `loops/${name}`;
const file = (name) => path.join(FLOWS, 'loops', name);

const pathOf = (call) => new URL(call.url).pathname;
const lastSegment = (request) => new URL(request.url).pathname.split('/').pop();
const queryOf = (request, name) => (request.query.find((entry) => entry.name === name) || {}).value;

/** The calls one step made, in the order they went out. */
const callsOf = (run, stepId) => run.calls.filter((call) => call.stepId === stepId);

const ok = (body = {}) => ({ status: 200, body });

const VENDORS = {
  data: [
    { id: 'v1', attributes: { is_customer: false, is_vendor: true } },
    { id: 'v2', attributes: { is_customer: false, is_vendor: true } },
    { id: 'v3', attributes: { is_customer: false, is_vendor: true } },
    // Both a customer and a vendor, which the fixture's filter leaves out of the candidates.
    { id: 'both', attributes: { is_customer: true, is_vendor: true } }
  ]
};

/** How many members each vendor has — v2 is the first with any, v3 has one more. */
const MEMBERS = { v1: 0, v2: 2, v3: 1 };

const vendorResponses = (members = MEMBERS, list = VENDORS) => ({
  loopListVendors: ok(list),
  loopGetVendor: (request) => {
    const id = lastSegment(request);
    return ok({ data: { id, members: Array.from({ length: members[id] || 0 }, (unused, index) => index) } });
  },
  loopCreateVendor: { status: 201, body: { data: { id: 'new' } } }
});

const RPC_RESULTS = { 'acct-1': 'r1', 'acct-2': 'r2', 'acct-3': 'r3' };

const rpcResponses = (overrides = {}) => ({
  loopRpc: (request, ctx, info) => {
    const key = request.body.value.key;
    if (overrides[key]) return typeof overrides[key] === 'function' ? overrides[key](request, ctx, info) : overrides[key];
    return ok({ data: { ok: true, result: RPC_RESULTS[key] } });
  }
});

describe('L1.1 — the request is built again for each value', () => {
  it('sends one request for each value, each with its own path', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), {
      responses: vendorResponses({ v1: 0, v2: 0, v3: 0 })
    });

    expect(callsOf(run, 'find_vendor_with_member').map(pathOf)).toEqual([
      '/loops/vendors/v1',
      '/loops/vendors/v2',
      '/loops/vendors/v3'
    ]);
  });
});

describe('L1.2 — pre: runs again for each iteration and sees loop.*', () => {
  it('computes a value from the iteration, and the request carries it', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), {
      responses: vendorResponses({ v1: 0, v2: 0, v3: 0 })
    });

    expect(callsOf(run, 'find_vendor_with_member').map((call) => call.headers['X-Label'])).toEqual([
      'v1-0',
      'v2-1',
      'v3-2'
    ]);
  });

  it('runs pre: once for each iteration, and not once for the loop', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), {
      responses: vendorResponses({ v1: 0, v2: 0, v3: 0 })
    });

    const preScripts = run.scripts.filter((script) => script.source.includes('ctx.loop.vendorId'));
    expect(preScripts).toHaveLength(3);
    // The script is handed a context whose `loop` is the iteration it runs for.
    expect(preScripts.map((script) => script.args[0].loop.index)).toEqual([0, 1, 2]);
  });
});

describe('L2.1 — until stops at the first match', () => {
  it('sends no value after the match, and publishes the outputs of the match', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses() });

    expect(run.status).toBe('passed');
    expect(callsOf(run, 'find_vendor_with_member').map(pathOf)).toEqual(['/loops/vendors/v1', '/loops/vendors/v2']);
    expect(run.step('find_vendor_with_member').outputs).toEqual({ partnershipId: 'v2' });
    expect(run.step('find_vendor_with_member').loop).toEqual({
      count: 2,
      of: 3,
      matched: true,
      index: 1,
      value: 'v2'
    });
    // `partnershipId` is the match's, so the guarded reader asks for v2 and nothing else.
    expect(callsOf(run, 'read_partner').map(pathOf)).toEqual(['/loops/vendors/v2']);
  });

  it('leaves a step that decides on matched: false unrun', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses() });

    expect(run.outcome('create_vendor')).toBe('skipped:condition-false');
    expect(run.callsFor('loopCreateVendor')).toHaveLength(0);
  });
});

describe('L2.2 — no match is a success, and the next step decides', () => {
  const NONE = { v1: 0, v2: 0, v3: 0 };

  it('succeeds with matched: false, every value tried and no outputs published', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses(NONE) });

    expect(run.outcome('find_vendor_with_member')).toBe('success');
    expect(run.step('find_vendor_with_member').loop).toEqual({ count: 3, of: 3, matched: false });
    expect(run.step('find_vendor_with_member').outputs).toEqual({});
  });

  it('runs the step that is guarded on matched: false', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses(NONE) });

    expect(run.status).toBe('passed');
    expect(run.outcome('create_vendor')).toBe('success');
    expect(run.outcome('read_partner')).toBe('skipped:condition-false');
  });

  /**
   * §4's reason for a success and not a skip: `depends: status: [skipped]` cannot tell a branch that
   * was not needed from a gate that stopped the run, and a skipped loop would spread
   * `unmet-dependency` to the steps that must run.
   */
  it('does not skip the steps that depend on it', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses(NONE) });

    expect(run.table()).toEqual({
      find_vendors: 'success',
      find_vendor_with_member: 'success',
      create_vendor: 'success',
      read_partner: 'skipped:condition-false'
    });
  });
});

describe('L2.3 — a list with no values runs no iteration', () => {
  it('succeeds with matched: false and count 0, and sends nothing', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), {
      responses: vendorResponses(MEMBERS, { data: [] })
    });

    expect(run.outcome('find_vendor_with_member')).toBe('success');
    expect(run.step('find_vendor_with_member').loop).toEqual({ count: 0, of: 0, matched: false });
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(0);
    expect(run.outcome('create_vendor')).toBe('success');
  });

  it('succeeds with matched: true where there is no until, because the values ended', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.over = [];
    });
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.step('call_each').loop).toEqual({ count: 0, of: 0, matched: true });
  });
});

describe('L2.4 — without until, every value runs and iterations holds each output in order', () => {
  it('runs every value', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    expect(run.status).toBe('passed');
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-2', 'acct-3']);
    expect(run.step('call_each').loop).toEqual({ count: 3, of: 3, matched: true });
  });

  it('publishes each output in index order, whatever order the calls finished in', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    // `summarize` interpolates `steps.call_each.iterations` into its request.
    expect(run.call('loopRpc', 4).json.key).toBe(
      'got [{"result":"r1"},{"result":"r2"},{"result":"r3"}]'
    );
  });

  it('publishes no declared output of its own, so a reader of one is skipped', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[1].body.key = '{{steps.call_each.result}}';
    });
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.step('call_each').outputs).toEqual({});
    expect(run.outcome('summarize')).toBe('skipped:unresolved-dependency');
  });

  it('publishes count, and a built-in that a later assertion reads', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    // `summarize` asserts `steps.call_each.count eq 3`.
    expect(run.outcome('summarize')).toBe('success');
    expect(run.step('summarize').assertions).toEqual([
      expect.objectContaining({ passed: true, expected: 3, actual: 3 })
    ]);
  });
});

describe('L2.5 — shared: publishes from the matching iteration only', () => {
  const withSlot = (mutate = () => {}) =>
    variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.shared = ['partner'];
      document.steps[1].shared = { partner: 'partnershipId' };
      document.steps.push({
        id: 'read_slot',
        operation: 'loops-api#loopGetVendor',
        depends: {
          all: [
            { on: 'create_vendor', status: ['success', 'skipped'] },
            { on: 'read_partner', status: ['success', 'skipped'] }
          ]
        },
        pathParams: { pk: 'slot-{{shared.partner}}' }
      });
      mutate(document);
    });

  it('writes the slot from the match', async () => {
    const { entry, files } = withSlot();
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(pathOf(run.call('loopGetVendor', 4))).toBe('/loops/vendors/slot-v2');
  });

  it('writes nothing where there is no match', async () => {
    const { entry, files } = withSlot();
    const run = await runFlow(entry, { files, responses: vendorResponses({ v1: 0, v2: 0, v3: 0 }) });

    // An unwritten slot resolves empty (§11.2).
    expect(pathOf(run.callsFor('loopGetVendor').pop())).toBe('/loops/vendors/slot-');
  });
});

describe('L3.1 — a failed iteration fails the step and ends the loop', () => {
  const FAILING = rpcResponses({ 'acct-2': { status: 500, body: { error: { message: 'down' } } } });

  it('fails with the reason of the iteration, and sends no later value', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: FAILING });

    expect(run.outcome('call_each')).toBe('failed:unexpected-status');
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-2']);
    expect(run.outcome('summarize')).toBe('skipped:unmet-dependency');
  });

  it('names the index and the value, in the message and in the result', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: FAILING });

    expect(run.step('call_each').message).toContain('loop.index 1 (value "acct-2")');
    expect(run.step('call_each').loop).toEqual({ count: 2, of: 3, matched: false, index: 1, value: 'acct-2' });
  });

  it('reports the assertions of the iteration that failed', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), {
      responses: rpcResponses({ 'acct-2': ok({ data: { ok: false } }) })
    });

    expect(run.outcome('call_each')).toBe('failed:assertion-failed');
    expect(run.step('call_each').assertions).toEqual([expect.objectContaining({ passed: false, actual: false })]);
  });
});

/**
 * Cursor stubs for 006 §1's second loop. Page 3 is the last, and the API says so in `links.last`;
 * each page links to the one before it, and page 2 is the first with a vendor in it.
 */
const PAGE_LINK = (page) => `https://loops.example.com/loops/vendors?page%5Bnumber%5D=${page}`;
const PAGES = {
  3: { data: [{ id: 'x3', attributes: { is_vendor: false } }], links: { prev: PAGE_LINK(2) } },
  2: {
    data: [
      { id: 'c1', attributes: { is_vendor: true } },
      { id: 'c2', attributes: { is_vendor: true } }
    ],
    links: { prev: PAGE_LINK(1) }
  },
  1: { data: [{ id: 'x1', attributes: { is_vendor: false } }], links: {} }
};

const cursorResponses = (pages = PAGES) => ({
  loopListVendors: (request) => {
    const page = queryOf(request, 'page[number]');
    // The first call asks for no page, and is what `lastPage` is read from.
    if (page === undefined) return ok({ data: [], links: { last: PAGE_LINK(3) } });
    return ok(pages[page]);
  },
  loopMatchVendor: (request) => {
    const id = request.body.value.vendor_id;
    return ok({ data: { matched: id === 'c2', vendor_id: id } });
  },
  loopGetVendor: ok({ data: {} })
});

const pagesRequested = (run) =>
  callsOf(run, 'search_vendor_pages').map((call) => queryOf(call.request, 'page[number]'));

describe('L3.2 — a script that throws fails the step and names the iteration', () => {
  it('fails on an until that throws', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.steps[1].loop.until = '(res) => { throw new Error("boom"); }';
    });
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(run.outcome('find_vendor_with_member')).toBe('failed:script-error');
    expect(run.step('find_vendor_with_member').message).toContain('loop.index 0 (value "v1")');
    expect(run.step('find_vendor_with_member').message).toContain('until threw: boom');
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(1);
  });

  it('fails on a next that throws', async () => {
    const { entry, files } = variant(flow('cursor-pages.flow.yml'), (document) => {
      document.steps[1].loop.next = '(previous) => { throw new Error("no cursor"); }';
    });
    const run = await runFlow(entry, { files, responses: cursorResponses() });

    expect(run.outcome('search_vendor_pages')).toBe('failed:script-error');
    expect(run.step('search_vendor_pages').message).toContain('next threw: no cursor');
  });

  it('fails on a pre: that throws, and sends no request for that iteration', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.steps[1].pre.label = '() => { throw new Error("nope"); }';
    });
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(run.outcome('find_vendor_with_member')).toBe('failed:script-error');
    expect(run.step('find_vendor_with_member').message).toContain('pre.label threw: nope');
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(0);
  });
});

describe('L3.3 — max is a bound, and with until a loop that reaches it has not matched', () => {
  it('succeeds with matched: false, and sends no value past the bound', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.steps[1].loop.max = 2;
    });
    const run = await runFlow(entry, { files, responses: vendorResponses({ v1: 0, v2: 0, v3: 0 }) });

    expect(run.outcome('find_vendor_with_member')).toBe('success');
    expect(run.step('find_vendor_with_member').loop).toEqual({ count: 2, of: 2, matched: false });
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(2);
  });
});

describe('L3.4 — without until, a loop that reaches max with values left has not finished', () => {
  it('fails with loop-max-reached', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.max = 2;
    });
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.outcome('call_each')).toBe('failed:loop-max-reached');
    expect(run.step('call_each').message).toContain('2 iterations');
    expect(callsOf(run, 'call_each')).toHaveLength(2);
  });

  it('succeeds where the values end exactly at max', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.max = 3;
    });
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.outcome('call_each')).toBe('success');
  });
});

describe('L3.5 — a source that cannot be read ends the loop before any request', () => {
  it('skips the step, as a step without a loop is, where over: names an output nobody produced', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.steps[1].loop.over = '{{steps.find_vendors.nothing}}';
    });
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(run.outcome('find_vendor_with_member')).toBe('skipped:unresolved-dependency');
    expect(run.step('find_vendor_with_member').message).toContain('steps.find_vendors.nothing');
    // §11.2: an unresolved reference fails the run, and says which step it was.
    expect(run.status).toBe('failed');
    expect(run.result.decidedBy).toContain('find_vendor_with_member');
  });

  it('fails the step where over: resolves to something that is not a list', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      document.steps[0].outputs.candidateIds.script = '(res) => "not-a-list"';
    });
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(run.outcome('find_vendor_with_member')).toBe('failed:invalid-request');
    expect(run.step('find_vendor_with_member').message).toContain('not a list');
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(0);
  });
});

describe('L3.6 — a loop that nobody validated is refused, and sends nothing', () => {
  it('refuses a loop with no max', async () => {
    const { entry, files } = variant(flow('retrieve-or-create.flow.yml'), (document) => {
      delete document.steps[1].loop.max;
    });
    const run = await runFlow(entry, { files, responses: vendorResponses() });

    expect(run.outcome('find_vendor_with_member')).toBe('failed:invalid-request');
    expect(run.step('find_vendor_with_member').message).toContain('loop.max');
    expect(callsOf(run, 'find_vendor_with_member')).toHaveLength(0);
  });
});

describe('L4.1 — a cursor follows the API from one value to the next', () => {
  it('reads from the last page towards the first, and stops at the match', async () => {
    const run = await runFlow(flow('cursor-pages.flow.yml'), { responses: cursorResponses() });

    expect(run.status).toBe('passed');
    // `start` is `lastPage`, and each `next` is the `links.prev` of the page before. Page 1 is not read.
    expect(pagesRequested(run)).toEqual(['3', '2']);
    expect(run.step('search_vendor_pages').loop).toEqual({ count: 2, matched: true, index: 1, value: 2 });
  });

  it('gives the loop that follows it the candidates of the match, and stops there too', async () => {
    const run = await runFlow(flow('cursor-pages.flow.yml'), { responses: cursorResponses() });

    expect(callsOf(run, 'match_candidate').map((call) => call.json.vendor_id)).toEqual(['c1', 'c2']);
    expect(pathOf(callsOf(run, 'confirm_match')[0])).toBe('/loops/vendors/c2');
  });
});

describe('L4.2 — a cursor ends where next returns null', () => {
  it('succeeds with matched: false when no page has a candidate, having read every page', async () => {
    const noCandidates = { ...PAGES, 2: { data: [], links: { prev: PAGE_LINK(1) } } };
    const run = await runFlow(flow('cursor-pages.flow.yml'), { responses: cursorResponses(noCandidates) });

    expect(pagesRequested(run)).toEqual(['3', '2', '1']);
    expect(run.step('search_vendor_pages').loop).toEqual({ count: 3, matched: false });
    // The loop that follows it is guarded on the match, and has nothing to do.
    expect(run.outcome('match_candidate')).toBe('skipped:condition-false');
  });

  it('ends at once where the cursor has no first value', async () => {
    const { entry, files } = variant(flow('cursor-pages.flow.yml'), (document) => {
      document.steps[1].loop.start = '{{steps.list_vendors.noSuchOutput}}';
      document.steps[0].outputs.noSuchOutput = { script: '() => null' };
    });
    const run = await runFlow(entry, { files, responses: cursorResponses() });

    expect(run.outcome('search_vendor_pages')).toBe('success');
    expect(run.step('search_vendor_pages').loop).toEqual({ count: 0, matched: false });
  });
});

describe('L4.3 — loop.previous carries values from one iteration to the next', () => {
  const objectPages = (pages) => ({
    loopListObjects: (request) => ok(pages[queryOf(request, 'page')]),
    loopRpc: ok({ data: { ok: true } })
  });

  const MORE = {
    1: { data: [{ id: 'p1', kind: 'payable' }, { id: 'o', kind: 'other' }], has_more: true },
    2: { data: [{ id: 'p2', kind: 'payable' }], has_more: true },
    3: { data: [{ id: 'p3', kind: 'payable' }], has_more: true },
    4: { data: [{ id: 'p4', kind: 'payable' }], has_more: false }
  };

  it('collects the matches across pages, and stops when there are enough', async () => {
    const run = await runFlow(flow('ledger-pages.flow.yml'), { responses: objectPages(MORE) });

    expect(run.status).toBe('passed');
    // Three matches are enough, and page 4 would have been the fourth request.
    expect(callsOf(run, 'read_pages').map((call) => queryOf(call.request, 'page'))).toEqual(['1', '2', '3']);
    expect(run.step('read_pages').outputs.matches.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    expect(run.call('loopRpc').json.key).toBe('p1');
  });

  it('adds one to the cursor from ctx.loop, which is the iteration that has just ended', async () => {
    const run = await runFlow(flow('ledger-pages.flow.yml'), { responses: objectPages(MORE) });

    const nexts = run.scripts.filter((script) => script.source.includes('ctx.loop.page + 1'));
    expect(nexts.map((script) => script.args[1].loop.page)).toEqual([1, 2]);
    // `loop.previous` is undefined on the first iteration, and the outputs of the one before after it.
    const matchScripts = run.scripts.filter((script) => script.source.includes('ctx.loop.previous'));
    expect(matchScripts.map((script) => Boolean(script.args[1].loop.previous))).toEqual([false, true, true]);
  });

  it('ends where the API has no more pages, with fewer matches than were wanted', async () => {
    const run = await runFlow(flow('ledger-pages.flow.yml'), {
      responses: objectPages({ ...MORE, 2: { data: [{ id: 'p2', kind: 'payable' }], has_more: false } })
    });

    expect(run.step('read_pages').loop).toEqual({ count: 2, matched: false });
    expect(run.outcome('use_matches')).toBe('skipped:condition-false');
  });
});

describe('L4.4 — a cursor that has not ended at max has not finished', () => {
  const unending = {
    loopListObjects: () => ok({ data: [{ id: 'p', kind: 'other' }], has_more: true }),
    loopRpc: ok({ data: { ok: true } })
  };

  it('succeeds with matched: false where there is an until', async () => {
    const { entry, files } = variant(flow('ledger-pages.flow.yml'), (document) => {
      document.steps[0].loop.max = 3;
    });
    const run = await runFlow(entry, { files, responses: unending });

    expect(run.outcome('read_pages')).toBe('success');
    expect(run.step('read_pages').loop).toEqual({ count: 3, matched: false });
  });

  it('fails with loop-max-reached where there is none', async () => {
    const { entry, files } = variant(flow('ledger-pages.flow.yml'), (document) => {
      document.steps[0].loop.max = 3;
      delete document.steps[0].loop.until;
    });
    const run = await runFlow(entry, { files, responses: unending });

    expect(run.outcome('read_pages')).toBe('failed:loop-max-reached');
    expect(callsOf(run, 'read_pages')).toHaveLength(3);
  });

  it('succeeds where the cursor ends exactly at max', async () => {
    const { entry, files } = variant(flow('ledger-pages.flow.yml'), (document) => {
      document.steps[0].loop.max = 2;
      delete document.steps[0].loop.until;
    });
    const run = await runFlow(entry, {
      files,
      responses: {
        loopListObjects: (request) =>
          ok({ data: [], has_more: queryOf(request, 'page') < 2 }),
        loopRpc: ok({ data: { ok: true } })
      }
    });

    expect(run.step('read_pages').loop).toEqual({ count: 2, matched: true });
  });
});

describe('L5.1 — retry: inside a loop retries only the current iteration', () => {
  const retrying = () =>
    variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].retry = { maxAttempts: 3, delay: 100, shouldRetry: '(res) => res.status === 503' };
    });

  it('sends the same request again, and goes on with the next value after it', async () => {
    const { entry, files } = retrying();
    let seen = 0;
    const run = await runFlow(entry, {
      files,
      responses: rpcResponses({
        'acct-2': (request, ctx, info) => {
          seen += 1;
          return seen === 1 ? { status: 503, body: {} } : ok({ data: { ok: true, result: 'r2' } });
        }
      })
    });

    expect(run.status).toBe('passed');
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-2', 'acct-2', 'acct-3']);
    expect(run.sleeps).toEqual([100]);
  });

  it('counts every request as an attempt of the step', async () => {
    const { entry, files } = retrying();
    let seen = 0;
    const run = await runFlow(entry, {
      files,
      responses: rpcResponses({
        'acct-2': () => {
          seen += 1;
          return seen === 1 ? { status: 503, body: {} } : ok({ data: { ok: true, result: 'r2' } });
        }
      })
    });

    // Three iterations and one retry.
    expect(run.step('call_each').attempts).toBe(4);
    expect(run.step('call_each').loop.count).toBe(3);
    // The result says which iteration the retry was in, so a reader can open that one's attempts.
    expect(run.step('call_each').loop.attemptsPerIteration).toEqual([1, 2, 1]);
  });

  it('fails the step at the iteration whose retries ran out', async () => {
    const { entry, files } = retrying();
    const run = await runFlow(entry, {
      files,
      responses: rpcResponses({ 'acct-2': { status: 503, body: {} } })
    });

    expect(run.outcome('call_each')).toBe('failed:retries-exhausted');
    expect(run.step('call_each').loop.index).toBe(1);
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-2', 'acct-2', 'acct-2']);
  });
});

describe('L5.2 — maxDuration bounds the whole loop, and not each iteration', () => {
  /** Every iteration costs 1000 ms of the harness clock: one attempt, a delay, and a second attempt. */
  const slow = (maxDuration) =>
    variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].maxDuration = maxDuration;
      document.steps[0].retry = { maxAttempts: 2, delay: 1000, shouldRetry: '(res, attempt) => attempt < 2' };
    });

  it('fails the iteration that the budget runs out in, where one iteration alone would have fitted', async () => {
    const { entry, files } = slow(2000);
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    // Iteration 0 costs 1000 ms and fits. Iteration 1 meets the end of the budget at its delay.
    expect(run.outcome('call_each')).toBe('failed:max-duration-exceeded');
    expect(run.step('call_each').loop).toMatchObject({ index: 1, value: 'acct-2' });
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-1', 'acct-2']);
  });

  it('gives the iteration the remainder of the budget, and not a new one', async () => {
    const { entry, files } = slow(2500);
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.outcome('call_each')).toBe('failed:max-duration-exceeded');
    expect(run.step('call_each').loop.index).toBe(2);
  });

  /**
   * Time passes inside a sub-flow without the loop looking, so this is the budget being met between
   * two iterations: the delay is a step of the child's, and the child has no budget of its own.
   */
  it('fails before an iteration starts where the budget has run out between two', async () => {
    const child = variant(flow('per-key-child.flow.yml'), (document) => {
      document.steps[0].retry = { maxAttempts: 2, delay: 1000, shouldRetry: '(res, attempt) => attempt < 2' };
    });
    const parent = variant(flow('per-key-subflow.flow.yml'), (document) => {
      document.steps[0].uses = './per-key-child.variant.flow.yml';
      document.steps[0].maxDuration = 1500;
      delete document.steps[0].loop.until;
    });
    const run = await runFlow(parent.entry, {
      files: { ...child.files, ...parent.files },
      responses: {
        loopSearchObject: (request) => (queryOf(request, 'page') === '1' ? ok({ data: [] }) : ok({ total: 1 })),
        loopRpc: ok({ data: { ok: true } })
      }
    });

    expect(run.outcome('search_each_key')).toBe('failed:max-duration-exceeded');
    expect(run.step('search_each_key').message).toContain('after 2 iterations');
    expect(run.step('search_each_key').loop.count).toBe(2);
  });

  it('lets the loop finish when the budget is enough for all of it', async () => {
    const { entry, files } = slow(10000);
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.outcome('call_each')).toBe('success');
  });
});

describe('L5.3 — the rate limiter takes one token for each request', () => {
  it('paces five iterations as five requests', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.apis['loops-api'] = { source: '../../specs/loops-v1.yml', rateLimit: { requests: 1, per: 'second' } };
      document.steps[0].loop.over = ['acct-1', 'acct-2', 'acct-3', 'acct-4', 'acct-5'];
      // Without `summarize`, which would be a sixth request.
      document.steps.pop();
    });
    const run = await runFlow(entry, { files, responses: rpcResponses() });

    expect(run.calls).toHaveLength(5);
    // The first request is entitled to go at once, and each of the four after it waits a second.
    expect(run.sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(run.step('call_each').rateLimitWaitMs).toBe(4000);
  });
});

describe('L5.4 — cancellation stops a loop between iterations', () => {
  it('reports the step as cancelled, and sends no value after the stop', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), {
      responses: rpcResponses({
        'acct-2': (request, ctx, info) => {
          info.abort();
          return ok({ data: { ok: true, result: 'r2' } });
        }
      })
    });

    expect(run.status).toBe('cancelled');
    expect(run.outcome('call_each')).toBe('cancelled:run-cancelled');
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['acct-1', 'acct-2']);
    expect(run.step('call_each').loop).toEqual({ count: 2, of: 3, matched: false });
    expect(run.outcome('summarize')).toBe('skipped:run-cancelled');
  });
});

describe('L6.1 — concurrency runs iterations in parallel up to its number', () => {
  const MOST_IN_FLIGHT = (run) => {
    const edges = run.calls.flatMap((call) => [
      { at: call.startedAt, by: 1 },
      { at: call.settledAt, by: -1 }
    ]);
    let current = 0;
    let most = 0;
    for (const edge of edges.sort((left, right) => left.at - right.at)) {
      current += edge.by;
      most = Math.max(most, current);
    }
    return most;
  };

  const parallel = (over) =>
    variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.over = over;
      document.steps[0].loop.concurrency = 3;
      // Without `summarize`, which runs after the loop and would make the count of the loop's own
      // requests depend on it.
      document.steps.pop();
    });

  it('keeps three in flight out of five', async () => {
    const { entry, files } = parallel(['a1', 'a2', 'a3', 'a4', 'a5']);
    const run = await runFlow(entry, {
      files,
      responses: { loopRpc: { status: 200, body: { data: { ok: true } }, delayMs: 30 } }
    });

    expect(run.calls).toHaveLength(5);
    expect(MOST_IN_FLIGHT(run)).toBe(3);
  });

  it('keeps iterations in index order whatever order the calls finish in', async () => {
    const { entry, files } = parallel(['a1', 'a2', 'a3']);
    const delays = { a1: 60, a2: 30, a3: 0 };
    const run = await runFlow(entry, {
      files,
      responses: {
        loopRpc: (request) => ({
          status: 200,
          body: { data: { ok: true, result: request.body.value.key } },
          delayMs: delays[request.body.value.key]
        })
      }
    });

    // The calls finished a3, a2, a1; the list is in the order of the values.
    expect(run.calls.map((call) => call.json.key)).toEqual(['a1', 'a2', 'a3']);
    expect(run.step('call_each').loop.count).toBe(3);
  });

  it('publishes iterations in index order', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.concurrency = 3;
    });
    const delays = { 'acct-1': 60, 'acct-2': 30, 'acct-3': 0 };
    const run = await runFlow(entry, {
      files,
      responses: {
        loopRpc: (request) => ({
          status: 200,
          body: { data: { ok: true, result: RPC_RESULTS[request.body.value.key] } },
          delayMs: delays[request.body.value.key] || 0
        })
      }
    });

    // `summarize` is the fourth request, and reads `steps.call_each.iterations`.
    expect(run.call('loopRpc', 4).json.key).toBe('got [{"result":"r1"},{"result":"r2"},{"result":"r3"}]');
  });
});

describe('L6.2 — the first failure cancels the iterations in flight', () => {
  const failFast = () =>
    variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.over = ['a1', 'a2', 'a3', 'a4'];
      document.steps[0].loop.concurrency = 2;
    });

  it('reports the failing index, starts no iteration after it, and aborts the request in flight', async () => {
    const { entry, files } = failFast();
    let aborted = false;
    const run = await runFlow(entry, {
      files,
      responses: {
        loopRpc: (request, ctx) => {
          const key = request.body.value.key;
          if (key === 'a2') return { status: 500, body: {} };
          // a1 is still in flight when a2 fails, and waits until the loop aborts it.
          return new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          });
        }
      }
    });

    expect(aborted).toBe(true);
    expect(run.outcome('call_each')).toBe('failed:unexpected-status');
    expect(run.step('call_each').loop).toMatchObject({ index: 1, value: 'a2' });
    // a3 and a4 were never started, and the aborted a1 is not counted as a failure of its own.
    expect(callsOf(run, 'call_each').map((call) => call.json.key)).toEqual(['a1', 'a2']);
    expect(run.step('call_each').loop.count).toBe(1);
  });

  it('reports the lowest index where more than one iteration failed', async () => {
    const { entry, files } = failFast();
    const run = await runFlow(entry, {
      files,
      responses: {
        loopRpc: (request) => ({
          status: 500,
          body: {},
          // a1 fails after a2 has, with a response rather than an abort.
          delayMs: request.body.value.key === 'a1' ? 30 : 0
        })
      }
    });

    expect(run.step('call_each').loop).toMatchObject({ index: 0, value: 'a1' });
  });
});

describe('L7.1 — a loop on a uses: step invokes the sub-flow for each value', () => {
  const searchResponses = (totals = { 'key-1': 2, 'key-2': 4, 'key-3': 6 }) => ({
    loopSearchObject: (request) => {
      const key = new URL(request.url).pathname.split('/')[3];
      return queryOf(request, 'page') === '1' ? ok({ data: [] }) : ok({ total: totals[key] });
    },
    loopRpc: ok({ data: { ok: true } })
  });

  it('builds with: again for each iteration, with loop.* in scope', async () => {
    const run = await runFlow(flow('per-key-subflow.flow.yml'), { responses: searchResponses() });

    expect(run.status).toBe('passed');
    expect(run.calls.filter((call) => call.operationId === 'loopSearchObject').map(pathOf)).toEqual([
      '/loops/objects/key-1/search',
      '/loops/objects/key-1/search',
      '/loops/objects/key-2/search',
      '/loops/objects/key-2/search'
    ]);
  });

  it('asks until about the exports of the sub-flow, and stops at the match', async () => {
    const run = await runFlow(flow('per-key-subflow.flow.yml'), { responses: searchResponses() });

    // key-1 exports a total of 2, which is below 4; key-2 exports 4; key-3 is never invoked.
    expect(run.step('search_each_key').loop).toEqual({ count: 2, of: 3, matched: true, index: 1, value: 'key-2' });
    expect(run.step('search_each_key').outputs).toEqual({ total: 4 });
    expect(pathOf(run.call('loopRpc'))).toBe('/loops/rpc');
    expect(run.call('loopRpc').json.key).toBe('total 4');
  });

  it('names the steps inside the sub-flow by the iteration they ran for', async () => {
    const run = await runFlow(flow('per-key-subflow.flow.yml'), { responses: searchResponses() });

    expect(Object.keys(run.table())).toEqual([
      'search_each_key',
      'search_each_key/iteration-0/page_1',
      'search_each_key/iteration-0/page_2',
      'search_each_key/iteration-1/page_1',
      'search_each_key/iteration-1/page_2',
      'record_total'
    ]);
  });

  it('runs every value where there is no until, and keeps each export in order', async () => {
    const { entry, files } = variant(flow('per-key-subflow.flow.yml'), (document) => {
      delete document.steps[0].loop.until;
      document.steps[1].when = 'steps.search_each_key.matched eq true';
    });
    const run = await runFlow(entry, { files, responses: searchResponses() });

    expect(run.step('search_each_key').loop).toEqual({ count: 3, of: 3, matched: true });
    expect(run.step('search_each_key').outputs).toEqual({});
    expect(run.callsFor('loopSearchObject')).toHaveLength(6);
  });

  it('fails the step where an iteration of the sub-flow fails, naming the iteration', async () => {
    const run = await runFlow(flow('per-key-subflow.flow.yml'), {
      responses: {
        loopSearchObject: (request) =>
          queryOf(request, 'page') === '1' ? ok({ data: [] }) : { status: 500, body: {} },
        loopRpc: ok({ data: { ok: true } })
      }
    });

    expect(run.outcome('search_each_key')).toBe('failed:subflow-failed');
    expect(run.step('search_each_key').message).toContain('loop.index 0 (value "key-1")');
    // The step inside the sub-flow that failed, by the id that its own result has.
    expect(run.step('search_each_key').message).toContain('search_each_key/iteration-0/page_2');
  });

  /**
   * §12.3: anything that is data must be declared. A sub-flow reads `params.key`; a reference to the
   * caller's `loop` is one that its caller's loop does not reach, and it stays as it was written.
   */
  it('keeps the caller\'s loop out of the sub-flow', async () => {
    const child = variant(flow('per-key-child.flow.yml'), (document) => {
      document.steps[0].pathParams.key = '{{loop.key}}';
    });
    const parent = variant(flow('per-key-subflow.flow.yml'), (document) => {
      document.steps[0].uses = './per-key-child.variant.flow.yml';
    });
    const run = await runFlow(parent.entry, {
      files: { ...child.files, ...parent.files },
      responses: searchResponses()
    });

    const first = run.callsFor('loopSearchObject')[0];
    expect(decodeURIComponent(pathOf(first))).toContain('{{loop.key}}');
    expect(pathOf(first)).not.toContain('key-1');
  });
});

describe('L8.1 — each request is captured under its iteration', () => {
  it('writes one directory for each iteration, with one attempt file for each request', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    expect(run.layout()).toEqual([
      'call_each/iteration-0/attempt-1.json',
      'call_each/iteration-1/attempt-1.json',
      'call_each/iteration-2/attempt-1.json',
      'flow.json',
      'flow.yml',
      'inputs.json',
      'run.json',
      'summarize/attempt-1.json',
      'summary.json'
    ]);
  });

  it('numbers the attempts of each iteration from 1 again', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].retry = { maxAttempts: 2, delay: 0, shouldRetry: '(res) => res.status === 503' };
    });
    let seen = 0;
    const run = await runFlow(entry, {
      files,
      responses: rpcResponses({
        'acct-2': () => {
          seen += 1;
          return seen === 1 ? { status: 503, body: {} } : ok({ data: { ok: true, result: 'r2' } });
        }
      })
    });

    expect(run.layout().filter((target) => target.startsWith('call_each/'))).toEqual([
      'call_each/iteration-0/attempt-1.json',
      'call_each/iteration-1/attempt-1.json',
      'call_each/iteration-1/attempt-2.json',
      'call_each/iteration-2/attempt-1.json'
    ]);
  });

  it('records which iteration an attempt belongs to, and the request that it sent', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    const capture = await run.readCapture({ stepId: 'call_each', loopIteration: 1, attempt: 1 });
    expect(capture.loopIteration).toBe(1);
    expect(JSON.parse(capture.request.body.text)).toEqual({ key: 'acct-2' });
  });

  it('names the directory of the step as the capture path of the step', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    expect(run.step('call_each').capturePath).toBe(path.join(run.captureDir, 'call_each'));
  });

  it('lists a looped step as captured, though its own directory holds no attempt file', async () => {
    const run = await runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() });

    const stored = await run.readRun({ stepIds: ['call_each', 'summarize'] });
    expect(stored.capturedSteps).toEqual(['call_each', 'summarize']);
  });

  it('captures the steps inside a sub-flow under the iteration that ran them', async () => {
    const run = await runFlow(flow('per-key-subflow.flow.yml'), {
      responses: {
        loopSearchObject: (request) => (queryOf(request, 'page') === '1' ? ok({ data: [] }) : ok({ total: 9 })),
        loopRpc: ok({ data: { ok: true } })
      }
    });

    expect(run.layout().filter((target) => target.startsWith('search_each_key/'))).toEqual([
      'search_each_key/iteration-0/page_1/attempt-1.json',
      'search_each_key/iteration-0/page_2/attempt-1.json'
    ]);
  });

  it('leaves the paths of a step without a loop as they were', async () => {
    const run = await runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses() });

    expect(run.layout()).toContain('find_vendors/attempt-1.json');
    expect(run.layout()).toContain('read_partner/attempt-1.json');
  });
});

describe('L8.2 — step:iteration announces each iteration', () => {
  const iterationsOf = async (file, options) => {
    const announced = [];
    await runFlow(file, {
      ...options,
      onEvent: (event) => {
        if (event.type === 'step:iteration') announced.push(event);
      }
    });
    return announced;
  };

  it('says which iteration, out of how many, and for which value', async () => {
    const announced = await iterationsOf(flow('each-call.flow.yml'), { responses: rpcResponses() });

    expect(announced.map(({ id, iteration, of, value }) => ({ id, iteration, of, value }))).toEqual([
      { id: 'call_each', iteration: 0, of: 3, value: 'acct-1' },
      { id: 'call_each', iteration: 1, of: 3, value: 'acct-2' },
      { id: 'call_each', iteration: 2, of: 3, value: 'acct-3' }
    ]);
    // `index` is the iteration of the run, as it is on every step event.
    expect(announced.every((event) => event.index === 0)).toBe(true);
  });

  it('says which iteration each attempt belongs to, and says it only for a loop', async () => {
    const attempts = [];
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].retry = { maxAttempts: 2, delay: 0, shouldRetry: '(res) => res.status === 503' };
    });
    let seen = 0;
    await runFlow(entry, {
      files,
      responses: rpcResponses({
        'acct-2': () => {
          seen += 1;
          return seen === 1 ? { status: 503, body: {} } : ok({ data: { ok: true, result: 'r2' } });
        }
      }),
      onEvent: (event) => {
        if (event.type === 'step:attempt') attempts.push([event.id, event.iteration, event.attempt]);
      }
    });

    expect(attempts).toEqual([
      ['call_each', 0, 1],
      ['call_each', 1, 1],
      ['call_each', 1, 2],
      ['call_each', 2, 1],
      // `summarize` has no loop, so its attempt names no iteration.
      ['summarize', undefined, 1]
    ]);
  });

  it('gives no total for a cursor, which cannot know it', async () => {
    const announced = await iterationsOf(flow('cursor-pages.flow.yml'), { responses: cursorResponses() });

    const pages = announced.filter((event) => event.id === 'search_vendor_pages');
    expect(pages.map((event) => event.value)).toEqual([3, 2]);
    expect(pages.every((event) => !('of' in event))).toBe(true);
  });

  it('caps the total at max, which is as many as can run', async () => {
    const { entry, files } = variant(flow('each-call.flow.yml'), (document) => {
      document.steps[0].loop.max = 2;
    });
    const announced = await iterationsOf(entry, { files, responses: rpcResponses() });

    expect(announced.map((event) => event.of)).toEqual([2, 2]);
  });

  /** §14.4: a value that the run knows is secret is masked wherever the run reports it. */
  it('masks a value that the run knows is secret, in the event and in the result', async () => {
    const announced = [];
    const run = await runFlow(flow('each-call.flow.yml'), {
      secrets: ['acct-2'],
      responses: rpcResponses({ 'acct-2': { status: 500, body: {} } }),
      onEvent: (event) => {
        if (event.type === 'step:iteration') announced.push(event.value);
      }
    });

    expect(announced).toEqual(['acct-1', engine.MASK, ...announced.slice(2)]);
    expect(run.step('call_each').message).not.toContain('acct-2');
    expect(run.step('call_each').loop.value).toBe(engine.MASK);
  });
});

describe('L10.1 — the five loops of 006 §1 can be written as flows', () => {
  const FLOWS_OF_THE_PROBLEM = [
    'retrieve-or-create.flow.yml',
    'cursor-pages.flow.yml',
    'ledger-pages.flow.yml',
    'each-call.flow.yml',
    'per-key-subflow.flow.yml',
    'per-key-child.flow.yml'
  ];

  it.each(FLOWS_OF_THE_PROBLEM)('validates %s with nothing to report', async (name) => {
    expect(await validate(flow(name))).toEqual([]);
  });

  it('runs each of them to a pass', async () => {
    const runs = await Promise.all([
      runFlow(flow('retrieve-or-create.flow.yml'), { responses: vendorResponses() }),
      runFlow(flow('cursor-pages.flow.yml'), { responses: cursorResponses() }),
      runFlow(flow('each-call.flow.yml'), { responses: rpcResponses() })
    ]);

    expect(runs.map((run) => run.status)).toEqual(['passed', 'passed', 'passed']);
  });
});

describe('L11.1 — the flow description marks a looped step and draws what it reads', () => {
  it('marks the step with the most iterations it can run, and no other', async () => {
    const description = await describeFlow(flow('retrieve-or-create.flow.yml'));
    const markers = (id) => description.nodes.find((node) => node.id === id).markers;

    expect(markers('find_vendor_with_member').loopMaxIterations).toBe(25);
    expect(markers('find_vendors').loopMaxIterations).toBeUndefined();
  });

  it('draws over: as a data edge from the step that produced the list', async () => {
    const description = await describeFlow(flow('retrieve-or-create.flow.yml'));

    expect(description.edges).toContainEqual({
      from: 'find_vendors',
      to: 'find_vendor_with_member',
      kind: 'data',
      output: 'candidateIds',
      declared: true
    });
  });

  it('draws no edge for matched, which is a built-in', async () => {
    const description = await describeFlow(flow('retrieve-or-create.flow.yml'));

    const edgesToCreate = description.edges.filter((edge) => edge.to === 'create_vendor' && edge.kind === 'data');
    expect(edgesToCreate).toEqual([]);
  });
});

describe('L11.2 — the builder leaves a loop as it was', () => {
  const fs = require('fs');
  const text = fs.readFileSync(file('retrieve-or-create.flow.yml'), 'utf8');

  it('writes the same bytes where there is no edit', () => {
    expect(engine.applyFlowEdits(text, [])).toMatchObject({ ok: true, changed: false, text });
  });

  it('leaves the loop block untouched where another key of the step is patched', () => {
    const result = engine.applyFlowEdits(text, [
      { kind: 'step.patch', id: 'find_vendor_with_member', patch: { set: { timeout: 5000 } } }
    ]);

    expect(result.ok).toBe(true);
    const block = (source) => source.slice(source.indexOf('    loop:'), source.indexOf('    pre:'));
    expect(block(result.text)).toBe(block(text));
  });

  it('lists the loop as a key the builder does not edit', () => {
    const model = engine.readFlowEditModel(text);
    const step = model.steps.find((entry) => entry.id === 'find_vendor_with_member');

    expect(step.opaque).toContainEqual({ key: 'loop' });
    expect(step.fields.loop).toBeUndefined();
  });
});
