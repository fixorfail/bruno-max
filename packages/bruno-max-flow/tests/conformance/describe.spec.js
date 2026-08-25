/**
 * R4q — the described graph (001-C §7, 002 §11.1 and §5.3).
 *
 * These assert what `describeFlow` *returns*, never how it is drawn: 002-C's U1 owns the drawing.
 * The split matters because the distinctions here are invisible once rendered wrongly — a sequence
 * edge and a declared one are the same relationship by the time the graph exists, and only this
 * layer can still tell them apart.
 */
const path = require('path');

const { describeFlow, validate, variant, FLOWS } = require('./harness');

const flow = (name) => `regressions/${name}`;

const edgesBetween = (description, kind) =>
  description.edges.filter((edge) => edge.kind === kind).map((edge) => `${edge.from}->${edge.to}`);

const node = (description, id) => {
  const found = description.nodes.find((entry) => entry.id === id);
  if (!found) throw new Error(`no node ${id} in ${description.nodes.map((entry) => entry.id).join(', ')}`);
  return found;
};

describe('R4q — control edges', () => {
  it('draws the implicit sequence, and marks it as one', async () => {
    const description = await describeFlow(flow('r1-dead-service.flow.yml'));

    expect(description.edges.filter((edge) => edge.kind !== 'data')).toEqual([
      { from: 'create', to: 'consume', kind: 'sequence', status: undefined, join: undefined }
    ]);
    // The linear case is the common one, and one step per rank is what makes it draw as a column.
    expect(description.nodes.map((entry) => entry.rank)).toEqual([0, 1]);
  });

  it('rewires the chain when a step is inserted in the middle', async () => {
    const { entry, files } = variant(flow('r1-dead-service.flow.yml'), (document) => {
      document.steps.splice(1, 0, { id: 'inserted', operation: 'regress-api#getState' });
    });
    const description = await describeFlow(entry, { files });

    expect(edgesBetween(description, 'sequence')).toEqual(['create->inserted', 'inserted->consume']);
  });

  // `audit` writes `depends: [settle]`, naming the step directly above it. After normalization that
  // is byte-identical to having written nothing, so only the flag the parser records separates the
  // two — and getting this wrong makes every declared edge in a linear flow read as implicit.
  it('distinguishes a declared depends from the sequence it replaces', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(edgesBetween(description, 'sequence')).toEqual(['sign_in->create']);
    expect(edgesBetween(description, 'depends')).toEqual([
      'create->fallback',
      'create->settle',
      'fallback->settle',
      'settle->audit'
    ]);
  });

  it('carries a status set only when it is not the default', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));
    const conditioned = description.edges.find((edge) => edge.to === 'fallback');

    expect(conditioned.status).toEqual(['failed']);
    for (const edge of description.edges.filter((entry) => entry.to === 'audit' && entry.kind === 'depends')) {
      expect(edge.status).toBeUndefined();
    }
  });

  it('marks an any join on the edges into the receiving node', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    for (const edge of description.edges.filter((entry) => entry.to === 'settle' && entry.kind === 'depends')) {
      expect(edge.join).toBe('any');
    }

    const { entry, files } = variant(flow('r4q-graph.flow.yml'), (document) => {
      const settle = document.steps.find((step) => step.id === 'settle');
      settle.depends = { all: settle.depends.any };
    });
    const allJoin = await describeFlow(entry, { files });

    for (const edge of allJoin.edges.filter((candidate) => candidate.to === 'settle' && candidate.kind === 'depends')) {
      expect(edge.join).toBe('all');
    }
  });

  it('ranks by longest path, so a step under uneven branches sits below the longer one', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(node(description, 'sign_in').rank).toBe(0);
    expect(node(description, 'create').rank).toBe(1);
    expect(node(description, 'fallback').rank).toBe(2);
    // `settle` joins create (rank 1) and fallback (rank 2), so the longer path decides.
    expect(node(description, 'settle').rank).toBe(3);
    expect(node(description, 'audit').rank).toBe(4);
  });
});

