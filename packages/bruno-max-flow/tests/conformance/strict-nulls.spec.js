/**
 * §10.1's `strictNulls:` — a response check that tolerates a null where the document declares a type.
 *
 * The case it exists for is an API that serializes an absent value as `"field": null` across
 * hundreds of fields. The format's own answer is `nullable: true` written at each of them, and two
 * of the three shapes that need it cannot take the keyword at all: Ajv refuses to compile
 * `nullable` without a sibling `type`, which rules out a bare `$ref` and an `allOf`, and where it
 * does compile it does not rescue an `enum`. `fixtures/specs/nulls-v1.yml` is written around those
 * three shapes on purpose.
 *
 * The tolerance is declared on the **binding**, not in `config:`: whether a service sends nulls is a
 * property of its document, and a flow may bind two. A step may still override it, and §8.5's
 * connector files are where a scope states it once for every flow that calls the API.
 *
 * `nulls-31-v1.yml` is the same feature one dialect over. Its `coordinates` is the witness that the
 * right validator was chosen: `prefixItems` is not a draft-07 keyword, so a draft-07 reader ignores
 * it and the tuple checks nothing — silently, which is the only reason this is worth a test.
 */
const path = require('path');

const { runFlow, validate, variant, FLOWS } = require('./harness');

const flow = (name) => `nulls/${name}`;

/** §8.5's fixture scope, reused because a connector file is where a scope-wide tolerance lives. */
const CONNECTOR_WORKSPACE = path.join(FLOWS, 'connectors');
const CONNECTOR_SCOPE = {
  workspaceRoot: CONNECTOR_WORKSPACE,
  collectionRoot: path.join(CONNECTOR_WORKSPACE, 'collections', 'payments')
};
const connectorFlow = (name) => `connectors/collections/payments/flows/${name}`;

/** A profile as the document describes it, with nothing null anywhere. */
const PROFILE = { id: 'profile-1', company: { id: 'company-1', name: 'Acme' }, status: 'active' };
const CREATED = { status: 201, body: PROFILE };

/** The same profile with one field replaced, which is what every scenario here varies. */
const profileWith = (fields) => ({ status: 200, body: { ...PROFILE, ...fields } });

const readingProfile = (fields, options = {}) =>
  runFlow(flow('profiles.flow.yml'), {
    responses: { createProfile: CREATED, getProfile: profileWith(fields) },
    ...options
  });

/** The flow with `strictNulls: false` written where the scenario puts it. */
const relaxedAt = (place) =>
  variant(flow('profiles.flow.yml'), (document) => {
    if (place === 'binding') document.apis.profiles.strictNulls = false;
    else document.steps.find((step) => step.id === place).strictNulls = false;
  });

describe('§10.1 — a document that says nothing about null is read as meaning none', () => {
  it('refuses a null where the document declares a $ref', async () => {
    const run = await readingProfile({ company: null });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
    expect(run.step('read').validation.response.errors[0].path).toBe('/company');
  });

  it('refuses a null where the document declares an enum', async () => {
    const run = await readingProfile({ status: null });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
  });

  it('accepts a null at the one field the document annotates', async () => {
    const run = await readingProfile({ note: null });

    expect(run.outcome('read')).toBe('success');
  });
});

describe('§10.1 — strictNulls: false', () => {
  it('accepts a null through a $ref, which the format cannot annotate at all', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: { createProfile: CREATED, getProfile: profileWith({ company: null }) }
    });

    expect(run.outcome('read')).toBe('success');
  });

  it('accepts a null an enum refuses even when annotated', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: { createProfile: CREATED, getProfile: profileWith({ status: null }) }
    });

    expect(run.outcome('read')).toBe('success');
  });

  /**
   * The wrapper is `anyOf: [<the schema>, {type: null}]`, and a value that is neither fails all three
   * of its parts at once. Two of those three describe machinery the author did not write, so what is
   * reported is the one the document would have produced on its own.
   */
  it('reports a real mismatch in the words the document would have used', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: { createProfile: CREATED, getProfile: profileWith({ id: 42 }) }
    });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
    expect(run.step('read').validation.response.errors).toEqual([
      { path: '/id', message: 'must be string', keyword: 'type' }
    ]);
  });

  /** A null is a value. `required` is about a key being *there*, and is untouched. */
  it('still refuses a field the document requires and the response omits', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: {
        createProfile: CREATED,
        getProfile: { status: 200, body: { company: { id: 'company-1' }, status: 'active' } }
      }
    });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
    expect(run.step('read').message).toMatch(/must have required property/);
  });

  /** `[null]` is a different claim about an API than `"field": null`, and is not what was asked for. */
  it('does not relax an array element', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: { createProfile: CREATED, getProfile: profileWith({ tags: [null] }) }
    });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
  });

  it('relaxes the properties of an object inside an array', async () => {
    const { entry, files } = relaxedAt('read');
    const run = await runFlow(entry, {
      files,
      responses: { createProfile: CREATED, getProfile: profileWith({ tags: [{ label: null }] }) }
    });

    expect(run.outcome('read')).toBe('success');
  });

  /**
   * A request body is written by the flow, not reported by the API — so a null the document forbids
   * there is this file's own bug, and relaxing it would hide exactly what the check is for.
   */
  it('leaves the request body strict', async () => {
    const { entry, files } = variant(flow('profiles.flow.yml'), (document) => {
      document.apis.profiles.strictNulls = false;
      document.steps.find((step) => step.id === 'create').body = { name: null };
    });
    const run = await runFlow(entry, { files, responses: { createProfile: CREATED } });

    expect(run.outcome('create')).toBe('failed:invalid-request');
  });
});

