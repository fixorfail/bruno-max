/**
 * L9 — what `bru flow validate` says about a loop (006 §10, 006-C).
 *
 * Built the way `validation.spec.js` is: the fixtures under `fixtures/flows/loops/` are correct files,
 * and a case is one of them with one line changed by `variant()`. What a check reports is then the
 * edit and not the fixture, and a rule that stopped firing shows up as a case that stopped failing.
 * Each rule has its failing cases and the clean file beside them, because a check that fires on a
 * correct flow is the failure a static checker is retired for.
 */
const { validate, variant } = require('./harness');

const flow = (name) => `loops/${name}`;

const of = (diagnostics, code) => diagnostics.filter((entry) => entry.code === code);

/** The flow with one edit applied, and what validation said of it. */
const checked = async (name, mutate) => {
  const { entry, files } = variant(flow(name), mutate);
  return validate(entry, { files });
};

const RETRIEVE = 'retrieve-or-create.flow.yml';
const CURSOR = 'cursor-pages.flow.yml';
const EACH = 'each-call.flow.yml';
const LEDGER = 'ledger-pages.flow.yml';
const TOTALS = 'ledger-totals.flow.yml';

describe('L9.1 — loop-source-missing', () => {
  it('reports nothing for a loop with over:, and nothing for one with start:', async () => {
    expect(await validate(flow(RETRIEVE))).toEqual([]);
    expect(await validate(flow(CURSOR))).toEqual([]);
  });

  it('reports a loop with neither over: nor start:', async () => {
    const found = of(await checked(RETRIEVE, (document) => { delete document.steps[1].loop.over; }), 'loop-source-missing');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'find_vendor_with_member' });
    expect(found[0].message).toContain('neither');
    // Anchored at the loop block, so the author is taken to the line.
    expect(found[0].line).toBeGreaterThan(0);
  });

  it('reports a loop with both', async () => {
    const found = of(
      await checked(CURSOR, (document) => { document.steps[1].loop.over = ['a', 'b']; }),
      'loop-source-missing'
    );

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('both');
  });
});

describe('L9.2 — loop-next-missing', () => {
  it('reports start: without next:', async () => {
    const found = of(await checked(CURSOR, (document) => { delete document.steps[1].loop.next; }), 'loop-next-missing');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'search_vendor_pages' });
    expect(found[0].message).toContain('start: needs next:');
  });

  it('reports next: without start:', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[1].loop.next = '(previous) => null'; }),
      'loop-next-missing'
    );

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('only for a loop with start:');
  });

  it('reports nothing where start: and next: are both there, or both are not', async () => {
    expect(of(await validate(flow(CURSOR)), 'loop-next-missing')).toEqual([]);
    expect(of(await validate(flow(RETRIEVE)), 'loop-next-missing')).toEqual([]);
  });
});

describe('L9.3 — loop-max-missing', () => {
  const withMax = (max) => checked(RETRIEVE, (document) => { document.steps[1].loop.max = max; });

  it('reports a max that is absent, anchored at the loop block', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { delete document.steps[1].loop.max; }),
      'loop-max-missing'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'find_vendor_with_member' });
    expect(found[0].message).toContain('absent');
    expect(found[0].line).toBeGreaterThan(0);
  });

  it.each([['a string', '5'], ['zero', 0], ['negative', -1], ['over 1000', 1001], ['a fraction', 2.5], ['null', null]])(
    'reports a max that is %s',
    async (unused, max) => {
      expect(of(await withMax(max), 'loop-max-missing')).toHaveLength(1);
    }
  );

  it.each([1, 25, 1000])('reports nothing for a max of %s', async (max) => {
    expect(of(await withMax(max), 'loop-max-missing')).toEqual([]);
  });
});

