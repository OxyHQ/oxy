/**
 * LIKE-pattern escaping — the test six repos did not have.
 *
 * Ten copies of this escape existed across six Oxy repos with ONE test between
 * them (Homiio's, against a real Postgres). These cases are the reason the
 * function is shared: each asserts a wrong answer that an unescaped or
 * half-escaped pattern produces silently, with a successful response.
 */

import { escapeLikePattern, likeContains, likeEndsWith, likeStartsWith } from '../sql';

describe('escapeLikePattern', () => {
  it('escapes the multi-character wildcard', () => {
    // The consequence when it does not: `LIKE '%100%%'` matches EVERY row, and
    // the response looks like a successful search that happened to match
    // everything. No error, no hint that the filter was ignored.
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('escapes the single-character wildcard', () => {
    // Subtler than `%`, because a term containing `_` still returns something
    // plausible: unescaped, `a_b` also matches `axb`.
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes the escape character itself, in the same pass', () => {
    // The ordering trap. Escaping `%` and `_` while leaving `\` alone makes a
    // term ending in a backslash escape the wildcard the code just added — a
    // syntax error rather than a wrong result. And chaining three `replace`
    // calls re-escapes the backslashes the earlier passes introduced, which is
    // why this is one character class and one pass.
    expect(escapeLikePattern('C:\\Users')).toBe('C:\\\\Users');
    expect(escapeLikePattern('trailing\\')).toBe('trailing\\\\');
  });

  it('escapes all three together without double-escaping', () => {
    // The case that catches a chained implementation: three passes turn this
    // into `\\\\\\%\\_` or worse.
    expect(escapeLikePattern('\\%_')).toBe('\\\\\\%\\_');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('climate')).toBe('climate');
    expect(escapeLikePattern('')).toBe('');
    // Not a LIKE metacharacter, whatever regex habit suggests.
    expect(escapeLikePattern('a.b*c+d?e')).toBe('a.b*c+d?e');
  });
});

describe('pattern builders', () => {
  it('wraps a substring match on both sides', () => {
    expect(likeContains('climate')).toBe('%climate%');
    expect(likeContains('100%')).toBe('%100\\%%');
  });

  it('anchors a prefix match', () => {
    expect(likeStartsWith('cli')).toBe('cli%');
    expect(likeStartsWith('100%')).toBe('100\\%%');
  });

  it('anchors a suffix match', () => {
    expect(likeEndsWith('mate')).toBe('%mate');
  });

  it('keeps a mid-string wildcard literal, which a trailing one cannot prove', () => {
    // `%100%%` and `%100\%%` match exactly the same rows, so a test using a
    // TRAILING `%` passes whether or not the escaping exists — Mention's copy
    // records discovering that by mutation-testing its own case. The `%` has to
    // be in the MIDDLE for the assertion to distinguish them: unescaped,
    // `%50%off%` also matches "50 percent off".
    expect(likeContains('50%off')).toBe('%50\\%off%');
  });
});
