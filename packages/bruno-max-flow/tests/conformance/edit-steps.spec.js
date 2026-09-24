/**
 * B1.4–B1.9 — what an edit to the step list writes, and what it deliberately does not.
 *
 * The wrong implementation each of these catches is the helpful one. An insert that wrote
 * `depends:` on the new step and re-pointed the one below it draws exactly the same graph, and
 * turns a two-line diff into a rewiring of its neighbours; a rename that followed its own id
 * through the file repairs three references and guesses at a fourth. §5.1 and §6.6 both choose the
 * smaller edit and the anchored diagnostic, and these are where that choice is held.
 */
const fs = require('fs');
const path = require('path');

const { applyFlowEdits } = require('../../src/edit');
const { describeFlow, validate, FLOWS } = require('./harness');
const { changedLines, lineOf } = require('./lines');

const read = (file) => fs.readFileSync(path.join(FLOWS, file), 'utf8');

/**
 * The edited text, described the way the app describes a draft (002 §11.3): served from memory
 * beside the fixture it came from, so its relative `apis:` still resolves.
 */
const described = (file, text) => {
  const entry = path.join(FLOWS, file).replace(/\.flow\.yml$/, '.variant.flow.yml');
  return { entry, files: { [entry]: text } };
};

const write = (file, edits) => {
  const text = read(file);
  const result = applyFlowEdits(text, edits);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return { text, result, diff: changedLines(text, result.text) };
};

const sequence = (description) =>
  description.edges.filter((edge) => edge.kind === 'sequence').map((edge) => `${edge.from}->${edge.to}`);

describe('B1.4 — insert after writes two lines, and the sequence rewires', () => {
  const file = 'builder/linear.flow.yml';
  const edits = [{ kind: 'step.insert', step: { operation: 'regress-api#getState' }, after: 'a' }];

  it('adds the id and the operation, and nothing else', () => {
    const { text, diff } = write(file, edits);

    expect(diff).toEqual({
      at: lineOf(text, '    operation: regress-api#signIn') + 1,
      removed: [],
      added: ['  - id: get_state', '    operation: regress-api#getState']
    });
  });

  /**
   * §5.1's whole argument: the position *is* the dependency. 001 §9.1 links a step with no
   * `depends` to the one above it and re-points the one below, so the two lines above are the
   * rewiring — and an implementation that wrote the edges instead would draw this same graph from a
   * four-line diff carrying two declared edges where the file had none.
   */
  it('draws a → new → b → c, with no depends: written anywhere', async () => {
    const { result } = write(file, edits);
    const { entry, files } = described(file, result.text);
    const description = await describeFlow(entry, { files });

    expect(sequence(description)).toEqual(['a->get_state', 'get_state->b', 'b->c']);
    expect(description.edges.filter((edge) => edge.kind === 'depends')).toEqual([]);
    expect(result.text).not.toContain('depends:');
  });
});

describe('B1.5 — insert does not rewire an explicit dependency', () => {
  const file = 'builder/explicit-depends.flow.yml';
  const edits = [{ kind: 'step.insert', step: { operation: 'regress-api#createThing' }, after: 'a' }];

  it('leaves the declared line untouched', () => {
    const { text, diff, result } = write(file, edits);

    expect(diff).toEqual({
      at: lineOf(text, '    operation: regress-api#signIn') + 1,
      removed: [],
      added: ['  - id: create_thing', '    operation: regress-api#createThing']
    });
    expect(result.text).toContain('    depends: [a]');
  });

  it('leaves the new step a leaf, because the step below it named its own parent', async () => {
    const { result } = write(file, edits);
    const { entry, files } = described(file, result.text);
    const description = await describeFlow(entry, { files });

    expect(sequence(description)).toEqual(['a->create_thing']);
    expect(description.edges.filter((edge) => edge.kind === 'depends').map((edge) => `${edge.from}->${edge.to}`))
      .toEqual(['a->c']);
  });
});

describe('B1.7 — remove closes the gap, and removing the last step removes the key', () => {
  const file = 'builder/linear.flow.yml';

  it('takes the removed step\'s lines and no others', () => {
    const { text, diff } = write(file, [{ kind: 'step.remove', id: 'b' }]);

    expect(diff).toEqual({
      at: lineOf(text, '  - id: b'),
      removed: ['  - id: b', '    operation: regress-api#createThing', ''],
      added: []
    });
  });

  it('closes the sequence over the gap', async () => {
    const { result } = write(file, [{ kind: 'step.remove', id: 'b' }]);
    const { entry, files } = described(file, result.text);

    expect(sequence(await describeFlow(entry, { files }))).toEqual(['a->c']);
  });

  /**
   * §5.2: the file goes back to the shape 002 §4.1c's create form writes, rather than keeping
   * `steps: []`. The two mean the same to the engine and only one of them is what a person would
   * have typed — and the schema gate has to let this through, since `steps` is a *required*
   * property the create form's own output does not have.
   */
  it('removes the steps: key with the last step', () => {
    const { result } = write(file, [
      { kind: 'step.remove', id: 'c' },
      { kind: 'step.remove', id: 'b' },
      { kind: 'step.remove', id: 'a' }
    ]);

    expect(result.text).not.toContain('steps:');
    expect(result.text.endsWith('apis:\n  regress-api: ../../specs/regressions-v1.yml\n')).toBe(true);
  });
});

