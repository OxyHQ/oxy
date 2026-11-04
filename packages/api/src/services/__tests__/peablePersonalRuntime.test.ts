import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  accessGrants,
  accessProviderRefunds,
  accessSubscriptionSources,
  personalPlanCheckoutIntents,
} from '../../db/schema';
import { logger } from '../../utils/logger';
import { nativePeable } from '../__fixtures__/nativePeable';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  productBillingCatalogueSchema,
} from '../productBillingCatalogue.service';
import {
  createPeablePersonalRuntime,
  getPeablePersonalRuntime,
  initializePeablePersonalRuntime,
  peablePersonalRuntimeConfigurationSchema,
  recoverPeablePersonalSources,
  startPeablePersonalRuntime,
  stopPeablePersonalRuntime,
} from '../peablePersonalRuntime.service';
import { startPersonalPlanCheckout } from '../personalPlanCheckout.service';
import { cancelStoredPeablePersonalSource } from '../peablePersonalManagement.service';

beforeAll(connectPostgres);
afterEach(stopPeablePersonalRuntime);
afterAll(closePostgres);

const SECRET = 'whsec_fixture';
const DAY = 86_400;
const unixNow = () => Math.floor(Date.now() / 1000);
let directories: string[] = [];
const previousCatalogue = process.env.BILLING_PRODUCT_CATALOGUE_FILE;
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories = [];
  if (previousCatalogue === undefined) delete process.env.BILLING_PRODUCT_CATALOGUE_FILE;
  else process.env.BILLING_PRODUCT_CATALOGUE_FILE = previousCatalogue;
});

async function fixture(options: { recoveryEnabled?: boolean } = {}) {
  const f = await productAccessFixture();
  const merchant = {
    id: `merch_${randomUUID().replaceAll('-', '_')}`,
    oxy_app_id: f.app.id,
    environment: 'production',
  };
  const peable = nativePeable({ merchant, livemode: true });
  const price = peable.price({ unitAmount: 2999, interval: 'month' });
  const offer = f.offers[0];
  const catalogue = productBillingCatalogueSchema.parse({
    ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: f.products,
    offers: f.offers,
    personalPlans: [
      {
        offerId: offer.id,
        offerVersion: 1,
        displayName: 'Synthetic bundle',
        kind: 'oxy_one',
        audience: 'personal',
        benefitNames: ['Synthetic first', 'Synthetic second'],
      },
    ],
    prices: [
      {
        priceId: price.id,
        provider: 'peable',
        providerAccountId: merchant.id,
        mode: 'live',
        environment: 'production',
        offerId: offer.id,
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
  const directory = await mkdtemp(join(tmpdir(), 'peable-native-runtime-'));
  directories.push(directory);
  const cataloguePath = join(directory, 'catalogue.json');
  await writeFile(cataloguePath, JSON.stringify(catalogue));
  process.env.BILLING_PRODUCT_CATALOGUE_FILE = cataloguePath;
  const configuration = peablePersonalRuntimeConfigurationSchema.parse({
    merchantId: merchant.id,
    applicationId: f.app.id,
    namespace: { mode: 'live', environment: 'production' },
    offers: [{ offerId: offer.id, offerVersion: 1, providerPriceId: price.id }],
    portalReturnUrl: 'https://accounts.oxy.so/payments',
    purchasesEnabled: true,
    checkout: { returnUrl: 'https://accounts.oxy.so/payments' },
    eventsEnabled: true,
    recoveryEnabled: options.recoveryEnabled ?? false,
    recoveryIntervalMilliseconds: 60_000,
  });
  const runtime = createPeablePersonalRuntime(peable.client, configuration, SECRET);
  const checkoutProvider = runtime.checkoutProvider;
  if (!checkoutProvider) throw new Error('checkout provider missing');
  const start = (key = randomUUID()) =>
    startPersonalPlanCheckout(
      f.payer,
      {
        expectedSubjectAccountId: f.payer,
        offerId: offer.id,
        offerVersion: 1,
        idempotencyKey: key,
      },
      { catalogue, provider: checkoutProvider },
    );
  const deliver = (type: string, object: object) =>
    runtime.receive(peable.event(type, object as Record<string, unknown>), `valid:${SECRET}`);
  const grants = async () =>
    getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer));
  const intent = async () =>
    (
      await getDb()
        .select()
        .from(personalPlanCheckoutIntents)
        .where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer))
    )[0];
  const period = { start: unixNow() - 60, end: unixNow() + 30 * DAY };
  return {
    f,
    merchant,
    peable,
    price,
    configuration,
    runtime,
    start,
    deliver,
    grants,
    intent,
    period,
    catalogue,
  };
}

