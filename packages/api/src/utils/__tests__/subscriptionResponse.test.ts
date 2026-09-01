import {
  type BillingSubscriptionSource,
  type LegacySubscriptionSource,
  formatSubscriptionResponse,
} from '../subscriptionResponse';

/** A billing row, with only the columns the serializer reads. */
function billingRow(
  overrides: Partial<BillingSubscriptionSource> = {},
): BillingSubscriptionSource {
  return {
    userId: 'user-1',
    status: 'active',
    currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    planName: 'pro',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A whole legacy row — every column reaches the wire. */
function legacyRow(
  overrides: Partial<LegacySubscriptionSource> = {},
): LegacySubscriptionSource {
  return {
    id: 'sub-1',
    userId: 'user-1',
    plan: 'pro',
    status: 'active',
    startDate: new Date('2025-12-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:00:00.000Z'),
    autoRenew: true,
    paymentMethod: null,
    latestInvoice: null,
    featureAnalytics: true,
    featurePremiumBadge: true,
    featureUnlimitedFollowing: false,
    featureHigherUploadLimits: false,
    featurePromotedPosts: false,
    featureBusinessTools: false,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    updatedAt: new Date('2025-12-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Before the legacy fixture's `endDate`, so it is not derived-expired. */
const DURING_PERIOD = new Date('2025-12-15T00:00:00.000Z');

describe('formatSubscriptionResponse', () => {
  it('prefers an active billing subscription over legacy rows', () => {
    expect(formatSubscriptionResponse(billingRow(), legacyRow({ plan: 'basic' }), DURING_PERIOD))
      .toEqual({
        plan: 'pro',
        status: 'active',
        userId: 'user-1',
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-02-01T00:00:00.000Z',
        autoRenew: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
  });

  it('maps trialing billing subscriptions to active status for Accounts UI', () => {
    const billing = billingRow({
      status: 'trialing',
      cancelAtPeriodEnd: true,
      planName: 'business',
    });

    expect(formatSubscriptionResponse(billing, null)).toMatchObject({
      plan: 'business',
      status: 'active',
      autoRenew: false,
    });
  });

  it('falls back to legacy subscription rows when billing is absent', () => {
    expect(formatSubscriptionResponse(null, legacyRow(), DURING_PERIOD)).toMatchObject({
      plan: 'pro',
      status: 'active',
      userId: 'user-1',
      autoRenew: true,
    });
  });

  it('reassembles the six feature columns into the nested object', () => {
    const response = formatSubscriptionResponse(null, legacyRow(), DURING_PERIOD);

    // Six real columns in the schema, one object on the wire.
    expect(response.features).toEqual({
      analytics: true,
      premiumBadge: true,
      unlimitedFollowing: false,
      higherUploadLimits: false,
      promotedPosts: false,
      businessTools: false,
    });
  });

  it('returns the basic fallback when neither billing nor legacy rows exist', () => {
    expect(formatSubscriptionResponse(null, null)).toEqual({ plan: 'basic' });
  });

  describe('legacy expiry is DERIVED, not read from the stored status', () => {
    /**
     * The Mongo TTL index used to DELETE a lapsed subscription, destroying the
     * record of what was bought. It is gone, so the row now outlives its own
     * deadline — and a serializer that trusted the stored `status` would report
     * `active` for a subscription that ended months ago.
     */
    it('reports expired once end_date has passed, without deleting anything', () => {
      const lapsed = legacyRow({ status: 'active', endDate: new Date('2026-01-01T00:00:00.000Z') });
      const afterPeriod = new Date('2026-06-01T00:00:00.000Z');

      const response = formatSubscriptionResponse(null, lapsed, afterPeriod);

      expect(response.status).toBe('expired');
      // The record survives its own expiry — that is the whole point of removing
      // the TTL index. Dates and features are still reported.
      expect(response.endDate).toBe('2026-01-01T00:00:00.000Z');
      expect(response.features).toBeDefined();
    });

    it('keeps reporting active while the period is still open', () => {
      const live = legacyRow({ status: 'active', endDate: new Date('2026-01-01T00:00:00.000Z') });

      expect(formatSubscriptionResponse(null, live, DURING_PERIOD).status).toBe('active');
    });

    it('lets an explicit cancellation outrank the deadline', () => {
      const cancelled = legacyRow({
        status: 'canceled',
        endDate: new Date('2026-01-01T00:00:00.000Z'),
      });
      const afterPeriod = new Date('2026-06-01T00:00:00.000Z');

      // A cancellation is a decision the user made; it does not decay into
      // "expired" just because the period also elapsed.
      expect(formatSubscriptionResponse(null, cancelled, afterPeriod).status).toBe('canceled');
    });
  });
});
