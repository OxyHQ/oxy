import * as providerEvidence from '../productProviderEvidence.service';
import { reconcileProductAccessFinancialState } from '../productAccessPersistence.service';
import { accessSubscriptionSources, accessProviderRefunds } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  reconcilePeablePersonalPaidInvoice,
  reconcilePeablePersonalInvoiceState,
  handlePeablePersonalObservation,
  type PeableEvidenceAuthority,
} from '../peablePersonalEvidence.service';
/** Peable instants are integer Unix seconds (ADR 0014). */
const unix = (instant: string | Date | number) => Math.floor(new Date(instant).getTime() / 1000);
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const f = await productAccessFixture();
  const context = {
    accountId: f.payer,
    appId: f.app.id,
    merchantId: 'merch_fixture',
    customerId: 'cus_fixture',
    subscriptionId: `sub_${f.payer}`,
    priceId: 'price_fixture',
    planId: 'synthetic-approved',
    offerId: f.offers[0].id,
    offerVersion: 1,
    mode: 'live' as const,
    environment: 'production' as const,
  };
  const invoiceId = `in_${f.payer.replaceAll('-', '')}`;
  // The ledger period Peable's whole-second instants restore.
  const period = {
    start: new Date(unix(f.period.start) * 1000).toISOString(),
    end: new Date(unix(f.period.end) * 1000).toISOString(),
  };
  const paid = {
    invoice_id: invoiceId,
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
  let release!: () => void;
  let captured!: () => void;
  const atAuthority = new Promise<void>((r) => (captured = r)),
    barrier = new Promise<void>((r) => (release = r));
  const client = {
    merchants: {
      retrieve: async () => ({
        id: context.merchantId,
        oxy_app_id: context.appId,
        environment: context.environment,
      }),
    },
    billing: {
      retrievePaidInvoice: async () => paid,
      retrieveInvoiceState: async () => ({
        ...paid,
        state: 'fully_refunded',
        charge_id: 'ch_fixture',
        amount_refunded: '2999',
      }),
      retrieveSubscription: async () => ({
        provider_subscription_id: context.subscriptionId,
        provider_customer_id: context.customerId,
        provider_price_id: context.priceId,
        store_id: f.payer,
        plan_id: context.planId,
        livemode: true,
        status: 'active',
        interval: 'month',
        cancel_at_period_end: false,
        current_period_start: unix(f.period.start),
        current_period_end: unix(f.period.end),
        trial_ends_at: null,
      }),
    },
  } as unknown as PeableEvidenceAuthority['client'];
  const authority: PeableEvidenceAuthority = {
    client,
    readFinalInvoiceAuthority: async (source) => {
      captured();
      await barrier;
      return {
        source,
        method: 'card' as const,
        invoice: {
          platform: 'peable',
          currency: 'USD',
          gross_minor_units: 2999,
          net_minor_units: 2500,
          tax_minor_units: 499,
          merchant_fee_minor_units: 0,
          tax_treatment: 'inclusive',
          seller_id: 'synthetic',
          invoice_issuer_id: 'synthetic',
          tax_quote_id: 'synthetic',
          customer_location_evidence_id: 'synthetic',
          tax_rate_evidence_id: 'synthetic',
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
            mode: context.mode,
            environment: context.environment,
          },
        },
      };
    },
  };
  return { f, period, context, paid, client, authority, release, atAuthority, invoiceId };
}
it('a completed refund before activation commits fences the still-fresh paid worker', async () => {
  const { f, context, client, authority, release, atAuthority, invoiceId } = await fixture();
  const activation = reconcilePeablePersonalPaidInvoice(
    authority,
    context,
    invoiceId,
    () => f.now,
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await atAuthority;
  const refund = await reconcilePeablePersonalInvoiceState(
    { client },
    context,
    invoiceId,
    () => f.now,
  );
  release();
  const result = await activation;
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(0);
  expect(refund.status).toBe('fenced');
  const [fence] = await getDb()
    .select()
    .from(accessProviderRefunds)
    .where(eq(accessProviderRefunds.payerAccountId, f.payer));
  expect(fence.invoiceId).toBe(invoiceId);
  await expect(
    getDb()
      .update(accessProviderRefunds)
      .set({ priceId: 'forged' })
      .where(eq(accessProviderRefunds.id, fence.id)),
  ).rejects.toThrow();
  expect(
    (await reconcilePeablePersonalInvoiceState({ client }, context, invoiceId, () => f.now)).status,
  ).toBe('replayed');
  expect(result).toMatchObject({ error: expect.any(Error) });
  expect(
    await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer)),
  ).toHaveLength(0);
});