describe('B1.8 — rename writes the id and nothing else', () => {
  const file = 'builder/linear.flow.yml';
  const edits = [{ kind: 'step.rename', id: 'b', to: 'fetch' }];

  it('changes the id line and leaves every reference as written', () => {
    const { text, diff, result } = write(file, edits);

    expect(diff).toEqual({ at: lineOf(text, '  - id: b'), removed: ['  - id: b'], added: ['  - id: fetch'] });
    expect(result.text).toContain('    when: steps.b.status eq 200');
    expect(result.text).toContain('      id: "{{steps.b.thingId}}"');
  });

  /**
   * The rewrite is future work (§6.6) and the diagnostic is the contract: what the rename dangled is
   * reported on the line that has it, so the editor can say *2 references to the old name* beside
   * the field and open the YAML at each.
   */
  it('leaves the engine reporting what it dangled, on the lines that carry it', async () => {
    const { result } = write(file, edits);
    const { entry, files } = described(file, result.text);
    const diagnostics = await validate(entry, { files });
    const dangling = diagnostics.filter((entry_) => entry_.code === 'unknown-step-reference');

    // Both references sit on `c`, and 001 §14.3 anchors a step's diagnostics on the step — which is
    // the line the editor's *2 references to the old name* opens the YAML tab at.
    expect(dangling.map((entry_) => entry_.stepId)).toEqual(['c', 'c']);
    expect(dangling.map((entry_) => entry_.line)).toEqual([
      lineOf(result.text, '  - id: c'),
      lineOf(result.text, '  - id: c')
    ]);
  });
});

describe('B1.9 — the derived id is deterministic', () => {
  const idsAfter = (references) => {
    const result = applyFlowEdits(
      read('builder/linear.flow.yml'),
      references.map((reference) => ({ kind: 'step.insert', step: typeof reference === 'string' ? { operation: reference } : reference }))
    );
    if (!result.ok) throw new Error(result.reason);
    return result.text.split('\n').filter((line) => line.startsWith('  - id: ')).map((line) => line.slice(8));
  };

  it('snake-cases an operationId, acronyms included', () => {
    expect(idsAfter(['api#createPayment', 'api#getOrderByID'])).toEqual(['a', 'b', 'c', 'create_payment', 'get_order_by_id']);
  });

  /** 001 §6.1's fallback reference: the method and the path's static segments, and nothing templated. */
  it('derives a method-and-path reference from its static segments', () => {
    expect(idsAfter(['api#POST /payments/{id}/refund'])).toEqual(['a', 'b', 'c', 'post_payments_refund']);
  });

  it('prefixes a leading digit and suffixes a name the flow already has', () => {
    expect(idsAfter(['api#2faVerify', 'api#createPayment', 'api#createPayment'])).toEqual([
      'a', 'b', 'c', '_2fa_verify', 'create_payment', 'create_payment_2'
    ]);
  });

  /** A separator the class rejects becomes the one it accepts, rather than vanishing. */
  it('turns a separator into an underscore', () => {
    expect(idsAfter(['api#create-payment', 'api#list.orders', 'api#GET /v1/order-items/{id}'])).toEqual([
      'a', 'b', 'c', 'create_payment', 'list_orders', 'get_v1_order_items'
    ]);
  });

  /** B1.18 — the caller cannot know a derived id, so the result says which it wrote, and nothing when it wrote none. */
  it('reports the ids it inserted, in order', () => {
    const inserted = applyFlowEdits(read('builder/linear.flow.yml'), [
      { kind: 'step.insert', step: { operation: 'api#createPayment' } },
      { kind: 'step.duplicate', id: 'a', to: 'a_again' },
      { kind: 'step.patch', id: 'b', patch: { set: { name: 'B' } } }
    ]);
    expect(inserted.ok && inserted.inserted).toEqual(['create_payment', 'a_again']);

    const patched = applyFlowEdits(read('builder/linear.flow.yml'), [{ kind: 'step.patch', id: 'b', patch: { set: { name: 'B' } } }]);
    expect(patched.ok && patched.inserted).toBeUndefined();
  });

  /** A `uses:` step is named for the file it invokes, wherever the file is and however it is reached. */
  it('names a uses: step for the file it invokes', () => {
    expect(idsAfter([{ uses: './sign-in.flow.yml' }, { uses: 'workspace:flows/shared/login.flow.yml' }, { uses: '../lib/sign-in.flow.yml' }])).toEqual([
      'a', 'b', 'c', 'sign_in', 'login', 'sign_in_2'
    ]);
  });

  it('produces an id the format accepts, every time', () => {
    const derived = idsAfter([
      'api#createPayment', 'api#getOrderByID', 'api#POST /payments/{id}/refund', 'api#2faVerify', 'api#create-payment'
    ]);

    for (const id of derived) expect(id).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });
});

