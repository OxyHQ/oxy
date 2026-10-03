import { createHash } from 'node:crypto';
import {
	type ProductBenefit,
	type ProductDefinition,
	type ProductOffer,
	type ProductOfferSegment,
	type ProductSubscriptionSource,
	productAccessGrantSchema,
	productDefinitionSchema,
	productOfferSchema,
	productOfferSegmentSchema,
	productSubscriptionSourceSchema,
} from "@oxy.so/contracts";
import { and, eq, inArray, isNull } from 'drizzle-orm';
/** Generic internal writer. No HTTP grant lane, checkout or provider call. */
import { z } from "zod";
import {
  type DatabaseOrTransaction, type Transaction ,
	getDb,
} from '../config/postgres';
import {
  accessGrants,
	accessOfferBenefits,
	accessOfferSegments, accessOffers, accessProducts, accessSubscriptionSources, accountClosureFences,
  applications, users, } from '../db/schema';
import { ApiError, ConflictError } from '../utils/error';
import { composeSubjectProductAccess } from './productAccess';

export const productProviderBindingSchema = z.object({
  providerAccountRef: z.string().min(1).max(160), mode: z.literal('live'), environment: z.literal('production'),
}).strict();
export const productAccessConfigurationExpectationSchema = z.object({ products: z.array(productDefinitionSchema), offer: productOfferSchema }).strict();
export type ProductAccessConfigurationExpectation = z.infer<typeof productAccessConfigurationExpectationSchema>;
export type ProductProviderBinding = z.infer<typeof productProviderBindingSchema>;

export function productAccessNotConfigured(): ApiError {
  return new ApiError(503, 'Product access configuration is unavailable', 'PRODUCT_ACCESS_NOT_CONFIGURED');
}
function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ConflictError('Immutable product access identity or replay payload differs');
}
function sourceDto(row: typeof accessSubscriptionSources.$inferSelect): ProductSubscriptionSource {
  return productSubscriptionSourceSchema.parse({ schemaVersion: 1, id: row.id,
    beneficiaryAccountId: row.beneficiaryAccountId, payerAccountId: row.payerAccountId,
    provider: row.provider, providerSubscriptionId: row.providerSubscriptionId, status: row.status,
    period: { start: row.periodStart.toISOString(), end: row.periodEnd.toISOString() }, cancelAtPeriodEnd: row.cancelAtPeriodEnd });
}
function segmentDto(row: typeof accessOfferSegments.$inferSelect): ProductOfferSegment {
  return productOfferSegmentSchema.parse({ schemaVersion: 1, id: row.id, subscriptionId: row.subscriptionId,
    beneficiaryAccountId: row.beneficiaryAccountId, offerId: row.offerId, offerVersion: row.offerVersion,
    origin: row.origin, period: { start: row.periodStart.toISOString(), end: row.periodEnd.toISOString() } });
}
function benefitDto(row: typeof accessOfferBenefits.$inferSelect): ProductBenefit {
  if (row.kind === 'quota' && (row.unit === null || row.included === null || row.combination === null)) throw productAccessNotConfigured();
  return row.kind === 'capability'
    ? { kind: 'capability', productId: row.productId, key: row.key }
    : { kind: 'quota', productId: row.productId, key: row.key, unit: z.string().parse(row.unit), included: z.number().parse(row.included), combination: z.enum(['maximum','sum','exclusive']).parse(row.combination) };
}
/** Serializes with account closure using the existing users row fence. */
async function lockOpenAccounts(db: DatabaseOrTransaction, accountIds: string[]): Promise<void> {
  const ids = [...new Set(accountIds)].sort();
  const rows = await db.select({ id: users.id, status: users.accountStatus }).from(users)
    .where(inArray(users.id, ids)).orderBy(users.id).for('update');
  if (rows.length !== ids.length || rows.some(row => row.status !== 'active')) throw new ConflictError('Product access account is unavailable');
  const fences = await db.select().from(accountClosureFences).where(inArray(accountClosureFences.accountId, ids));
  if (fences.length) throw new ConflictError('Account closure prevents product access writes');
}
export async function readRegisteredProduct(db: DatabaseOrTransaction, productId: string): Promise<ProductDefinition> {
  const [row] = await db.select({ product: accessProducts, application: applications, ownerStatus: users.accountStatus })
    .from(accessProducts).innerJoin(applications, eq(accessProducts.applicationId, applications.id))
    .innerJoin(users, eq(accessProducts.ownerAccountId, users.id)).where(eq(accessProducts.id, productId));
  if (!row || row.application.status !== 'active' || row.ownerStatus !== 'active'
    || row.application.ownerAccountId !== row.product.ownerAccountId) throw productAccessNotConfigured();
  const [fence] = await db.select().from(accountClosureFences).where(eq(accountClosureFences.accountId, row.product.ownerAccountId));
  if (fence) throw productAccessNotConfigured();
  return productDefinitionSchema.parse({ schemaVersion: 1, id: row.product.id,
    ownerAccountId: row.product.ownerAccountId, applicationId: row.product.applicationId });
}
async function configuredOffer(db: DatabaseOrTransaction, id: string, version: number): Promise<ProductOffer> {
  const [offer] = await db.select().from(accessOffers).where(and(eq(accessOffers.id, id), eq(accessOffers.version, version)));
  if (!offer) throw productAccessNotConfigured();
  const benefits = await db.select().from(accessOfferBenefits)
    .where(and(eq(accessOfferBenefits.offerId, id), eq(accessOfferBenefits.offerVersion, version)))
    .orderBy(accessOfferBenefits.benefitIndex);
  if (benefits.length !== offer.expectedBenefitCount || benefits.some((benefit, index) => benefit.benefitIndex !== index)) {
    throw productAccessNotConfigured();
  }
  for (const productId of new Set(benefits.map(row => row.productId))) await readRegisteredProduct(db, productId);
  return productOfferSchema.parse({ schemaVersion: 1, id, version, kind: offer.kind, benefits: benefits.map(benefitDto) });
}