describe('§6.2 — the tolerance belongs to the binding', () => {
  it('applies to every step through it', async () => {
    const { entry, files } = relaxedAt('binding');
    const run = await runFlow(entry, {
      files,
      responses: {
        createProfile: { status: 201, body: { ...PROFILE, company: null } },
        getProfile: profileWith({ company: null })
      }
    });

    expect(run.status).toBe('passed');
  });

  it('is overridden by a step that asks for strictness', async () => {
    const { entry, files } = variant(flow('profiles.flow.yml'), (document) => {
      document.apis.profiles.strictNulls = false;
      document.steps.find((step) => step.id === 'read').strictNulls = true;
    });
    const run = await runFlow(entry, {
      files,
      responses: {
        createProfile: { status: 201, body: { ...PROFILE, company: null } },
        getProfile: profileWith({ company: null })
      }
    });

    expect(run.outcome('create')).toBe('success');
    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
  });
});

describe('§8.5 — a connector file declares a service\'s null tolerance once', () => {
  it('relaxes a flow that declares none, matching on the document and not the alias', async () => {
    const run = await runFlow(connectorFlow('strict-nulls-inherit.flow.yml'), {
      scope: CONNECTOR_SCOPE,
      responses: { getProfile: profileWith({ company: null }) }
    });

    expect(run.outcome('read')).toBe('success');
    // The second step asked for strictness against the same binding, and gets it.
    expect(run.outcome('read_strictly')).toBe('failed:schema-validation-failed');
  });

  it('names a misspelt tolerance in a connector file rather than ignoring it', async () => {
    const diagnostics = await validate(connectorFlow('strict-nulls-inherit.flow.yml'), {
      scope: CONNECTOR_SCOPE,
      files: {
        [path.join(CONNECTOR_SCOPE.workspaceRoot, 'flows', 'connectors.yml')]: [
          'version: 1',
          'apis:',
          '  nulls-api:',
          '    source: ../../specs/nulls-v1.yml',
          '    strictnulls: false',
          'connectors: {}'
        ].join('\n')
      }
    });

    expect(diagnostics.map((entry) => entry.message).join('\n')).toMatch(/strictnulls/);
  });
});

describe('§10.1 — an OpenAPI 3.1 document', () => {
  const PLACE = { id: 'place-1', region: { code: 'west' }, coordinates: [1, 2] };
  const placeWith = (fields) => ({ status: 200, body: { ...PLACE, ...fields } });

  /**
   * The dialect witness. `prefixItems` is a 2020-12 keyword; a draft-07 reader does not know it and
   * ignores it, so this response passes a validator chosen by the old default and fails the right
   * one. Nothing else in the run distinguishes them.
   */
  it('is read with the 2020-12 validator, so its tuple schema is checked at all', async () => {
    const run = await runFlow(flow('places.flow.yml'), {
      responses: { getPlace: placeWith({ coordinates: ['west', 2] }) }
    });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
    expect(run.step('read').message).toMatch(/must be number/);
  });

  it('accepts 3.1\'s own spelling of a nullable field with no flag at all', async () => {
    const run = await runFlow(flow('places.flow.yml'), { responses: { getPlace: placeWith({ label: null }) } });

    expect(run.outcome('read')).toBe('success');
  });

  it('refuses a null the document does not allow, as 3.0 does', async () => {
    const run = await runFlow(flow('places.flow.yml'), { responses: { getPlace: placeWith({ region: null }) } });

    expect(run.outcome('read')).toBe('failed:schema-validation-failed');
  });

  it('relaxes the same way when the binding says so', async () => {
    const { entry, files } = variant(flow('places.flow.yml'), (document) => {
      document.apis.places.strictNulls = false;
    });
    const run = await runFlow(entry, { files, responses: { getPlace: placeWith({ region: null }) } });

    expect(run.outcome('read')).toBe('success');
  });
});
