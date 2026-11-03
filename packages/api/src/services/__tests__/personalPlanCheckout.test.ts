import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants, personalPlanCheckoutIntents } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  productBillingCatalogueSchema,
} from '../productBillingCatalogue.service';
import {
  closePersonalPlanCheckoutFromProvider,
  startPersonalPlanCheckout,
  startProductPlanCheckout,
  resumePersonalPlanCheckout,
  type PersonalCheckoutSnapshot,
  personalCheckoutSnapshotFromIntent,
  type PersonalCheckoutProvider,
} from '../personalPlanCheckout.service';
import { recordProductProviderPeriod } from '../productProviderEvidence.service';
import { createPeablePersonalCheckoutProvider } from '../peablePersonalCheckout.service';
import { Peable, PeableInvalidRequestError } from '@peable.to/sdk';
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const f = await productAccessFixture();
  const catalogue = productBillingCatalogueSchema.parse({
    ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: f.products,
    offers: f.offers,
    personalPlans: [
      {
        offerId: f.offers[0].id,
        offerVersion: 1,
        displayName: 'Synthetic bundle',
        kind: 'oxy_one',
        audience: 'personal',
        benefitNames: ['Synthetic first', 'Synthetic second'],
      },
    ],
    prices: [
      {
        priceId: 'price_synthetic',
        provider: 'peable',
        providerAccountId: 'merch_synthetic',
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
  });
  const request = {
    expectedSubjectAccountId: f.payer,
    offerId: f.offers[0].id,
    offerVersion: 1,
    idempotencyKey: randomUUID(),
  };
  const create = jest.fn(async (input: { intentId: string }) => ({
    sessionId: `synthetic_${input.intentId}`,
    checkoutUrl: `https://checkout.invalid/${input.intentId}`,
  }));
  const provider: PersonalCheckoutProvider = { kind: 'synthetic', create };
  return { ...f, catalogue, request, provider, create };
}
it('keeps HTTP-equivalent provider absence and empty offers unconfigured; grants nothing', async () => {
  const f = await fixture();
  expect(await startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue })).toEqual({
    state: 'unconfigured',
    reason: 'provider_unconfigured',
  });
  expect(
    await startPersonalPlanCheckout(f.payer, f.request, {
      catalogue: EMPTY_PRODUCT_BILLING_CATALOGUE,
    }),
  ).toEqual({ state: 'unconfigured', reason: 'offer_unconfigured' });
  expect(f.create).not.toHaveBeenCalled();
  expect(
    await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer)),
  ).toHaveLength(0);
});
it('reserves and replays the SDK transport without granting from a hosted session', async () => {
  const test = await fixture();
  test.catalogue.prices[0].amountMinorUnits = 2999;
  const merchant = { id: 'merch_synthetic', oxy_app_id: 'app_fixture', environment: 'production' };
  const ensureCustomer = jest.fn(async () => ({ provider_customer_id: 'cus_fixture' }));
  const createCheckoutSession = jest.fn(async () => ({
    id: 'cs_fixture',
    url: 'https://checkout.example.invalid/fixture',
    expires_at: Date.parse('2099-01-01T00:00:00.000Z') / 1000,
  }));
  const retrieveCheckout = jest.fn(async () => ({
    id: 'cs_fixture',
    store_id: test.payer,
    plan_id: 'one_monthly',
    provider_customer_id: 'cus_fixture',
    provider_price_id: 'price_synthetic',
    status: 'open',
    subscription: null,
    initial_invoice_id: null,
  }));
  const client = {
    merchants: { retrieve: async () => merchant },
    billing: {
      retrieveCheckout,
      ensureCustomer,
      createCheckoutSession,
      createTaxQuote: async () => {
        const snapshot = authority(
          {
            intentId: 'fixture',
            idempotencyKey: 'fixture',
            subjectAccountId: test.payer,
            offerId: test.request.offerId,
            offerVersion: 1,
            priceId: 'price_synthetic',
            amountMinorUnits: 2999,
            currency: 'USD',
            providerAccountRef: merchant.id,
            mode: 'live',
            environment: 'production',
            interval: 'month',
            trial: 'none',
          },
          'quote_transport',
        );
        snapshot.taxQuote.source.plan_id = 'one_monthly';
        snapshot.taxQuote.quote.seller_id = 'seller_fixture';
        snapshot.taxQuote.quote.invoice_issuer_id = 'issuer_fixture';
        snapshot.taxQuote.quote.tax_remitter_id = 'remitter_fixture';
        snapshot.taxQuote.quote.customer_location_evidence_id = 'location_fixture';
        return snapshot.taxQuote;
      },
    },
  } as unknown as Pick<Peable, 'merchants' | 'billing'>;
  const provider = createPeablePersonalCheckoutProvider(
    client,
    {
      merchantId: merchant.id,
      applicationId: merchant.oxy_app_id,
      sellerId: 'seller_fixture',
      invoiceIssuerId: 'issuer_fixture',
      taxRemitterId: 'remitter_fixture',
      namespace: { mode: 'live', environment: 'production' },
      returnUrl: 'https://accounts.example.invalid/payments',
      offers: [
        {
          offerId: test.request.offerId,
          offerVersion: 1,
          priceId: 'price_synthetic',
          planId: 'one_monthly',
          amountMinorUnits: 2999,
          currency: 'USD',
          interval: 'month',
          trial: 'none',
        },
      ],
    },
    undefined,
    {
      resolveCustomerLocationEvidence: async () => ({
        customerLocationEvidenceId: 'location_fixture',
      }),
    },
  );
  const dependencies = { catalogue: test.catalogue, provider };
  const first = await startPersonalPlanCheckout(test.payer, test.request, dependencies);
  expect(first.state).toBe('pending');
  expect(await startPersonalPlanCheckout(test.payer, test.request, dependencies)).toEqual(first);
  expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  retrieveCheckout.mockRejectedValueOnce(
    new PeableInvalidRequestError('The billing state must be reconciled before this can proceed.', {
      statusCode: 409,
      code: 'reconciliation_required',
    }),
  );
  await expect(
    startPersonalPlanCheckout(test.payer, test.request, dependencies),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'PAYMENT_REVIEW_REQUIRED',
  });
  const held = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, test.payer));
  expect(held).toHaveLength(1);
  expect(held[0].state).toBe('pending');
  await expect(
    startPersonalPlanCheckout(
      test.payer,
      { ...test.request, idempotencyKey: randomUUID() },
      dependencies,
    ),
  ).rejects.toThrow('already pending');
  expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  expect(
    await getDb()
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.beneficiaryAccountId, test.payer)),
  ).toHaveLength(0);
});
it('selects exact server price, replays one intent and blocks changed payload/new duplicate', async () => {
  const f = await fixture();
  const deps = { catalogue: f.catalogue, provider: f.provider };
  const [first, second] = await Promise.all([
    startPersonalPlanCheckout(f.payer, f.request, deps),
    startPersonalPlanCheckout(f.payer, f.request, deps),
  ]);
  expect(first).toEqual(second);
  expect(first.state).toBe('pending');
  expect(f.create.mock.calls[0][0]).toMatchObject({
    amountMinorUnits: 2999,
    currency: 'usd',
    priceId: 'price_synthetic',
    subjectAccountId: f.payer,
  });
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(0);
  await expect(
    startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps),
  ).rejects.toThrow('already pending');
  const changed = structuredClone(f.catalogue);
  changed.prices[0].amountMinorUnits = 8;
  expect(
    await startPersonalPlanCheckout(f.payer, f.request, { ...deps, catalogue: changed }),
  ).toEqual(first);
  expect(
    await startPersonalPlanCheckout(f.payer, f.request, {
      ...deps,
      catalogue: EMPTY_PRODUCT_BILLING_CATALOGUE,
    }),
  ).toEqual(first);
  await expect(startPersonalPlanCheckout(f.owner, f.request, deps)).rejects.toMatchObject({
    statusCode: 403,
  });
});
it('fulfills only on exact normalized paid evidence, and replay preserves one grant set', async () => {
  const f = await fixture();
  const deps = { catalogue: f.catalogue, provider: f.provider };
  const checkout = await startPersonalPlanCheckout(f.payer, f.request, deps);
  if (checkout.state !== 'pending') throw new Error('Expected synthetic pending checkout');
  const raw = f.input();
  const { id: _id, ...subscription } = raw.source;
  const input = {
    checkoutIntentId: checkout.intentId,
    binding: { ...f.providerBinding, providerAccountRef: 'merch_synthetic' },
    subscription: {
      ...subscription,
      provider: 'peable' as const,
      beneficiaryAccountId: f.payer,
      payerAccountId: f.payer,
    },
    offer: { offerId: f.offers[0].id, offerVersion: 1, origin: 'bundle' as const },
    paidLine: {
      invoiceId: `in_${randomUUID()}`,
      lineId: `il_${randomUUID()}`,
      priceId: 'price_synthetic',
      quantity: 1 as const,
      period: f.period,
    },
    event: { id: `evt_${randomUUID()}`, createdAt: f.now.toISOString() },
    providerObservedAt: f.now,
  };
  await recordProductProviderPeriod(input);
  await recordProductProviderPeriod(input);
  const [fulfilledIntent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, checkout.intentId));
  expect(fulfilledIntent.initialInvoiceId).toBe(input.paidLine.invoiceId);
  await expect(
    recordProductProviderPeriod({
      ...input,
      paidLine: {
        ...input.paidLine,
        invoiceId: `in_${randomUUID()}`,
        lineId: `il_${randomUUID()}`,
      },
      event: { ...input.event, id: `evt_${randomUUID()}` },
    }),
  ).rejects.toThrow('checkout attribution differs');
  await expect(
    recordProductProviderPeriod({ ...input, checkoutIntentId: randomUUID() }),
  ).rejects.toThrow();
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({
    state: 'fulfilled',
    intentId: checkout.intentId,
  });
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(2);
  await expect(
    startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps),
  ).rejects.toThrow('already exists');
});
it('keeps an ambiguous/expired price unavailable and forbids extra client-controlled pricing', async () => {
  const f = await fixture();
  f.catalogue.prices[0].validUntil = '2026-01-02T00:00:00.000Z';
  expect(
    await startPersonalPlanCheckout(f.payer, f.request, {
      catalogue: f.catalogue,
      provider: f.provider,
    }),
  ).toEqual({ state: 'unconfigured', reason: 'price_unconfigured' });
  await expect(
    startPersonalPlanCheckout(f.payer, { ...f.request, amountMinorUnits: 1 } as typeof f.request, {
      catalogue: f.catalogue,
    }),
  ).rejects.toThrow();
});