describe('L9.4 — loop-concurrency-with-until', () => {
  it('reports concurrency above 1 beside an until:', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[1].loop.concurrency = 3; }),
      'loop-concurrency-with-until'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'find_vendor_with_member' });
  });

  it('reports nothing for concurrency of 1 beside an until:', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => { document.steps[1].loop.concurrency = 1; });

    expect(of(diagnostics, 'loop-concurrency-with-until')).toEqual([]);
  });

  it('reports nothing for concurrency above 1 where there is no until:', async () => {
    const diagnostics = await checked(EACH, (document) => { document.steps[0].loop.concurrency = 3; });

    expect(diagnostics).toEqual([]);
  });

  /** The same rule from the other side: `next:` needs the outputs of the iteration before. */
  it('reports concurrency above 1 beside a start: as loop-concurrency-with-cursor', async () => {
    const diagnostics = await checked(LEDGER, (document) => {
      delete document.steps[0].loop.until;
      document.steps[0].loop.concurrency = 2;
    });

    expect(of(diagnostics, 'loop-concurrency-with-cursor')).toHaveLength(1);
    expect(of(diagnostics, 'loop-concurrency-with-until')).toEqual([]);
  });
});

describe('L9.5 — loop-reference-outside-loop', () => {
  it('reports {{loop.x}} in a step with no loop:', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[2].body.name = '{{loop.vendorId}}'; }),
      'loop-reference-outside-loop'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'create_vendor' });
  });

  it('reports a loop. operand in an assertion', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[2].assert = ['res.status eq loop.index']; }),
      'loop-reference-outside-loop'
    );

    expect(found).toHaveLength(1);
  });

  it('reports a loop. operand in a when:', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[3].when = 'loop.index eq 0'; }),
      'loop-reference-outside-loop'
    );

    expect(found.map((entry) => entry.stepId)).toEqual(['read_partner']);
  });

  it('reports a reference in a sub-flow to the loop of its caller, which §12.3 does not pass in', async () => {
    const child = variant(flow('per-key-child.flow.yml'), (document) => {
      document.steps[0].pathParams.key = '{{loop.key}}';
    });
    const parent = variant(flow('per-key-subflow.flow.yml'), (document) => {
      document.steps[0].uses = './per-key-child.variant.flow.yml';
    });
    const found = of(
      await validate(parent.entry, { files: { ...child.files, ...parent.files } }),
      'loop-reference-outside-loop'
    );

    expect(found).toHaveLength(1);
    expect(found[0].stepId).toBe('page_1');
  });

  it('reports nothing where a step with a loop: reads loop.*', async () => {
    // `find_vendor_with_member` reads `{{loop.vendorId}}` and `ctx.loop` in `pre:`.
    expect(of(await validate(flow(RETRIEVE)), 'loop-reference-outside-loop')).toEqual([]);
    expect(of(await validate(flow('per-key-subflow.flow.yml')), 'loop-reference-outside-loop')).toEqual([]);
  });

  it('does not take the word loop in other text for a reference', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      document.steps[2].body.name = 'a loop of vendors';
      document.steps[2].assert = ['res.status eq 201'];
    });

    expect(of(diagnostics, 'loop-reference-outside-loop')).toEqual([]);
  });
});

describe('L9.6 — loop-over-not-a-list', () => {
  const withOver = (over) => checked(RETRIEVE, (document) => { document.steps[1].loop.over = over; });

  it.each([
    ['a string that is not a reference', 'abc'],
    ['a number', 5],
    ['a mapping', { a: 1 }],
    ['a reference with text around it', 'ids {{steps.find_vendors.candidateIds}}']
  ])('reports over: as %s', async (unused, over) => {
    const found = of(await withOver(over), 'loop-over-not-a-list');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', stepId: 'find_vendor_with_member' });
  });

  it('says why a reference with text around it is not a list', async () => {
    const [found] = of(await withOver('ids {{steps.find_vendors.candidateIds}}'), 'loop-over-not-a-list');

    expect(found.message).toContain('always a string');
  });

  it('reports nothing for a list, or for one whole reference', async () => {
    expect(of(await validate(flow(EACH)), 'loop-over-not-a-list')).toEqual([]);
    expect(of(await validate(flow(RETRIEVE)), 'loop-over-not-a-list')).toEqual([]);
  });
});

describe('L9.7 — unknown-function reaches next: and until:', () => {
  it('reports a helper that an until: calls and nothing declares', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[1].loop.until = '(res) => hasMember(res)'; }),
      'unknown-function'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', stepId: 'find_vendor_with_member' });
    expect(found[0].message).toContain('hasMember()');
    expect(found[0].line).toBeGreaterThan(0);
  });

  it('reports a helper that a next: calls', async () => {
    const found = of(
      await checked(CURSOR, (document) => { document.steps[1].loop.next = '(previous) => follow(previous)'; }),
      'unknown-function'
    );

    expect(found.map((entry) => entry.message)).toEqual([expect.stringContaining('follow()')]);
  });

  it('reports nothing where functions: declares it', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      document.functions = { hasMember: '(res) => res.body.data.members.length > 0' };
      document.steps[1].loop.until = '(res) => hasMember(res)';
    });

    expect(of(diagnostics, 'unknown-function')).toEqual([]);
  });
});

