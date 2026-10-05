import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants, personalPlanCheckoutIntents } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { EMPTY_PRODUCT_BILLING_CATALOGUE, productBillingCatalogueSchema } from '../productBillingCatalogue.service';
import { closePersonalPlanCheckoutFromProvider, startPersonalPlanCheckout, type PersonalCheckoutProvider } from '../personalPlanCheckout.service';
import { recordProductProviderPeriod } from '../productProviderEvidence.service';
beforeAll(connectPostgres); afterAll(closePostgres);
async function fixture() {
  const f = await productAccessFixture();
  const catalogue = productBillingCatalogueSchema.parse({ ...EMPTY_PRODUCT_BILLING_CATALOGUE, products: f.products, offers: f.offers,
    personalPlans: [{ offerId: f.offers[0].id, offerVersion: 1, displayName: 'Synthetic bundle', kind: 'oxy_one', audience: 'personal', benefitNames: ['Synthetic first', 'Synthetic second'] }],
    prices: [{ priceId: 'price_synthetic', provider: 'peable', providerAccountId: 'merch_synthetic', mode: 'live', environment: 'production',
      offerId: f.offers[0].id, offerVersion: 1, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
      currency: 'usd', amountMinorUnits: 7, offerKind: 'bundle', kind: 'oxy_one' }],
  });
  const request = { expectedSubjectAccountId: f.payer, offerId: f.offers[0].id, offerVersion: 1, idempotencyKey: randomUUID() };
  const create = jest.fn(async (input: { intentId: string }) => ({ sessionId: `synthetic_${input.intentId}`, checkoutUrl: `https://checkout.invalid/${input.intentId}` }));
  const provider: PersonalCheckoutProvider = { kind: 'synthetic', create };
  return { ...f, catalogue, request, provider, create };
}
it('keeps HTTP-equivalent provider absence and empty offers unconfigured; grants nothing', async () => {
  const f = await fixture();
  expect(await startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue })).toEqual({ state: 'unconfigured', reason: 'provider_unconfigured' });
  expect(await startPersonalPlanCheckout(f.payer, f.request, { catalogue: EMPTY_PRODUCT_BILLING_CATALOGUE })).toEqual({ state: 'unconfigured', reason: 'offer_unconfigured' });
  expect(f.create).not.toHaveBeenCalled();
  expect(await getDb().select().from(personalPlanCheckoutIntents).where(eq(personalPlanCheckoutIntents.subjectAccountId, f.payer))).toHaveLength(0);
});
it('selects exact server price, replays one intent and blocks changed payload/new duplicate', async () => {
  const f = await fixture(); const deps = { catalogue: f.catalogue, provider: f.provider };
  const [first, second] = await Promise.all([startPersonalPlanCheckout(f.payer, f.request, deps), startPersonalPlanCheckout(f.payer, f.request, deps)]);
  expect(first).toEqual(second); expect(first.state).toBe('pending');
  expect(f.create.mock.calls[0][0]).toMatchObject({ amountMinorUnits: 7, currency: 'usd', priceId: 'price_synthetic', subjectAccountId: f.payer });
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer))).toHaveLength(0);
  await expect(startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps)).rejects.toThrow('already pending');
  const changed = structuredClone(f.catalogue); changed.prices[0].amountMinorUnits = 8;
  expect(await startPersonalPlanCheckout(f.payer, f.request, { ...deps, catalogue: changed })).toEqual(first);
  expect(await startPersonalPlanCheckout(f.payer, f.request, { ...deps, catalogue: EMPTY_PRODUCT_BILLING_CATALOGUE })).toEqual(first);
  await expect(startPersonalPlanCheckout(f.owner, f.request, deps)).rejects.toMatchObject({ statusCode: 403 });
});
it('fulfills only on exact normalized paid evidence, and replay preserves one grant set', async () => {
  const f = await fixture(); const deps = { catalogue: f.catalogue, provider: f.provider };
  const checkout = await startPersonalPlanCheckout(f.payer, f.request, deps);
  if (checkout.state !== 'pending') throw new Error('Expected synthetic pending checkout');
  const raw = f.input(); const { id: _id, ...subscription } = raw.source;
  const input = { checkoutIntentId: checkout.intentId, binding: { ...f.providerBinding, providerAccountRef: 'merch_synthetic' },
    subscription: { ...subscription, provider: 'peable' as const, beneficiaryAccountId: f.payer, payerAccountId: f.payer },
    offer: { offerId: f.offers[0].id, offerVersion: 1, origin: 'bundle' as const },
    paidLine: { invoiceId: `in_${randomUUID()}`, lineId: `il_${randomUUID()}`, priceId: 'price_synthetic', quantity: 1 as const, period: f.period },
    event: { id: `evt_${randomUUID()}`, createdAt: f.now.toISOString() }, providerObservedAt: f.now };
  await recordProductProviderPeriod(input); await recordProductProviderPeriod(input);
  await expect(recordProductProviderPeriod({ ...input, checkoutIntentId: randomUUID() })).rejects.toThrow();
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({ state: 'fulfilled', intentId: checkout.intentId });
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer))).toHaveLength(2);
  await expect(startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps)).rejects.toThrow('already exists');
});
it('keeps an ambiguous/expired price unavailable and forbids extra client-controlled pricing', async () => {
  const f = await fixture(); f.catalogue.prices[0].validUntil = '2026-01-02T00:00:00.000Z';
  expect(await startPersonalPlanCheckout(f.payer, f.request, { catalogue: f.catalogue, provider: f.provider })).toEqual({ state: 'unconfigured', reason: 'price_unconfigured' });
  await expect(startPersonalPlanCheckout(f.payer, { ...f.request, amountMinorUnits: 1 } as typeof f.request, { catalogue: f.catalogue })).rejects.toThrow();
});

