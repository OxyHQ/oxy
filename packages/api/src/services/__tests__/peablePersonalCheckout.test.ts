import type { BillingTaxQuote, Peable } from '@peable.to/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPeablePersonalCheckoutProvider } from '../peablePersonalCheckout.service';

const now = new Date('2026-10-07T00:00:00.000Z');
const configuration = {
  merchantId: 'merch_fixture',
  applicationId: 'app_fixture',
  sellerId: 'seller_fixture',
  invoiceIssuerId: 'issuer_fixture',
  taxRemitterId: 'remitter_fixture',
  namespace: { mode: 'test' as const, environment: 'staging' as const },
  returnUrl: 'https://accounts.example.invalid/payments',
  offers: [
    {
      offerId: 'one',
      offerVersion: 1,
      priceId: 'price_fixture',
      planId: 'one_monthly',
      amountMinorUnits: 2999 as const,
      currency: 'USD' as const,
      interval: 'month' as const,
      trial: 'none' as const,
    },
  ],
};
const input = {
  intentId: 'intent_fixture',
  idempotencyKey: 'personal-checkout:intent_fixture',
  subjectAccountId: 'account_fixture',
  offerId: 'one',
  offerVersion: 1,
  priceId: 'price_fixture',
  amountMinorUnits: 2999,
  currency: 'usd',
  providerAccountRef: 'merch_fixture',
  mode: 'test',
  environment: 'staging',
  interval: 'month' as const,
  trial: 'none' as const,
};
const quote: BillingTaxQuote = {
  schemaVersion: 1,
  source: {
    merchantId: 'merch_fixture',
    appId: 'app_fixture',
    storeId: 'account_fixture',
    planId: 'one_monthly',
    mode: 'test',
    environment: 'staging',
  },
  quote: {
    id: 'quote_fixture',
    currency: 'USD',
    grossMinorUnits: 2999,
    netMinorUnits: 2499,
    taxMinorUnits: 500,
    taxTreatment: 'inclusive',
    sellerId: 'seller_fixture',
    invoiceIssuerId: 'issuer_fixture',
    taxRemitterId: 'remitter_fixture',
    taxServiceRef: 'tax_fixture',
    country: 'RO',
    coverageEvidenceId: 'coverage_fixture',
    taxRateEvidenceId: 'rate_fixture',
    customerLocationEvidenceId: 'location_fixture',
    quotedAt: now.toISOString(),
    expiresAt: '2026-10-07T02:00:00.000Z',
  },
  signature: { algorithm: 'Ed25519', keyId: 'key_fixture', value: 'fixture' },
};
function fixture() {
  const retrieve = jest.fn(async () => ({
    id: 'merch_fixture',
    oxyAppId: 'app_fixture',
    environment: 'staging',
  }));
  const ensureCustomer = jest.fn(async () => ({ providerCustomerId: 'cus_fixture' }));
  const createTaxQuote = jest.fn(async () => structuredClone(quote));
  const createCheckoutSession = jest.fn(async () => ({
    id: 'cs_fixture',
    url: 'https://checkout.example.invalid/fixture',
    expiresAt: '2026-10-07T01:00:00.000Z',
  }));
  const resolveCustomerLocationEvidence = jest.fn(async () => ({
    customerLocationEvidenceId: 'location_fixture',
  }));
  const client = {
    merchants: { retrieve },
    billing: { ensureCustomer, createTaxQuote, createCheckoutSession },
  } as unknown as Pick<Peable, 'merchants' | 'billing'>;
  const provider = createPeablePersonalCheckoutProvider(client, configuration, () => now, {
    resolveCustomerLocationEvidence,
  });
  return {
    retrieve,
    ensureCustomer,
    createTaxQuote,
    createCheckoutSession,
    resolveCustomerLocationEvidence,
    provider,
  };
}
it('prepares trusted customer and quote then replays only the frozen checkout snapshot', async () => {
  const test = fixture();
  const snapshot = await test.provider.prepare?.(input);
  expect(snapshot?.taxQuote).toEqual(quote);
  expect(test.resolveCustomerLocationEvidence).toHaveBeenCalledWith(input.subjectAccountId);
  expect(test.createTaxQuote).toHaveBeenCalledWith({
    storeId: input.subjectAccountId,
    planId: 'one_monthly',
    customerLocationEvidenceId: 'location_fixture',
  });
  const frozen = { ...input, snapshot };
  expect(await test.provider.create(frozen)).toEqual({
    sessionId: 'cs_fixture',
    checkoutUrl: 'https://checkout.example.invalid/fixture',
    expiresAt: '2026-10-07T01:00:00.000Z',
  });
  await test.provider.create(frozen);
  expect(test.ensureCustomer).toHaveBeenCalledTimes(1);
  expect(test.createTaxQuote).toHaveBeenCalledTimes(1);
  expect(test.createCheckoutSession.mock.calls[0]).toEqual(
    test.createCheckoutSession.mock.calls[1],
  );
  expect(test.createCheckoutSession).toHaveBeenCalledWith(
    {
      providerCustomerId: 'cus_fixture',
      providerPriceId: input.priceId,
      trialDays: 0,
      returnUrl: configuration.returnUrl,
      storeId: input.subjectAccountId,
      planId: 'one_monthly',
      taxQuote: quote,
    },
    { idempotencyKey: input.idempotencyKey },
  );
});
it.each([
  { amountMinorUnits: 1 },
  { currency: 'EUR' },
  { providerAccountRef: 'another' },
  { offerVersion: 2 },
  { mode: 'live' },
  { environment: 'production' },
])('rejects changed trusted binding before remote effects %p', async (changed) => {
  const test = fixture();
  await expect(test.provider.prepare?.({ ...input, ...changed })).rejects.toThrow(
    'selection differs',
  );
  expect(test.retrieve).not.toHaveBeenCalled();
  expect(test.ensureCustomer).not.toHaveBeenCalled();
});
it('rejects wrong credentials before customer effects', async () => {
  const test = fixture();
  test.retrieve.mockResolvedValue({ id: 'other', oxyAppId: 'app_fixture', environment: 'staging' });
  await expect(test.provider.prepare?.(input)).rejects.toThrow('credential owner');
  expect(test.ensureCustomer).not.toHaveBeenCalled();
});
it.each([
  'sellerId',
  'invoiceIssuerId',
  'taxRemitterId',
  'currency',
  'customerLocationEvidenceId',
] as const)('rejects quote substitution of %s', async (field) => {
  const test = fixture();
  const changed = structuredClone(quote);
  changed.quote[field] = 'other';
  test.createTaxQuote.mockResolvedValue(changed);
  await expect(test.provider.prepare?.(input)).rejects.toThrow();
  expect(test.createCheckoutSession).not.toHaveBeenCalled();
});
it('rejects missing snapshot, foreign subject, stale quote and an altered replay key', async () => {
  const test = fixture();
  await expect(test.provider.create(input)).rejects.toThrow('snapshot differs');
  const snapshot = await test.provider.prepare?.(input);
  await expect(
    test.provider.create({ ...input, snapshot, subjectAccountId: 'other' }),
  ).rejects.toThrow('snapshot differs');
  await expect(
    test.provider.create({ ...input, snapshot, idempotencyKey: 'other' }),
  ).rejects.toThrow('snapshot differs');
  if (!snapshot) throw new Error('Fixture snapshot missing');
  snapshot.taxQuote.quote.expiresAt = now.toISOString();
  await expect(test.provider.create({ ...input, snapshot })).rejects.toThrow('expired');
  expect(test.createCheckoutSession).not.toHaveBeenCalled();
});
it('keeps production purchase closed before every remote effect', async () => {
  const test = fixture();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await expect(test.provider.prepare?.(input)).rejects.toThrow('authority is unconfigured');
    await expect(test.provider.create(input)).rejects.toThrow('authority is unconfigured');
  } finally {
    process.env.NODE_ENV = previous;
  }
  expect(test.retrieve).not.toHaveBeenCalled();
});
it.each([
  { expiresAt: now.toISOString() },
  { expiresAt: '2026-10-07T03:00:00.000Z' },
  { url: 'http://checkout.example.invalid/fixture' },
])('rejects unsafe or expired checkout %p', async (change) => {
  const test = fixture();
  const snapshot = await test.provider.prepare?.(input);
  test.createCheckoutSession.mockResolvedValue({
    id: 'cs_fixture',
    url: 'https://checkout.example.invalid/fixture',
    expiresAt: '2026-10-07T01:00:00.000Z',
    ...change,
  });
  await expect(test.provider.create({ ...input, snapshot })).rejects.toThrow();
});
it.each([
  { source: { ...quote.source, storeId: 'foreign' } },
  { source: { ...quote.source, environment: 'production' as const } },
  { quote: { ...quote.quote, grossMinorUnits: 3000 } },
  { quote: { ...quote.quote, netMinorUnits: 2498 } },
  { quote: { ...quote.quote, taxTreatment: 'exclusive' as const } },
  { quote: { ...quote.quote, quotedAt: '2026-10-07T00:00:01.000Z' } },
])('rejects foreign or invalid signed quote context %p', async (change) => {
  const test = fixture();
  test.createTaxQuote.mockResolvedValue({ ...structuredClone(quote), ...change });
  await expect(test.provider.prepare?.(input)).rejects.toThrow('tax quote');
  expect(test.createCheckoutSession).not.toHaveBeenCalled();
});
it('detaches the approved configuration and the returned SDK authority', async () => {
  const test = fixture();
  test.createTaxQuote.mockResolvedValue(quote);
  const snapshot = await test.provider.prepare?.(input);
  if (!snapshot) throw new Error('Fixture snapshot missing');
  snapshot.taxQuote.quote.currency = 'EUR';
  expect(quote.quote.currency).toBe('USD');
  await expect(test.provider.create({ ...input, snapshot })).rejects.toThrow('tax quote');
});
it('refuses a missing trusted location dependency before remote effects', async () => {
  const test = fixture();
  const client = {
    merchants: { retrieve: test.retrieve },
    billing: {
      ensureCustomer: test.ensureCustomer,
      createTaxQuote: test.createTaxQuote,
      createCheckoutSession: test.createCheckoutSession,
    },
  } as unknown as Pick<Peable, 'merchants' | 'billing'>;
  const provider = createPeablePersonalCheckoutProvider(client, configuration, () => now);
  await expect(provider.prepare?.(input)).rejects.toThrow('location is unconfigured');
  expect(test.retrieve).not.toHaveBeenCalled();
});
it('records the approved issuer and renewal choices without treating them as fiscal activation', () => {
  const proposed = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../config/drafts/oxy-one-commercial-decisions.json'),
      'utf8',
    ),
  );
  expect(proposed.commercialActivation).toBe(false);
  expect(proposed.saleCountryObjective).toBe('worldwide');
  expect(proposed.enabledSaleCountries).toEqual([]);
  expect(proposed.invoiceIssuer).toMatchObject({
    legalName: 'The Oxy Collective, Inc.',
    approved: false,
    issuerBrandApproved: true,
    taxIdentifier: null,
    registrationJurisdiction: null,
    legalNameStatus: 'user_proposed_not_independently_verified',
  });
  expect(proposed.faircoinRenewal).toEqual({
    customerChoices: ['manual_monthly', 'automatic_revocable'],
    mandatesEnabled: false,
    automaticRequirements: [
      'express_consent',
      'amount_limit',
      'periodicity_limit',
      'verifiable_revocation',
    ],
  });
  expect(proposed.unresolved).toEqual(
    expect.arrayContaining([
      'seller_id_and_invoice_issuer_id',
      'tax_remitter_registrations_and_sale_countries',
      'authoritative_tax_and_customer_location_service',
      'renewal_failure_grace',
      'partial_refund_entitlement_policy',
    ]),
  );
});

it('replays the frozen return URL after provider restart with changed configuration', async () => {
  const test = fixture();
  const snapshot = await test.provider.prepare?.(input);
  const client = {
    merchants: { retrieve: test.retrieve },
    billing: {
      ensureCustomer: test.ensureCustomer,
      createTaxQuote: test.createTaxQuote,
      createCheckoutSession: test.createCheckoutSession,
    },
  } as unknown as Pick<Peable, 'merchants' | 'billing'>;
  const restarted = createPeablePersonalCheckoutProvider(
    client,
    { ...configuration, returnUrl: 'https://new.example.invalid/return' },
    () => now,
  );
  await restarted.create({ ...input, snapshot });
  expect(test.createCheckoutSession).toHaveBeenCalledWith(
    expect.objectContaining({ returnUrl: configuration.returnUrl }),
    { idempotencyKey: input.idempotencyKey },
  );
  expect(test.createTaxQuote).toHaveBeenCalledTimes(1);
});