describe('L9.8 — loop-output-unguarded', () => {
  it('reports a reader of a declared output that has no when: on matched', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { delete document.steps[3].when; }),
      'loop-output-unguarded'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', stepId: 'read_partner' });
    expect(found[0].message).toContain('steps.find_vendor_with_member.matched');
  });

  it('reports a reader whose when: is about something else', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[3].when = 'steps.find_vendors.status eq 200'; }),
      'loop-output-unguarded'
    );

    expect(found).toHaveLength(1);
  });

  it('reports each reader once, however many outputs it reads', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => {
        document.steps[1].outputs.other = 'data.members';
        document.steps[3].pathParams.pk = '{{steps.find_vendor_with_member.partnershipId}}{{steps.find_vendor_with_member.other}}';
        delete document.steps[3].when;
      }),
      'loop-output-unguarded'
    );

    expect(found).toHaveLength(1);
  });

  it('reports nothing for a reader that is guarded', async () => {
    expect(of(await validate(flow(RETRIEVE)), 'loop-output-unguarded')).toEqual([]);
  });

  it('accepts a guard that is a script, which names matched as a script does', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      document.steps[3].when = { script: '(ctx) => ctx.steps.find_vendor_with_member.matched === true' };
    });

    expect(of(diagnostics, 'loop-output-unguarded')).toEqual([]);
  });

  it('reports nothing for a built-in, which is always there', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      document.steps[3].pathParams.pk = 'at-{{steps.find_vendor_with_member.index}}';
      delete document.steps[3].when;
    });

    expect(of(diagnostics, 'loop-output-unguarded')).toEqual([]);
  });

  it('reports nothing for a loop with no until:, whose outputs are never published', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      delete document.steps[1].loop.until;
      delete document.steps[3].when;
    });

    expect(of(diagnostics, 'loop-output-unguarded')).toEqual([]);
  });
});

describe('L9.9 — the built-ins of a loop are not outputs nobody reads', () => {
  it('does not report matched, iterations, count or index as unused, where a step declares them', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      Object.assign(document.steps[1].outputs, {
        matched: 'data.id',
        iterations: 'data.id',
        count: 'data.id',
        index: 'data.id'
      });
    });

    expect(of(diagnostics, 'unused-output')).toEqual([]);
  });

  it('counts a read of iterations as a read of every output the loop declares', async () => {
    expect(of(await validate(flow(EACH)), 'unused-output')).toEqual([]);
  });

  it('still reports an output that nothing reads, which is what the two cases above are not', async () => {
    const diagnostics = await checked(EACH, (document) => {
      document.steps[1].body.key = 'nothing';
    });

    expect(of(diagnostics, 'unused-output').map((entry) => `${entry.stepId}.${entry.message.split(' ')[0]}`)).toEqual([
      'call_each.call_each.result'
    ]);
  });

  it('counts a read by next: or until: as a read', async () => {
    expect(of(await validate(flow(CURSOR)), 'unused-output')).toEqual([]);
  });

  it('reports the output that only a next: read once the next: stops reading it', async () => {
    const found = of(
      await checked(CURSOR, (document) => { document.steps[1].loop.next = '() => null'; }),
      'unused-output'
    );

    expect(found.map((entry) => entry.message)).toEqual([expect.stringContaining('search_vendor_pages.prevPage')]);
  });
  it('counts a read of loop.iterations by until: as a read of every output the step declares', async () => {
    expect(of(await validate(flow(TOTALS)), 'unused-output')).toEqual([]);
  });

  it('reports the output that only loop.iterations read once until: stops reading it', async () => {
    const found = of(
      await checked(TOTALS, (document) => { document.steps[0].loop.until = '() => false'; }),
      'unused-output'
    );

    expect(found.map((entry) => entry.message)).toEqual([expect.stringContaining('read_pages.matching')]);
  });
});

