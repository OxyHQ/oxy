import {
  getOnePlans,
  onePlanQuote,
  OXY_ONE_FAMILY_MEMBERS,
  OXY_ONE_APP_SUBSCRIPTIONS,
} from '../one';

describe('approved Oxy One terms from website /one', () => {
  test.each([
    ['personal', 'individual', [0, 1500, 2999, 9900, 40000]],
    ['personal', 'family', [2500, 4900, 16900, 59900]],
    ['creator', 'individual', [2900, 6900, 14900, 49900]],
    ['business', 'individual', [3900, 9999, 19900, 59900]],
  ] as const)('%s/%s keeps approved monthly minor units', (audience, mode, amounts) => {
    expect(getOnePlans(audience, mode).map((plan) => plan.monthlyPrice)).toEqual(amounts);
  });
  test('annual amounts round each billable line; displayed monthly amount is not recharged', () => {
    const pro = getOnePlans('personal').find((plan) => plan.name === 'Pro');
    if (!pro) throw new Error('Expected published Pro plan');
    expect(onePlanQuote(pro, 'annual', undefined)).toMatchObject({
      totalAnnual: 28790,
      totalMonthly: 2399,
      monthlyCredits: 10000,
    });
  });
  test('family allowance is shared, never multiplied by its six members', () => {
    expect(OXY_ONE_FAMILY_MEMBERS).toBe(6);
    const pro = getOnePlans('personal', 'family').find((plan) => plan.name === 'Pro');
    if (!pro) throw new Error('Expected published Pro plan');
    expect(onePlanQuote(pro, 'monthly', 6)).toMatchObject({
      totalMonthly: 4900,
      storageGB: 200,
      monthlyCredits: 20000,
    });
  });
  test('business adds per-seat price, storage and credits', () => {
    const pro = getOnePlans('business').find((plan) => plan.name === 'Pro');
    if (!pro) throw new Error('Expected published Pro plan');
    expect(onePlanQuote(pro, 'monthly', 3)).toMatchObject({
      totalMonthly: 15699,
      storageGB: 130,
      monthlyCredits: 40000,
    });
    expect(onePlanQuote(pro, 'monthly', undefined)).toMatchObject({
      totalMonthly: undefined,
      storageGB: undefined,
      monthlyCredits: undefined,
    });
  });
  test('free does not grant paid product tiers', () => {
    expect(Object.values(OXY_ONE_APP_SUBSCRIPTIONS).every((app) => app.tiers.Free === null)).toBe(
      true,
    );
    expect(Object.keys(OXY_ONE_APP_SUBSCRIPTIONS)).toHaveLength(8);
  });
});
