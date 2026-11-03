import { personalCheckoutSnapshotColumns } from '../personalPlanCheckout.service';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Peable, type BillingTaxQuote } from '@peable.to/sdk';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { eq } from 'drizzle-orm';
import { personalPlanCheckoutIntents, accessGrants } from '../../db/schema';
import { logger } from '../../utils/logger';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { recordProductAccessPeriod } from '../productAccessPersistence.service';
import {
  createPeablePersonalEvidenceAuthority,
  reconcilePeablePersonalPaidInvoice,
} from '../peablePersonalEvidence.service';
import {
  createPeablePersonalRuntime,
  getPeablePersonalRuntime,
  initializePeablePersonalRuntime,
  peablePersonalRuntimeConfigurationSchema,
  recoverPeablePersonalSources,
  stopPeablePersonalRuntime,
} from '../peablePersonalRuntime.service';

/** Peable instants are integer Unix seconds (ADR 0014). */
const unix = (instant: string | Date | number) => Math.floor(new Date(instant).getTime() / 1000);
const source = {
  invoice_id: 'invoice_fixture',
  payment_intent_id: 'payment_fixture',
  customer_id: 'customer_fixture',
  subscription_id: 'subscription_fixture',
  price_id: 'price_fixture',
  plan_id: 'plan_fixture',
  merchant_id: 'merch_fixture',
  app_id: 'app_fixture',
  mode: 'test' as const,
  environment: 'development' as const,
};
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const configuration = {
  merchantId: source.merchant_id,
  applicationId: source.app_id,
  namespace: { mode: 'test' as const, environment: 'development' as const },
  offers: [
    { offerId: 'one', offerVersion: 1, planId: source.plan_id, providerPriceId: source.price_id },
  ],
  invoiceIssuer: { legalName: 'Oxy Platforms, Inc.' as const, id: 'issuer_fixture' },
  sellerId: 'seller_fixture',
  invoiceAuthorityKeys: { fixture: publicKey },
  taxQuoteAuthorityKeys: { fixture: publicKey },
  purchasesEnabled: false as const,
  observationsEnabled: false,
  recoveryEnabled: false,
  recoveryIntervalMilliseconds: 60_000,
};
const invoice = { seller_id: 'seller_fixture', invoice_issuer_id: 'issuer_fixture' };
function fixture() {
  const retrieveFinalInvoiceAuthority = jest.fn(async () => ({
    source,
    invoice,
    method: 'card' as const,
  }));
  const client = { billing: { retrieveFinalInvoiceAuthority } } as unknown as Peable;
  return { client, retrieveFinalInvoiceAuthority };
}
afterEach(stopPeablePersonalRuntime);
afterAll(closePostgres);
it('uses the new SDK invoice-authority API and verifies every frozen source binding', async () => {
  const test = fixture();
  const authority = createPeablePersonalEvidenceAuthority(test.client);
  if (!authority.readFinalInvoiceAuthority) throw new Error('Missing SDK authority');
  expect(await authority.readFinalInvoiceAuthority(source)).toEqual({
    source,
    invoice,
    method: 'card',
  });
  expect(test.retrieveFinalInvoiceAuthority).toHaveBeenCalledWith(
    source.subscription_id,
    source.invoice_id,
  );
  for (const field of Object.keys(source)) {
    await expect(
      authority.readFinalInvoiceAuthority({ ...source, [field]: 'other' }),
    ).rejects.toThrow('source differs');
  }
});
it.each(['review_required', 'not_recorded', 'unknown_status'])(
  'defers %s, continues other sources and retries after the scan wraps',
  async (status) => {
    await connectPostgres();
    const account = await productAccessFixture();
    const merchantId = `merch_${account.payer.replaceAll('-', '_')}`;
    const sourceIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const input = account.input();
      await recordProductAccessPeriod({
        ...input,
        source: { ...input.source, provider: 'peable', beneficiaryAccountId: account.payer },
        segment: { ...input.segment, beneficiaryAccountId: account.payer },
        providerBinding: { ...input.providerBinding, providerAccountRef: merchantId },
      });
      sourceIds.push(input.source.id);
    }
    sourceIds.sort();
    const directory = await mkdtemp(join(tmpdir(), 'one-recovery-deferred-'));
    const path = join(directory, 'runtime.json');
    const runtimeConfiguration = {
      ...configuration,
      merchantId,
      applicationId: account.app.id,
      namespace: { mode: 'live', environment: 'production' },
      recoveryEnabled: true,
    };
    await writeFile(path, JSON.stringify(runtimeConfiguration));
    const values = {
      OXY_ONE_PEABLE_RUNTIME_ENABLED: 'true',
      OXY_ONE_PEABLE_RUNTIME_FILE: path,
    };
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(values)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const client = {
        merchants: {
          retrieve: async () => ({
            id: merchantId,
            oxy_app_id: account.app.id,
            environment: 'production',
          }),
        },
      } as unknown as Peable;
      await initializePeablePersonalRuntime({ client });
      const runtime = getPeablePersonalRuntime();
      if (!runtime) throw new Error('Fixture runtime unavailable');
      const recover = jest
        .spyOn(runtime, 'recover')
        .mockResolvedValueOnce({ status } as Awaited<ReturnType<typeof runtime.recover>>)
        .mockResolvedValueOnce({
          status: 'replayed',
          sourceId: sourceIds[1],
          segmentId: 'fixture_segment',
        } as Awaited<ReturnType<typeof runtime.recover>>);
      expect(await recoverPeablePersonalSources()).toEqual({
        scanned: 2,
        completed: 1,
        deferred: 1,
        batchDeferred: false,
      });
      expect(recover.mock.calls.map((call) => call[0])).toEqual(sourceIds);
      expect(warning).toHaveBeenCalledWith('Peable personal source recovery deferred', {
        sourceId: sourceIds[0],
      });
      recover.mockResolvedValue({ status: 'no_invoice' });
      expect(await recoverPeablePersonalSources()).toEqual({
        scanned: 2,
        completed: 2,
        deferred: 0,
        batchDeferred: false,
      });
      expect(recover.mock.calls.map((call) => call[0])).toEqual([...sourceIds, ...sourceIds]);
    } finally {
      await stopPeablePersonalRuntime();
      warning.mockRestore();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
it('requires the configured approved issuer and seller in SDK evidence', async () => {
  const test = fixture();
  const runtime = createPeablePersonalRuntime(test.client, configuration);
  expect(await runtime.authority.readFinalInvoiceAuthority(source)).toMatchObject({ invoice });
  test.retrieveFinalInvoiceAuthority.mockResolvedValue({
    source,
    invoice: { ...invoice, invoice_issuer_id: 'other' },
    method: 'card',
  });
  await expect(runtime.authority.readFinalInvoiceAuthority(source)).rejects.toThrow();
  test.retrieveFinalInvoiceAuthority.mockResolvedValue({
    source,
    invoice: { ...invoice, seller_id: 'other' },
    method: 'card',
  });
  await expect(runtime.authority.readFinalInvoiceAuthority(source)).rejects.toThrow();
});
it('requires deployment-pinned Ed25519 keys and a secret before enabling observations', () => {
  const test = fixture();
  expect(() =>
    createPeablePersonalRuntime(test.client, { ...configuration, observationsEnabled: true }),
  ).toThrow('verification unconfigured');
  expect(() =>
    createPeablePersonalRuntime(test.client, {
      ...configuration,
      invoiceAuthorityKeys: { fixture: 'not a key' },
    }),
  ).toThrow();
  expect(
    peablePersonalRuntimeConfigurationSchema.safeParse({
      ...configuration,
      taxQuoteAuthorityKeys: {},
    }).success,
  ).toBe(false);
  expect(
    peablePersonalRuntimeConfigurationSchema.safeParse({ ...configuration, purchasesEnabled: true })
      .success,
  ).toBe(false);
});
it('refuses disabled observations before any SDK operation or DB lookup', async () => {
  const test = fixture();
  const runtime = createPeablePersonalRuntime(test.client, configuration);
  await expect(runtime.observe('untrusted-source', '{}', 'untrusted')).rejects.toThrow(
    'observations disabled',
  );
  await expect(runtime.recover('untrusted-source')).rejects.toThrow('recovery disabled');
  expect(test.retrieveFinalInvoiceAuthority).not.toHaveBeenCalled();
});
it('keeps a production process without configuration closed and starts no recovery', async () => {
  const previousNodeEnvironment = process.env.NODE_ENV,
    previousEnabled = process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
  process.env.NODE_ENV = 'production';
  delete process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
  try {
    await initializePeablePersonalRuntime();
    expect(getPeablePersonalRuntime()).toBeUndefined();
    await recoverPeablePersonalSources();
  } finally {
    process.env.NODE_ENV = previousNodeEnvironment;
    if (previousEnabled === undefined) delete process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
    else process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = previousEnabled;
  }
});

async function pendingCheckoutFixture(observationsEnabled = false) {
  await connectPostgres();
  const account = await productAccessFixture();
  const intentId = randomUUID();
  const periodStart = unix(account.period.start),
    periodEnd = unix(account.period.end);
  const quote: BillingTaxQuote = {
    schema_version: 2,
    source: {
      merchant_id: 'merch_fixture',
      app_id: account.app.id,
      store_id: account.payer,
      plan_id: 'plan_fixture',
      mode: 'live',
      environment: 'production',
    },
    quote: {
      id: `quote_${intentId}`,
      currency: 'USD',
      gross_minor_units: 2999,
      net_minor_units: 2500,
      tax_minor_units: 499,
      tax_treatment: 'inclusive',
      seller_id: 'seller_fixture',
      invoice_issuer_id: 'issuer_fixture',
      tax_remitter_id: 'remitter_fixture',
      tax_service_ref: 'tax_fixture',
      country: 'RO',
      coverage_evidence_id: 'coverage_fixture',
      tax_rate_evidence_id: 'rate_fixture',
      customer_location_evidence_id: 'location_fixture',
      quoted_at: periodStart,
      expires_at: periodEnd,
    },
    signature: { algorithm: 'Ed25519', key_id: 'fixture', value: 'fixture' },
  };
  await getDb()
    .insert(personalPlanCheckoutIntents)
    .values({
      id: intentId,
      subjectAccountId: account.payer,
      mode: 'live',
      environment: 'production',
      idempotencyHash: randomUUID(),
      requestHash: randomUUID(),
      offerId: account.offers[0].id,
      offerVersion: 1,
      offerKind: 'bundle',
      providerAccountRef: 'merch_fixture',
      priceId: 'price_fixture',
      priceProvider: 'peable',
      priceKind: 'oxy_one',
      currency: 'usd',
      amountMinorUnits: 2999,
      priceValidFrom: new Date(account.period.start),
      state: 'pending',
      providerSessionId: `cs_${intentId}`,
      providerSessionExpiresAt: new Date(account.period.end),
      checkoutUrl: 'https://checkout.example.invalid/fixture',
      applicationRef: account.app.id,
      customerRef: 'customer_fixture',
      planRef: 'plan_fixture',
      ...personalCheckoutSnapshotColumns({
        applicationId: account.app.id,
        merchantId: 'merch_fixture',
        subjectAccountId: account.payer,
        planId: 'plan_fixture',
        customerId: 'customer_fixture',
        offerId: account.offers[0].id,
        offerVersion: 1,
        priceId: 'price_fixture',
        mode: 'live',
        environment: 'production',
        taxQuote: quote,
        returnUrl: 'https://example.invalid/return',
      }),
    });
  const subscription = {
    provider_subscription_id: `sub_${intentId}`,
    latest_invoice_id: `in_${intentId}`,
    provider_customer_id: 'customer_fixture',
    provider_price_id: 'price_fixture',
    store_id: account.payer,
    plan_id: 'plan_fixture',
    livemode: true,
    status: 'active',
    interval: 'month',
    cancel_at_period_end: false,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    trial_ends_at: null,
    cancel_at: null,
    cancelled_at: null,
  };
  const session = {
    id: `cs_${intentId}`,
    initial_invoice_id: subscription.latest_invoice_id,
    status: 'complete',
    store_id: account.payer,
    plan_id: 'plan_fixture',
    provider_customer_id: 'customer_fixture',
    provider_price_id: 'price_fixture',
    subscription,
  };
  const paid = {
    invoice_id: subscription.latest_invoice_id,
    line_id: `line_${intentId}`,
    payment_intent_id: `pi_${intentId}`,
    provider_subscription_id: subscription.provider_subscription_id,
    provider_customer_id: 'customer_fixture',
    provider_price_id: 'price_fixture',
    store_id: account.payer,
    plan_id: 'plan_fixture',
    livemode: true,
    currency: 'USD',
    amount_paid: '2999',
    net_amount: '2500',
    tax_amount: '499',
    period_start: periodStart,
    period_end: periodEnd,
    paid_at: unix(account.now),
    observed_at: unix(account.now),
  };
  const final = {
    platform: 'peable',
    currency: 'USD',
    gross_minor_units: 2999,
    net_minor_units: 2500,
    tax_minor_units: 499,
    merchant_fee_minor_units: 0,
    tax_treatment: 'inclusive',
    seller_id: 'seller_fixture',
    invoice_issuer_id: 'issuer_fixture',
    tax_quote_id: quote.quote.id,
    customer_location_evidence_id: 'location_fixture',
    tax_rate_evidence_id: 'rate_fixture',
    issued_at: periodStart,
    expires_at: periodEnd,
    context: {
      payer_account_id: account.payer,
      beneficiary_account_id: account.payer,
      provider_subscription_id: subscription.provider_subscription_id,
      offer_id: account.offers[0].id,
      offer_version: 1,
      period_start: periodStart,
      period_end: periodEnd,
      mode: 'live',
      environment: 'production',
    },
  };
  const retrieveCheckout = jest.fn(async () => session);
  const retrievePaidInvoice = jest.fn(async () => paid);
  const retrieveInvoiceState = jest.fn(async () => ({
    ...paid,
    charge_id: `ch_${intentId}`,
    amount_refunded: '0',
    state: 'paid',
  }));
  const retrieveFinalInvoiceAuthority = jest.fn(async () => ({
    source: {
      invoice_id: paid.invoice_id,
      payment_intent_id: paid.payment_intent_id,
      customer_id: paid.provider_customer_id,
      subscription_id: paid.provider_subscription_id,
      price_id: paid.provider_price_id,
      plan_id: paid.plan_id,
      merchant_id: 'merch_fixture',
      app_id: account.app.id,
      mode: 'live',
      environment: 'production',
    },
    invoice: final,
    method: 'card',
  }));
  const retrieveMerchant = jest.fn(async () => ({
    id: 'merch_fixture',
    oxy_app_id: account.app.id,
    environment: 'production',
  }));
  const client = {
    webhooks: {
      constructEvent: () => ({
        id: `evt_${intentId}`,
        object: 'event',
        type: 'billing.observation.updated',
        livemode: true,
        created: Math.floor(account.now.getTime() / 1000),
        data: {
          object: {
            object: 'billing_observation',
            livemode: true,
            resource_kind: 'invoice',
            resource_id: paid.invoice_id,
            subscription_id: subscription.provider_subscription_id,
            revision: 1,
            observed_at: Math.floor(account.now.getTime() / 1000),
          },
        },
      }),
    },
    merchants: { retrieve: retrieveMerchant },
    billing: {
      retrieveCheckout,
      retrievePaidInvoice,
      retrieveInvoiceState,
      retrieveFinalInvoiceAuthority,
      retrieveSubscription: async () => subscription,
    },
  } as unknown as Peable;
  const runtime = createPeablePersonalRuntime(
    client,
    {
      ...configuration,
      applicationId: account.app.id,
      namespace: { mode: 'live', environment: 'production' },
      recoveryEnabled: true,
      observationsEnabled,
      offers: [
        {
          offerId: account.offers[0].id,
          offerVersion: 1,
          planId: 'plan_fixture',
          providerPriceId: 'price_fixture',
        },
      ],
    },
    observationsEnabled ? 'fixture_observation_secret' : undefined,
    { clock: () => account.now },
  );
  return {
    account,
    retrieveMerchant,
    intentId,
    session,
    paid,
    final,
    runtime,
    retrieveCheckout,
    retrieveInvoiceState,
    retrievePaidInvoice,
    retrieveFinalInvoiceAuthority,
  };
}
it('fulfills an owned initial invoice once and preserves its checkout attribution on replay', async () => {
  const test = await pendingCheckoutFixture();
  expect(await test.runtime.recoverCheckout(test.intentId)).toMatchObject({ status: 'recorded' });
  expect(await test.runtime.recoverCheckout(test.intentId)).toEqual({ status: 'no_invoice' });
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('fulfilled');
  expect(intent.initialInvoiceId).toBe(test.paid.invoice_id);
  expect(test.retrievePaidInvoice).toHaveBeenCalledTimes(1);
  if (!intent.fulfilledSourceId) throw new Error('Missing fulfilled source');
  expect(
    await reconcilePeablePersonalPaidInvoice(
      test.runtime.authority,
      {
        accountId: test.account.payer,
        customerId: test.paid.provider_customer_id,
        subscriptionId: test.paid.provider_subscription_id,
        priceId: test.paid.provider_price_id,
        planId: test.paid.plan_id,
        merchantId: 'merch_fixture',
        appId: test.account.app.id,
        mode: 'live',
        environment: 'production',
        offerId: test.account.offers[0].id,
        offerVersion: 1,
      },
      test.paid.invoice_id,
      () => test.account.now,
    ),
  ).toMatchObject({ status: 'replayed' });
});
it.each(['open', 'complete'])(
  'keeps %s without paid invoice pending and grants no rights',
  async (status) => {
    const test = await pendingCheckoutFixture();
    test.retrieveCheckout.mockResolvedValue({
      ...test.session,
      status,
      subscription: null,
    } as unknown as typeof test.session);
    expect(await test.runtime.recoverCheckout(test.intentId)).toEqual({
      status: 'checkout_pending',
    });
    expect(test.retrieveInvoiceState).not.toHaveBeenCalled();
    expect(
      await getDb()
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.beneficiaryAccountId, test.account.payer)),
    ).toHaveLength(0);
  },
);
it('rejects a foreign session before reading any invoice', async () => {
  const test = await pendingCheckoutFixture();
  test.retrieveCheckout.mockResolvedValue({ ...test.session, store_id: test.account.owner });
  await expect(test.runtime.recoverCheckout(test.intentId)).rejects.toThrow('binding differs');
  expect(test.retrieveInvoiceState).not.toHaveBeenCalled();
});
it('defers a discovered renewal carrying a different quote and grants no rights', async () => {
  const test = await pendingCheckoutFixture();
  test.final.tax_quote_id = 'renewal_quote';
  await expect(test.runtime.recoverCheckout(test.intentId)).rejects.toThrow();
  expect(
    await getDb()
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.beneficiaryAccountId, test.account.payer)),
  ).toHaveLength(0);
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('pending');
});
it('closes only an exact authoritative expired session without a subscription', async () => {
  const test = await pendingCheckoutFixture();
  test.retrieveCheckout.mockResolvedValue({
    ...test.session,
    status: 'expired',
    subscription: null,
  } as unknown as typeof test.session);
  expect(await test.runtime.recoverCheckout(test.intentId)).toEqual({ status: 'no_invoice' });
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('closed');
  expect(intent.closedReason).toBe('expired');
});

