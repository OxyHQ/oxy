import {
  OXY_PUBLISHED_USER_CHANGE_REASONS,
  OXY_USER_CHANGE_REASONS,
  OXY_USER_INVALIDATION_CHANNEL,
  isPublishedOxyUserChangeReason,
  oxyUserInvalidationEventSchema,
} from '../index';

describe('@oxyhq/contracts userInvalidation', () => {
  it('pins the channel name', () => {
    // Both sides subscribe/publish by this literal; a rename is a silent
    // "invalidation never arrives", so it is pinned rather than derived.
    expect(OXY_USER_INVALIDATION_CHANNEL).toBe('oxy:user:invalidate');
  });

  it('classifies graph churn as non-broadcast and profile changes as broadcast', () => {
    expect(isPublishedOxyUserChangeReason('profile')).toBe(true);
    expect(isPublishedOxyUserChangeReason('graph')).toBe(false);
  });

  it('keeps every published reason inside the reason union', () => {
    // Guards the two lists drifting apart: a published reason the union does not
    // contain could never be produced, and would type-check anyway.
    for (const reason of OXY_PUBLISHED_USER_CHANGE_REASONS) {
      expect(OXY_USER_CHANGE_REASONS).toContain(reason);
    }
  });

  it('accepts a well-formed event', () => {
    const parsed = oxyUserInvalidationEventSchema.safeParse({
      userId: '6981c9178fcdefaf81988ffb',
      reason: 'profile',
      at: 1_754_000_000_000,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-broadcast reason on the wire', () => {
    // The suppression is meant to happen at the publisher. If a `graph` event
    // ever reaches the channel it is a bug, and the schema is the thing that
    // says so rather than a subscriber silently discarding it.
    const parsed = oxyUserInvalidationEventSchema.safeParse({
      userId: '6981c9178fcdefaf81988ffb',
      reason: 'graph',
      at: 1_754_000_000_000,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload missing an id, or carrying an empty one', () => {
    expect(
      oxyUserInvalidationEventSchema.safeParse({ reason: 'profile', at: 1 }).success,
    ).toBe(false);
    expect(
      oxyUserInvalidationEventSchema.safeParse({ userId: '', reason: 'profile', at: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a non-integer or negative timestamp', () => {
    const base = { userId: 'u1', reason: 'profile' as const };
    expect(oxyUserInvalidationEventSchema.safeParse({ ...base, at: -1 }).success).toBe(false);
    expect(oxyUserInvalidationEventSchema.safeParse({ ...base, at: 1.5 }).success).toBe(false);
  });

  it('carries no profile data', () => {
    // The channel is readable by every Oxy backend. This asserts the payload
    // stays an id + a reason + a clock, so nobody can widen it into a
    // profile-broadcast without the test saying so.
    const shape = oxyUserInvalidationEventSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(['at', 'reason', 'userId']);
  });
});
