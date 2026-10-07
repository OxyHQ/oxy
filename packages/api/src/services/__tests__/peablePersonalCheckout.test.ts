import type { Peable } from '@peable.to/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPeablePersonalCheckoutProvider } from '../peablePersonalCheckout.service';

const now = new Date('2026-10-07T00:00:00.000Z');
const configuration = {
  merchantId: 'merch_fixture', applicationId: 'app_fixture',
  namespace: { mode: 'test' as const, environment: 'test' as const },
  returnUrl: 'https://accounts.example.invalid/payments',
  offers: [{ offerId: 'one', offerVersion: 1, priceId: 'price_fixture', planId: 'one_monthly',
    amountMinorUnits: 2999 as const, currency: 'USD' as const,
    interval: 'month' as const, trial: 'none' as const }],
};
const input = {
  intentId: 'intent_fixture', idempotencyKey: 'personal-checkout:intent_fixture',
  subjectAccountId: 'account_fixture', offerId: 'one', offerVersion: 1,
  priceId: 'price_fixture', amountMinorUnits: 2999, currency: 'usd',
  providerAccountRef: 'merch_fixture', mode: 'test', environment: 'test',
  interval: 'month' as const, trial: 'none' as const,
};
function fixture() {
  const retrieve = jest.fn(async () => ({ id: 'merch_fixture', oxyAppId: 'app_fixture', environment: 'test' }));
  const ensureCustomer = jest.fn(async () => ({ providerCustomerId: 'cus_fixture' }));
  const createCheckoutSession = jest.fn(async () => ({ id: 'cs_fixture', url: 'https://checkout.example.invalid/fixture', expiresAt: '2026-10-07T01:00:00.000Z' }));
  const client = { merchants: { retrieve }, billing: { ensureCustomer, createCheckoutSession } } as unknown as Pick<Peable, 'merchants' | 'billing'>;
  return { retrieve, ensureCustomer, createCheckoutSession,
    provider: createPeablePersonalCheckoutProvider(client, configuration, () => now) };
}
it('uses exact account and monthly no-trial selection with durable SDK replay identities', async () => {
  const test = fixture();
  expect(await test.provider.create(input)).toEqual({ sessionId: 'cs_fixture', checkoutUrl: 'https://checkout.example.invalid/fixture' });
  await test.provider.create(input);
  expect(test.ensureCustomer.mock.calls[0]).toEqual(test.ensureCustomer.mock.calls[1]);
  expect(test.ensureCustomer).toHaveBeenCalledWith({ storeId: input.subjectAccountId, storeName: input.subjectAccountId },
    { idempotencyKey: expect.stringMatching(/^oxy-one-customer:[a-f0-9]{64}$/) });
  expect(test.createCheckoutSession).toHaveBeenCalledWith({ providerCustomerId: 'cus_fixture', providerPriceId: 'price_fixture', trialDays: 0,
    returnUrl: configuration.returnUrl, storeId: input.subjectAccountId, planId: 'one_monthly' }, { idempotencyKey: input.idempotencyKey });
  await test.provider.create({ ...input, subjectAccountId: 'another_account' });
  expect(test.ensureCustomer.mock.calls[2]).not.toEqual(test.ensureCustomer.mock.calls[0]);
});
it.each([{ amountMinorUnits: 1 }, { currency: 'EUR' }, { providerAccountRef: 'another' },
  { offerVersion: 2 }, { mode: 'live' }, { environment: 'production' }])('rejects changed trusted binding before remote effects %p', async changed => {
  const test = fixture();
  await expect(test.provider.create({ ...input, ...changed })).rejects.toThrow('selection differs');
  expect(test.retrieve).not.toHaveBeenCalled();
  expect(test.ensureCustomer).not.toHaveBeenCalled();
});
it('rejects wrong credentials before customer or session creation', async () => {
  const test = fixture(); test.retrieve.mockResolvedValue({ id: 'other', oxyAppId: 'app_fixture', environment: 'test' });
  await expect(test.provider.create(input)).rejects.toThrow('credential owner');
  expect(test.ensureCustomer).not.toHaveBeenCalled();
});
it('keeps production purchase closed before every remote effect', async () => {
  const test = fixture(); const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await expect(test.provider.create(input)).rejects.toThrow('authority is unconfigured'); }
  finally { process.env.NODE_ENV = previous; }
  expect(test.retrieve).not.toHaveBeenCalled();
});
it('refuses expired and unsafe hosted URLs', async () => {
  const test = fixture();
  test.createCheckoutSession.mockResolvedValue({ id: 'cs_fixture', url: 'https://checkout.example.invalid/fixture', expiresAt: now.toISOString() });
  await expect(test.provider.create(input)).rejects.toThrow('expired');
  test.createCheckoutSession.mockResolvedValue({ id: 'cs_fixture', url: 'http://checkout.example.invalid/fixture', expiresAt: '2026-10-07T01:00:00.000Z' });
  await expect(test.provider.create(input)).rejects.toThrow();
});
it('records the approved issuer and renewal choices without treating them as fiscal activation', () => {
  const proposed = JSON.parse(readFileSync(resolve(__dirname, '../../../config/drafts/oxy-one-commercial-decisions.json'), 'utf8'));
  expect(proposed.commercialActivation).toBe(false);
  expect(proposed.saleCountryObjective).toBe('worldwide');
  expect(proposed.enabledSaleCountries).toEqual([]);
  expect(proposed.invoiceIssuer).toEqual({ legalName: 'The Oxy Collective, Inc.', approved: true });
  expect(proposed.faircoinRenewal).toEqual({
    customerChoices: ['manual_monthly', 'automatic_revocable'], mandatesEnabled: false,
    automaticRequirements: ['express_consent', 'amount_limit', 'periodicity_limit', 'verifiable_revocation'],
  });
  expect(proposed.unresolved).toEqual(expect.arrayContaining([
    'seller_id_and_invoice_issuer_id', 'tax_remitter_registrations_and_sale_countries',
    'authoritative_tax_and_customer_location_service', 'fair_usd_source_quote_expiry_and_rounding',
    'renewal_failure_grace', 'partial_refund_entitlement_policy',
  ]));
});
