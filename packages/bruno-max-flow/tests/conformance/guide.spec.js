/**
 * The examples in `docs/writing-flows.md` run.
 *
 * A guide whose examples do not execute is worse than none: every reader's first flow is a copy of
 * one of these, and a shape that drifted from the engine sends them debugging the documentation. The
 * flows below are the guide's, rewritten against the fixture spec so they can actually be run.
 */
const fs = require('fs');
const path = require('path');

const { runFlow, validate, FLOWS } = require('./harness');

/**
 * Every engine source as one string, for the checks that ask whether a documented name is real.
 *
 * `validate.ts` alone was the bug: `stages:` emits from `graph.ts` and a run reports two codes from
 * `run.ts`, so a document naming one of those five read as naming something the engine does not have
 * — and, in the other direction, those five could go undocumented with nothing complaining.
 */
const ENGINE_SOURCES = path.join(__dirname, '../../src');

const engineFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return engineFiles(target);
    return target.endsWith('.ts') ? [target] : [];
  });

const engineText = () => engineFiles(ENGINE_SOURCES).map((file) => fs.readFileSync(file, 'utf8')).join('\n');

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

  /** Every documented diagnostic code is one the engine can actually produce. */
  it('names only diagnostic codes the engine emits', () => {
    // The diagnostics table only — the CLI options table a few lines above is also backticked rows.
    const guideText = fs.readFileSync(path.join(__dirname, '../../../../docs/writing-flows.md'), 'utf8');
    const section = guideText.slice(guideText.indexOf('## Validating a flow'));
    const documented = [...section.slice(0, section.indexOf('## Reference tables'))
      .matchAll(/^\| `([a-z][a-z-]+)`(?: \/ `([a-z-]+)`)?(?: \*\(warning\)\*)? \| /gm)]
      .flatMap((match) => [match[1], match[2]].filter(Boolean));
    const source = engineText();

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

  it('names only diagnostic codes the engine emits', () => {
    const source = engineText();
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

/**
 * `pre:` and `functions:` — the two positions the guide documents last, and the two whose examples
 * are easiest to write in a shape the engine does not accept.
 *
 * Everything above this line was documented first and tested afterwards. These two were written
 * together, which is the order that catches a guide describing a field the engine spells
 * differently: the example here is the guide's, and if it stops running the guide is wrong.
 */
describe('the pre: and functions: documentation', () => {
  const flowFile = (name, body) => {
    const entry = path.join(FLOWS, `guide-${name}.flow.yml`);
    return { entry, files: { [entry]: body } };
  };

  it('runs a request built from a computed value and a library helper', async () => {
    const { entry, files } = flowFile('pre', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

config:
  baseUrl: "{{apiBaseUrl}}"

functions:
  tail: |
    (value) => String(value).slice(-4)

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    outputs:
      token: data.access_token

  - id: add_product
    operation: shop-api#addProduct
    pre:
      shortToken: |
        (ctx) => tail(ctx.steps.sign_in.token)
    body:
      name: "Widget {{pre.shortToken}}"
      price: 1299
    outputs:
      productId: data.id
      shortToken: { from: pre }
      fingerprint: { from: pre, path: shortToken }
    assert:
      - res.status eq 201
`);

    const run = await runFlow(entry, { files, responses: { login: LOGGED_IN, addProduct: PRODUCT } });

    expect(run.result.status).toBe('passed');
    // The library helper ran, its value reached the request, and both promotion forms carried it out.
    expect(run.result.iterations[0].steps[1].outputs).toEqual({
      productId: 'prod-1',
      shortToken: 'ok-1',
      fingerprint: 'ok-1'
    });
  });

  /** The typo the guide warns about: a promotion naming a value the step never computes. */
  it('reports an output promoting a pre value the step does not compute', async () => {
    const { entry, files } = flowFile('pre-typo', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    pre:
      shortToken: |
        () => 'abcd'
    outputs:
      fingerprint: { from: pre, path: shortTokn }
`);

    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unknown-pre-value', severity: 'error', stepId: 'sign_in' })
    );
  });

  /**
   * The mistake the shape invites: an output's string form is a path into the response, so an
   * interpolation written there selects nothing and the output is silently unset.
   */
  it('warns on an interpolation written where an output path belongs', async () => {
    const { entry, files } = flowFile('pre-interpolated', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    pre:
      shortToken: |
        () => 'abcd'
    outputs:
      fingerprint: "{{pre.shortToken}}"
`);

    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interpolation-in-output-path', severity: 'warning', stepId: 'sign_in' })
    );
  });
  /**
   * The limitation the guide states, pinned so it cannot change silently.
   *
   * The context handed to these scripts is built once, before the first of them runs, so `ctx.pre`
   * is empty for every entry however they are ordered — computing a nonce on one line and signing it
   * on the next does not work, and does not say so. This asserts today's behaviour rather than
   * endorsing it: if the engine ever makes siblings visible, this test failing is the reminder that
   * both documents describe the old rule.
   */
  it('does not let a pre script read a sibling pre value', async () => {
    const { entry, files } = flowFile('pre-siblings', `
version: 1

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
    pre:
      nonce: |
        () => 'abcd'
      derived: |
        (ctx) => (ctx.pre && ctx.pre.nonce) === undefined ? 'sibling-not-visible' : 'sibling-visible'
    outputs:
      derived: { from: pre }
`);

    const run = await runFlow(entry, { files, responses: { login: LOGGED_IN } });

    expect(run.result.iterations[0].steps[0].outputs).toEqual({ derived: 'sibling-not-visible' });
  });

  /**
   * And the warning that stops it being silent. The rule above is deliberate — `outputs:` behaves
   * the same way — so what is reported is not the semantics but the fact that reading a sibling
   * looks like it works, compiles, runs, and resolves `undefined` every time.
   */
  it('warns when a pre script reads a sibling value', async () => {
    const { entry, files } = flowFile('pre-sibling-read', `
version: 1

apis:
  shop-api: ../specs/shop-v1.yml

steps:
  - id: sign_in
    operation: shop-api#login
    auth: none
    body:
      email: qa@example.com
      password: hunter2
    pre:
      nonce: |
        () => 'abcd'
      signature: |
        (ctx) => 'sig:' + ctx.pre.nonce
`);

    const diagnostics = await validate(entry, { files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pre-reads-sibling-value', severity: 'warning', stepId: 'sign_in' })
    );
    // The entry that computes the value is fine; only the one reading a sibling is reported.
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'pre-reads-sibling-value')).toHaveLength(1);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});

/**
 * The reverse of every check above, and the one that actually catches drift.
 *
 * The tests further up ask *is everything documented real* — they read the tables and look each
 * entry up in the engine. That direction only ever catches a document describing something that was
 * removed. It cannot catch the far more common failure, which is the engine growing a code and
 * nobody writing it down: `functions:` shipped two diagnostics that reached neither document, and
 * every check in this file passed the whole time.
 *
 * So this asks the other question — *is everything real documented* — of both documents at once,
 * because the portable copy drifts from the guide as readily as either drifts from the engine.
 *
 * Membership is tested against the whole document rather than a named section. A stricter check
 * would pin each code to its table, and would then fail every time someone reorganized a heading —
 * which is a test that trains people to edit the test. "Appears nowhere in the file" is the failure
 * worth blocking a commit for.
 */
describe('the documents cover the engine', () => {
  const ENGINE = path.join(__dirname, '../../src');
  const DOCUMENTS = {
    'docs/writing-flows.md': path.join(__dirname, '../../../../docs/writing-flows.md'),
    '.claude/skills/flow-writer/references/dsl.md': path.join(
      __dirname,
      '../../../../.claude/skills/flow-writer/references/dsl.md'
    ),
    // The normative spec is held to the same bar as the two guides: §14.6 named a code no package
    // emits for as long as nothing checked it, which is the drift this block exists to stop.
    'docs/specs/001-api-flows.md': path.join(__dirname, '../../../../docs/specs/001-api-flows.md')
  };

  /**
   * Codes are read from the call sites rather than from a list, because a list is the thing that
   * goes stale. `\s*` spans the line break, since the longer calls wrap their arguments.
   *
   * **Every source, not `validate.ts` alone.** Reading one file reintroduced the exact failure this
   * block exists to catch: `stages:` shipped three diagnostics from `graph.ts` and a run reports two
   * of its own from `run.ts`, and none of the five were visible here — so the check passed while the
   * documents were missing codes an author can be shown. Scanning the tree means the next file to
   * emit one is covered before anybody notices it is a new file.
   */
  const emittedCodes = () => {
    const found = new Set();
    for (const file of engineFiles(ENGINE)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:error|warn)\(\s*'([a-z][a-z-]+)'|code:\s*'([a-z][a-z-]+)'/g)) {
        found.add(match[1] || match[2]);
      }
    }
    return [...found].sort();
  };

  /** The `StepReason` union only — the file also declares statuses, which are not reasons. */
  const declaredReasons = () => {
    const source = fs.readFileSync(path.join(ENGINE, 'types/result.ts'), 'utf8');
    const union = source.slice(source.indexOf('export type StepReason'));
    return [...union.slice(0, union.indexOf(';')).matchAll(/'([a-z][a-z-]+)'/g)].map((match) => match[1]).sort();
  };

  /**
   * Anything deliberately left out, with the reason it is left out. An empty list is the goal, not
   * an accident: adding a name here is a decision that this is not an author's concern, and the
   * comment is what makes that decision reviewable later.
   */
  const UNDOCUMENTED = {
    'docs/writing-flows.md': [],
    '.claude/skills/flow-writer/references/dsl.md': [],
    'docs/specs/001-api-flows.md': []
  };

  const missing = (names, file) => {
    const text = fs.readFileSync(DOCUMENTS[file], 'utf8');
    return names.filter((name) => !UNDOCUMENTED[file].includes(name) && !text.includes(`\`${name}\``));
  };

  it('finds diagnostic codes to check', () => {
    // A regex that silently matched nothing would make every assertion below vacuously true.
    expect(emittedCodes().length).toBeGreaterThan(25);
    expect(declaredReasons().length).toBeGreaterThan(10);
  });

  /**
   * The reverse of the above for 001's own tables — every row names a code some package produces.
   *
   * Scoped to §14.3's two tables rather than to the whole file, because 001 discusses codes in prose
   * throughout and a document-wide sweep would read package names and header names as codes. The
   * CLI is searched as well as the engine: `run-refused` is the command's, not the engine's, and a
   * check that knew only about `src/` would call the one code §14.6 is *about* a mistake.
   */
  it('docs/specs/001-api-flows.md names only diagnostic codes some package emits', () => {
    const text = fs.readFileSync(DOCUMENTS['docs/specs/001-api-flows.md'], 'utf8');
    const section = text.slice(text.indexOf('#### The codes a check emits'), text.indexOf('### 14.4'));
    const documented = [...section.matchAll(/^\| `([a-z][a-z-]+)`(?: \/ `([a-z-]+)`)?/gm)]
      .flatMap((match) => [match[1], match[2]].filter(Boolean));
    const source = engineText() + fs.readFileSync(
      path.join(__dirname, '../../../bruno-cli/src/fork/flow/index.js'),
      'utf8'
    );

    expect(documented.length).toBeGreaterThan(25);
    for (const code of documented) {
      expect({ code, emitted: source.includes(`'${code}'`) }).toEqual({ code, emitted: true });
    }
  });

  for (const file of Object.keys(DOCUMENTS)) {
    it(`${file} documents every diagnostic the engine emits`, () => {
      expect({ file, missing: missing(emittedCodes(), file) }).toEqual({ file, missing: [] });
    });

    it(`${file} documents every step reason the engine can report`, () => {
      expect({ file, missing: missing(declaredReasons(), file) }).toEqual({ file, missing: [] });
    });
  }
});