/** Call after sorted account locks; freeze the application's ownership during a write. */
async function lockProductApplications(db: DatabaseOrTransaction, products: ProductDefinition[]): Promise<void> {
  const ids = [...new Set(products.map(product => product.applicationId))].sort();
  for (const id of ids) {
    const [app] = await db.select().from(applications).where(eq(applications.id, id)).for('share');
    if (!app || app.status !== 'active' || products.some(product => product.applicationId === id && product.ownerAccountId !== app.ownerAccountId)) {
      throw productAccessNotConfigured();
    }
  }
}

/** Explicit trusted configuration only; this function is not mounted as an API. */
export async function registerProductAccessConfiguration(input: { products: ProductDefinition[]; offers: ProductOffer[] }): Promise<void> {
  const products = input.products.map(row => productDefinitionSchema.parse(row));
  const offers = input.offers.map(row => productOfferSchema.parse(row));
  await getDb().transaction(async tx => {
    await lockOpenAccounts(tx, products.map(product => product.ownerAccountId));
    for (const product of products) {
      const [application] = await tx.select().from(applications).where(eq(applications.id, product.applicationId)).for('share');
      if (!application || application.status !== 'active' || application.ownerAccountId !== product.ownerAccountId) throw productAccessNotConfigured();
      await tx.insert(accessProducts).values({ id: product.id, ownerAccountId: product.ownerAccountId, applicationId: product.applicationId }).onConflictDoNothing();
      const [stored] = await tx.select().from(accessProducts).where(eq(accessProducts.id, product.id));
      same(productDefinitionSchema.parse({ schemaVersion: 1, id: stored.id, ownerAccountId: stored.ownerAccountId, applicationId: stored.applicationId }), product);
    }
    for (const offer of offers) {
      // Every benefit must bind to an existing registered product; an absent rule never gets a default.
      for (const benefit of offer.benefits) {
        const [product] = await tx.select().from(accessProducts).where(eq(accessProducts.id, benefit.productId));
        if (!product) throw productAccessNotConfigured();
      }
      const inserted = await tx.insert(accessOffers).values({ id: offer.id, version: offer.version, kind: offer.kind,
        expectedBenefitCount: offer.benefits.length }).onConflictDoNothing().returning();
      if (inserted.length && offer.benefits.length) {
        await tx.insert(accessOfferBenefits).values(offer.benefits.map((benefit, benefitIndex) => ({
          offerId: offer.id, offerVersion: offer.version, benefitIndex,
          productId: benefit.productId, kind: benefit.kind, key: benefit.key,
          unit: benefit.kind === 'quota' ? benefit.unit : null,
          included: benefit.kind === 'quota' ? benefit.included : null,
          combination: benefit.kind === 'quota' ? benefit.combination : null,
        })));
      }
      same(await configuredOffer(tx, offer.id, offer.version), offer);
    }
  });
}