it.each([false, true])(
  'uses packed SDK signed authority and refuses tampering=%s before fulfillment',
  async (hasTampering) => {
    const test = await pendingCheckoutFixture();
    const authorityValue = { schema_version: 2, ...(await test.retrieveFinalInvoiceAuthority()) };
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
    const signed = {
      ...authorityValue,
      signature: {
        algorithm: 'Ed25519',
        key_id: 'fixture',
        value: sign(null, Buffer.from(canonical(authorityValue)), keys.privateKey).toString(
          'base64url',
        ),
      },
    };
    if (hasTampering) signed.invoice.tax_quote_id = 'tampered_quote';
    const calls: string[] = [];
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const path = new URL(String(request)).pathname;
      calls.push(path);
      let response: unknown;
      if (path === '/v1/merchants/me')
        response = {
          id: 'merch_fixture',
          oxy_app_id: test.account.app.id,
          environment: 'production',
        };
      else if (path.includes('/checkout_sessions/')) response = test.session;
      else if (path.includes('/invoice_states/')) response = await test.retrieveInvoiceState();
      else if (path.includes('/paid_invoices/')) response = test.paid;
      else if (path.includes('/invoice_authorities/')) response = signed;
      else if (path.includes('/subscriptions/')) response = test.session.subscription;
      else throw new Error(`Unexpected fixture request ${path}`);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const client = new Peable({
        baseURL: 'https://fixture.example.invalid',
        tokenProvider: { getToken: async () => 'synthetic-fixture', invalidate: () => {} },
        invoiceAuthorityKeys: { fixture: publicKey },
        taxQuoteAuthorityKeys: { fixture: publicKey },
      });
      const runtime = createPeablePersonalRuntime(
        client,
        {
          ...configuration,
          applicationId: test.account.app.id,
          namespace: { mode: 'live', environment: 'production' },
          recoveryEnabled: true,
          offers: [
            {
              offerId: test.account.offers[0].id,
              offerVersion: 1,
              planId: 'plan_fixture',
              providerPriceId: 'price_fixture',
            },
          ],
        },
        undefined,
        { clock: () => test.account.now },
      );
      if (hasTampering) await expect(runtime.recoverCheckout(test.intentId)).rejects.toThrow();
      else
        expect(await runtime.recoverCheckout(test.intentId)).toMatchObject({ status: 'recorded' });
      expect(calls.some((path) => path.includes('/invoice_authorities/'))).toBe(true);
      expect(calls.every((path) => path.startsWith('/v1/'))).toBe(true);
      const [intent] = await getDb()
        .select()
        .from(personalPlanCheckoutIntents)
        .where(eq(personalPlanCheckoutIntents.id, test.intentId));
      expect(intent.initialInvoiceId).toBe(hasTampering ? null : test.paid.invoice_id);
    } finally {
      transport.mockRestore();
    }
  },
);

