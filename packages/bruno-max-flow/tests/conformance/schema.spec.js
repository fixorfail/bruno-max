/**
 * R4m — §5.4's document schema, and the pass §14.3 runs first (001-C §4).
 *
 * Two halves, asserted separately because they answer different questions:
 *
 * - `checkDocumentSchema` is the schema itself, over the **projected** document (§5.4) and nothing
 *   else. It is what an editor given `yaml.schemas` runs, and it needs no ports, no OpenAPI
 *   document and no graph — so a case here is one document and one verdict.
 * - `validate()` is §14.3, which runs the schema first and every semantic check after it. What it
 *   reports is narrower on purpose: a rule §14.3 named for itself is reported under that name by
 *   the check that owns it, so a reader gets one diagnostic per mistake rather than two spellings
 *   of it.
 *
 * The negative controls at the bottom are what define the schema's edge, and they matter more than
 * any positive case: a schema that starts rejecting an unresolvable `operation:` or a cyclic
 * `depends` has grown semantic knowledge it cannot keep correct from one document.
 */
const fs = require('fs');
const path = require('path');

const { normalizeFlow, parseDocument } = require('../../src/document');
const { CURRENT_FLOW_VERSION, checkDocumentSchema, flowSchema, project } = require('../../src/schema');
const { validate, variant, FLOWS } = require('./harness');

const SCHEMA_FLOWS = path.join(FLOWS, 'schema');
const flow = (name) => path.join(SCHEMA_FLOWS, name);

/** The schema half: what an editor sees, with no ports and nothing resolved. */
const issuesIn = (file) => {
  const source = fs.readFileSync(file, 'utf8');
  return checkDocumentSchema(normalizeFlow(parseDocument(source), file).raw);
};

/** The same, for a document held in memory — the shape every mutation case below takes. */
const issuesOf = (files, entry) =>
  checkDocumentSchema(normalizeFlow(parseDocument(files[entry]), entry).raw);

const codes = (issues) => issues.map((issue) => issue.code).sort();
const named = (issues) => issues.map((issue) => issue.named).filter(Boolean).sort();

const edit = (mutate) => {
  const { entry, files } = variant(flow('document.flow.yml'), mutate);
  return { entry, files, issues: issuesOf(files, entry) };
};

const step = (document, id) => document.steps.find((entry) => entry.id === id);