/**
 * A future financial adapter must supply provider-verified input. This writes
 * access provenance only, and never awards money/API credits or reads old balances.
 * Exact replay is harmless; a reused source/segment with different provenance fails.
 */
export async function recordProductAccessPeriod(input: {
  source: ProductSubscriptionSource; segment: ProductOfferSegment; providerObservedAt: Date; providerBinding: ProductProviderBinding;
  /** Internal provider adapter only; account/app union is locked before source transition. */
  advanceSourceSnapshot?: boolean;
  expectedConfiguration?: ProductAccessConfigurationExpectation;
/** Only the internal verified paid-evidence adapter may retain a past segment. */
		allowHistoricalPaidSegment?: boolean;
	}, transaction?: Transaction,
): Promise<{ status: 'recorded' | 'replayed'; grantIds: string[] }> {
  const binding = productProviderBindingSchema.parse(input.providerBinding);
  const source = productSubscriptionSourceSchema.parse(input.source);
  const segment = productOfferSegmentSchema.parse(input.segment);
  if (!Number.isFinite(input.providerObservedAt.getTime())) throw new ConflictError('Provider observation is required');
  if (segment.subscriptionId !== source.id || segment.beneficiaryAccountId !== source.beneficiaryAccountId) {
    throw new ConflictError('Offer segment does not match its subscription source');
  }
  const write = async (tx: Transaction,
	): Promise<{ status: 'recorded' | 'replayed'; grantIds: string[] }> => {
    const offer = await configuredOffer(tx, segment.offerId, segment.offerVersion);
    const definitions = await Promise.all([...new Set(offer.benefits.map(benefit => benefit.productId))].map(id => readRegisteredProduct(tx, id)));
    await lockOpenAccounts(tx, [source.beneficiaryAccountId, source.payerAccountId, ...definitions.map(product => product.ownerAccountId)]);
    await lockProductApplications(tx, definitions);
    if (input.expectedConfiguration) {
      const expected = productAccessConfigurationExpectationSchema.parse(input.expectedConfiguration);
      same(offer, expected.offer);
      const byId = (a: ProductDefinition, b: ProductDefinition) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      same([...definitions].sort(byId), [...expected.products].sort(byId));
    }
    if (offer.kind !== segment.origin) throw new ConflictError('Offer origin differs from frozen configuration');
    await tx.insert(accessSubscriptionSources).values({ id: source.id,
      beneficiaryAccountId: source.beneficiaryAccountId, payerAccountId: source.payerAccountId,
      provider: source.provider, providerSubscriptionId: source.providerSubscriptionId, status: source.status,
      periodStart: new Date(source.period.start), periodEnd: new Date(source.period.end),
      cancelAtPeriodEnd: source.cancelAtPeriodEnd, providerObservedAt: input.providerObservedAt,
      providerAccountRef: binding.providerAccountRef, mode: binding.mode, environment: binding.environment,
    }).onConflictDoNothing();
    const [storedSource] = await tx.select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id)).for('update');
    if (!storedSource) throw new ConflictError('Provider subscription is already bound to another source');
    // Immutable parties/provider always match; historic replay need not rewrite current commercial state.
    same(productProviderBindingSchema.parse({ providerAccountRef: storedSource.providerAccountRef, mode: storedSource.mode, environment: storedSource.environment }), binding);
    const actualSource = sourceDto(storedSource);
    same({ id: actualSource.id, beneficiaryAccountId: actualSource.beneficiaryAccountId, payerAccountId: actualSource.payerAccountId, provider: actualSource.provider, providerSubscriptionId: actualSource.providerSubscriptionId },
      { id: source.id, beneficiaryAccountId: source.beneficiaryAccountId, payerAccountId: source.payerAccountId, provider: source.provider, providerSubscriptionId: source.providerSubscriptionId });
    const [historic] = await tx.select().from(accessOfferSegments).where(eq(accessOfferSegments.id, segment.id));
    if (!historic) {
      // Current state does not authorize a NEW grant for an old/canceled period.
      // An immutable existing segment can be acknowledged without rewinding it.
      const withinCurrentPeriod =
				Date.parse(segment.period.start) >= Date.parse(source.period.start) &&
				Date.parse(segment.period.end) <= Date.parse(source.period.end);
			const active = ["active", "trialing"].includes(source.status);
			const retainedPaidHistory =
				input.allowHistoricalPaidSegment &&
				(Date.parse(segment.period.end) <= Date.parse(source.period.start)
        || (!active && withinCurrentPeriod) );
			if (!withinCurrentPeriod && !retainedPaidHistory) throw new ConflictError('New offer segment is outside current source period');
      if (!active && !retainedPaidHistory) throw new ConflictError('Inactive source cannot issue an access period');
    }
    if (!historic && input.advanceSourceSnapshot) {
      // Union of every new bundle product owner/application was locked above,
      // before the source row; no named update acquires another lower lock later.
      if (input.providerObservedAt.getTime() <= storedSource.providerObservedAt.getTime()) same(actualSource, source);
      else {
        if (Date.parse(source.period.start) < storedSource.periodStart.getTime()
          || Date.parse(source.period.end) < storedSource.periodEnd.getTime()) throw new ConflictError('Provider source period cannot rewind');
        await tx.update(accessSubscriptionSources).set({ status: source.status,
          periodStart: new Date(source.period.start), periodEnd: new Date(source.period.end),
          cancelAtPeriodEnd: source.cancelAtPeriodEnd, providerObservedAt: input.providerObservedAt,
        }).where(eq(accessSubscriptionSources.id, source.id));
      }
    } else if (!historic) same(actualSource, source);
    const inserted = await tx.insert(accessOfferSegments).values({ id: segment.id, subscriptionId: segment.subscriptionId,
      beneficiaryAccountId: segment.beneficiaryAccountId, offerId: segment.offerId, offerVersion: segment.offerVersion,
      origin: segment.origin, periodStart: new Date(segment.period.start), periodEnd: new Date(segment.period.end),
    }).onConflictDoNothing().returning();
    const [storedSegment] = await tx.select().from(accessOfferSegments).where(eq(accessOfferSegments.id, segment.id));
    same(segmentDto(storedSegment), segment);
    const grantIds = offer.benefits.map((_, index) => `grant_${createHash('sha256').update(JSON.stringify([segment.id, index])).digest('hex')}`);
		if (inserted.length && grantIds.length) {
      await tx.insert(accessGrants).values(offer.benefits.map((benefit, benefitIndex) => ({
        id: grantIds[benefitIndex], sourceSegmentId: segment.id, beneficiaryAccountId: segment.beneficiaryAccountId,
        offerId: segment.offerId, offerVersion: segment.offerVersion, origin: segment.origin,
        benefitIndex, productId: benefit.productId, periodStart: new Date(segment.period.start), periodEnd: new Date(segment.period.end),
      })));
    }
		const persisted = await tx.select({ id: accessGrants.id }).from(accessGrants)
      .where(eq(accessGrants.sourceSegmentId, segment.id)).orderBy(accessGrants.benefitIndex);
		if (persisted.length !== grantIds.length || persisted.some((grant, index) => grant.id !== grantIds[index])) throw productAccessNotConfigured();
		return { status: inserted.length ? 'recorded' : 'replayed', grantIds: persisted.map(grant => grant.id) };
	};
	return transaction ? write(transaction) : getDb().transaction(write);
}

