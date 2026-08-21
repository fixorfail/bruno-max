import { assignSubflowColors } from './subflowColors';

/**
 * 002 §5.4 — a colour per `uses:` step, worn by its ring and by the band behind the steps it drew.
 * What has to hold is that a container's colour is its own: stable across everything except the
 * flow's own declaration order, and never shared with a second container on the same drawing.
 */
const container = (id) => ({ id, kind: 'subflow', uses: `../lib/${id}.flow.yml`, outputs: [], rank: 0 });
const step = (id) => ({ id, kind: 'operation', outputs: [], rank: 0 });

describe('assignSubflowColors', () => {
  it('colours the uses: steps and nothing else', () => {
    const colors = assignSubflowColors([step('login'), container('pay'), step('report')], 'dark');

    expect([...colors.keys()]).toEqual(['pay']);
  });

  /**
   * Declaration order, not expansion order: a colour that changed when a *different* sub-flow was
   * collapsed would be saying something about this one.
   */
  it('assigns in declaration order, and never two containers the same colour', () => {
    const colors = assignSubflowColors([container('pay'), container('refund')], 'dark');

    expect(colors.get('pay')).not.toBe(colors.get('refund'));
    expect(assignSubflowColors([container('pay'), container('refund')], 'dark').get('pay')).toBe(colors.get('pay'));
  });

  /** A nested container is one of them: it opens its own band inside its parent's. */
  it('colours a container nested inside another', () => {
    const colors = assignSubflowColors([container('pay'), container('pay/refund')], 'dark');

    expect(colors.get('pay/refund')).toBeDefined();
    expect(colors.get('pay/refund')).not.toBe(colors.get('pay'));
  });

  /** §5.1's rule: two regions in one colour is worse than one with none, and the band still draws. */
  it('gives a container past the palette no colour rather than repeating one', () => {
    const containers = ['a', 'b', 'c', 'd', 'e'].map(container);
    const colors = assignSubflowColors(containers, 'dark');

    expect(colors.get('e')).toBeUndefined();
    expect(new Set([...colors.values()].filter(Boolean)).size).toBe(4);
  });

  /** A palette chosen for one surface is unreadable on the other. */
  it('steps the colour to the theme', () => {
    expect(assignSubflowColors([container('pay')], 'light').get('pay')).not.toBe(
      assignSubflowColors([container('pay')], 'dark').get('pay')
    );
  });
});
