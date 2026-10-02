import { randomUUID } from 'node:crypto';
import { productOfferSchema, productSubscriptionSourceSchema } from '@oxy.so/contracts';
import { isCheckViolation, isForeignKeyViolation } from '@oxy.so/db';
import { eq, and, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessProviderPeriods, accessProviderEvents, accessOfferSegments, accessSubscriptionSources, accessGrants } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { registerProductAccessConfiguration, readSubjectProductAccess, updateProductAccessSourceState } from '../productAccessPersistence.service';
import { recordProductProviderPeriod, type ProductProviderPeriodInput } from '../productProviderEvidence.service';

jest.setTimeout(60_000);
beforeAll(connectPostgres);
afterAll(closePostgres);

async function failSyntheticDeliveryInserts() {
  await getDb().execute(sql`CREATE FUNCTION i07_synthetic_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id LIKE 'evt_failure_%' THEN RAISE EXCEPTION 'synthetic event persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER i07_synthetic_delivery_failure BEFORE INSERT ON access_provider_events FOR EACH ROW EXECUTE FUNCTION i07_synthetic_delivery_failure();`);
}
async function restoreDeliveryInserts() {
  await getDb().execute(sql`DROP TRIGGER i07_synthetic_delivery_failure ON access_provider_events; DROP FUNCTION i07_synthetic_delivery_failure();`);
}
async function expectConstraint(operation: Promise<unknown>, predicate: (error: unknown) => boolean) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(predicate(caught)).toBe(true);
}

async function fixture() {
  const f = await productAccessFixture();
  const offer = productOfferSchema.parse({ schemaVersion: 1, id: randomUUID(), version: 1, kind: 'individual',
    benefits: [{ kind: 'quota', productId: f.products[0].id, key: 'tokens', unit: 'token', included: 10, combination: 'sum' }] });
  await registerProductAccessConfiguration({ products: [], offers: [offer] });
  const raw = f.input(offer);
  const subscription = productSubscriptionSourceSchema.omit({ id: true }).parse(
    Object.fromEntries(Object.entries(raw.source).filter(([key]) => key !== 'id')));
  const input: ProductProviderPeriodInput = { binding: f.providerBinding, subscription,
    offer: { offerId: offer.id, offerVersion: offer.version, origin: offer.kind },
    paidLine: { invoiceId: `in_${randomUUID()}`, lineId: `il_${randomUUID()}`, priceId: `price_${randomUUID()}`, quantity: 1, period: f.period },
    event: { id: `evt_${randomUUID()}`, createdAt: f.now.toISOString() }, providerObservedAt: f.now };
  return { ...f, input };
}

it('different events for the same provider invoice line recover one source/segment and additive quota', async () => {
  const f = await fixture();
  const first = await recordProductProviderPeriod(f.input);
  const second = await recordProductProviderPeriod({ ...f.input, event: { ...f.input.event, id: `evt_${randomUUID()}` } });
  expect(first.status).toBe('recorded'); expect(second.status).toBe('replayed');
  expect(second).toEqual({ ...first, status: 'replayed' });
  const access = await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now);
  expect(access.quotas[0].included).toBe(10);
  expect(access.quotas[0].grantIds).toHaveLength(1);
  expect(await getDb().select().from(accessProviderEvents).where(eq(accessProviderEvents.evidenceId, first.evidenceId))).toHaveLength(2);
});

it('concurrent replay of one event persists one delivery and returns stored grant IDs', async () => {
  const f = await fixture();
  const results = await Promise.all([recordProductProviderPeriod(f.input), recordProductProviderPeriod(f.input)]);
  expect(results.map(r => r.status).sort()).toEqual(['recorded', 'replayed']);
  expect(results.map(r => r.eventStatus).sort()).toEqual(['recorded', 'replayed']);
  expect(results[0].grantIds).toEqual(results[1].grantIds);
  for (const id of results[0].grantIds) expect(await getDb().select().from(accessGrants).where(eq(accessGrants.id, id))).toHaveLength(1);
  expect(await getDb().select().from(accessProviderEvents).where(eq(accessProviderEvents.evidenceId, results[0].evidenceId))).toHaveLength(1);
});

it('concurrent new event IDs for one paid line commit two deliveries and only one grant set', async () => {
  const f = await fixture();
  const results = await Promise.all([recordProductProviderPeriod(f.input), recordProductProviderPeriod({ ...f.input,
    event: { ...f.input.event, id: `evt_${randomUUID()}` } })]);
  expect(results.map(r => r.status).sort()).toEqual(['recorded', 'replayed']);
  expect(results.map(r => r.eventStatus)).toEqual(['recorded', 'recorded']);
  expect(results[0].grantIds).toEqual(results[1].grantIds);
  expect(await getDb().select().from(accessProviderEvents).where(eq(accessProviderEvents.evidenceId, results[0].evidenceId))).toHaveLength(2);
  const access = await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now);
  expect(access.quotas[0].included).toBe(10); expect(access.quotas[0].grantIds).toHaveLength(1);
});

