/**
 * R4p — what the parse guarantees (001-C §7, 001 §5.4 and §13.2).
 *
 * These run against `document.ts` directly rather than through a run: they are properties of
 * reading the file, and a scenario that had to dispatch to observe them would be asserting the
 * parse through four other layers.
 */
const path = require('path');

const { parseDocument, normalizeFlow, FileRef, DROP } = require('../../src/document');
const { validate, variant, FLOWS } = require('./harness');

const flow = (name) => `regressions/${name}`;

const parse = (text) => normalizeFlow(parseDocument(text), '/flows/probe.flow.yml');

const wrap = (steps) => `version: 1\nmeta:\n  name: probe\n${steps}`;

describe('R4p — the local tags project to values with identity', () => {
  const document = parse(`${wrap('')}
vars:
  scalar: !file ./catalog.json
  mapping: !file
    path: ./invoice.pdf
    filename: signed.pdf
    contentType: application/x-pdf
  forged: { path: ./evil.pdf }
`);

  it('resolves both !file spellings to the same kind of value', () => {
    expect(document.vars.scalar).toBeInstanceOf(FileRef);
    expect(document.vars.mapping).toBeInstanceOf(FileRef);
    expect(document.vars.scalar.path).toBe('./catalog.json');
    expect(document.vars.mapping).toMatchObject({
      path: './invoice.pdf',
      filename: 'signed.pdf',
      contentType: 'application/x-pdf'
    });
  });

  // A body may legitimately contain any key, so shape cannot be what distinguishes a tag from data.
  it('does not let an ordinary mapping forge one', () => {
    expect(document.vars.forged).not.toBeInstanceOf(FileRef);
    expect(document.vars.forged).toEqual({ path: './evil.pdf' });
  });

  it('resolves !... to the removal symbol, which is not null', () => {
    const removed = parse(`${wrap('')}
vars:
  gone: !...
  nulled: null
`);

    expect(removed.vars.gone).toBe(DROP);
    expect(removed.vars.nulled).toBeNull();
  });
});

describe('R4p — a merge key is resolved', () => {
  // Invisible in every fixture, and a regression changes what a committed file means: the step
  // would carry a literal `<<` field instead of the fields the anchor names, and every assertion
  // about the step would still pass.
  const merged = parse(`${wrap('')}
defaults: &defaults
  timeout: 4000
  maxDuration: 9000

steps:
  - id: create
    operation: regress-api#createThing
    <<: *defaults
`);

  it('gives the step the merged fields', () => {
    expect(merged.steps[0].timeout).toBe(4000);
    expect(merged.steps[0].maxDuration).toBe(9000);
  });

  it('leaves no literal merge key behind', () => {
    expect(JSON.stringify(merged.steps[0])).not.toContain('<<');
  });
});

describe('R4p — an empty document is an empty flow', () => {
  it('parses rather than crashing', () => {
    expect(parse('').steps).toEqual([]);
  });
});

describe('R4p — positions', () => {
  const positioned = parse(`version: 1

meta:
  name: probe

steps:
  - id: first
    operation: regress-api#createThing

  - id: second
    operation: regress-api#getThing
`);

  it('gives every step the 1-based line and column of its own node', () => {
    expect(positioned.steps.map((step) => step.position)).toEqual([
      { line: 7, column: 5 },
      { line: 10, column: 5 }
    ]);
  });

  it('addresses any node by its path through the projected model', () => {
    expect(positioned.positions.at(['steps', 1, 'operation'])).toEqual({ line: 11, column: 16 });
    expect(positioned.positions.at(['meta', 'name'])).toEqual({ line: 4, column: 9 });
    expect(positioned.positions.at(['nothing', 'here'])).toBeUndefined();
  });
});

describe('R4p — diagnostics carry a position', () => {
  it('anchors a step-scoped diagnostic to that step', async () => {
    const { entry, files } = variant(flow('r4b-condition-false.flow.yml'), (document) => {
      document.steps[1].operation = 'regress-api#noSuchOperation';
    });
    const diagnostics = await validate(entry, { files });
    const found = diagnostics.find((entry_) => entry_.code === 'unknown-operation');

    expect(found).toMatchObject({ stepId: 'conditional', file: entry });
    expect(found.line).toBeGreaterThan(0);
    expect(found.column).toBeGreaterThan(0);

    // The line it names is the one the step is written on, not the first line of the file.
    const source = files[entry].split('\n');
    expect(source[found.line - 1]).toContain('- id: conditional');
  });

  it('anchors a diagnostic that names no step to the node it is about', async () => {
    const { entry, files } = variant(flow('r4b-condition-false.flow.yml'), (document) => {
      document.apis['regress-api'] = '../../specs/does-not-exist.yml';
    });
    const diagnostics = await validate(entry, { files });
    const found = diagnostics.find((entry_) => entry_.code === 'unresolved-alias' && !entry_.stepId);

    expect(found.line).toBeGreaterThan(0);
    expect(files[entry].split('\n')[found.line - 1]).toContain('regress-api');
  });
});

describe('R4p — the corpus still reads the same', () => {
  // `flow-yaml.js` is a deliberately separate reader of the format (001-C §2), so agreeing with it
  // over every committed fixture is what says the parse did not quietly change meaning.
  const { load } = require('./flow-yaml');
  const fs = require('fs');

  const files = fs
    .readdirSync(path.join(FLOWS, 'regressions'))
    .filter((file) => file.endsWith('.flow.yml'))
    .map((file) => path.join(FLOWS, 'regressions', file));

  it.each(files)('%s', (file) => {
    const viaHelper = load(file);
    const viaEngine = parseDocument(fs.readFileSync(file, 'utf8')).model;

    expect(JSON.stringify(viaEngine)).toEqual(JSON.stringify(viaHelper));
  });
});
