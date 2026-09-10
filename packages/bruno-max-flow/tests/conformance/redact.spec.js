/**
 * R4n — §14.4's two redaction mechanisms, asserted directly rather than through a run.
 *
 * Every other spec in this corpus reaches `redact.ts` through `runFlow`, which can only show that
 * a secret did not reach a capture. That is the outcome worth having, but it is a poor test of the
 * mechanism: it cannot distinguish masking from a value that never got there, and it cannot reach
 * the cases that decide whether masking is *sound* — an overlapping pair of secrets, a regex
 * metacharacter in a token, a `secret: true` variable that resolved to nothing.
 *
 * Those are the cases here. The two mechanisms are asserted apart because §14.4 gives them
 * different jobs: the denylist knows names and not values, provenance knows values and not names,
 * and each covers precisely what the other cannot.
 */
const { MASK, createRedactor, createSecretTracker } = require('../../src/redact');

describe('§14.4 header-name denylist', () => {
  it('masks a denied header whatever case it is written in', () => {
    const redacted = createRedactor().headers({ 'Authorization': 'Bearer t', 'X-API-KEY': 'k' });

    expect(redacted).toEqual({ 'Authorization': MASK, 'X-API-KEY': MASK });
  });

  it('leaves a header that is not denied alone', () => {
    expect(createRedactor().headers({ 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json'
    });
  });

  it('masks each value of a repeated header rather than the list', () => {
    expect(createRedactor().headers({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': [MASK, MASK] });
  });

  it('adds `config.redactHeaders` to the denylist without replacing it', () => {
    const redacted = createRedactor(['X-Tenant']).headers({ 'x-tenant': 't', 'authorization': 'Bearer t' });

    expect(redacted).toEqual({ 'x-tenant': MASK, 'authorization': MASK });
  });
});

describe('§14.4 provenance by value', () => {
  it('masks a secret wherever it surfaces, whatever name it is under by then', () => {
    const tracker = createSecretTracker(['s3cr3t']);

    expect(tracker.mask({ token: 's3cr3t', promoted: { copy: ['s3cr3t'] } })).toEqual({
      token: MASK,
      promoted: { copy: [MASK] }
    });
  });

  it('masks a secret embedded in a longer string', () => {
    expect(createSecretTracker(['s3cr3t']).mask('Bearer s3cr3t expired')).toBe(`Bearer ${MASK} expired`);
  });

  it('masks every occurrence, not just the first', () => {
    expect(createSecretTracker(['s3cr3t']).mask('s3cr3t and s3cr3t')).toBe(`${MASK} and ${MASK}`);
  });

  it('leaves no tail of a secret beside the mask when one contains another', () => {
    const tracker = createSecretTracker(['abc', 'abcdef']);

    expect(tracker.mask('abcdef')).toBe(MASK);
  });

  it('treats a secret as a literal, so its metacharacters match nothing else', () => {
    const tracker = createSecretTracker(['a.c']);

    expect(tracker.mask('abc')).toBe('abc');
    expect(tracker.mask('a.c')).toBe(MASK);
  });

  it('ignores a blank value, which would otherwise match at every position', () => {
    const tracker = createSecretTracker(['', '   ']);

    expect(tracker.mask('nothing is secret here')).toBe('nothing is secret here');
  });

  it('ignores a non-string, so an unresolved variable contributes no pattern', () => {
    const tracker = createSecretTracker([undefined, null, 42, { token: 'x' }]);

    expect(tracker.mask('42 x')).toBe('42 x');
  });

  it('returns the value untouched when the run knows no secrets', () => {
    const body = { token: 'plain' };

    expect(createSecretTracker().mask(body)).toBe(body);
  });

  it('picks up a secret added after the first mask, since not all are known before the run', () => {
    const tracker = createSecretTracker();

    expect(tracker.mask('later')).toBe('later');
    tracker.add('later');
    expect(tracker.mask('later')).toBe(MASK);
  });

  it('never mutates its argument — the run still has to send the real token', () => {
    const tracker = createSecretTracker(['s3cr3t']);
    const body = { token: 's3cr3t' };

    expect(tracker.mask(body)).not.toBe(body);
    expect(body.token).toBe('s3cr3t');
  });

  it('returns a value the walk cannot rebuild faithfully as it is', () => {
    const tracker = createSecretTracker(['s3cr3t']);
    const buffer = Buffer.from('s3cr3t');
    const date = new Date(0);

    const masked = tracker.mask({ buffer, date });

    expect(masked.buffer).toBe(buffer);
    expect(masked.date).toBe(date);
  });
});

describe('the mask itself', () => {
  it('is never length-preserving, which would leak how long the secret is', () => {
    const tracker = createSecretTracker(['short', 'a-considerably-longer-secret']);

    expect(tracker.mask('short')).toBe(tracker.mask('a-considerably-longer-secret'));
  });
});
