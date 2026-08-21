import { assignApiColors } from './apiColors';

/**
 * 002 §5.1 — a colour per `apis:` binding. What has to hold is that the same flow draws the same
 * colours every time, that a binding never shares one, and that a flow with a single binding gets
 * none at all.
 */
const node = (id, api) => ({
  id,
  kind: 'operation',
  operation: api ? { api, method: 'GET', path: '/x' } : undefined,
  outputs: [],
  markers: {},
  position: { line: 1, column: 1 },
  rank: 0
});

describe('assignApiColors', () => {
  /** The key names it either way; there is simply nothing for a colour to tell it apart from. */
  it('names the one binding a flow calls, and gives it no colour', () => {
    const colors = assignApiColors([node('a', 'backend'), node('b', 'backend')], 'dark');

    expect([...colors.keys()]).toEqual(['backend']);
    expect(colors.get('backend')).toBeUndefined();
  });

  it('assigns nothing to a flow whose operations did not resolve', () => {
    expect(assignApiColors([node('a'), node('b')], 'dark').size).toBe(0);
  });

  /** File order, so a colour is a property of the binding rather than of the run or of the layout. */
  it('assigns in the order the steps declare the bindings', () => {
    const colors = assignApiColors([node('a', 'glados'), node('b', 'backend'), node('c', 'glados')], 'dark');

    expect([...colors.keys()]).toEqual(['glados', 'backend']);
    expect(colors.get('glados')).not.toBe(colors.get('backend'));
  });

  /**
   * 001 §6.2: assignment is a default, and a default that overrode the file would be the tool
   * arguing with its author.
   */
  describe('a colour the file declares', () => {
    const nodes = [node('a', 'glados'), node('b', 'backend')];

    it('is used instead of the assigned one', () => {
      const colors = assignApiColors(nodes, 'dark', [{ alias: 'backend', color: '#8ab4f8' }]);

      expect(colors.get('backend')).toBe('#8ab4f8');
    });

    it('is used on both themes, where an assigned one is stepped for each', () => {
      const declared = [{ alias: 'backend', color: '#8ab4f8' }];

      expect(assignApiColors(nodes, 'light', declared).get('backend')).toBe('#8ab4f8');
      expect(assignApiColors(nodes, 'dark', declared).get('backend')).toBe('#8ab4f8');
    });

    /** Having said which colour, the author has said there is one — even with nothing to contrast. */
    it('colours a flow that binds one API, which is otherwise left uncoloured', () => {
      const single = [node('a', 'backend'), node('b', 'backend')];

      expect(assignApiColors(single, 'dark', [{ alias: 'backend', color: '#8ab4f8' }]).get('backend')).toBe('#8ab4f8');
      expect(assignApiColors(single, 'dark', [{ alias: 'backend' }]).get('backend')).toBeUndefined();
    });

    it('is not assigned to another binding around it', () => {
      const assigned = assignApiColors(nodes, 'dark');
      const takenByGlados = assigned.get('glados');
      const colors = assignApiColors(nodes, 'dark', [{ alias: 'backend', color: takenByGlados }]);

      expect(colors.get('backend')).toBe(takenByGlados);
      expect(colors.get('glados')).not.toBe(takenByGlados);
    });

    it('is ignored for a binding the flow declares and never calls', () => {
      const colors = assignApiColors(nodes, 'dark', [{ alias: 'ledger', color: '#8ab4f8' }]);

      expect([...colors.keys()]).toEqual(['glados', 'backend']);
      expect([...colors.values()]).not.toContain('#8ab4f8');
    });
  });

  it('draws the step for the theme it is drawn on', () => {
    const nodes = [node('a', 'glados'), node('b', 'backend')];

    expect(assignApiColors(nodes, 'light').get('glados')).not.toBe(assignApiColors(nodes, 'dark').get('glados'));
  });

  /**
   * Two services sharing a colour is worse than one having none: the reader cannot tell which they
   * are looking at and has no reason to doubt it. The alias is on the bar either way.
   */
  it('gives no colour past the palette rather than reusing one', () => {
    const many = Array.from({ length: 12 }, (unused, index) => node(`s${index}`, `api-${index}`));
    const colors = assignApiColors(many, 'dark');
    const painted = [...colors.values()].filter(Boolean);

    // Every binding is still keyed — it is the colour that runs out, not the list.
    expect(colors.size).toBe(many.length);
    expect(painted.length).toBeLessThan(many.length);
    expect(new Set(painted).size).toBe(painted.length);
    expect(colors.get('api-11')).toBeUndefined();
  });
});