describe('L9.10 — the built-ins are references that a loop publishes', () => {
  it('accepts matched, iterations, count and index on a step with a loop:', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => {
      const loop = 'steps.find_vendor_with_member';
      document.steps[3].pathParams.pk = [
        `{{${loop}.partnershipId}}`,
        `{{${loop}.matched}}`,
        `{{${loop}.count}}`,
        `{{${loop}.index}}`,
        `{{${loop}.iterations[0].partnershipId}}`
      ].join('');
    });

    expect(of(diagnostics, 'unknown-output-reference')).toEqual([]);
  });

  it('refuses the same names on a step with no loop:, which publishes none of them', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => {
        document.steps[3].pathParams.pk = '{{steps.create_vendor.matched}}';
        document.steps[3].depends = ['create_vendor'];
      }),
      'unknown-output-reference'
    );

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('create_vendor');
  });
});

describe('L9.11 — over: and start: are reads of the steps they name', () => {
  it('reports over: naming a step that is not there', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[1].loop.over = '{{steps.nowhere.ids}}'; }),
      'unknown-step-reference'
    );

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('steps.nowhere');
  });

  it('reports over: naming a step that is not an ancestor', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => { document.steps[1].depends = []; }),
      'non-ancestor-reference'
    );

    expect(found.map((entry) => entry.stepId)).toEqual(['find_vendor_with_member']);
    expect(found[0].message).toContain('steps.find_vendors');
  });

  it('reports start: naming an output the step does not produce', async () => {
    const found = of(
      await checked(CURSOR, (document) => { document.steps[1].loop.start = '{{steps.list_vendors.firstPage}}'; }),
      'unknown-output-reference'
    );

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('firstPage');
  });

  it('reports nothing where the step is an ancestor and produces the output', async () => {
    expect(await validate(flow(RETRIEVE))).toEqual([]);
    expect(await validate(flow(CURSOR))).toEqual([]);
  });
});

