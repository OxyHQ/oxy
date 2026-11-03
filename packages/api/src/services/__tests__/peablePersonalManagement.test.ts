import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessSubscriptionSources, accessGrants } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { recordProductProviderPeriod } from '../productProviderEvidence.service';
import { cancelStoredPeablePersonalSource } from '../peablePersonalManagement.service';
import { EMPTY_PRODUCT_BILLING_CATALOGUE } from '../productBillingCatalogue.service';
import type { Peable } from '@peable.to/sdk';
beforeAll(connectPostgres);
afterAll(closePostgres);
it('wires exact personal source through trusted Peable owner/customer mapping, preserves rights and isolates another account', async () => {
  const f = await productAccessFixture();
  const raw = f.input();
  const { id: _id, ...subscription } = raw.source;
  const binding = {
    providerAccountRef: 'merch_fixture',
    mode: 'live' as const,
    environment: 'production' as const,
  };
  const paid = await recordProductProviderPeriod({
    binding,
    subscription: { ...subscription, provider: 'peable', beneficiaryAccountId: f.payer },
    offer: { offerId: f.offers[0].id, offerVersion: 1, origin: 'bundle' },
    paidLine: {
      invoiceId: `in_${randomUUID()}`,
      lineId: `il_${randomUUID()}`,
      priceId: 'price_fixture',
      quantity: 1,
      period: f.period,
    },
    event: { id: `event_${randomUUID()}`, createdAt: f.now.toISOString() },
    providerObservedAt: f.now,
  });
  const directory = await mkdtemp(join(tmpdir(), 'one-management-'));
  const path = join(directory, 'catalogue.json');
  const old = process.env.BILLING_PRODUCT_CATALOGUE_FILE;
  const cfg = {
    merchantId: 'merch_fixture',
    applicationId: f.app.id,
    namespace: { mode: 'live' as const, environment: 'production' as const },
    offers: [
      {
        offerId: f.offers[0].id,
        offerVersion: 1,
        planId: 'approved_fixture',
        providerPriceId: 'price_fixture',
      },
    ],
  };
  await writeFile(
    path,
    JSON.stringify({
      ...EMPTY_PRODUCT_BILLING_CATALOGUE,
      products: f.products,
      offers: f.offers,
      prices: [
        {
          provider: 'peable',
          providerAccountId: 'merch_fixture',
          priceId: 'price_fixture',
          mode: 'live',
          environment: 'production',
          offerId: f.offers[0].id,
          offerVersion: 1,
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: null,
          currency: 'usd',
          amountMinorUnits: 2999,
          offerKind: 'bundle',
          kind: 'oxy_one',
        },
      ],
    }),
  );
  process.env.BILLING_PRODUCT_CATALOGUE_FILE = path;
  let snapshot = {
    provider_subscription_id: subscription.providerSubscriptionId,
    provider_customer_id: 'cus_fixture',
    provider_price_id: 'price_fixture',
    store_id: f.payer,
    plan_id: 'approved_fixture',
    livemode: true,
    status: 'active' as const,
    interval: 'month' as const,
    cancel_at_period_end: false,
    current_period_start: Date.parse(f.period.start) / 1000,
    current_period_end: Date.parse(f.period.end) / 1000,
    trial_ends_at: null,
    cancel_at: null,
    cancelled_at: null,
  };
  const retrieve = jest.fn(async () => snapshot);
  const cancel = jest.fn(async () => {
    snapshot = { ...snapshot, cancel_at_period_end: true };
    return snapshot;
  });
  const merchant = jest.fn(async () => ({
    id: cfg.merchantId,
    oxy_app_id: cfg.applicationId,
    environment: 'production',
  }));
  const client = {
    billing: { retrieveSubscription: retrieve, cancelAtPeriodEnd: cancel },
    merchants: { retrieve: merchant },
  } as unknown as Peable;
  try {
    const count = (
      await getDb()
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.beneficiaryAccountId, f.payer))
    ).length;
    await expect(
      cancelStoredPeablePersonalSource(f.owner, paid.sourceId, 'action_001', {
        management: { configuration: cfg, client },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(merchant).not.toHaveBeenCalled();
    snapshot = { ...snapshot, store_id: f.owner };
    await expect(
      cancelStoredPeablePersonalSource(f.payer, paid.sourceId, 'action_001', {
        management: { configuration: cfg, client },
      }),
    ).rejects.toThrow('ownership');
    expect(cancel).not.toHaveBeenCalled();
    snapshot = { ...snapshot, store_id: f.payer };
    expect(
      await cancelStoredPeablePersonalSource(f.payer, paid.sourceId, 'action_001', {
        management: { configuration: cfg, client },
      }),
    ).toEqual({ sourceId: paid.sourceId, cancelAtPeriodEnd: true });
    expect(
      (
        await getDb()
          .select()
          .from(accessSubscriptionSources)
          .where(eq(accessSubscriptionSources.id, paid.sourceId))
      )[0].cancelAtPeriodEnd,
    ).toBe(true);
    expect(
      (
        await getDb()
          .select()
          .from(accessGrants)
          .where(eq(accessGrants.beneficiaryAccountId, f.payer))
      ).length,
    ).toBe(count);
  } finally {
    if (old === undefined) delete process.env.BILLING_PRODUCT_CATALOGUE_FILE;
    else process.env.BILLING_PRODUCT_CATALOGUE_FILE = old;
    await rm(directory, { recursive: true, force: true });
  }
});
