import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants, accessSubscriptionSources } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  reconcilePeablePersonalPaidInvoice,
  type PeableEvidenceAuthority,
} from '../peablePersonalEvidence.service';
import { recordProductAccessPeriod } from '../productAccessPersistence.service';
/** Peable instants are integer Unix seconds (ADR 0014). */
const unix = (instant: string | Date | number) => Math.floor(new Date(instant).getTime() / 1000);
beforeAll(connectPostgres);
afterAll(closePostgres);
it('requires real authority, activates exact paid period once and preserves individual sources', async () => {
  const f = await productAccessFixture();
  const raw = f.input(f.offers[1]);
  await recordProductAccessPeriod({
    ...raw,
    source: { ...raw.source, beneficiaryAccountId: f.payer },
    segment: { ...raw.segment, beneficiaryAccountId: f.payer },
  });
  const context = {
    accountId: f.payer,
    customerId: 'cus_fixture',
    subscriptionId: `sub_${randomUUID()}`,
    priceId: 'price_fixture',
    planId: 'approved_fixture',
    merchantId: 'merch_fixture',
    appId: 'oxy',
    mode: 'live' as const,
    environment: 'production' as const,
    offerId: f.offers[0].id,
    offerVersion: 1,
  };
  const value = {
    invoice_id: 'in_fixture',
    line_id: 'il_fixture',
    payment_intent_id: 'pi_fixture',
    provider_subscription_id: context.subscriptionId,
    provider_customer_id: context.customerId,
    provider_price_id: context.priceId,
    store_id: f.payer,
    plan_id: context.planId,
    livemode: true,
    currency: 'USD',
    amount_paid: '2999',
    net_amount: '2500',
    tax_amount: '499',
    period_start: unix(f.period.start),
    period_end: unix(f.period.end),
    paid_at: unix(f.now),
    observed_at: unix(f.now),
  };
  const final = {
    platform: 'peable',
    currency: 'USD',
    gross_minor_units: '2999',
    net_minor_units: '2500',
    tax_minor_units: '499',
    merchant_fee_minor_units: '0',
    tax_treatment: 'inclusive',
    seller_id: 'synthetic-review-seller',
    invoice_issuer_id: 'synthetic-review-issuer',
    tax_quote_id: 'synthetic-review-tax',
    customer_location_evidence_id: 'synthetic-location',
    tax_rate_evidence_id: 'synthetic-rate',
    issued_at: unix(f.now.getTime() - 1000),
    expires_at: unix(f.now.getTime() + 60_000),
    context: {
      payer_account_id: f.payer,
      beneficiary_account_id: f.payer,
      provider_subscription_id: context.subscriptionId,
      offer_id: context.offerId,
      offer_version: 1,
      period_start: unix(f.period.start),
      period_end: unix(f.period.end),
      mode: 'live',
      environment: 'production',
    },
  };
  const subscription = {
    provider_subscription_id: context.subscriptionId,
    provider_customer_id: context.customerId,
    provider_price_id: context.priceId,
    store_id: f.payer,
    plan_id: context.planId,
    livemode: true,
    status: 'active',
    interval: 'month',
    cancel_at_period_end: true,
    current_period_start: unix(f.period.start),
    current_period_end: unix(f.period.end),
    trial_ends_at: null,
  };
  const read = jest.fn(async () => value);
  const current = jest.fn(async () => subscription);
  const client = {
    merchants: {
      retrieve: async () => ({
        id: context.merchantId,
        oxy_app_id: context.appId,
        environment: context.environment,
      }),
    },
    billing: { retrievePaidInvoice: read, retrieveSubscription: current },
  } as unknown as PeableEvidenceAuthority['client'];
  await expect(
    reconcilePeablePersonalPaidInvoice({ client }, context, 'in_fixture', () => f.now),
  ).rejects.toThrow('unconfigured');
  expect(read).not.toHaveBeenCalled();
  const authority = {
    client,
    readFinalInvoiceAuthority: async (
      source: import('../peablePersonalEvidence.service').PeableInvoiceSource,
    ) => ({ source, method: 'card' as const, invoice: final }),
  };
  const faircoinAuthority = {
    client,
    readFinalInvoiceAuthority: async (
      source: import('../peablePersonalEvidence.service').PeableInvoiceSource,
    ) => ({ source, method: 'faircoin' as const, invoice: final }),
  };
  await expect(
    reconcilePeablePersonalPaidInvoice(faircoinAuthority, context, 'in_fixture', () => f.now),
  ).rejects.toThrow('Faircoin quote');
  read.mockResolvedValue({ ...value, store_id: f.owner });
  await expect(
    reconcilePeablePersonalPaidInvoice(authority, context, 'in_fixture', () => f.now),
  ).rejects.toThrow('ownership');
  read.mockResolvedValue({ ...value, observed_at: unix(f.now.getTime() - 60_001) });
  await expect(
    reconcilePeablePersonalPaidInvoice(authority, context, 'in_fixture', () => f.now),
  ).rejects.toThrow('time');
  read.mockResolvedValue(value);
  for (const key of [
    'invoice_id',
    'payment_intent_id',
    'customer_id',
    'price_id',
    'merchant_id',
    'app_id',
    'environment',
  ] as const) {
    const wrong = {
      client,
      readFinalInvoiceAuthority: async (
        source: import('../peablePersonalEvidence.service').PeableInvoiceSource,
      ) => ({ source: { ...source, [key]: 'wrong' }, method: 'card' as const, invoice: final }),
    };
    await expect(
      reconcilePeablePersonalPaidInvoice(wrong, context, 'in_fixture', () => f.now),
    ).rejects.toThrow('source differs');
  }
  for (const changed of [{ merchantId: 'merch_other' }, { appId: 'other' }])
    await expect(
      reconcilePeablePersonalPaidInvoice(
        authority,
        { ...context, ...changed },
        'in_fixture',
        () => f.now,
      ),
    ).rejects.toThrow('credential owner');
  let moving = f.now.getTime();
  read.mockImplementation(async () => {
    await Promise.resolve();
    moving += 100;
    return { ...value, observed_at: unix(moving) };
  });
  current.mockImplementation(async () => {
    await Promise.resolve();
    moving += 100;
    return subscription;
  });
  current.mockImplementationOnce(async () => {
    moving += 60_001;
    return subscription;
  });
  await expect(
    reconcilePeablePersonalPaidInvoice(authority, context, 'in_fixture', () => new Date(moving)),
  ).rejects.toThrow('time');
  moving = f.now.getTime();
  const first = await reconcilePeablePersonalPaidInvoice(
    authority,
    context,
    'in_fixture',
    () => new Date(moving),
  );
  read.mockResolvedValue(value);
  const second = await reconcilePeablePersonalPaidInvoice(
    authority,
    context,
    'in_fixture',
    () => f.now,
  );
  expect(second.sourceId).toBe(first.sourceId);
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(3);
  const sources = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(eq(accessSubscriptionSources.payerAccountId, f.payer));
  expect(sources).toHaveLength(2);
  expect(sources.find((s) => s.id === first.sourceId)?.cancelAtPeriodEnd).toBe(true);
});