describe('L9.12 — the document schema', () => {
  it('warns of a key that a loop does not have, and names the near miss', async () => {
    const found = of(
      await checked(RETRIEVE, (document) => {
        document.steps[1].loop.maxx = 5;
      }),
      'unknown-property'
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning' });
    expect(found[0].message).toContain('maxx');
    expect(found[0].message).toContain('did you mean max');
  });

  it('reports a next: that is not text, and a concurrency that is not a whole number', async () => {
    const diagnostics = await checked(LEDGER, (document) => {
      document.steps[0].loop.next = 5;
      document.steps[0].loop.concurrency = 0;
    });

    expect(of(diagnostics, 'schema-violation').map((entry) => entry.message)).toEqual([
      expect.stringContaining('next'),
      expect.stringContaining('concurrency')
    ]);
  });

  it('is accepted on a uses: step, which §12.4 does not bar it from', async () => {
    const diagnostics = await validate(flow('per-key-subflow.flow.yml'));

    expect(of(diagnostics, 'invalid-subflow-field')).toEqual([]);
    expect(of(diagnostics, 'schema-violation')).toEqual([]);
  });

  it('warns of a var named loop, which the namespace shadows', async () => {
    const diagnostics = await checked(RETRIEVE, (document) => { document.vars = { loop: 'x' }; });

    expect(of(diagnostics, 'shadowed-reserved-name')).toHaveLength(1);
  });
});

describe('L9.13 — loop-output-never-published', () => {
  const reading = (mutate = () => {}) =>
    checked(EACH, (document) => {
      document.steps[1].body.key = '{{steps.call_each.result}}';
      mutate(document);
    });

  it('reports a reader of a declared output of a loop with no until:', async () => {
    const found = of(await reading(), 'loop-output-never-published');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', stepId: 'summarize' });
    expect(found[0].message).toContain('call_each.result');
    expect(found[0].message).toContain('steps.call_each.iterations');
    expect(found[0].line).toBeGreaterThan(0);
  });

  it('reports it whatever guard the reader has, because no guard can make the output appear', async () => {
    const found = of(
      await reading((document) => { document.steps[1].when = 'steps.call_each.matched eq true'; }),
      'loop-output-never-published'
    );

    expect(found).toHaveLength(1);
  });

  it('reports each reader once, however many outputs it reads', async () => {
    const found = of(
      await reading((document) => {
        document.steps[0].outputs.other = 'data.other';
        document.steps[1].body.key = '{{steps.call_each.result}}{{steps.call_each.other}}';
      }),
      'loop-output-never-published'
    );

    expect(found).toHaveLength(1);
  });

  it('does not ask for a guard as well, which would be the wrong advice', async () => {
    expect(of(await reading(), 'loop-output-unguarded')).toEqual([]);
  });

  it('reports nothing for iterations, count or matched, which a loop with no until: does publish', async () => {
    expect(of(await validate(flow(EACH)), 'loop-output-never-published')).toEqual([]);
  });

  it('reports nothing for a declared output that has the name of a built-in, which the built-in wins', async () => {
    const diagnostics = await checked(EACH, (document) => {
      document.steps[0].outputs.count = 'data.result';
      document.steps[1].body.key = 'n {{steps.call_each.count}}';
    });

    expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
  });

  it('reports nothing for a loop with an until:, which loop-output-unguarded is about', async () => {
    expect(of(await validate(flow(RETRIEVE)), 'loop-output-never-published')).toEqual([]);
  });

  describe('a shared: entry', () => {
    const publishing = (name, mutate = () => {}) =>
      checked(name, (document) => {
        document.shared = ['last'];
        mutate(document);
      });

    it('reports a loop with no until: that publishes a declared output into a slot', async () => {
      const found = of(
        await publishing(EACH, (document) => { document.steps[0].shared = { last: 'result' }; }),
        'loop-output-never-published'
      );

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: 'warning', stepId: 'call_each' });
      expect(found[0].message).toContain('result into last');
      // Anchored at the entry, so the author is taken to the line.
      expect(found[0].line).toBeGreaterThan(0);
    });

    it('reports each entry, and not the reads of the step', async () => {
      const found = of(
        await publishing(EACH, (document) => {
          document.shared = ['first', 'second'];
          document.steps[0].outputs.other = 'data.other';
          document.steps[0].shared = { first: 'result', second: 'other' };
        }),
        'loop-output-never-published'
      );

      expect(found).toHaveLength(2);
    });

    it('reports nothing for a loop with an until:, which writes the slot from the match', async () => {
      const diagnostics = await publishing(RETRIEVE, (document) => {
        document.steps[1].shared = { last: 'partnershipId' };
      });

      expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
    });

    it('reports nothing for a step with no loop:', async () => {
      const diagnostics = await publishing(RETRIEVE, (document) => {
        document.steps[0].shared = { last: 'candidateIds' };
      });

      expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
    });
  });

  describe('an exports: entry', () => {
    it('reports an export of a declared output of a loop with no until:', async () => {
      const found = of(
        await checked(EACH, (document) => { document.exports = { answer: 'steps.call_each.result' }; }),
        'loop-output-never-published'
      );

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: 'warning' });
      expect(found[0].message).toContain('exports.answer');
      expect(found[0].message).toContain('steps.call_each.iterations');
      expect(found[0].line).toBeGreaterThan(0);
    });

    it('reports an export of an output of the sub-flow of a looped uses: step with no until:', async () => {
      const found = of(
        await checked('per-key-subflow.flow.yml', (document) => {
          delete document.steps[0].loop.until;
          document.exports = { total: 'steps.search_each_key.total' };
        }),
        'loop-output-never-published'
      );

      // The step that reads it is reported as well: `record_total` is the other.
      expect(found.map((entry) => entry.stepId)).toEqual(['record_total', undefined]);
    });

    it('reports nothing for iterations, count or matched, which the loop does publish', async () => {
      const diagnostics = await checked(EACH, (document) => {
        document.exports = { all: 'steps.call_each.iterations', total: 'steps.call_each.count' };
      });

      expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
    });

    it('reports nothing for a loop with an until:', async () => {
      const diagnostics = await checked(RETRIEVE, (document) => {
        document.exports = { id: 'steps.find_vendor_with_member.partnershipId' };
      });

      expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
    });

    it('reports nothing for an export of a step with no loop:', async () => {
      const diagnostics = await checked(RETRIEVE, (document) => {
        document.exports = { ids: 'steps.find_vendors.candidateIds' };
      });

      expect(of(diagnostics, 'loop-output-never-published')).toEqual([]);
    });
  });
});
