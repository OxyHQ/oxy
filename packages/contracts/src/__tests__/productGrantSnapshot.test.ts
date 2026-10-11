import { subjectProductGrantSnapshotSchema } from '../products/access';

const evaluatedAt = '2026-10-06T12:00:00.000Z';
function snapshot(revokedAt: string | null) {
  return {
    schemaVersion: 1 as const,
    access: {
      schemaVersion: 1 as const,
      subjectAccountId: 'acct_subject',
      productId: 'product_one',
      evaluatedAt,
      capabilities: [{ key: 'mono', grantIds: ['grant_one'] }],
      quotas: [],
      conflicts: [],
    },
    grants: [
      {
        schemaVersion: 1 as const,
        id: 'grant_one',
        sourceSegmentId: 'segment_one',
        beneficiaryAccountId: 'acct_subject',
        offerId: 'offer_one',
        offerVersion: 1,
        origin: 'bundle' as const,
        benefit: { kind: 'capability' as const, productId: 'product_one', key: 'mono' },
        period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
        revokedAt,
      },
    ],
  };
}

describe('subjectProductGrantSnapshotSchema revocation', () => {
  it('accepts an unrevoked active grant', () => {
    expect(subjectProductGrantSnapshotSchema.safeParse(snapshot(null)).success).toBe(true);
  });
  it('accepts a grant whose scheduled revocation is still in the future', () => {
    expect(
      subjectProductGrantSnapshotSchema.safeParse(snapshot('2026-10-06T12:00:00.001Z')).success,
    ).toBe(true);
  });
  it('refuses a grant revoked at or before evaluation', () => {
    expect(subjectProductGrantSnapshotSchema.safeParse(snapshot(evaluatedAt)).success).toBe(false);
    expect(
      subjectProductGrantSnapshotSchema.safeParse(snapshot('2026-10-05T00:00:00.000Z')).success,
    ).toBe(false);
  });
});