it('releases only exact trusted terminal sessions and keeps the original retry closed', async () => {
  const f = await fixture();
  const deps = { catalogue: f.catalogue, provider: f.provider };
  const checkout = await startPersonalPlanCheckout(f.payer, f.request, deps);
  if (checkout.state !== 'pending') throw new Error('Expected pending');
  const observation = {
    intentId: checkout.intentId,
    subjectAccountId: f.payer,
    mode: 'live',
    environment: 'production',
    providerAccountRef: 'merch_synthetic',
    providerSessionId: `synthetic_${checkout.intentId}`,
    reason: 'expired' as const,
  };
  await expect(
    closePersonalPlanCheckoutFromProvider({ ...observation, providerSessionId: 'wrong' }),
  ).rejects.toThrow();
  await closePersonalPlanCheckoutFromProvider(observation);
  await closePersonalPlanCheckoutFromProvider(observation);
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({
    state: 'closed',
    intentId: checkout.intentId,
  });
  expect(
    (await startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps))
      .state,
  ).toBe('pending');
});

it('requires provider mapping to match approved display amount/currency and requests monthly with no trial', async () => {
  const f = await fixture();
  f.catalogue.prices[0].amountMinorUnits = 7;
  f.catalogue.personalPlans[0].price = {
    amountMinorUnits: 2999,
    currency: 'USD',
    interval: 'month',
    trial: 'none',
    taxTreatment: 'inclusive',
    merchantTotal: 'final',
  };
  const deps = { catalogue: f.catalogue, provider: f.provider };
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({
    state: 'unconfigured',
    reason: 'price_unconfigured',
  });
  expect(f.create).not.toHaveBeenCalled();
  f.catalogue.prices[0].amountMinorUnits = 2999;
  f.catalogue.prices[0].currency = 'eur';
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({
    state: 'unconfigured',
    reason: 'price_unconfigured',
  });
  expect(f.create).not.toHaveBeenCalled();
  f.catalogue.prices[0].currency = 'usd';
  expect((await startPersonalPlanCheckout(f.payer, f.request, deps)).state).toBe('pending');
  expect(f.create.mock.calls[0][0]).toMatchObject({
    amountMinorUnits: 2999,
    currency: 'usd',
    interval: 'month',
    trial: 'none',
  });
});