/**
 * The four members of §9.1's union 005-C scripts no scenario for. They are part of the contract the
 * host switches on, so they are exercised here rather than left to their first caller — each with
 * the one property that would otherwise be discovered as a malformed file.
 */
describe('B1 — the edit kinds with no scenario of their own', () => {
  it('duplicates a step without duplicating its anchor', () => {
    const { result } = write('builder/anchored.flow.yml', [
      { kind: 'step.duplicate', id: 'sign_in', to: 'sign_in_again' }
    ]);

    // An anchor names one node in a document. A copy carrying `&poll` would leave two, and every
    // `*poll` below would resolve to whichever the emitter wrote last.
    expect(result.text).toContain('    retry: &poll { maxAttempts: 10, delay: 500 }');
    expect(result.text).toContain('  - id: sign_in_again\n    operation: regress-api#signIn\n    retry: { maxAttempts: 10, delay: 500 }');
    expect(result.text.match(/&poll/g)).toHaveLength(1);
  });

  it('moves a step and leaves the blank lines separating the ones that stayed', () => {
    const { result } = write('builder/linear.flow.yml', [{ kind: 'step.move', id: 'a', after: 'c' }]);

    expect(result.text.slice(result.text.indexOf('steps:'))).toBe([
      'steps:',
      '  - id: b',
      '    operation: regress-api#createThing',
      '',
      '  - id: c',
      '    operation: regress-api#getThing',
      '    when: steps.b.status eq 200',
      '    pathParams:',
      '      id: "{{steps.b.thingId}}"',
      '',
      '  - id: a',
      '    operation: regress-api#signIn',
      ''
    ].join('\n'));
  });

  /** B1.18 — an alias has one place a step names it, so a rename reaches it. */
  it('rewrites a binding in place, and renames one where every step names it', () => {
    const updated = write('builder/linear.flow.yml', [{
      kind: 'api.update',
      alias: 'regress-api',
      binding: { alias: 'regress-api', source: '../../specs/regressions-v1.yml', auth: 'user-token' }
    }]);
    const renamed = write('builder/linear.flow.yml', [{ kind: 'api.rename', alias: 'regress-api', to: 'regress' }]);

    expect(updated.diff).toEqual({
      at: lineOf(updated.text, '  regress-api: ../../specs/regressions-v1.yml'),
      removed: ['  regress-api: ../../specs/regressions-v1.yml'],
      added: ['  regress-api:', '    source: ../../specs/regressions-v1.yml', '    auth: user-token']
    });
    // §5.5: an alias has one place a step names it, the prefix of `operation:`, so retargeting it is
    // reading rather than the guess §5.2 refuses to make about a step id.
    expect(renamed.diff.added).toContain('  regress: ../../specs/regressions-v1.yml');
    expect(renamed.result.text).not.toContain('regress-api#');
    expect(renamed.result.text).toContain('    operation: regress#signIn');
    expect(renamed.result.text).toContain('    operation: regress#createThing');

    const retitled = write('builder/linear.flow.yml', [{
      kind: 'api.update',
      alias: 'regress-api',
      binding: { alias: 'regress', source: '../../specs/regressions-v1.yml' }
    }]);
    expect(retitled.result.text).not.toContain('regress-api#');
    expect(retitled.result.text).toContain('    operation: regress#signIn');
  });

  /**
   * The `apis:` half of §5.2's rule for `steps:`: an empty block is not what a person would have
   * left behind, and `writeNewFlowDocument` declines to write one. Adding a binding and removing it
   * is therefore the identity, which is the sharpest way to say it.
   */
  it('removes the apis: key with the last binding', () => {
    const text = read('builder/no-apis.flow.yml');
    const result = applyFlowEdits(text, [
      { kind: 'api.add', binding: { alias: 'regress-api', source: '../../specs/regressions-v1.yml' } },
      { kind: 'api.remove', alias: 'regress-api' }
    ]);

    expect(result).toEqual({ ok: true, text, changed: false });
  });
});
