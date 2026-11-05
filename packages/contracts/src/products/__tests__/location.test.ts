import {
  billingCustomerLocationRequestSchema,
  billingCustomerLocationResultSchema,
} from '../location';
import {
  billingCustomerLocationRequestCheck,
  billingCustomerLocationResultCheck,
  productPlanCheckoutRequestCheck,
} from '../../client/products';
import { productPlanCheckoutRequestSchema } from '../checkout';
const request = {
  expectedSubjectAccountId: 'payer',
  billingAddress: { country: 'US', state: 'DE', postalCode: ' 19802 ', line1: ' Test street ' },
};
it('keeps portable address validation identical and forwards only bounded declared address fields', () => {
  for (const value of [
    request,
    { ...request, paymentMethodCountry: 'US' },
    { ...request, billingAddress: { ...request.billingAddress, ipAddress: '127.0.0.1' } },
    { ...request, billingAddress: { country: 'us' } },
    { ...request, billingAddress: { country: 'US', line1: 'x'.repeat(201) } },
    { ...request, billingAddress: { country: 'US', postalCode: ' ' } },
    { ...request, billingAddress: { country: 'US', city: null } },
  ]) {
    const schema = billingCustomerLocationRequestSchema.safeParse(value);
    const portable = billingCustomerLocationRequestCheck(value, []);
    expect(portable.ok).toBe(schema.success);
    if (schema.success && portable.ok) expect(portable.value).toEqual(schema.data);
  }
});
it('keeps evidence optional for recovering existing checkout without accepting arbitrary location claims', () => {
  const checkout = {
    expectedSubjectAccountId: 'payer',
    productId: 'mention',
    offerId: 'monthly',
    offerVersion: 1,
    idempotencyKey: 'checkout_key',
  };
  for (const value of [
    checkout,
    { ...checkout, customerLocationEvidenceId: 'taxloc_owned' },
    { ...checkout, customerLocationEvidenceId: 'foreign' },
    { ...checkout, billingCountry: 'US' },
  ])
    expect(productPlanCheckoutRequestCheck(value, []).ok).toBe(
      productPlanCheckoutRequestSchema.safeParse(value).success,
    );
});
it('reports insufficient evidence without implying purchase readiness or returning an address', () => {
  const result = {
    state: 'recorded',
    subjectAccountId: 'payer',
    evidenceId: 'taxloc_owned',
    status: 'insufficient',
    country: null,
    expiresAt: '2026-11-04T00:00:00.000Z',
  };
  for (const value of [
    result,
    { ...result, billingAddress: request.billingAddress },
    { ...result, status: 'verified' },
    { state: 'unconfigured', reason: 'provider_unconfigured' },
  ])
    expect(billingCustomerLocationResultCheck(value, []).ok).toBe(
      billingCustomerLocationResultSchema.safeParse(value).success,
    );
});