it('replays a reserved intent with its frozen typed price after the catalogue changes', async () => {
  const f = await fixture();
  const failing: PersonalCheckoutProvider = {
    kind: 'synthetic',
    create: jest.fn(async () => {
      throw new Error('provider unavailable');
    }),
  };
  await expect(
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider: failing }),
  ).rejects.toThrow('provider unavailable');
  const [reserved] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  expect(reserved).toMatchObject({
    state: 'reserved',
    priceId: 'price_synthetic',
    priceProvider: 'peable',
    priceKind: 'oxy_one',
    offerKind: 'bundle',
    currency: 'usd',
    amountMinorUnits: 2999,
    priceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    priceValidUntil: null,
  });
  const changed = structuredClone(f.catalogue);
  changed.prices[0].amountMinorUnits = 8;
  changed.prices[0].priceId = 'price_replaced';
  expect(
    (
      await startPersonalPlanCheckout(f.payer, f.request, {
        catalogue: changed,
        provider: f.provider,
      })
    ).state,
  ).toBe('pending');
  expect(f.create.mock.calls[0][0]).toMatchObject({
    intentId: reserved.id,
    amountMinorUnits: 2999,
    currency: 'usd',
    priceId: 'price_synthetic',
  });
});

it('binds a checkout to a registered bundle offer version at the database', async () => {
  const f = await fixture();
  const row = {
    id: randomUUID(),
    subjectAccountId: f.payer,
    mode: 'live',
    environment: 'production',
    idempotencyHash: randomUUID(),
    requestHash: randomUUID(),
    offerId: f.offers[0].id,
    offerVersion: 99,
    offerKind: 'bundle' as const,
    providerAccountRef: 'merch_synthetic',
    priceId: 'price_synthetic',
    priceProvider: 'peable' as const,
    priceKind: 'oxy_one' as const,
    currency: 'usd',
    amountMinorUnits: 2999,
    priceValidFrom: new Date(),
    state: 'reserved' as const,
  };
  await expect(getDb().insert(personalPlanCheckoutIntents).values(row)).rejects.toThrow();
  await expect(
    getDb()
      .insert(personalPlanCheckoutIntents)
      .values({
        ...row,
        offerVersion: 1,
        fulfilledSourceId: `access_source_${randomUUID()}`,
        state: 'fulfilled',
      }),
  ).rejects.toThrow();
});

