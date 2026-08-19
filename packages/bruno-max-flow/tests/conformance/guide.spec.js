/**
 * The examples in `docs/writing-flows.md` run.
 *
 * A guide whose examples do not execute is worse than none: every reader's first flow is a copy of
 * one of these, and a shape that drifted from the engine sends them debugging the documentation. The
 * flows below are the guide's, rewritten against the fixture spec so they can actually be run.
 */
const fs = require('fs');
const path = require('path');

const { runFlow, validateFlow, FLOWS } = require('./harness');

const guide = (name, body) => {
  const entry = path.join(FLOWS, `guide-${name}.flow.yml`);
  return { entry, files: { [entry]: body } };
};

const LOGGED_IN = { status: 200, body: { data: { access_token: 'tok-1', role: 'admin' } } };
const PRODUCT = { status: 201, body: { data: { id: 'prod-1', name: 'Widget' } } };

describe('docs/writing-flows.md', () => {
  it('runs the first flow: two steps, an output carried, an assertion', async () => {
    const { entry, files } = guide('first', `
version: 1

meta:
  name: Checkout happy path
  description: Creates a product and reads it back.

apis:
  shop-api: ../specs/shop-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    outputs:
      token: data.access_token
    assert:
      - res.status eq 200

  - id: add_product
    operation: shop-api#addProduct
    body:
      name: "Widget {{flow.runId}}"
      price: 1299
    outputs:
      productId: data.id
    assert:
      - res.status eq 201
      - res.body.data.name contains Widget
`);

    const run = await runFlow(entry, { files, responses: { login: LOGGED_IN, addProduct: PRODUCT } });

    expect(run.result.status).toBe('passed');
    expect(run.result.iterations[0].steps.map((step) => step.status)).toEqual(['success', 'success']);
    expect(run.result.iterations[0].steps[1].outputs).toEqual({ productId: 'prod-1' });
  });

  /** The guide's auth profile, output forms, `when:`, and a script — the shapes most easily got wrong. */
  it('runs the documented auth profile, output forms, condition and script', async () => {
    const { entry, files } = guide('forms', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"

authProfiles:
  user-token:
    mode: bearer
    token: "{{steps.sign_in.token}}"

vars:
  label: widget

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    outputs:
      token: data.access_token
      code:
        from: status
      role:
        from: body
        path: data.role
      shout:
        script: |
          (res, ctx) => res.body.data.role.toUpperCase()

  - id: add_product
    operation: shop-api#addProduct
    auth: user-token
    when:
      script: |
        (ctx) => ctx.steps.sign_in.code === 200
    body:
      name: "{{label}}"
      price: 1299
    assert:
      - steps.sign_in.shout eq ADMIN
      - res.status eq 201
`);

    const run = await runFlow(entry, { files, responses: { login: LOGGED_IN, addProduct: PRODUCT } });

    expect(run.result.status).toBe('passed');
    expect(run.result.iterations[0].steps[0].outputs).toEqual({
      token: 'tok-1',
      code: 200,
      role: 'admin',
      shout: 'ADMIN'
    });
  });

  /** Slots, the documented answer to "two branches might produce this". */
  it('runs the documented slot example', async () => {
    const { entry, files } = guide('slots', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"

shared: [productId]

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2

  - id: add_product
    operation: shop-api#addProduct
    depends: [sign_in]
    body:
      name: widget
      price: 1299
    outputs:
      newId: data.id
    shared:
      productId: newId

  - id: read_back
    operation: shop-api#getProduct
    depends:
      any: [add_product]
    pathParams:
      productId: "{{shared.productId}}"
`);

    const run = await runFlow(entry, {
      files,
      responses: { login: LOGGED_IN, addProduct: PRODUCT, getProduct: { status: 200, body: { data: { id: 'prod-1' } } } }
    });

    expect(run.result.status).toBe('passed');
    expect(run.result.iterations[0].steps.map((step) => step.status)).toEqual(['success', 'success', 'success']);
  });

  /** Every documented diagnostic code is one `validateFlow` can actually produce. */
  it('names only diagnostic codes the validator emits', () => {
    // The diagnostics table only — the CLI options table a few lines above is also backticked rows.
    const guideText = fs.readFileSync(path.join(__dirname, '../../../../docs/writing-flows.md'), 'utf8');
    const section = guideText.slice(guideText.indexOf('## Validating a flow'));
    const documented = [...section.slice(0, section.indexOf('## Reference tables'))
      .matchAll(/^\| `([a-z][a-z-]+)`(?: \/ `([a-z-]+)`)?(?: \*\(warning\)\*)? \| /gm)]
      .flatMap((match) => [match[1], match[2]].filter(Boolean));
    const source = fs.readFileSync(path.join(__dirname, '../../src/validate.ts'), 'utf8');

    expect(documented.length).toBeGreaterThan(8);
    for (const code of documented) {
      expect({ code, emitted: source.includes(`'${code}'`) }).toEqual({ code, emitted: true });
    }
  });
});