it('keeps a partially refunded initial invoice under review without creating rights', async () => {
  const test = await pendingCheckoutFixture();
  test.retrieveInvoiceState.mockResolvedValue({
    ...(await test.retrieveInvoiceState()),
    amount_refunded: '1',
    state: 'partially_refunded',
  });
  expect(await test.runtime.recoverCheckout(test.intentId)).toEqual({
    status: 'review_required',
    reason: 'partial_refund_entitlement_policy_unconfigured',
  });
  expect(test.retrieveFinalInvoiceAuthority).not.toHaveBeenCalled();
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('pending');
});
it('does not fulfill a fully refunded first invoice', async () => {
  const test = await pendingCheckoutFixture();
  test.retrieveInvoiceState.mockResolvedValue({
    ...(await test.retrieveInvoiceState()),
    amount_refunded: '2999',
    state: 'fully_refunded',
  });
  await test.runtime.recoverCheckout(test.intentId);
  expect(test.retrieveFinalInvoiceAuthority).not.toHaveBeenCalled();
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('pending');
});
it('retains reservations without dispatch when ordinary runtime has no checkout provider', async () => {
  const test = await pendingCheckoutFixture();
  await getDb()
    .update(personalPlanCheckoutIntents)
    .set({
      state: 'reserved',
      providerSessionId: null,
      providerSessionExpiresAt: null,
      checkoutUrl: null,
    })
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(test.runtime.checkoutProvider).toBeUndefined();
  expect(await test.runtime.recoverCheckout(test.intentId)).toEqual({ status: 'checkout_pending' });
  expect(test.retrieveCheckout).not.toHaveBeenCalled();
});