function authority(
  input: Parameters<PersonalCheckoutProvider['create']>[0],
  id: string,
): PersonalCheckoutSnapshot {
  return {
    applicationId: 'app_fixture',
    returnUrl: 'https://example.invalid/return',
    merchantId: input.providerAccountRef,
    subjectAccountId: input.subjectAccountId,
    planId: 'plan_fixture',
    customerId: 'cus_fixture',
    offerId: input.offerId,
    offerVersion: input.offerVersion,
    priceId: input.priceId,
    mode: input.mode,
    environment: input.environment,
    taxQuote: {
      schema_version: 2,
      source: {
        merchant_id: input.providerAccountRef,
        app_id: 'app_fixture',
        store_id: input.subjectAccountId,
        plan_id: 'plan_fixture',
        mode: 'live',
        environment: 'production',
      },
      quote: {
        id,
        currency: input.currency,
        gross_minor_units: input.amountMinorUnits,
        net_minor_units: input.amountMinorUnits,
        tax_minor_units: 0,
        tax_treatment: 'inclusive',
        seller_id: 'synthetic',
        invoice_issuer_id: 'synthetic',
        tax_remitter_id: 'synthetic',
        tax_service_ref: 'synthetic',
        country: 'US',
        coverage_evidence_id: 'synthetic',
        tax_rate_evidence_id: 'synthetic',
        customer_location_evidence_id: 'synthetic',
        quoted_at: Date.parse('2026-01-01T00:00:00.000Z') / 1000,
        expires_at: Date.parse('2099-01-01T00:00:00.000Z') / 1000,
      },
      signature: { algorithm: 'Ed25519', key_id: 'synthetic', value: 'synthetic' },
    },
  };
}
it('freezes the winning prepared quote before concurrent dispatch and restart after lost response', async () => {
  const f = await fixture();
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparations = 0;
  const prepare = jest.fn(async (input: Parameters<PersonalCheckoutProvider['create']>[0]) => {
    const selected = authority(input, `quote_${++preparations}`);
    if (preparations === 2) release();
    await both;
    return selected;
  });
  const dispatched: string[] = [];
  const create = jest.fn(async (input: Parameters<PersonalCheckoutProvider['create']>[0]) => {
    const [stored] = await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.id, input.intentId));
    if (!stored.taxQuoteRef || !input.snapshot) throw new Error('Missing stored authority');
    expect(personalCheckoutSnapshotFromIntent(stored)?.taxQuote).toEqual(input.snapshot.taxQuote);
    dispatched.push(input.snapshot.taxQuote.quote.id);
    throw new Error('response lost');
  });
  const provider: PersonalCheckoutProvider = { kind: 'synthetic', prepare, create };
  const result = await Promise.allSettled([
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider }),
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider }),
  ]);
  expect(result.every((r) => r.status === 'rejected')).toBe(true);
  expect(preparations).toBe(2);
  expect(new Set(dispatched).size).toBe(1);
  const [stored] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  const replayCreate = jest.fn(async (input: Parameters<PersonalCheckoutProvider['create']>[0]) => {
    expect(input.idempotencyKey).toBe(`personal-checkout:${stored.id}`);
    if (!input.snapshot) throw new Error('Missing replay snapshot');
    expect(input.snapshot.taxQuote.quote.id).toBe(dispatched[0]);
    return {
      sessionId: 'cs_recovered',
      checkoutUrl: 'https://checkout.invalid/recovered',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  });
  expect(
    (
      await resumePersonalPlanCheckout(stored.id, {
        provider: { ...provider, create: replayCreate },
      })
    ).state,
  ).toBe('pending');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(
    await resumePersonalPlanCheckout(stored.id, {
      provider,
      now: new Date('2100-01-01T00:00:00.000Z'),
    }),
  ).toEqual({ state: 'pending', intentId: stored.id });
  const [expired] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, stored.id));
  expect(expired.state).toBe('pending');
});
it('does not recalculate or release a reserved quote that expired after a lost response', async () => {
  const f = await fixture();
  const prepare = jest.fn(async (input: Parameters<PersonalCheckoutProvider['create']>[0]) =>
    authority(input, 'frozen'),
  );
  const create = jest.fn(async () => {
    throw new Error('lost');
  });
  const provider: PersonalCheckoutProvider = { kind: 'synthetic', prepare, create };
  await expect(
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider }),
  ).rejects.toThrow('lost');
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  expect(
    await resumePersonalPlanCheckout(intent.id, {
      provider,
      now: new Date('2100-01-01T00:00:00.000Z'),
    }),
  ).toEqual({ state: 'pending', intentId: intent.id });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
});

