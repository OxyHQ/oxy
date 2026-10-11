import { FREE_PERIOD_PROMOTIONS, resolveFreePeriodPromotion } from '../subscriptionPromotionPolicy';
const input = { planId: 'pro_monthly', amountPaid: 0, trialCoversPeriod: true, couponIds: [] };
const synthetic = {
  id: 'synthetic-trial@v1',
  planId: 'pro_monthly',
  kind: 'trial' as const,
  couponId: null,
  credits: 2000,
  oncePerAccount: true,
};
it('initial registry is empty and illustrative trial/coupon values never activate', () => {
  expect(FREE_PERIOD_PROMOTIONS).toEqual([]);
  expect(resolveFreePeriodPromotion(input)).toBeNull();
  expect(resolveFreePeriodPromotion({ ...input, couponIds: ['FOUNDERS100'] })).toBeNull();
});
it('explicit synthetic fixtures select only the declared plan and verified promotion type', () => {
  expect(resolveFreePeriodPromotion(input, [synthetic])).toEqual(synthetic);
  expect(
    resolveFreePeriodPromotion({ ...input, planId: 'business_monthly' }, [synthetic]),
  ).toBeNull();
  expect(
    resolveFreePeriodPromotion({ ...input, trialCoversPeriod: false }, [synthetic]),
  ).toBeNull();
});
it('unknown coupons, ambiguous matches and positive invoices fail closed', () => {
  const coupon = {
    ...synthetic,
    id: 'synthetic-coupon@v1',
    kind: 'coupon' as const,
    couponId: 'synthetic-coupon',
  };
  expect(
    resolveFreePeriodPromotion({ ...input, trialCoversPeriod: false, couponIds: ['unknown'] }, [
      coupon,
    ]),
  ).toBeNull();
  expect(() =>
    resolveFreePeriodPromotion({ ...input, couponIds: ['synthetic-coupon'] }, [synthetic, coupon]),
  ).toThrow();
  expect(() => resolveFreePeriodPromotion({ ...input, amountPaid: 1 }, [synthetic])).toThrow();
});