describe('R4q — data edges', () => {
  it('names a declared output and marks it declared', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));
    const declared = description.edges.filter((edge) => edge.kind === 'data' && edge.declared);

    expect(declared).toContainEqual({
      from: 'create',
      to: 'audit',
      kind: 'data',
      output: 'thingId',
      declared: true
    });
  });

  it('draws one edge for an output interpolated more than once', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));
    const repeated = description.edges.filter(
      (edge) => edge.kind === 'data' && edge.from === 'create' && edge.to === 'audit' && edge.output === 'thingId'
    );

    // The fixture reads `steps.create.thingId` twice in `audit`; that is one data path.
    expect(repeated).toHaveLength(1);
  });

  it('draws raw body access as an undeclared edge, and warns about the same reference', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));
    const diagnostics = await validate(flow('r4q-graph.flow.yml'));

    expect(description.edges).toContainEqual({
      from: 'sign_in',
      to: 'audit',
      kind: 'data',
      output: 'body',
      declared: false
    });
    // The graph and the validator have to agree; either alone is a claim the other contradicts.
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'undeclared-dependency', stepId: 'audit' })
    );
  });

  it('draws no data edge for built-in step metadata', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    // `settle` reads `steps.create.ok` in its `when:` — always-available metadata, not a data path.
    expect(description.edges.filter((edge) => edge.kind === 'data' && edge.to === 'settle')).toEqual([]);
    expect(description.edges.some((edge) => edge.output === 'ok')).toBe(false);
  });
});

describe('R4q — shared slots', () => {
  it('routes a slot through its own endpoints rather than writer to reader', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(description.edges).toContainEqual({ from: 'create', to: 'ref', kind: 'slot-write', slot: 'ref' });
    expect(description.edges).toContainEqual({ from: 'ref', to: 'audit', kind: 'slot-read', slot: 'ref' });
    // §9.1's slots name no producer, so an edge asserting one would contradict the format.
    expect(description.edges.some((edge) => edge.from === 'create' && edge.to === 'audit' && edge.slot)).toBe(false);
  });

  it('reports each slot with its writers and readers', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(description.slots).toEqual([{ name: 'ref', writers: ['create'], readers: ['audit'] }]);
  });
});

describe('R4q — nodes', () => {
  it('resolves the operation to a method and a path, not the reference the file wrote', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(node(description, 'create').operation).toEqual({
      api: 'regress-api',
      method: 'POST',
      path: '/things',
      operationId: 'createThing'
    });
  });

  it('marks only what a step actually carries', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(node(description, 'settle').markers).toEqual({
      conditional: true,
      retryMaxAttempts: undefined,
      allowsErrorStatus: false,
      usesSharedSlot: false
    });
    expect(node(description, 'fallback').markers).toMatchObject({
      conditional: false,
      retryMaxAttempts: 3,
      allowsErrorStatus: true
    });
    expect(node(description, 'create').markers.usesSharedSlot).toBe(true);
    expect(node(description, 'audit').markers.usesSharedSlot).toBe(true);
  });

  it('carries declared output names and a position', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(node(description, 'create').outputs).toEqual(['thingId']);
    expect(node(description, 'settle').outputs).toEqual([]);
    for (const entry of description.nodes) {
      expect(entry.position.line).toBeGreaterThan(0);
      expect(entry.position.column).toBeGreaterThan(0);
    }
  });

  it('returns the same diagnostics validateFlow does', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(description.diagnostics).toEqual(await validate(flow('r4q-graph.flow.yml')));
  });
});

/**
 * 001 §6.2's `color:`. The engine carries it and decides nothing with it: what a flow *does* is
 * unchanged, and 002 §5.1 is the only reader. It is on the description because the binding is the
 * thing being coloured, and the file is the only place an author can say so.
 */