describe('R4m — The document schema', () => {
  /**
   * The corpus is the artifact 001-C §2 is about, and every flow in it is a v1 document. A schema
   * that rejected one of them would be describing a format nobody writes.
   *
   * `file-option-typo.flow.yml` is excluded by the parse rather than by name: §5.4 makes a `!file`
   * carrying a fourth option a parse error, and a document that did not parse has no model.
   */
  it('validates every .flow.yml in the fixture corpus', () => {
    const under = (directory) =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return under(target);
        return entry.name.endsWith('.flow.yml') ? [target] : [];
      });

    const rejected = under(FLOWS)
      .map((file) => ({ file, parsed: parseDocument(fs.readFileSync(file, 'utf8')) }))
      .filter(({ parsed }) => !parsed.errors.length)
      .map(({ file, parsed }) => ({
        file: path.relative(FLOWS, file),
        issues: checkDocumentSchema(normalizeFlow(parsed, file).raw)
      }))
      .filter(({ issues }) => issues.length);

    expect(under(FLOWS).length).toBeGreaterThan(40);
    expect(rejected).toEqual([]);
  });

  /**
   * §15's golden fixture for v1, which is the reason §5.4 ships one schema per version rather than
   * one schema. Pinned against `flowSchema(1)` by number rather than against the current version,
   * so it keeps asserting what it asserts today once a version 2 exists.
   */
  it('validates §15\'s golden v1 fixture against the v1 schema', () => {
    expect(flowSchema(1)).toBeDefined();
    expect(flowSchema(1).properties.version).toEqual({ const: 1 });
    expect(issuesIn(flow('golden-v1.flow.yml'))).toEqual([]);
  });

  it('describes one format version per file, the current one by default', () => {
    expect(flowSchema()).toBe(flowSchema(CURRENT_FLOW_VERSION));
    expect(flowSchema(2)).toBeUndefined();
  });

  describe('a misspelled key', () => {
    it('is a warning, so a file from a newer Bruno still runs', async () => {
      const { entry, files, issues } = edit((document) => {
        const create = step(document, 'create');
        create.assertt = create.assert;
        delete create.assert;
      });

      expect(issues).toEqual([
        expect.objectContaining({ code: 'unknown-property', severity: 'warning', node: ['steps', 1, 'assertt'] })
      ]);
      // The did-you-mean is what makes the warning actionable: §14.3 asks every naming check for one.
      expect(issues[0].message).toContain('did you mean assert?');

      const diagnostics = await validate(entry, { files });
      const reported = diagnostics.filter((entry_) => entry_.code === 'unknown-property');

      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ severity: 'warning', stepId: 'create' });
      expect(diagnostics.filter((entry_) => entry_.severity === 'error')).toEqual([]);
    });

    /**
     * `--strict` turns that warning into exit 2, and the flag is the CLI's — 001-C §2 keeps its exit
     * codes in `bruno-cli/tests/fork/flow/strict-dataset.integration.spec.js`, which spawns the
     * process. What the engine owes that flag is the severity, so this is the half that lives here.
     */
    it('carries the severity --strict acts on', async () => {
      const { entry, files } = edit((document) => {
        step(document, 'create').maxAttempts = 3;
      });
      const diagnostics = await validate(entry, { files });

      expect(diagnostics.map((entry_) => entry_.severity)).toEqual(['warning']);
    });

    it('is reported at the top level and inside every nested block', () => {
      const { issues } = edit((document) => {
        document.confg = { concurrency: 2 };
        document.config.concurency = 2;
        step(document, 'create').retry.maxAttemps = 4;
      });

      expect(codes(issues)).toEqual(['unknown-property', 'unknown-property', 'unknown-property']);
      expect(issues.map((issue) => issue.node)).toEqual([
        ['confg'],
        ['config', 'concurency'],
        ['steps', 1, 'retry', 'maxAttemps']
      ]);
    });

    /**
     * A step is addressed by the id its author wrote, not by the index ajv counts to. `steps.3` is a
     * message that sends its reader counting steps in a file they are already lost in.
     */
    it('names the step it is in', () => {
      const { issues } = edit((document) => {
        step(document, 'read_back').ptahParams = {};
      });

      expect(issues[0].message).toContain('steps.read_back');
    });
  });

  describe('the values the schema fixes', () => {
    it('refuses a misspelled dependency status', () => {
      const { issues } = edit((document) => {
        step(document, 'read_back').depends.all[0].status = ['suceess'];
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      // §14.3 owns this rule under a name of its own, so the schema states it and the check reports it.
      expect(named(issues)).toEqual(['invalid-dependency-status']);
    });

    it('refuses a retry that never attempts anything', () => {
      const { issues } = edit((document) => {
        step(document, 'create').retry.maxAttempts = 0;
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      expect(issues[0].node).toEqual(['steps', 1, 'retry', 'maxAttempts']);
    });

    it('refuses a backoff strategy it does not have', () => {
      const { issues } = edit((document) => {
        step(document, 'create').retry.backoff = 'linear';
      });

      expect(codes(issues)).toEqual(['schema-violation']);
    });

    it('refuses an auth profile naming a mode Bruno does not have', () => {
      const { issues } = edit((document) => {
        document.authProfiles = { user: { mode: 'berer', token: 'x' } };
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      expect(issues[0].node).toEqual(['authProfiles', 'user', 'mode']);
    });

    /**
     * §6.4: `inherit` means "whatever is above me", and a flow profile has nothing above it. It is
     * refused rather than resolved, because the two resolutions available are both wrong — mapping
     * it to `none` sends unauthenticated requests under a profile the author believed was
     * authenticating, and passing it through leaves each host to answer differently.
     *
     * `auth: collection` is what an author reaching for it actually wants, so nothing is lost.
     */
    it('refuses a profile declaring inherit, which has no referent at a profile boundary', () => {
      const { issues } = edit((document) => {
        document.authProfiles = { user: { mode: 'inherit' } };
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      expect(issues[0].node).toEqual(['authProfiles', 'user', 'mode']);
    });

    it('accepts every other member of Bruno\'s union', () => {
      for (const mode of ['none', 'awsv4', 'basic', 'bearer', 'digest', 'ntlm', 'oauth1', 'oauth2', 'wsse', 'apikey', 'akamai-edgegrid']) {
        const { issues } = edit((document) => {
          document.authProfiles = { user: { mode } };
        });

        expect({ mode, issues }).toEqual({ mode, issues: [] });
      }
    });

    /**
     * The fields *under* a mode are `@usebruno/schema-types`' `Auth` union rather than this format's
     * (§5.4), so the schema claims the `mode` enum and stops. Copying the union here would flag a
     * valid profile the first time upstream added a field to a mode.
     */
    it('leaves the fields under a declared mode to Bruno', () => {
      const { issues } = edit((document) => {
        document.authProfiles = { user: { mode: 'awsv4', accessKeyId: 'x', sessionToken: 'y' } };
      });

      expect(issues).toEqual([]);
    });
  });

  describe('the rules that need no graph', () => {
    it('refuses a step declaring both operation: and uses:', () => {
      const { issues } = edit((document) => {
        step(document, 'auth').operation = 'regress-api#signIn';
      });

      expect(named(issues)).toContain('operation-and-uses');
    });

    it('refuses a step declaring both body: and bodyFile:', () => {
      const { issues } = edit((document) => {
        step(document, 'create').bodyFile = './fixtures/body.json';
      });

      expect(named(issues)).toContain('body-and-body-file');
    });

    it('refuses a step declaring neither, naming the field it is missing', () => {
      const { issues } = edit((document) => {
        delete step(document, 'create').operation;
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      expect(issues[0].message).toContain('operation');
    });

    /**
     * The base file, which every case above is one edit away from: it carries all three `depends`
     * shapes and says nothing to either half. That is the assertion that catches the schema firing
     * on a correct document, which is the failure a static checker is retired for.
     */
    it('accepts all three depends shapes — a list, all: and any:', async () => {
      expect(issuesIn(flow('document.flow.yml'))).toEqual([]);
      expect(await validate(flow('document.flow.yml'))).toEqual([]);
    });

    it('refuses a depends mapping carrying a key that is neither', () => {
      const { issues } = edit((document) => {
        step(document, 'read_back').depends = { on: 'create' };
      });

      expect(codes(issues)).toEqual(['unknown-property']);
    });
  });

  describe('§5.3\'s step id', () => {
    it.each([['my.step'], ['2fa'], ['my-step']])('refuses %s', (id) => {
      const { issues } = edit((document) => {
        step(document, 'report').id = id;
      });

      expect(codes(issues)).toEqual(['schema-violation']);
      expect(named(issues)).toEqual(['invalid-step-id']);
    });

    it.each([['my_step'], ['_internal2']])('accepts %s', (id) => {
      const { issues } = edit((document) => {
        step(document, 'report').id = id;
      });

      expect(issues).toEqual([]);
    });

    /** The pattern is the schema's; the suggestion is §14.3's, under the name the rule already had. */
    it('is reported once, by the check that owns the rule, with the underscored form', async () => {
      const { entry, files } = edit((document) => {
        step(document, 'report').id = 'my-step';
      });
      const diagnostics = await validate(entry, { files });
      const reported = diagnostics.filter((entry_) => entry_.code === 'invalid-step-id');

      expect(reported).toHaveLength(1);
      expect(reported[0].message).toContain('my_step');
      expect(diagnostics.filter((entry_) => entry_.code === 'schema-violation')).toEqual([]);
    });

    it('leaves two steps sharing an id to the check that can see both', async () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'report').id = 'create';
      });

      expect(issues).toEqual([]);
      expect((await validate(entry, { files })).map((entry_) => entry_.code)).toContain('duplicate-step-id');
    });
  });

  describe('§12.4\'s sub-flow fields', () => {
    it('accepts the ones a step invoking a sub-flow may carry', () => {
      const { issues } = edit((document) => {
        Object.assign(step(document, 'auth'), {
          assert: ['steps.auth.token isDefined'],
          outputs: { token: 'data.token' },
          shared: { thingId: 'token' },
          maxDuration: 30000
        });
      });

      expect(issues).toEqual([]);
    });

    it.each([
      ['retry', { maxAttempts: 2 }],
      ['timeout', 5000],
      ['body', { name: 'widget' }],
      ['validateSchema', false],
      ['strictNulls', false],
      ['auth', 'user-token']
    ])('refuses %s on it, rather than ignoring it', (field, value) => {
      const { issues } = edit((document) => {
        step(document, 'auth')[field] = value;
      });

      expect(named(issues)).toContain('invalid-subflow-field');
    });

    it('reports one violation per refused field', () => {
      const { issues } = edit((document) => {
        Object.assign(step(document, 'auth'), { retry: { maxAttempts: 2 }, timeout: 5000 });
      });

      expect(issues.filter((issue) => issue.named === 'invalid-subflow-field')).toHaveLength(2);
    });

    it('leaves a with: key the sub-flow does not declare to the check that reads it', async () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'auth').with = { emial: 'qa@example.com' };
      });

      expect(issues).toEqual([]);

      const [reported] = (await validate(entry, { files })).filter((entry_) => entry_.code === 'unknown-param');

      expect(reported.message).toContain('did you mean email?');
    });
  });

  /**
   * §5.4's projection: strip the tag, keep the node. The schema describes what a tag-unaware reader
   * already sees, which is the property that lets one schema serve both ajv and the YAML language
   * server without either being told that tags exist.
   */
  describe('the projected model', () => {
    it('validates a document carrying both local tags', () => {
      expect(issuesIn(flow('golden-v1.flow.yml'))).toEqual([]);
      expect(issuesIn(path.join(FLOWS, 'validation/files.flow.yml'))).toEqual([]);
      expect(issuesIn(path.join(FLOWS, 'validation/drop.flow.yml'))).toEqual([]);
    });

    it('strips a !file to the node beneath it, in both spellings', () => {
      const { model } = parseDocument(fs.readFileSync(flow('golden-v1.flow.yml'), 'utf8'));
      const projected = project(model);

      expect(projected.vars.catalog).toBe('./fixtures/manifest.csv');
      expect(projected.steps[3].body.manifest).toEqual({
        path: './fixtures/manifest.csv',
        filename: 'manifest.csv',
        contentType: 'text/csv'
      });
    });

    it('projects !... to null, which is why the schema cannot tell it from an empty key', () => {
      const { model } = parseDocument(fs.readFileSync(flow('golden-v1.flow.yml'), 'utf8'));

      expect(project(model).steps[1].body.ref).toBeNull();
    });

    /**
     * §5.4's table, both rows. An `outputs:` entry set to `!...` suppresses an inherited connector
     * entry (§8.5) and one set to `null` is a key left empty by accident — indistinguishable once
     * projected, so the schema accepts both and §14.3, which has the identity, errors on the second.
     */
    it('accepts an outputs entry the schema cannot tell from a suppression', async () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'read_back').outputs.name = null;
      });

      expect(issues).toEqual([]);
      expect((await validate(entry, { files })).map((entry_) => entry_.code)).toContain('null-output');
    });

    /**
     * §17 rejects a `{ file: ... }` mapping because a body may legitimately contain any key. The
     * tags resolve to a symbol and a class instance precisely so a hostile body cannot forge one.
     */
    it('reads a body that spells a tag out as ordinary data', () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'create').body = { $file: './x.pdf', $drop: true };
      });
      const { model } = parseDocument(files[entry]);

      expect(issues).toEqual([]);
      expect(project(model).steps[1].body).toEqual({ $file: './x.pdf', $drop: true });
    });
  });

  /**
   * The two negative controls §5.4 turns on. Both are decidable only with something the document
   * does not contain — the bound OpenAPI document, and the resolved graph — so a schema that
   * rejected either has grown knowledge it cannot keep correct.
   */
  describe('what only §14.3 can decide', () => {
    it('passes a step naming an operation the bound document does not declare', async () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'create').operation = 'regress-api#createWidget';
      });

      expect(issues).toEqual([]);
      expect((await validate(entry, { files })).map((entry_) => entry_.code)).toContain('unknown-operation');
    });

    it('passes a cyclic depends', async () => {
      const { entry, files, issues } = edit((document) => {
        step(document, 'create').depends = ['report'];
      });

      expect(issues).toEqual([]);
      expect((await validate(entry, { files })).map((entry_) => entry_.code)).toContain('cyclic-dependency');
    });
  });
});

