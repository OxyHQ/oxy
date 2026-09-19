import { chunk, clamp, escapeRegExp } from '../text';

describe('escapeRegExp', () => {
  it('escapes every character a pattern gives meaning to', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o',
    );
  });

  it('makes a hostile term literal', () => {
    // The point of escaping: a user-supplied term must not be able to build a
    // pattern. `.*` would otherwise match anything, and a nested quantifier is
    // a catastrophic-backtracking risk.
    const term = '.*';
    expect(new RegExp(escapeRegExp(term)).test('anything')).toBe(false);
    expect(new RegExp(escapeRegExp(term)).test('a.*b')).toBe(true);
  });

  it('leaves the hyphen alone, deliberately', () => {
    // `-` is special only INSIDE a character class. A caller interpolating this
    // into one is building a pattern by hand and owns that; escaping it here
    // would change nothing for the ordinary case while implying a safety this
    // does not provide.
    expect(escapeRegExp('a-b')).toBe('a-b');
  });
});

describe('clamp', () => {
  it('bounds a value into the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('resolves NaN to the minimum rather than propagating it', () => {
    // The whole reason this is shared. `Math.min(max, Math.max(min, NaN))` is
    // `NaN`, so the idiomatic clamp does not clamp — two copies in the
    // ecosystem guard this and a third does not, so the same call returned `0`
    // in one place and `NaN` in another. A score that becomes `NaN` propagates
    // through arithmetic without ever throwing.
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 2, 5)).toBe(2);
  });

  it('bounds the infinities', () => {
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0);
  });
});

describe('chunk', () => {
  it('splits into consecutive groups of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('returns one group when the input fits, and none when it is empty', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    // Not `[[]]`: a caller looping over the result must not issue one batched
    // query for zero ids, which is how an `inArray(col, [])` reaches Postgres.
    expect(chunk([], 5)).toEqual([]);
  });

  it('copies rather than aliasing the input', () => {
    const items = [1, 2];
    const [group] = chunk(items, 5);
    group.push(3);
    expect(items).toEqual([1, 2]);
  });

  it('throws on a size that would loop forever', () => {
    // Reachable from a computed size (`Math.floor(budget / cost)`), where the
    // alternative to throwing is an infinite loop.
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});
