import { productBillingCatalogueSchema, EMPTY_PRODUCT_BILLING_CATALOGUE } from '../productBillingCatalogue.service';
import { readPersonalPlanCatalogue } from '../personalPlanCatalogue';

function fixture() {
  return productBillingCatalogueSchema.parse({ ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: [{ schemaVersion: 1, id: 'storage', ownerAccountId: 'owner', applicationId: 'app' }],
    offers: [{ schemaVersion: 1, id: 'personal', version: 2, kind: 'bundle', benefits: [
      { kind: 'quota', productId: 'storage', key: 'bytes', unit: 'byte', included: 123, combination: 'maximum' },
    ] }],
    personalPlans: [{ offerId: 'personal', offerVersion: 2, displayName: 'Fixture personal bundle', audience: 'personal', kind: 'oxy_one', benefitNames: ['Fixture storage'] }],
  });
}
it('has no purchasable default, price, owner or provider details', () => {
  expect(readPersonalPlanCatalogue(EMPTY_PRODUCT_BILLING_CATALOGUE)).toEqual({ schemaVersion: 1,
    state: 'unconfigured', purchase: 'unavailable', plans: [] });
  const answer = readPersonalPlanCatalogue(fixture());
  expect(answer.plans[0].benefits[0].benefit).toMatchObject({ included: 123 });
  expect(JSON.stringify(answer)).not.toMatch(/ownerAccountId|applicationId|priceId|amountMinorUnits|provider/);
  expect(answer.purchase).toBe('unavailable');
});
it('requires explicit publication, never infers it from registered bundles', () => {
  const value = fixture(); value.personalPlans = [];
  expect(readPersonalPlanCatalogue(value).plans).toEqual([]);
});
it('fails closed for wrong versions, duplicate publication and API credit benefits', () => {
  const value = fixture(); value.personalPlans[0].offerVersion = 1;
  expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
  const duplicate = fixture(); duplicate.personalPlans.push(duplicate.personalPlans[0]);
  expect(() => productBillingCatalogueSchema.parse(duplicate)).toThrow();
  const credits = fixture(); credits.offers[0].benefits[0] = {
    kind: 'quota', productId: 'storage', key: 'api_credits', unit: 'api_credit', included: 123, combination: 'sum' };
  expect(() => productBillingCatalogueSchema.parse(credits)).toThrow();
});