/**
 * `.claude/skills/flow-writer/` carries a portable copy of the DSL for use in repositories that do
 * not have `docs/writing-flows.md`. Two copies of one contract drift unless something compares
 * them to the engine, and this is that something.
 */
describe('the flow-writer skill', () => {
  const SKILL = path.join(__dirname, '../../../../.claude/skills/flow-writer');
  const read = (name) => fs.readFileSync(path.join(SKILL, name), 'utf8');
  const YAML = require('yaml');

  const TAGS = [
    { tag: '!file', collection: 'map', resolve: (map) => map.toJSON() },
    { tag: '!file', resolve: (value) => value },
    { tag: '!...', resolve: () => null }
  ];

  const blocksIn = (text) =>
    [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => {
      const body = match[1];
      const indent = Math.min(
        ...body.split('\n').filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length)
      );
      return body.split('\n').map((line) => line.slice(indent)).join('\n');
    });

  /** A reader copies these verbatim; one that does not parse is a broken instruction. */
  it('has YAML examples that parse, tags and all', () => {
    const files = ['SKILL.md', 'references/dsl.md', 'references/mapping.md'];
    const failures = [];

    for (const file of files) {
      for (const block of blocksIn(read(file))) {
        const document = YAML.parseDocument(block, { merge: true, customTags: TAGS });
        if (document.errors.length) failures.push(`${file}: ${document.errors[0].message.split('\n')[0]}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('lists exactly the assertion operators the engine implements', () => {
    const { parseAssertion } = require('../../src/document');
    // The whole paragraph, which wraps over several lines.
    const listed = read('references/dsl.md').split('Operators: ')[1].split('\n\n')[0];
    const documented = [...listed.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

    expect(documented.length).toBeGreaterThan(25);
    for (const operator of documented) {
      // `parseAssertion` finds an operator only when it is one the engine knows.
      expect({ operator, parsed: parseAssertion(`x ${operator} y`).op }).toEqual({ operator, parsed: operator });
    }
  });

  it('names only diagnostic codes the validator emits', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/validate.ts'), 'utf8');
    const section = read('references/dsl.md').split('## Diagnostics')[1].split('## Step outcomes')[0];
    const documented = [...section.matchAll(/^\| `([a-z][a-z-]+)`(?: \/ `([a-z-]+)`)?/gm)]
      .flatMap((match) => [match[1], match[2]].filter(Boolean));

    expect(documented.length).toBeGreaterThan(10);
    for (const code of documented) {
      expect({ code, emitted: source.includes(`'${code}'`) }).toEqual({ code, emitted: true });
    }
  });

  it('names only step reasons the engine can report', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/types/result.ts'), 'utf8');
    const section = read('references/dsl.md').split('## Step outcomes')[1].split('## Specified but not built')[0];
    const documented = [...section.matchAll(/`([a-z][a-z-]+)`/g)].map((match) => match[1]);

    expect(documented.length).toBeGreaterThan(10);
    for (const reason of documented) {
      expect({ reason, declared: source.includes(`'${reason}'`) }).toEqual({ reason, declared: true });
    }
  });
});
