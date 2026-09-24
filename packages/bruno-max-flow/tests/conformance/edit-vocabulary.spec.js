/**
 * B4.13 — the closed vocabularies the editor's controls render from (005 §9.2).
 *
 * 002-C R4's rule, one level down: a dropdown offering an operator the engine does not accept is the
 * renderer deciding semantics. So the lists travel with the model rather than being written out
 * again in the app, and these are the assertions that the ones that are *derived* stay derived.
 */
const fs = require('fs');
const path = require('path');

const { readFlowEditModel } = require('../../src/edit');
const { OPERATORS } = require('../../src/document');

const FLOWS = path.join(__dirname, 'fixtures', 'flows');
const vocabulary = () =>
  readFlowEditModel(fs.readFileSync(path.join(FLOWS, 'builder/linear.flow.yml'), 'utf8')).vocabulary;

describe('B4.13 — the model carries the vocabularies', () => {
  it('offers every operator §10.2 accepts, and nothing else', () => {
    expect([...vocabulary().operators].sort()).toEqual([...OPERATORS].sort());
  });

  /**
   * The aliases are the ones an editor is most likely to be missing: a file written with `==` has to
   * round-trip through a control that offers it, or the first edit to that row rewrites the operator.
   */
  it('includes the == and != aliases', () => {
    expect(vocabulary().operators).toEqual(expect.arrayContaining(['==', '!=']));
  });

  it('names the operators that take no operand', () => {
    const { unaryOperators } = vocabulary();

    expect(unaryOperators).toEqual(expect.arrayContaining(['isEmpty', 'isNull', 'isTruthy', 'isArray']));
    expect(unaryOperators).not.toContain('eq');
    expect(unaryOperators).not.toContain('between');
  });

  /** Derived from the evaluator's own table by arity, so a new operator cannot be missed off it. */
  it('derives the unary list rather than repeating it', () => {
    const { operators, unaryOperators } = vocabulary();

    for (const operator of unaryOperators) {
      expect(operators).toContain(operator);
    }
  });
});