describe('R4q — API bindings', () => {
  it('lists the bindings the file declares, in file order', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(description.apis).toEqual([{ alias: 'regress-api', color: undefined }]);
  });

  it('carries a declared colour', async () => {
    const { entry, files } = variant(flow('r4q-graph.flow.yml'), (document) => {
      document.apis = { 'regress-api': { source: '../../specs/regressions-v1.yml', color: '#8ab4f8' } };
    });
    const description = await describeFlow(entry, { files });

    expect(description.apis).toEqual([{ alias: 'regress-api', color: '#8ab4f8' }]);
  });

  /**
   * A colour the renderer cannot parse falls back to the unpainted default, which is exactly what a
   * *missing* colour looks like — so silence would leave an author's typo indistinguishable from a
   * binding they never coloured. A warning, because it decides how a graph is drawn and never what
   * a flow does.
   */
  it('warns about a colour that is not one, and blocks nothing', async () => {
    const { entry, files } = variant(flow('r4q-graph.flow.yml'), (document) => {
      document.apis = { 'regress-api': { source: '../../specs/regressions-v1.yml', color: 'ultraviolet' } };
    });
    const diagnostics = await validate(entry, { files });

    const complaint = diagnostics.find((entry_) => entry_.code === 'invalid-api-color');
    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('ultraviolet');
    expect(diagnostics.some((entry_) => entry_.severity === 'error')).toBe(false);
  });

  it('accepts both hex forms and says nothing about them', async () => {
    for (const color of ['#abc', '#8AB4F8']) {
      const { entry, files } = variant(flow('r4q-graph.flow.yml'), (document) => {
        document.apis = { 'regress-api': { source: '../../specs/regressions-v1.yml', color } };
      });

      expect(await validate(entry, { files })).not.toContainEqual(
        expect.objectContaining({ code: 'invalid-api-color' })
      );
    }
  });
});

/**
 * §5.5's boundaries. Everything here is presentation: the first case pins that a flow carrying
 * stages resolves the same graph as the same flow without them, and every failure below is a
 * warning that leaves the run alone.
 */
describe('R4q — stages', () => {
  const staged = (stages, edit) =>
    variant(flow('r4q-graph.flow.yml'), (document) => {
      edit?.(document);
      document.stages = stages;
    });

  it('resolves each boundary to the column its rule is drawn before', async () => {
    const { entry, files } = staged({ setup: 'sign_in', act: 'create', verify: 'audit' });
    const description = await describeFlow(entry, { files });

    expect(description.stages).toEqual([
      { name: 'setup', from: 'sign_in', rank: 0 },
      { name: 'act', from: 'create', rank: 1 },
      { name: 'verify', from: 'audit', rank: 4 }
    ]);
    expect(await validate(entry, { files })).not.toContainEqual(
      expect.objectContaining({ code: expect.stringContaining('stage') })
    );
  });

  // Both sides are round-tripped through the harness's writer, so the stages block is the only
  // difference between the two files — comparing against the committed fixture would compare
  // against its comments and line numbers as well.
  it('changes nothing about the graph it labels', async () => {
    const plain = staged(undefined);
    const labelled = staged({ setup: 'sign_in', act: 'create' });
    const before = await describeFlow(plain.entry, { files: plain.files });
    const after = await describeFlow(labelled.entry, { files: labelled.files });

    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
    expect(before.stages).toEqual([]);
  });

  it('drops a boundary at a step that does not exist, and warns', async () => {
    const { entry, files } = staged({ setup: 'sign_in', act: 'nowhere' });
    const description = await describeFlow(entry, { files });

    expect(description.stages.map((stage) => stage.name)).toEqual(['setup']);
    const complaint = description.diagnostics.find((entry_) => entry_.code === 'unknown-stage-step');
    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('nowhere');
    expect(description.diagnostics.some((entry_) => entry_.severity === 'error')).toBe(false);
  });

  it('drops a boundary that does not come after the one before it, and warns', async () => {
    const { entry, files } = staged({ act: 'settle', setup: 'create' });
    const diagnostics = await validate(entry, { files });

    const complaint = diagnostics.find((entry_) => entry_.code === 'stage-boundary-order');
    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('setup begins at create');
    expect((await describeFlow(entry, { files })).stages.map((stage) => stage.name)).toEqual(['act']);
  });

  /**
   * `audit` is listed last but, depending only on `create`, runs level with `fallback` — so no
   * vertical line separates them. Drawing the rule anyway would put `fallback` on the far side of a
   * boundary it shares a column with, which is a claim about execution order that is not true.
   */
  it('drops a boundary the schedule contradicts, naming the step that crosses it', async () => {
    const { entry, files } = staged({ act: 'create', teardown: 'audit' }, (document) => {
      document.steps.find((step) => step.id === 'audit').depends = ['create'];
    });
    const description = await describeFlow(entry, { files });

    expect(description.stages.map((stage) => stage.name)).toEqual(['act']);
    const complaint = description.diagnostics.find((entry_) => entry_.code === 'stage-out-of-order');
    expect(complaint.severity).toBe('warning');
    expect(complaint.message).toContain('fallback');
  });

  it('names the container of a sub-flow, never a step inside it', async () => {
    const boundary = (stages) =>
      variant(flow('r4-subflow-slot.flow.yml'), (document) => {
        document.stages = stages;
      });

    const container = boundary({ second: 'child' });
    expect((await describeFlow(container.entry, { files: container.files })).stages).toEqual([
      { name: 'second', from: 'child', rank: 1 }
    ]);

    // `use` draws as `child/use`, and a namespaced id is not addressable from the caller (§12).
    const internal = boundary({ inner: 'use' });
    const description = await describeFlow(internal.entry, { files: internal.files });
    expect(description.stages).toEqual([]);
    expect(description.diagnostics.some((entry_) => entry_.code === 'unknown-stage-step')).toBe(true);
  });
});