/** Named source update only, checked against a product it actually supplies. */
export async function updateProductAccessSourceState(input: {
  sourceId: string; productId: string; providerObservedAt: Date; providerBinding: ProductProviderBinding;
  status: ProductSubscriptionSource['status']; period: ProductSubscriptionSource['period']; cancelAtPeriodEnd: boolean;
}): Promise<'updated' | 'stale' | 'replayed'> {
  return getDb().transaction(async tx => {
    const [initial] = await tx.select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, input.sourceId));
    if (!initial) throw new ConflictError('Unknown named source');
    same(productProviderBindingSchema.parse({ providerAccountRef: initial.providerAccountRef, mode: initial.mode, environment: initial.environment }), productProviderBindingSchema.parse(input.providerBinding));
    const product = await readRegisteredProduct(tx, input.productId);
    await lockOpenAccounts(tx, [initial.beneficiaryAccountId, initial.payerAccountId, product.ownerAccountId]);
    await lockProductApplications(tx, [product]);
    const [source] = await tx.select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, input.sourceId)).for('update');
    const [bound] = await tx.select({ id: accessGrants.id }).from(accessGrants)
      .innerJoin(accessOfferSegments, eq(accessGrants.sourceSegmentId, accessOfferSegments.id))
      .where(and(eq(accessOfferSegments.subscriptionId, input.sourceId), eq(accessGrants.productId, input.productId))).limit(1);
    if (!bound) throw new ConflictError('Named source does not supply that product');
    const parsed = productSubscriptionSourceSchema.parse({ ...sourceDto(source), status: input.status, period: input.period, cancelAtPeriodEnd: input.cancelAtPeriodEnd });
    if (!Number.isFinite(input.providerObservedAt.getTime())) throw new ConflictError('Provider observation is required');
    if (input.providerObservedAt.getTime() < source.providerObservedAt.getTime()) return 'stale';
    if (input.providerObservedAt.getTime() === source.providerObservedAt.getTime()) { same(sourceDto(source), parsed); return 'replayed'; }
    await tx.update(accessSubscriptionSources).set({ status: parsed.status, periodStart: new Date(parsed.period.start),
      periodEnd: new Date(parsed.period.end), cancelAtPeriodEnd: parsed.cancelAtPeriodEnd, providerObservedAt: input.providerObservedAt,
    }).where(eq(accessSubscriptionSources.id, input.sourceId));
    return 'updated';
  });
}