it('rejects prepared authority for another subject without storing or dispatching it', async () => {
  const f = await fixture();
  const create = jest.fn(f.provider.create);
  const provider: PersonalCheckoutProvider = {
    kind: 'synthetic',
    create,
    prepare: async (input) => ({ ...authority(input, 'foreign'), subjectAccountId: f.owner }),
  };
  await expect(
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider }),
  ).rejects.toThrow('authority differs');
  expect(create).not.toHaveBeenCalled();
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  expect(intent.taxQuoteRef).toBeNull();
  expect(intent.state).toBe('reserved');
});

it('round-trips every typed signed quote field and exact Unix-second instants through PostgreSQL and official SDK verification', async () => {
  const f = await fixture();
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let prepared: PersonalCheckoutSnapshot | undefined;
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
  const provider: PersonalCheckoutProvider = {
    kind: 'synthetic',
    async prepare(input) {
      const snapshot = authority(input, 'signed_quote_roundtrip');
      snapshot.taxQuote.quote.currency = 'USD';
      snapshot.taxQuote.quote.quoted_at = Date.parse('2026-01-01T00:00:07Z') / 1000;
      snapshot.taxQuote.quote.expires_at = Date.parse('2099-01-01T00:00:59Z') / 1000;
      snapshot.taxQuote.signature.key_id = 'fixture';
      snapshot.taxQuote.signature.value = sign(
        null,
        Buffer.from(
          canonical({
            schema_version: snapshot.taxQuote.schema_version,
            source: snapshot.taxQuote.source,
            quote: snapshot.taxQuote.quote,
          }),
        ),
        keys.privateKey,
      ).toString('base64url');
      prepared = snapshot;
      return snapshot;
    },
    async create() {
      throw new Error('synthetic lost response');
    },
  };
  await expect(
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider }),
  ).rejects.toThrow('lost response');
  const [stored] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  const reconstructed = personalCheckoutSnapshotFromIntent(stored);
  expect(reconstructed).toEqual(prepared);
  // A signed instant is whole seconds: a sub-second stored value was never signed.
  expect(() =>
    personalCheckoutSnapshotFromIntent({
      ...stored,
      taxQuoteExpiresAt: new Date(Date.parse('2099-01-01T00:00:59.001Z')),
    }),
  ).toThrow('not a signed instant');
  await expect(
    getDb()
      .update(personalPlanCheckoutIntents)
      .set({ taxQuoteExpiresAt: stored.taxQuoteQuotedAt })
      .where(eq(personalPlanCheckoutIntents.id, stored.id)),
  ).rejects.toThrow();
  await expect(
    getDb()
      .update(personalPlanCheckoutIntents)
      .set({ taxQuoteNetMinorUnits: stored.amountMinorUnits + 1 })
      .where(eq(personalPlanCheckoutIntents.id, stored.id)),
  ).rejects.toThrow();
  await expect(
    getDb()
      .update(personalPlanCheckoutIntents)
      .set({ taxQuoteCountry: 'USA' })
      .where(eq(personalPlanCheckoutIntents.id, stored.id)),
  ).rejects.toThrow();

  expect(stored.taxQuoteQuotedAt).toBeInstanceOf(Date);
  expect(stored.taxQuoteExpiresAt).toBeInstanceOf(Date);
  const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(reconstructed?.taxQuote), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  try {
    const sdk = new Peable({
      baseURL: 'https://fixture.example.invalid',
      tokenProvider: { getToken: async () => 'synthetic', invalidate: () => {} },
      taxQuoteAuthorityKeys: { fixture: publicKey },
    });
    const params = {
      store_id: f.payer,
      plan_id: 'plan_fixture',
      customer_location_evidence_id: 'synthetic',
    };
    expect(await sdk.billing.createTaxQuote(params)).toEqual(prepared?.taxQuote);
    // A stored instant moved by one whole second no longer carries the signature.
    if (!stored.taxQuoteExpiresAt) throw new Error('Missing stored expiry');
    const shifted = personalCheckoutSnapshotFromIntent({
      ...stored,
      taxQuoteExpiresAt: new Date(stored.taxQuoteExpiresAt.getTime() + 1000),
    });
    transport.mockImplementation(
      async () =>
        new Response(JSON.stringify(shifted?.taxQuote), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(sdk.billing.createTaxQuote(params)).rejects.toThrow();
  } finally {
    transport.mockRestore();
  }
});

