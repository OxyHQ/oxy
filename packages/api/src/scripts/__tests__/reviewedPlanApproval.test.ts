import { requireReviewedPlanApproval } from '../reviewedPlanApproval';

const HASH = 'a'.repeat(64);

describe('reviewed plan approval', () => {
  it('returns the actor and reason when the reviewed hash matches', () => {
    expect(
      requireReviewedPlanApproval(HASH, {
        BOOTSTRAP_ACTOR: 'release-bot',
        BOOTSTRAP_REASON: 'OPS-123 reviewed plan',
        EXPECTED_PLAN_SHA256: HASH,
      }),
    ).toEqual({ actor: 'release-bot', reason: 'OPS-123 reviewed plan' });
  });

  it.each([
    {},
    { BOOTSTRAP_ACTOR: ' release-bot', BOOTSTRAP_REASON: 'OPS-123', EXPECTED_PLAN_SHA256: HASH },
    { BOOTSTRAP_ACTOR: 'release-bot', BOOTSTRAP_REASON: 'OPS-123 ', EXPECTED_PLAN_SHA256: HASH },
    {
      BOOTSTRAP_ACTOR: 'release-bot',
      BOOTSTRAP_REASON: 'OPS-123',
      EXPECTED_PLAN_SHA256: '0'.repeat(64),
    },
    { BOOTSTRAP_ACTOR: 'release-bot', BOOTSTRAP_REASON: 'OPS-123' },
  ])('fails closed for incomplete or mismatched approval: %j', (env) => {
    expect(() => requireReviewedPlanApproval(HASH, env)).toThrow();
  });
});