it('releases only exact trusted terminal sessions and keeps the original retry closed', async () => {
  const f = await fixture(); const deps = { catalogue: f.catalogue, provider: f.provider };
  const checkout = await startPersonalPlanCheckout(f.payer, f.request, deps);
  if (checkout.state !== 'pending') throw new Error('Expected pending');
  const observation = { intentId: checkout.intentId, subjectAccountId: f.payer, mode: 'live', environment: 'production',
    providerAccountRef: 'merch_synthetic', providerSessionId: `synthetic_${checkout.intentId}`, reason: 'expired' as const };
  await expect(closePersonalPlanCheckoutFromProvider({ ...observation, providerSessionId: 'wrong' })).rejects.toThrow();
  await closePersonalPlanCheckoutFromProvider(observation); await closePersonalPlanCheckoutFromProvider(observation);
  expect(await startPersonalPlanCheckout(f.payer, f.request, deps)).toEqual({ state: 'closed', intentId: checkout.intentId });
  expect((await startPersonalPlanCheckout(f.payer, { ...f.request, idempotencyKey: randomUUID() }, deps)).state).toBe('pending');
});

it('requires provider mapping to match approved display amount/currency and requests monthly with no trial',async()=>{
 const f=await fixture();f.catalogue.personalPlans[0].price={amountMinorUnits:2999,currency:'USD',interval:'month',trial:'none',taxTreatment:'inclusive',merchantTotal:'final'};
 const deps={catalogue:f.catalogue,provider:f.provider};
 expect(await startPersonalPlanCheckout(f.payer,f.request,deps)).toEqual({state:'unconfigured',reason:'price_unconfigured'});
 expect(f.create).not.toHaveBeenCalled();
 f.catalogue.prices[0].amountMinorUnits=2999;f.catalogue.prices[0].currency='eur';
 expect(await startPersonalPlanCheckout(f.payer,f.request,deps)).toEqual({state:'unconfigured',reason:'price_unconfigured'});
 expect(f.create).not.toHaveBeenCalled();
 f.catalogue.prices[0].currency='usd';
 expect((await startPersonalPlanCheckout(f.payer,f.request,deps)).state).toBe('pending');
 expect(f.create.mock.calls[0][0]).toMatchObject({amountMinorUnits:2999,currency:'usd',interval:'month',trial:'none'});
});
