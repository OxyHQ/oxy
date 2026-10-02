import { randomUUID } from 'node:crypto';
import { oxyAccountIdSchema } from '@oxy.so/contracts';
import type { ProductOffer, ProductSubscriptionSource, ProductOfferSegment } from '@oxy.so/contracts';
import { getDb } from '../../config/postgres';
import { users, applications } from '../../db/schema';
import { registerProductAccessConfiguration } from '../productAccessPersistence.service';
export async function accessAccount(kind: 'personal' | 'bot' = 'personal') {
  const [row] = await getDb().insert(users).values({ username: `i07-${randomUUID().slice(0, 8)}`, kind }).returning(); return oxyAccountIdSchema.parse(row.id);
}
export async function productAccessFixture() {
  const beneficiary = await accessAccount('bot'); const payer = await accessAccount(); const owner = await accessAccount();
  const [app] = await getDb().insert(applications).values({ name: 'I07 synthetic application', ownerAccountId: owner }).returning();
  const products = ['first', 'second'].map(id => ({ schemaVersion: 1 as const, id: `${id}-${randomUUID()}`, ownerAccountId: owner, applicationId: app.id }));
  const offers: ProductOffer[] = [
    { schemaVersion: 1, id: randomUUID(), version: 1, kind: 'bundle', benefits: products.map(p => ({ kind: 'capability', productId: p.id, key: 'use' })) },
    { schemaVersion: 1, id: randomUUID(), version: 1, kind: 'individual', benefits: [{ kind: 'capability', productId: products[0].id, key: 'use' }] },
  ];
  await registerProductAccessConfiguration({ products, offers });
  const now = new Date(); const period = { start: new Date(now.getTime() - 60_000).toISOString(), end: new Date(now.getTime() + 86_400_000).toISOString() };
  const providerBinding = { providerAccountRef: `synthetic-processor-${randomUUID()}`, mode: 'live' as const, environment: 'production' as const };
  function input(offer = offers[0]) {
    const id = randomUUID();
    const source: ProductSubscriptionSource = { schemaVersion: 1, id, beneficiaryAccountId: beneficiary, payerAccountId: payer, provider: 'stripe', providerSubscriptionId: `sub_${id}`, status: 'active', period, cancelAtPeriodEnd: false };
    const segment: ProductOfferSegment = { schemaVersion: 1, id: randomUUID(), subscriptionId: id, beneficiaryAccountId: beneficiary, offerId: offer.id, offerVersion: offer.version, origin: offer.kind, period };
    return { source, segment, providerObservedAt: now, providerBinding };
  }
  return { beneficiary, payer, owner, app, products, offers, now, period, input, providerBinding };
}