/**
 * R11.1 — what `bru flow validate` does with the schema, which is a different question from what the
 * schema says. R4m is the document's verdict; this is the command's.
 */
describe('R11.1 — The schema pass inside bru flow validate', () => {
  it('reports a version this build ships no schema for, rather than validating against nothing', async () => {
    const { entry, files, issues } = edit((document) => {
      document.version = 2;
    });

    expect(codes(issues)).toEqual(['schema-violation']);
    expect(issues[0].node).toEqual(['version']);
    expect(issues[0].message).toContain('format version 1');

    const [reported] = (await validate(entry, { files })).filter((entry_) => entry_.code === 'schema-violation');

    expect(reported).toMatchObject({ severity: 'error' });
  });

  /**
   * The pass reports and does not halt. A mistyped key that stopped validation would hide every real
   * error under it, and a document that parsed still has a graph and a set of references worth
   * checking — only a document that did not *parse* has no model (§14.3's `parse-error`).
   */
  it('reports the semantic errors under a document that also violates the schema', async () => {
    const { entry, files } = edit((document) => {
      document.steps[1].assertt = [];
      step(document, 'create').operation = 'regress-api#createWidget';
    });
    const diagnostics = await validate(entry, { files });

    expect(diagnostics.map((entry_) => entry_.code)).toEqual(
      expect.arrayContaining(['unknown-operation', 'unknown-property'])
    );
  });

  /**
   * A rule §14.3 named for itself reaches a reader once, under that name. The schema states it as
   * well, because an editor runs the schema and nothing else — but two spellings of one mistake in
   * one report is the cost of saying it twice, and the code is what a `--strict` list or a host
   * filtering its gutter addresses (§14.6).
   */
  it.each([
    ['invalid-subflow-field', (document) => {
      step(document, 'auth').timeout = 5000;
    }],
    ['invalid-dependency-status', (document) => {
      step(document, 'read_back').depends.all[0].status = ['suceess'];
    }]
  ])('reports %s once, under its own name', async (code, mutate) => {
    const { entry, files, issues } = edit(mutate);
    const diagnostics = await validate(entry, { files });

    expect(named(issues)).toContain(code);
    expect(diagnostics.filter((entry_) => entry_.code === code)).toHaveLength(1);
    expect(diagnostics.filter((entry_) => entry_.code === 'schema-violation')).toEqual([]);
  });
});