it('same event on incompatible lines or parties rolls back every provisional source, period, segment and grant', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const variants = [{ ...f.input, paidLine: { ...f.input.paidLine, lineId: `il_${randomUUID()}` } },
    { ...f.input, subscription: { ...f.input.subscription, providerSubscriptionId: `sub_${randomUUID()}`,
      beneficiaryAccountId: f.payer, payerAccountId: f.beneficiary },
      paidLine: { ...f.input.paidLine, invoiceId: `in_${randomUUID()}` } }];
  for (const changed of variants) await expect(recordProductProviderPeriod(changed)).rejects.toThrow('provider evidence');
  expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(1);
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(1);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer))).toHaveLength(0);
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.sourceId, first.sourceId))).toHaveLength(1);
  expect(await getDb().select().from(accessOfferSegments).where(eq(accessOfferSegments.subscriptionId, first.sourceId))).toHaveLength(1);
  expect((await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now)).quotas[0].included).toBe(10);
});

it('paid line identity is independent of party, subscription, price, offer and period changes', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const variants = [
    { ...f.input, paidLine: { ...f.input.paidLine, priceId: `price_${randomUUID()}` } },
    { ...f.input, offer: { offerId: f.offers[1].id, offerVersion: 1, origin: 'individual' as const } },
    { ...f.input, subscription: { ...f.input.subscription, payerAccountId: f.beneficiary } },
    { ...f.input, subscription: { ...f.input.subscription, beneficiaryAccountId: f.payer } },
    { ...f.input, subscription: { ...f.input.subscription, providerSubscriptionId: `sub_${randomUUID()}` } },
    { ...f.input, event: { ...f.input.event, createdAt: new Date(f.now.getTime() + 1).toISOString() } },
    { ...f.input, paidLine: { ...f.input.paidLine, period: { ...f.period, start: new Date(Date.parse(f.period.start) + 1).toISOString() } } },
  ];
  for (const input of variants) await expect(recordProductProviderPeriod(input)).rejects.toThrow();
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.sourceId, first.sourceId))).toHaveLength(1);
  expect((await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now)).quotas[0].included).toBe(10);
});

it('strict input refuses caller IDs, raw payloads, unbound modes and ambiguous quantities', async () => {
  const f = await fixture();
  const variants = [Object.assign({}, f.input, { segmentId: randomUUID() }),
    Object.assign({}, f.input, { sourceId: randomUUID() }),
    Object.assign({}, f.input, { namespace: randomUUID() }),
    { ...f.input, event: Object.assign({}, f.input.event, { payload: { secret: 'must-not-persist' } }) },
    { ...f.input, subscription: Object.assign({}, f.input.subscription, { id: randomUUID() }) },
    { ...f.input, paidLine: Object.assign({}, f.input.paidLine, { quantity: 2 }) },
    { ...f.input, binding: Object.assign({}, f.input.binding, { mode: 'test' }) },
    { ...f.input, binding: Object.assign({}, f.input.binding, { environment: 'staging' }) },
  ];
  for (const input of variants) await expect(recordProductProviderPeriod(input)).rejects.toThrow();
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(0);
});

it('explicit different provider account bindings are distinct financial namespaces', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const second = await recordProductProviderPeriod({ ...f.input,
    binding: { ...f.input.binding, providerAccountRef: `synthetic-other-${randomUUID()}` } });
  expect(second.status).toBe('recorded'); expect(second.eventStatus).toBe('recorded');
  expect(second.sourceId).not.toBe(first.sourceId); expect(second.segmentId).not.toBe(first.segmentId);
  expect(second.evidenceId).not.toBe(first.evidenceId);
  expect((await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now)).quotas[0].included).toBe(20);
});

it('missing registered configuration commits neither source nor evidence', async () => {
  const f = await fixture();
  await expect(recordProductProviderPeriod({ ...f.input, offer: { ...f.input.offer, offerId: randomUUID() } })).rejects.toMatchObject({ code: 'PRODUCT_ACCESS_NOT_CONFIGURED' });
  expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(0);
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(0);
});

it('event insertion failure rolls back source, grants and evidence and permits a clean retry', async () => {
  const f = await fixture(); f.input.event.id = `evt_failure_${randomUUID()}`;
  await failSyntheticDeliveryInserts();
  try {
    await expect(recordProductProviderPeriod(f.input)).rejects.toThrow();
    expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(0);
    expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.providerAccountRef, f.providerBinding.providerAccountRef))).toHaveLength(0);
    expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.beneficiary))).toHaveLength(0);
  } finally { await restoreDeliveryInserts(); }
  expect((await recordProductProviderPeriod(f.input)).status).toBe('recorded');
});