/** Start a checkout and let the payer complete it in Orbit. */
async function paidCheckout(t: Awaited<ReturnType<typeof fixture>>) {
  const result = await t.start();
  expect(result.state).toBe('pending');
  const pending = await t.intent();
  if (!pending.providerSessionId) throw new Error('session missing');
  const paid = t.peable.complete(pending.providerSessionId, t.period);
  return { pending, ...paid };
}

it('fulfills a completed checkout once from authoritative reads and replays without new rights', async () => {
  const t = await fixture();
  const { pending, invoice } = await paidCheckout(t);
  expect(await t.grants()).toHaveLength(0);
  const session = t.peable.raw.sessions.get(pending.providerSessionId as string);
  expect((await t.deliver('checkout.session.completed', session as object)).status).toBe(
    'recorded',
  );
  const fulfilled = await t.intent();
  expect(fulfilled.state).toBe('fulfilled');
  expect(fulfilled.initialInvoiceId).toBe(invoice.id);
  const granted = await t.grants();
  expect(granted.length).toBeGreaterThan(0);
  // Every redelivery, and the invoice's own event, is a replay of the same period.
  expect((await t.deliver('checkout.session.completed', session as object)).status).toBe(
    'no_invoice',
  );
  expect((await t.deliver('invoice.paid', invoice)).status).toBe('replayed');
  expect(await t.grants()).toHaveLength(granted.length);
});

it('records a renewal invoice from its event against the persisted source', async () => {
  const t = await fixture();
  const { pending, subscription } = await paidCheckout(t);
  await t.runtime.recoverCheckout(pending.id);
  const renewal = t.peable.renew(subscription.id as string, {
    start: t.period.end,
    end: t.period.end + 30 * DAY,
    paidAt: unixNow(),
  });
  expect((await t.deliver('invoice.paid', renewal)).status).toBe('recorded');
  expect((await t.deliver('invoice.paid', renewal)).status).toBe('replayed');
});

it('refuses an invoice that does not charge the approved price and grants nothing', async () => {
  const t = await fixture();
  const { pending, invoice } = await paidCheckout(t);
  const stored = t.peable.raw.invoices.get(invoice.id as string);
  if (!stored) throw new Error('invoice missing');
  stored.amount_paid = '2998';
  stored.total = '2998';
  await expect(t.runtime.recoverCheckout(pending.id)).rejects.toThrow('approved offer');
  expect(await t.grants()).toHaveLength(0);
  expect((await t.intent()).state).toBe('pending');
});

it('revokes a fully refunded paid period and keeps a partial refund under review', async () => {
  const t = await fixture();
  const { pending, invoice } = await paidCheckout(t);
  await t.runtime.recoverCheckout(pending.id);
  expect((await t.grants()).length).toBeGreaterThan(0);
  const payment = t.peable.refund(invoice.id as string, '1000');
  await expect(
    t.deliver('charge.refunded', { id: 'ch_1', payment_intent: payment.id }),
  ).resolves.toMatchObject({ status: 'review_required' });
  t.peable.refund(invoice.id as string, '2999');
  expect(
    (await t.deliver('refund.updated', { id: 're_1', payment_intent: payment.id })).status,
  ).toMatch(/^(revoked|fenced)$/);
  const [fence] = await getDb()
    .select()
    .from(accessProviderRefunds)
    .where(eq(accessProviderRefunds.payerAccountId, t.f.payer));
  expect(fence.invoiceId).toBe(invoice.id);
});

it('does not fulfill a first invoice refunded before Oxy recorded it', async () => {
  const t = await fixture();
  const { pending, invoice } = await paidCheckout(t);
  t.peable.refund(invoice.id as string, '2999');
  await t.runtime.recoverCheckout(pending.id);
  expect(await t.grants()).toHaveLength(0);
});

it('closes only an exact expired session that started no subscription', async () => {
  const t = await fixture();
  await t.start();
  const pending = await t.intent();
  t.peable.expire(pending.providerSessionId as string);
  const session = t.peable.raw.sessions.get(pending.providerSessionId as string);
  expect((await t.deliver('checkout.session.expired', session as object)).status).toBe(
    'no_invoice',
  );
  const closed = await t.intent();
  expect(closed.state).toBe('closed');
  expect(closed.closedReason).toBe('expired');
});

it('keeps an open or unpaid checkout pending', async () => {
  const t = await fixture();
  await t.start();
  const pending = await t.intent();
  expect(await t.runtime.recoverCheckout(pending.id)).toEqual({ status: 'checkout_pending' });
  t.peable.complete(pending.providerSessionId as string, { ...t.period, paidAt: null });
  expect(await t.runtime.recoverCheckout(pending.id)).toEqual({ status: 'no_invoice' });
  expect(await t.grants()).toHaveLength(0);
  expect((await t.intent()).state).toBe('pending');
});