it('rejects wrong SDK credential owner before owned checkout reads', async () => {
  const test = await pendingCheckoutFixture();
  test.retrieveMerchant.mockResolvedValue({
    id: 'foreign',
    oxy_app_id: test.account.app.id,
    environment: 'production',
  });
  await expect(test.runtime.recoverCheckout(test.intentId)).rejects.toThrow('credential owner');
  expect(test.retrieveCheckout).not.toHaveBeenCalled();
});

it('recovers the immutable initial invoice after a newer renewal becomes latest', async () => {
  const test = await pendingCheckoutFixture();
  test.session.subscription.latest_invoice_id = 'in_later_renewal';
  expect(await test.runtime.recoverCheckout(test.intentId)).toMatchObject({ status: 'recorded' });
  expect(test.retrievePaidInvoice).toHaveBeenCalledWith(
    test.paid.provider_subscription_id,
    test.paid.invoice_id,
  );
});

it('does not construct billing authority while disabled, even with stale configuration', async () => {
  const previous = { ...process.env };
  try {
    process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = 'false';
    process.env.OXY_ONE_PEABLE_PUBLIC_KEY = 'retired';
    delete process.env.OXY_PEABLE_BILLING_AWS_PROFILE;
    await expect(initializePeablePersonalRuntime()).resolves.toBeUndefined();
    expect(getPeablePersonalRuntime()).toBeUndefined();
  } finally {
    process.env = previous;
  }
});
it('requires a dedicated profile before reading configuration or resolving ambient credentials', async () => {
  const previous = { ...process.env };
  try {
    process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = 'true';
    process.env.OXY_ONE_PEABLE_RUNTIME_FILE = '/nonexistent/billing-config.json';
    delete process.env.OXY_PEABLE_BILLING_AWS_PROFILE;
    delete process.env.OXY_ONE_PEABLE_PUBLIC_KEY;
    delete process.env.OXY_ONE_PEABLE_SECRET;
    await expect(initializePeablePersonalRuntime()).rejects.toThrow(
      'OXY_PEABLE_BILLING_AWS_PROFILE',
    );
    expect(getPeablePersonalRuntime()).toBeUndefined();
  } finally {
    process.env = previous;
  }
});

it('routes a merchant observation through its owned checkout and requires current catalogue authority on replay', async () => {
  const test = await pendingCheckoutFixture(true);
  await test.runtime.observeMerchant('{}', 'verified');
  await expect(test.runtime.observeMerchant('{}', 'verified')).rejects.toThrow(
    'price authority unavailable',
  );
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.id, test.intentId));
  expect(intent.state).toBe('fulfilled');
  expect(intent.initialInvoiceId).toBe(test.paid.invoice_id);
  expect(test.retrieveFinalInvoiceAuthority).toHaveBeenCalled();
});