describe('R4q — sub-flows', () => {
  it('returns the container and its internals under namespaced ids', async () => {
    const description = await describeFlow(flow('r4-subflow-slot.flow.yml'));

    expect(description.nodes.map((entry) => entry.id)).toEqual(['create', 'child', 'child/use']);
    expect(node(description, 'child').kind).toBe('subflow');
    expect(node(description, 'child').uses).toBe('./r4-subflow-slot-child.flow.yml');
    expect(node(description, 'child/use').parent).toBe('child');
    expect(node(description, 'create').parent).toBeUndefined();
  });

  it('ranks an internal step within its own flow', async () => {
    const description = await describeFlow(flow('r4-subflow-slot.flow.yml'));

    // The container is rank 1 of its caller; its first internal step is rank 0 of the graph the app
    // draws beneath it, so the same library flow lays out identically in every caller.
    expect(node(description, 'child').rank).toBe(1);
    expect(node(description, 'child/use').rank).toBe(0);
  });
});

describe('R4q — identity and the broken cases', () => {
  it('reports the flow relative to its scope root, with its declared name', async () => {
    const description = await describeFlow(flow('r4q-graph.flow.yml'));

    expect(description.id).toBe(path.join('flows', 'regressions', 'r4q-graph.flow.yml'));
    expect(description.name).toBe('R4q — every edge kind');
    expect(description.isLibrary).toBe(false);
  });

  it('reports a library flow and its params', async () => {
    const description = await describeFlow(flow('r4-subflow-slot-child.flow.yml'));

    expect(description.isLibrary).toBe(true);
  });

  it('still opens a flow that does not parse', async () => {
    const entry = path.join(FLOWS, 'regressions', 'broken.variant.flow.yml');
    const description = await describeFlow(entry, {
      files: { [entry]: 'version: 1\nsteps:\n  - id: a\n   bad indent\n' }
    });

    expect(description.nodes).toEqual([]);
    expect(description.edges).toEqual([]);
    expect(description.id).toBe(path.join('flows', 'regressions', 'broken.variant.flow.yml'));
    expect(description.diagnostics.some((entry_) => entry_.code === 'parse-error')).toBe(true);
  });

  it('still draws a node whose api binding does not resolve', async () => {
    const { entry, files } = variant(flow('r1-dead-service.flow.yml'), (document) => {
      document.apis['regress-api'] = '../../specs/does-not-exist.yml';
    });
    const description = await describeFlow(entry, { files });

    expect(description.nodes.map((candidate) => candidate.id)).toEqual(['create', 'consume']);
    expect(node(description, 'create').operation).toBeUndefined();
    expect(description.diagnostics.some((candidate) => candidate.code === 'unresolved-alias')).toBe(true);
  });
});