/** Internal provider-authenticated maintenance of an EXISTING financial source.
 * Caller proves fresh provider snapshot/payer externally. Product owner/app authority
 * remains mandatory for grants and access. No source/segment/grant is created here.
 * Account closure preserves financial reconciliation, as with historical refunds.
 */
export async function reconcileProductAccessFinancialState(input: {
  sourceId: string; beneficiaryAccountId: string; payerAccountId: string;
  provider: ProductSubscriptionSource['provider']; providerSubscriptionId: string;
  providerObservedAt: Date; providerBinding: ProductProviderBinding;
  status: ProductSubscriptionSource['status']; period: ProductSubscriptionSource['period']; cancelAtPeriodEnd: boolean;
}): Promise<'updated' | 'stale' | 'replayed'> {
  const binding = productProviderBindingSchema.parse(input.providerBinding);
  if (!Number.isFinite(input.providerObservedAt.getTime())) throw new ConflictError('Provider observation is required');
  return getDb().transaction(async tx => {
    const ids = [...new Set([input.beneficiaryAccountId, input.payerAccountId])].sort();
    const accounts = await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids)).orderBy(users.id).for('update');
    if (accounts.length !== ids.length) throw new ConflictError('Financial source account is unavailable');
    const [source] = await tx.select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, input.sourceId)).for('update');
    if (!source) throw new ConflictError('Unknown financial source');
    same({ beneficiaryAccountId: source.beneficiaryAccountId, payerAccountId: source.payerAccountId,
      provider: source.provider, providerSubscriptionId: source.providerSubscriptionId,
      providerAccountRef: source.providerAccountRef, mode: source.mode, environment: source.environment },
      { beneficiaryAccountId: input.beneficiaryAccountId, payerAccountId: input.payerAccountId,
        provider: input.provider, providerSubscriptionId: input.providerSubscriptionId, ...binding });
    const parsed = productSubscriptionSourceSchema.parse({ ...sourceDto(source), status: input.status, period: input.period, cancelAtPeriodEnd: input.cancelAtPeriodEnd });
    if (input.providerObservedAt.getTime() < source.providerObservedAt.getTime()) return 'stale';
    if (input.providerObservedAt.getTime() === source.providerObservedAt.getTime()) { same(sourceDto(source), parsed); return 'replayed'; }
    if (Date.parse(parsed.period.start) < source.periodStart.getTime() || Date.parse(parsed.period.end) < source.periodEnd.getTime()) throw new ConflictError('Financial source period cannot rewind');
    await tx.update(accessSubscriptionSources).set({ status: parsed.status, periodStart: new Date(parsed.period.start),
      periodEnd: new Date(parsed.period.end), cancelAtPeriodEnd: parsed.cancelAtPeriodEnd, providerObservedAt: input.providerObservedAt,
    }).where(eq(accessSubscriptionSources.id, input.sourceId));
    return 'updated';
  });
}