it('rejects a session that is not the intent’s before reading any invoice', async () => {
  const t = await fixture();
  await t.start();
  const pending = await t.intent();
  const session = t.peable.raw.sessions.get(pending.providerSessionId as string);
  if (!session) throw new Error('session missing');
  session.client_reference_id = 'another_intent';
  const invoices = jest.spyOn(t.peable.client.invoices, 'list');
  await expect(t.runtime.recoverCheckout(pending.id)).rejects.toThrow('binding differs');
  expect(invoices).not.toHaveBeenCalled();
});

it('adopts a session created before a crash instead of opening a second one', async () => {
  const t = await fixture();
  const create = jest.spyOn(t.peable.client.checkout.sessions, 'create');
  const lost = jest
    .spyOn(t.runtime.checkoutProvider as NonNullable<typeof t.runtime.checkoutProvider>, 'create')
    .mockImplementationOnce(async (input) => {
      await t.peable.client.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.snapshot?.customerId,
          line_items: [{ price: t.price.id, quantity: 1 }],
          client_reference_id: input.intentId,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      throw new Error('response lost');
    });
  await expect(t.start()).rejects.toThrow('response lost');
  expect(lost).toHaveBeenCalledTimes(1);
  const reserved = await t.intent();
  expect(reserved.providerSessionId).toBeNull();
  expect(await t.runtime.recoverCheckout(reserved.id)).toEqual({ status: 'checkout_pending' });
  const adopted = await t.intent();
  expect(adopted.providerSessionId).toMatch(/^cs_/);
  expect(adopted.checkoutUrl).toMatch(/^https:\/\//);
  expect(create).toHaveBeenCalledTimes(1);
});

it('reconciles a scheduled cancellation from the subscription and never grants from it', async () => {
  const t = await fixture();
  const { pending, subscription } = await paidCheckout(t);
  await t.runtime.recoverCheckout(pending.id);
  const before = (await t.grants()).length;
  t.peable.setSubscription(subscription.id as string, { cancel_at_period_end: true });
  expect((await t.deliver('customer.subscription.updated', { id: subscription.id })).status).toBe(
    'updated',
  );
  const [source] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(eq(accessSubscriptionSources.providerSubscriptionId, subscription.id as string));
  expect(source.cancelAtPeriodEnd).toBe(true);
  expect(await t.grants()).toHaveLength(before);
});

it('cancels and opens the portal for the named source through native objects only', async () => {
  const t = await fixture();
  const { pending, subscription } = await paidCheckout(t);
  await t.runtime.recoverCheckout(pending.id);
  const [source] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(eq(accessSubscriptionSources.providerSubscriptionId, subscription.id as string));
  const management = t.runtime.management;
  await expect(
    cancelStoredPeablePersonalSource(t.f.owner, source.id, 'action_0001', { management }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    await cancelStoredPeablePersonalSource(t.f.payer, source.id, 'action_0001', { management }),
  ).toEqual({ sourceId: source.id, cancelAtPeriodEnd: true });
  const { openPeablePersonalPortal } = await import('../peablePersonalManagement.service');
  const portal = await openPeablePersonalPortal(t.f.payer, source.id, { management });
  expect(portal.url).toMatch(/^https:\/\/checkout\.peable\.to\/portal\//);
  await expect(
    openPeablePersonalPortal(t.f.owner, source.id, { management }),
  ).rejects.toMatchObject({ statusCode: 404 });
});

it('refuses an unsigned delivery before any read and ignores events it does not act on', async () => {
  const t = await fixture();
  const retrieve = jest.spyOn(t.peable.client.invoices, 'retrieve');
  await expect(
    t.runtime.receive(t.peable.event('invoice.paid', { id: 'in_forged' }), 'valid:other'),
  ).rejects.toThrow('signature');
  expect(retrieve).not.toHaveBeenCalled();
  expect(await t.deliver('product.created', { id: 'prod_1' })).toEqual({ status: 'ignored' });
  expect(await t.deliver('checkout.session.completed', { id: 'cs_unknown' })).toEqual({
    status: 'ignored',
  });
});

it('refuses events while disabled and requires a secret to enable them', async () => {
  const t = await fixture();
  expect(() => createPeablePersonalRuntime(t.peable.client, t.configuration)).toThrow(
    'verification unconfigured',
  );
  const disabled = createPeablePersonalRuntime(
    t.peable.client,
    { ...t.configuration, eventsEnabled: false },
    SECRET,
  );
  await expect(
    disabled.receive(t.peable.event('invoice.paid', { id: 'in_1' }), `valid:${SECRET}`),
  ).rejects.toThrow('events disabled');
});

it('requires a checkout return URL before purchases can be enabled', () => {
  expect(() =>
    peablePersonalRuntimeConfigurationSchema.parse({
      merchantId: 'merch_fixture',
      applicationId: 'app',
      namespace: { mode: 'live', environment: 'production' },
      offers: [{ offerId: 'one', offerVersion: 1, providerPriceId: 'price_fixture' }],
      portalReturnUrl: 'https://accounts.oxy.so/payments',
      purchasesEnabled: true,
      eventsEnabled: false,
      recoveryEnabled: false,
      recoveryIntervalMilliseconds: 60_000,
    }),
  ).toThrow('return URL');
});

it('defers a failing source, continues the others and retries after the scan wraps', async () => {
  const t = await fixture({ recoveryEnabled: true });
  const directory = await mkdtemp(join(tmpdir(), 'one-recovery-'));
  directories.push(directory);
  const path = join(directory, 'runtime.json');
  await writeFile(path, JSON.stringify(t.configuration));
  const previous = { ...process.env };
  process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = 'true';
  process.env.OXY_ONE_PEABLE_RUNTIME_FILE = path;
  process.env.OXY_ONE_PEABLE_WEBHOOK_SECRET = SECRET;
  const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    await initializePeablePersonalRuntime({ client: t.peable.client });
    const runtime = getPeablePersonalRuntime();
    if (!runtime) throw new Error('runtime missing');
    await t.start();
    const pending = await t.intent();
    t.peable.complete(pending.providerSessionId as string, t.period);
    const first = await recoverPeablePersonalSources();
    expect(first.completed).toBeGreaterThan(0);
    expect((await t.intent()).state).toBe('fulfilled');
    jest.spyOn(t.peable.client.subscriptions, 'retrieve').mockRejectedValue(new Error('offline'));
    const second = await recoverPeablePersonalSources();
    expect(second.deferred).toBeGreaterThan(0);
    expect(warning).toHaveBeenCalledWith(
      'Peable personal source recovery deferred',
      expect.objectContaining({ sourceId: expect.any(String) }),
    );
  } finally {
    warning.mockRestore();
    process.env = previous;
  }
});

it('never fails the boot when Peable is unreachable: purchases stay off and the start retries', async () => {
  const t = await fixture({ recoveryEnabled: false });
  const directory = await mkdtemp(join(tmpdir(), 'one-start-'));
  directories.push(directory);
  const path = join(directory, 'runtime.json');
  await writeFile(path, JSON.stringify(t.configuration));
  const previous = { ...process.env };
  process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = 'true';
  process.env.OXY_ONE_PEABLE_RUNTIME_FILE = path;
  process.env.OXY_ONE_PEABLE_WEBHOOK_SECRET = SECRET;
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  const retrieve = jest
    .spyOn(t.peable.client.merchants, 'retrieve')
    .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
  try {
    await expect(
      startPeablePersonalRuntime({
        retryMilliseconds: 20,
        dependencies: { client: t.peable.client },
      }),
    ).resolves.toBeUndefined();
    expect(getPeablePersonalRuntime()).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Peable personal runtime failed to start; purchases unavailable, retrying',
      expect.objectContaining({ error: 'connect ECONNREFUSED', retryMilliseconds: 20 }),
    );
    const deadline = Date.now() + 5_000;
    while (!getPeablePersonalRuntime() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getPeablePersonalRuntime()?.checkoutProvider).toBeDefined();
    expect(retrieve).toHaveBeenCalledTimes(2);
  } finally {
    error.mockRestore();
    retrieve.mockRestore();
    process.env = previous;
  }
});

it('stops a pending start retry with the runtime', async () => {
  const previous = { ...process.env };
  process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = 'true';
  process.env.OXY_ONE_PEABLE_RUNTIME_FILE = '/nonexistent/runtime.json';
  process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'reviewed-billing';
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    await startPeablePersonalRuntime({ retryMilliseconds: 20 });
    expect(error).toHaveBeenCalledTimes(1);
    await stopPeablePersonalRuntime();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(error).toHaveBeenCalledTimes(1);
    expect(getPeablePersonalRuntime()).toBeUndefined();
  } finally {
    error.mockRestore();
    process.env = previous;
  }
});

it('keeps a production process without configuration closed and starts no recovery', async () => {
  const previous = { ...process.env };
  process.env.NODE_ENV = 'production';
  delete process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
  try {
    await initializePeablePersonalRuntime();
    expect(getPeablePersonalRuntime()).toBeUndefined();
    expect(await recoverPeablePersonalSources()).toEqual({
      scanned: 0,
      completed: 0,
      deferred: 0,
      batchDeferred: false,
    });
  } finally {
    process.env = previous;
  }
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