it('renewal appends a distinct paid line while old deliveries retain their stored IDs', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const later = { start: f.period.end, end: new Date(Date.parse(f.period.end) + 86_400_000).toISOString() };
  const observed = new Date(f.now.getTime() + 1);
  await updateProductAccessSourceState({ sourceId: first.sourceId, productId: f.products[0].id,
    providerBinding: f.providerBinding, providerObservedAt: observed, status: 'active', period: later, cancelAtPeriodEnd: false });
  const renewal = await recordProductProviderPeriod({ ...f.input, subscription: { ...f.input.subscription, period: later },
    paidLine: { ...f.input.paidLine, invoiceId: `in_${randomUUID()}`, period: later },
    event: { ...f.input.event, id: `evt_${randomUUID()}` }, providerObservedAt: observed });
  expect(renewal.sourceId).toBe(first.sourceId); expect(renewal.segmentId).not.toBe(first.segmentId);
  const replay = await recordProductProviderPeriod(f.input);
  expect(replay).toEqual({ ...first, status: 'replayed', eventStatus: 'replayed' });
  const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, first.sourceId));
  expect(source.periodEnd.toISOString()).toBe(later.end);
  expect(source.providerObservedAt.getTime()).toBe(observed.getTime());
});

it('a committed named renewal transition survives failed award and exact retry recovers the new period', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const later = { start: f.period.end, end: new Date(Date.parse(f.period.end) + 86_400_000).toISOString() };
  const observed = new Date(f.now.getTime() + 1);
  await updateProductAccessSourceState({ sourceId: first.sourceId, productId: f.products[0].id,
    providerBinding: f.providerBinding, providerObservedAt: observed, status: 'active', period: later, cancelAtPeriodEnd: false });
  const renewal = { ...f.input, subscription: { ...f.input.subscription, period: later },
    paidLine: { ...f.input.paidLine, invoiceId: `in_${randomUUID()}`, period: later },
    event: { ...f.input.event, id: `evt_failure_${randomUUID()}` }, providerObservedAt: observed };
  await failSyntheticDeliveryInserts();
  try {
    await expect(recordProductProviderPeriod(renewal)).rejects.toThrow();
    const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, first.sourceId));
    expect(source.periodEnd.toISOString()).toBe(later.end);
    expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.sourceId, first.sourceId))).toHaveLength(1);
    expect(await getDb().select().from(accessOfferSegments).where(eq(accessOfferSegments.subscriptionId, first.sourceId))).toHaveLength(1);
  } finally { await restoreDeliveryInserts(); }
  expect((await recordProductProviderPeriod(renewal)).status).toBe('recorded');
  expect((await recordProductProviderPeriod(renewal)).status).toBe('replayed');
  expect((await recordProductProviderPeriod(f.input)).grantIds).toEqual(first.grantIds);
});

it('named cancellation preserves the other source and does not remove immutable delivery history', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const other = await recordProductProviderPeriod({ ...f.input,
    subscription: { ...f.input.subscription, providerSubscriptionId: `sub_${randomUUID()}` },
    paidLine: { ...f.input.paidLine, invoiceId: `in_${randomUUID()}` }, event: { ...f.input.event, id: `evt_${randomUUID()}` } });
  await updateProductAccessSourceState({ sourceId: first.sourceId, productId: f.products[0].id,
    providerBinding: f.providerBinding, providerObservedAt: new Date(f.now.getTime() + 1), status: 'canceled', period: f.period, cancelAtPeriodEnd: false });
  const access = await readSubjectProductAccess(f.beneficiary, f.products[0].id, f.now);
  expect(access.quotas[0].included).toBe(10); expect(access.quotas[0].grantIds).toEqual(other.grantIds);
  expect((await recordProductProviderPeriod(f.input)).grantIds).toEqual(first.grantIds);
});

it('database prevents rewriting/deleting either evidence record and rejects cross-source event binding', async () => {
  const f = await fixture(); const first = await recordProductProviderPeriod(f.input);
  const [period] = await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.id, first.evidenceId));
  const [event] = await getDb().select().from(accessProviderEvents).where(and(eq(accessProviderEvents.eventId, f.input.event.id), eq(accessProviderEvents.providerAccountRef, f.providerBinding.providerAccountRef)));
  await expectConstraint(getDb().update(accessProviderPeriods).set({ priceId: 'different' }).where(eq(accessProviderPeriods.id, period.id)), isCheckViolation);
  // A foreign-key restriction alone must not masquerade as the immutable guard.
  await expectConstraint(getDb().delete(accessProviderPeriods).where(eq(accessProviderPeriods.id, period.id)), isCheckViolation);
  await expectConstraint(getDb().update(accessProviderEvents).set({ payload: {} }).where(eq(accessProviderEvents.eventId, event.eventId)), isCheckViolation);
  await expectConstraint(getDb().delete(accessProviderEvents).where(eq(accessProviderEvents.eventId, event.eventId)), isCheckViolation);
  await expectConstraint(getDb().insert(accessProviderEvents).values({ ...event, eventId: `evt_${randomUUID()}`, sourceId: randomUUID() }), isForeignKeyViolation);
  await expectConstraint(getDb().insert(accessProviderPeriods).values({ ...period, id: randomUUID(), invoiceId: `in_${randomUUID()}`, payerAccountId: f.beneficiary }), isForeignKeyViolation);
});
