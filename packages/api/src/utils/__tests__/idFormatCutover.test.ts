import { isAccountIdFormat, isValidObjectId } from '../validation';

/**
 * Cutover regression guard. Two agents independently found guards written for
 * the 24-hex shape alone; one of them (`mediaPrivacyService`) failed OPEN, so a
 * post-migration account would have bypassed block enforcement entirely.
 */
describe('account id format accepts both live shapes', () => {
  it('accepts a pre-migration Mongo ObjectId', () => {
    expect(isAccountIdFormat('507f1f77bcf86cd799439011')).toBe(true);
  });

  it('accepts a post-cutover uuid v7', () => {
    expect(isAccountIdFormat('019fb834-d8a6-73fc-9073-da304c940f28')).toBe(true);
  });

  it('rejects a value that is neither', () => {
    expect(isAccountIdFormat('__federation__')).toBe(false);
    expect(isAccountIdFormat('')).toBe(false);
    expect(isAccountIdFormat('not-an-id')).toBe(false);
  });

  it('no longer accepts any 12-character string, which mongoose did and no caller wanted', () => {
    expect(isValidObjectId('abcdefghijkl')).toBe(false);
  });

  it('keeps isValidObjectId deliberately narrow, so unported callers stay visible', () => {
    // Widening this instead of adding isAccountIdFormat was the tempting fix and
    // the wrong one: it would silently make ~20 unreviewed call sites "work"
    // while hiding which ones still need a decision. Each remaining caller must
    // either drop its guard (it only ever existed to stop a Mongoose CastError)
    // or move to isAccountIdFormat where a 400 is a real contract.
    expect(isValidObjectId('019fb834-d8a6-73fc-9073-da304c940f28')).toBe(false);
    expect(isAccountIdFormat('019fb834-d8a6-73fc-9073-da304c940f28')).toBe(true);
  });
});
