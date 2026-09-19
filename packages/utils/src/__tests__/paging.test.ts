/**
 * Page-window resolution — every degenerate input the ecosystem disagreed on.
 *
 * Seven helpers in five repos plus 46 inline clamps, no two agreeing. Each case
 * below is a behaviour that shipped somewhere, so this file is simultaneously
 * the specification and the list of bugs it settles.
 */

import {
  offsetForPage,
  resolvePageLimit,
  resolvePageNumber,
  resolvePageOffset,
} from '../paging';

const BOUNDS = { fallback: 20, max: 50 };

describe('resolvePageLimit', () => {
  it('honours a value inside the bounds', () => {
    expect(resolvePageLimit('10', BOUNDS)).toBe(10);
    expect(resolvePageLimit(10, BOUNDS)).toBe(10);
  });

  it('caps at the maximum rather than trusting the caller', () => {
    expect(resolvePageLimit('9999', BOUNDS)).toBe(50);
  });

  it('never yields NaN, however malformed the input', () => {
    // THE bug this function exists for. `Math.min(max, Math.max(1,
    // parseInt('abc', 10)))` is `NaN` — both `Math.max` and `Math.min` return
    // `NaN` when given one — so the idiomatic clamp looks like it bounds the
    // value and does not. It then reaches the query as `limit: NaN`, and any
    // `(page - 1) * limit` alongside it as `NaN` too.
    for (const raw of ['abc', '', '   ', 'Infinity', '-Infinity', 'NaN', null, undefined, {}, [], true]) {
      const resolved = resolvePageLimit(raw, BOUNDS);
      expect(Number.isInteger(resolved)).toBe(true);
      expect(resolved).toBe(20);
    }
  });

  it('treats an absent limit as a page SIZE, never as "everything"', () => {
    // Two Mention endpoints read absent as "return every matching row" and then
    // hydrated relations for all of them. A response sized by how much data the
    // table happens to hold is not a page.
    expect(resolvePageLimit(undefined, BOUNDS)).toBe(20);
  });

  it('refuses zero, negatives and fractions rather than coercing them', () => {
    // `?limit=0` meant the default in four repos and `1` in a fifth.
    expect(resolvePageLimit('0', BOUNDS)).toBe(20);
    expect(resolvePageLimit('-5', BOUNDS)).toBe(20);
    expect(resolvePageLimit('2.5', BOUNDS)).toBe(20);
    expect(resolvePageLimit(2.5, BOUNDS)).toBe(20);
  });

  it('refuses a partially numeric value instead of taking its digits', () => {
    // `parseInt('5abc', 10)` is 5, which silently accepts a malformed value —
    // Homiio's copy chose `Number` for exactly this and said so. A typo gets
    // the default page rather than a size inferred from the start of a mistake.
    expect(resolvePageLimit('5abc', BOUNDS)).toBe(20);
  });

  it('refuses number FORMATS a query string has no business carrying', () => {
    // These are why the parse is a decimal-digit check and not a bare `Number`:
    // every one of them converts to a perfectly valid bounded integer, so
    // nothing would fail loudly — the caller would just get a page size they
    // did not ask for. `0x10` resolving to 16 is what caught it.
    expect(resolvePageLimit('0x10', BOUNDS)).toBe(20);
    expect(resolvePageLimit('0b11', BOUNDS)).toBe(20);
    expect(resolvePageLimit('0o17', BOUNDS)).toBe(20);
    expect(resolvePageLimit('1e3', BOUNDS)).toBe(20);
    // ...while a plain decimal with incidental whitespace still works, because
    // a query string can carry that without the caller meaning anything by it.
    expect(resolvePageLimit(' 10 ', BOUNDS)).toBe(10);
  });

  it('refuses a digit run too long to survive as an integer', () => {
    // Past the safe range the value parses to a rounded float, which is no
    // longer the number the caller wrote.
    expect(resolvePageLimit('9'.repeat(30), BOUNDS)).toBe(20);
  });

  it('takes the FIRST value of a repeated parameter', () => {
    // `?limit=5&limit=500` was 5, 500, NaN, and `parseInt('5,500')` = 5
    // depending on the repo. First wins, so appending a second parameter cannot
    // escape a limit something upstream set.
    expect(resolvePageLimit(['5', '500'], BOUNDS)).toBe(5);
    // ...and a malformed first value does not fall through to the second.
    expect(resolvePageLimit(['abc', '500'], BOUNDS)).toBe(20);
  });
});

describe('resolvePageOffset', () => {
  it('honours a valid offset and defaults to zero', () => {
    expect(resolvePageOffset('40')).toBe(40);
    expect(resolvePageOffset(undefined)).toBe(0);
    expect(resolvePageOffset('abc')).toBe(0);
    expect(resolvePageOffset('-5')).toBe(0);
  });

  it('accepts zero, unlike a limit', () => {
    // The reason this is a separate function: an absent LIMIT must become a
    // page size, while an absent offset is genuinely zero. One helper for both
    // would need a sentinel to tell them apart, which is how "0 means
    // unbounded" gets written.
    expect(resolvePageOffset('0')).toBe(0);
    expect(resolvePageOffset(0)).toBe(0);
  });
});

describe('resolvePageNumber and offsetForPage', () => {
  it('is 1-based and never below one', () => {
    expect(resolvePageNumber('3')).toBe(3);
    expect(resolvePageNumber('0')).toBe(1);
    expect(resolvePageNumber('-2')).toBe(1);
    expect(resolvePageNumber('abc')).toBe(1);
    expect(resolvePageNumber(undefined)).toBe(1);
  });

  it('computes an offset that can never be negative or NaN', () => {
    // The multiplication is where the `NaN` landed even in routes that clamped
    // both parameters: `(pageNum - 1) * limitNum` from values never checked.
    expect(offsetForPage('3', 10)).toBe(20);
    expect(offsetForPage('1', 10)).toBe(0);
    expect(offsetForPage('abc', 10)).toBe(0);
    expect(offsetForPage(undefined, 10)).toBe(0);
    expect(offsetForPage('-5', 10)).toBe(0);
  });
});