it('reserves only the explicitly published individual product and keeps its price and origin', async () => {
  const f = await fixture();
  const offer = f.offers[1];
  const productId = f.products[0].id;
  const price = {
    currency: 'USD' as const,
    amountMinorUnits: 1999,
    interval: 'month' as const,
    trial: 'none' as const,
    taxTreatment: 'inclusive' as const,
    merchantTotal: 'final' as const,
  };
  f.catalogue.productPlans = [
    { productId, offerId: offer.id, offerVersion: 1, displayName: 'Declared product', price },
  ];
  f.catalogue.prices = [
    {
      ...f.catalogue.prices[0],
      offerId: offer.id,
      offerKind: 'individual',
      kind: 'existing_product',
      amountMinorUnits: price.amountMinorUnits,
    },
  ];
  const request = { ...f.request, productId, offerId: offer.id };
  expect(
    await startProductPlanCheckout(
      f.payer,
      { ...request, productId: f.products[1].id },
      { catalogue: f.catalogue, provider: f.provider },
    ),
  ).toMatchObject({ state: 'unconfigured' });
  const [one, replay] = await Promise.all(
    [1, 2].map(() =>
      startProductPlanCheckout(f.payer, request, { catalogue: f.catalogue, provider: f.provider }),
    ),
  );
  expect(one).toEqual(replay);
  expect(one.state).toBe('pending');
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer));
  expect(intent).toMatchObject({
    offerKind: 'individual',
    priceKind: 'existing_product',
    amountMinorUnits: 1999,
  });
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(0);
  await expect(
    startPersonalPlanCheckout(
      f.payer,
      { ...f.request, offerId: offer.id },
      { catalogue: f.catalogue, provider: f.provider },
    ),
  ).rejects.toThrow('kind');
});

it('does not admit a different Oxy One price through the generic provider', async () => {
  const f = await fixture();
  f.catalogue.prices[0].amountMinorUnits = 3000;
  await expect(
    startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider: f.provider }),
  ).rejects.toThrow('personal bundle price');
  expect(f.create).not.toHaveBeenCalled();
});
