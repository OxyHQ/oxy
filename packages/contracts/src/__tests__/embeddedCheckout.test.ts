import {
  productPlanCheckoutRequestSchema,
  productCheckoutConfigurationSchema,
} from '../products/checkout';
import {
  productPlanCheckoutRequestCheck,
  productCheckoutConfigurationCheck,
} from '../client/products';
import { parseContract } from '../client/check';
const request = {
  expectedSubjectAccountId: 'account',
  productId: 'mention',
  offerId: 'monthly',
  offerVersion: 1,
  idempotencyKey: 'operation_123',
  presentation: 'embedded',
  billingAddress: { country: 'US', postalCode: '19802' },
};
it('accepts explicit embedded payer address in both server and headless client contracts', () => {
  expect(productPlanCheckoutRequestSchema.parse(request)).toEqual(request);
  expect(parseContract(productPlanCheckoutRequestCheck, request)).toEqual(request);
});
it('rejects inferred or extra location evidence and invalid presentation', () => {
  for (const value of [
    { ...request, presentation: 'custom' },
    { ...request, billingAddress: { country: 'US', ipCountry: 'US' } },
    { ...request, billingAddress: { country: 'en-US' } },
  ]) {
    expect(productPlanCheckoutRequestSchema.safeParse(value).success).toBe(false);
    expect(() => parseContract(productPlanCheckoutRequestCheck, value)).toThrow();
  }
});
it('readonly unconfigured state contains no payer secret or made-up configuration', () => {
  expect(productCheckoutConfigurationSchema.parse({ state: 'unconfigured' })).toEqual({
    state: 'unconfigured',
  });
  expect(parseContract(productCheckoutConfigurationCheck, { state: 'unconfigured' })).toEqual({
    state: 'unconfigured',
  });
  expect(() =>
    parseContract(productCheckoutConfigurationCheck, {
      state: 'unconfigured',
      clientSecret: 'not-allowed',
    }),
  ).toThrow();
});