export async function revokeProductAccessGrant(input: { grantId: string; productId: string; revokedAt: Date }): Promise<boolean> {
  if (!Number.isFinite(input.revokedAt.getTime())) throw new ConflictError('Revocation instant is required');
  const rows = await getDb().update(accessGrants).set({ revokedAt: input.revokedAt })
    .where(and(eq(accessGrants.id, input.grantId), eq(accessGrants.productId, input.productId), isNull(accessGrants.revokedAt))).returning({ id: accessGrants.id });
  return rows.length === 1;
}
/** Caller authorization is separate and mandatory at every exposed boundary. */
export async function readSubjectProductAccess(subjectAccountId: string, productId: string, now = new Date()) {
  await readRegisteredProduct(getDb(), productId);
  const rows = await getDb().select({ grant: accessGrants, benefit: accessOfferBenefits, segment: accessOfferSegments })
    .from(accessGrants)
    .innerJoin(accessOfferBenefits, and(eq(accessGrants.offerId, accessOfferBenefits.offerId), eq(accessGrants.offerVersion, accessOfferBenefits.offerVersion), eq(accessGrants.benefitIndex, accessOfferBenefits.benefitIndex)))
    .innerJoin(accessOfferSegments, eq(accessGrants.sourceSegmentId, accessOfferSegments.id))
    .where(and(eq(accessGrants.beneficiaryAccountId, subjectAccountId), eq(accessGrants.productId, productId)));
  for (const row of rows) await configuredOffer(getDb(), row.segment.offerId, row.segment.offerVersion);
  const sourceIds = [...new Set(rows.map(row => row.segment.subscriptionId))];
  const sources = sourceIds.length ? await getDb().select().from(accessSubscriptionSources).where(and(inArray(accessSubscriptionSources.id, sourceIds), eq(accessSubscriptionSources.mode, 'live'), eq(accessSubscriptionSources.environment, 'production'))) : [];
  const segments = [...new Map(rows.map(row => [row.segment.id, segmentDto(row.segment)])).values()];
  const grants = rows.map(({ grant, benefit }) => productAccessGrantSchema.parse({ schemaVersion: 1, id: grant.id,
    sourceSegmentId: grant.sourceSegmentId, beneficiaryAccountId: grant.beneficiaryAccountId,
    offerId: grant.offerId, offerVersion: grant.offerVersion, origin: grant.origin, benefit: benefitDto(benefit),
    period: { start: grant.periodStart.toISOString(), end: grant.periodEnd.toISOString() }, revokedAt: grant.revokedAt?.toISOString() ?? null }));
  return composeSubjectProductAccess({ subjectAccountId, productId, now, sources: sources.map(sourceDto), segments, grants });
}