it('an older subscription read cannot outrank cancellation after paid persistence awaits', async () => {
  const { f, period, context, client, authority, release, invoiceId } = await fixture();
  release();
  const first = await reconcilePeablePersonalPaidInvoice(
    authority,
    context,
    invoiceId,
    () => f.now,
  );
  let time = f.now.getTime();
  const originalRead = client.billing.retrieveSubscription;
  client.billing.retrieveSubscription = async (ref) => {
    const sub = await originalRead(ref);
    time = f.now.getTime() + 100;
    return sub;
  };
  let resume!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (resume = r)),
    atPersistence = new Promise<void>((r) => (arrived = r));
  const write = providerEvidence.recordProductProviderPeriod;
  const spy = jest
    .spyOn(providerEvidence, 'recordProductProviderPeriod')
    .mockImplementation(async (...args) => {
      const value = await write(...args);
      arrived();
      await gate;
      return value;
    });
  try {
    const old = reconcilePeablePersonalPaidInvoice(
      authority,
      context,
      invoiceId,
      () => new Date(time),
    );
    await atPersistence;
    await reconcileProductAccessFinancialState({
      sourceId: first.sourceId,
      beneficiaryAccountId: f.payer,
      payerAccountId: f.payer,
      provider: 'peable',
      providerSubscriptionId: context.subscriptionId,
      providerBinding: {
        providerAccountRef: context.merchantId,
        mode: context.mode,
        environment: context.environment,
      },
      providerObservedAt: new Date(f.now.getTime() + 200),
      status: 'active',
      period,
      cancelAtPeriodEnd: true,
    });
    time = f.now.getTime() + 300;
    resume();
    await old;
    const [source] = await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.id, first.sourceId));
    expect(source.cancelAtPeriodEnd).toBe(true);
    expect(source.providerObservedAt.getTime()).toBe(f.now.getTime() + 200);
  } finally {
    resume();
    spy.mockRestore();
  }
});

it('subscription wake observation time is captured before an awaited source lookup', async () => {
  const { f, period, context, client, authority, release, invoiceId } = await fixture();
  release();
  const first = await reconcilePeablePersonalPaidInvoice(
    authority,
    context,
    invoiceId,
    () => f.now,
  );
  let time = f.now.getTime();
  const read = client.billing.retrieveSubscription;
  client.billing.retrieveSubscription = async (ref) => {
    const value = await read(ref);
    time = f.now.getTime() + 100;
    return value;
  };
  const db = getDb(),
    select = db.select.bind(db);
  let resume!: () => void,
    arrived!: () => void,
    spent = false;
  const gate = new Promise<void>((r) => (resume = r)),
    atLookup = new Promise<void>((r) => (arrived = r));
  // Delay the real source query result, without replacing the writer or its locks.
  const spy = jest.spyOn(db, 'select').mockImplementation(((...args: any[]) => {
    const builder = (select as any)(...args);
    return new Proxy(builder, {
      get(target, key) {
        if (key !== 'from') {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (table: any) => {
          const query = target.from(table);
          if (table !== accessSubscriptionSources || spent) return query;
          return new Proxy(query, {
            get(q, k) {
              if (k !== 'where') {
                const value = Reflect.get(q, k);
                return typeof value === 'function' ? value.bind(q) : value;
              }
              return (...conditions: any[]) => {
                const filtered = q.where(...conditions);
                return new Proxy(filtered, {
                  get(result, p) {
                    if (p === 'then')
                      return (resolve: any, reject: any) =>
                        Promise.resolve(filtered)
                          .then(async (rows) => {
                            spent = true;
                            arrived();
                            await gate;
                            return rows;
                          })
                          .then(resolve, reject);
                    const value = Reflect.get(result, p);
                    return typeof value === 'function' ? value.bind(result) : value;
                  },
                });
              };
            },
          });
        };
      },
    });
  }) as any);
  try {
    const event = {
      id: 'evt_fixture',
      object: 'event',
      type: 'billing.observation.updated',
      created: unix(f.now),
      data: {
        object: {
          object: 'billing_observation',
          resource_kind: 'subscription',
          resource_id: context.subscriptionId,
          revision: 1,
          observed_at: unix(f.now),
        },
      },
    };
    const old = handlePeablePersonalObservation(
      authority,
      context,
      JSON.stringify(event),
      'synthetic',
      () => event,
      () => new Date(time),
    );
    await atLookup;
    await reconcileProductAccessFinancialState({
      sourceId: first.sourceId,
      beneficiaryAccountId: f.payer,
      payerAccountId: f.payer,
      provider: 'peable',
      providerSubscriptionId: context.subscriptionId,
      providerBinding: {
        providerAccountRef: context.merchantId,
        mode: context.mode,
        environment: context.environment,
      },
      providerObservedAt: new Date(f.now.getTime() + 200),
      status: 'active',
      period,
      cancelAtPeriodEnd: true,
    });
    time = f.now.getTime() + 300;
    resume();
    expect(await old).toEqual({ status: 'stale' });
    const [source] = await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.id, first.sourceId));
    expect(source.cancelAtPeriodEnd).toBe(true);
    expect(source.providerObservedAt.getTime()).toBe(f.now.getTime() + 200);
  } finally {
    resume();
    spy.mockRestore();
  }
});
