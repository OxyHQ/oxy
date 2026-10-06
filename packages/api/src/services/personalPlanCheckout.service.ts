import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { personalPlanCheckoutRequestSchema, personalPlanCheckoutResultSchema,
  type PersonalPlanCheckoutRequest, type PersonalPlanCheckoutResult } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { assertBillingDatabaseNamespace } from '../config/billingNamespace';
import { users, accountClosureFences, accessSubscriptionSources, accessOfferSegments, personalPlanCheckoutIntents } from '../db/schema';
import { ApiError, ConflictError } from '../utils/error';
import { loadProductBillingCatalogue, productBillingCatalogueSchema, productBillingPriceSchema, type ProductBillingCatalogue } from './productBillingCatalogue.service';

/** Injection is for adapter contract tests. No provider is wired into HTTP yet. */
export interface PersonalCheckoutProvider {
  kind: 'synthetic';
  create(input: { intentId: string; idempotencyKey: string; subjectAccountId: string;
    offerId: string; offerVersion: number; priceId: string; amountMinorUnits: number; currency: string;
    providerAccountRef: string; mode: string; environment: string; interval:'month';trial:'none' }): Promise<{ sessionId: string; checkoutUrl: string }>;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** The approved price frozen at reservation, independent of the current catalogue. */
function frozenPrice(intent: typeof personalPlanCheckoutIntents.$inferSelect) {
  return productBillingPriceSchema.parse({ priceId: intent.priceId, provider: intent.priceProvider, providerAccountId: intent.providerAccountRef,
    mode: intent.mode, environment: intent.environment, offerId: intent.offerId, offerVersion: intent.offerVersion,
    validFrom: intent.priceValidFrom.toISOString(), validUntil: intent.priceValidUntil?.toISOString() ?? null,
    currency: intent.currency, amountMinorUnits: intent.amountMinorUnits, offerKind: intent.offerKind, kind: intent.priceKind });
}
export async function startPersonalPlanCheckout(subjectAccountId: string, raw: PersonalPlanCheckoutRequest,
  dependencies: { catalogue?: ProductBillingCatalogue; provider?: PersonalCheckoutProvider; now?: Date } = {}): Promise<PersonalPlanCheckoutResult> {
  const request = personalPlanCheckoutRequestSchema.parse(raw);
  if (request.expectedSubjectAccountId !== subjectAccountId) throw new ApiError(403, 'Signed-in subject changed', 'SUBJECT_CHANGED');
  // No Peable purchase adapter exists yet. Do not use unrelated Stripe credentials
  // or persist an intent while recurring/tax/FX evidence is unavailable.
  if (!dependencies.provider) {
    const catalogue = productBillingCatalogueSchema.parse(dependencies.catalogue ?? await loadProductBillingCatalogue());
    const published = catalogue.personalPlans.some(value => value.offerId === request.offerId && value.offerVersion === request.offerVersion);
    return { state: 'unconfigured', reason: published ? 'provider_unconfigured' : 'offer_unconfigured' };
  }
  const namespace = await assertBillingDatabaseNamespace(getDb());
  const idempotencyHash = hash(request.idempotencyKey);
  const [prior] = await getDb().select().from(personalPlanCheckoutIntents).where(and(
    eq(personalPlanCheckoutIntents.subjectAccountId, subjectAccountId),
    eq(personalPlanCheckoutIntents.mode, namespace.mode), eq(personalPlanCheckoutIntents.environment, namespace.environment),
    eq(personalPlanCheckoutIntents.idempotencyHash, idempotencyHash)));
  if (prior && (prior.offerId !== request.offerId || prior.offerVersion !== request.offerVersion))
    throw new ConflictError('Checkout idempotency key was reused for another selection');
  // A prior intent owns its frozen selection even after the catalogue changes.
  const catalogue = productBillingCatalogueSchema.parse(dependencies.catalogue ?? await loadProductBillingCatalogue());
  const published = catalogue.personalPlans.find(value => value.offerId === request.offerId && value.offerVersion === request.offerVersion);
  if (!published && !prior) return { state: 'unconfigured', reason: 'offer_unconfigured' };
  if (!dependencies.provider && !prior) return { state: 'unconfigured', reason: 'provider_unconfigured' };
  if (process.env.NODE_ENV !== 'test') throw new ApiError(503, 'Consumer checkout provider is unconfigured', 'CHECKOUT_NOT_CONFIGURED');
  const now = dependencies.now ?? new Date();
  const prices = catalogue.prices.filter(value => value.offerId === request.offerId && value.offerVersion === request.offerVersion
    && (!published?.price || (value.amountMinorUnits === published.price.amountMinorUnits && value.currency.toUpperCase() === published.price.currency))
    && value.kind === 'oxy_one' && value.offerKind === 'bundle' && value.mode === namespace.mode && value.environment === namespace.environment
    && Date.parse(value.validFrom) <= now.getTime() && (value.validUntil === null || Date.parse(value.validUntil) > now.getTime()));
  if (!prior && prices.length === 0) return { state: 'unconfigured', reason: 'price_unconfigured' };
  if (!prior && prices.length !== 1) throw new ConflictError('Approved checkout price selection is ambiguous');
  const price = prior ? frozenPrice(prior) : prices[0];
  const requestHash = hash(JSON.stringify({ offerId: request.offerId, offerVersion: request.offerVersion,
    providerAccountRef: price.providerAccountId, priceId: price.priceId, amountMinorUnits: price.amountMinorUnits, currency: price.currency }));
  const intent = await getDb().transaction(async tx => {
    // Account closure and all checkout intents serialize on the same account row.
    const [account] = await tx.select({ kind: users.kind, status: users.accountStatus }).from(users).where(eq(users.id, subjectAccountId)).for('update');
    const fences = await tx.select({ id: accountClosureFences.accountId }).from(accountClosureFences).where(eq(accountClosureFences.accountId, subjectAccountId));
    if (!account || account.kind !== 'personal' || account.status !== 'active' || fences.length)
      throw new ApiError(403, 'Personal account is unavailable', 'ACCOUNT_UNAVAILABLE');
    const scope = and(eq(personalPlanCheckoutIntents.subjectAccountId, subjectAccountId), eq(personalPlanCheckoutIntents.mode, namespace.mode), eq(personalPlanCheckoutIntents.environment, namespace.environment));
    const [prior] = await tx.select().from(personalPlanCheckoutIntents).where(and(scope, eq(personalPlanCheckoutIntents.idempotencyHash, idempotencyHash)));
    if (prior) { if (prior.requestHash !== requestHash) throw new ConflictError('Checkout idempotency key was reused for another selection'); return prior; }
    const [pending] = await tx.select({ id: personalPlanCheckoutIntents.id }).from(personalPlanCheckoutIntents).where(and(scope, inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending'])));
    if (pending) throw new ConflictError('A personal bundle checkout is already pending');
    const [held] = await tx.select({ id: accessSubscriptionSources.id }).from(accessSubscriptionSources)
      .innerJoin(accessOfferSegments, eq(accessOfferSegments.subscriptionId, accessSubscriptionSources.id))
      .where(and(eq(accessSubscriptionSources.beneficiaryAccountId, subjectAccountId), eq(accessSubscriptionSources.mode, namespace.mode), eq(accessSubscriptionSources.environment, namespace.environment),
        eq(accessOfferSegments.origin, 'bundle'), gt(accessSubscriptionSources.periodEnd, now),
        inArray(accessSubscriptionSources.status, ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'])));
    if (held) throw new ConflictError('A personal bundle subscription already exists');
    const [created] = await tx.insert(personalPlanCheckoutIntents).values({ id: randomUUID(), subjectAccountId, ...namespace,
      idempotencyHash, requestHash, offerId: request.offerId, offerVersion: request.offerVersion,
      providerAccountRef: price.providerAccountId, offerKind: price.offerKind, priceId: price.priceId, priceProvider: price.provider,
      priceKind: price.kind, currency: price.currency, amountMinorUnits: price.amountMinorUnits,
      priceValidFrom: new Date(price.validFrom), priceValidUntil: price.validUntil === null ? null : new Date(price.validUntil), state: 'reserved' }).returning();
    return created;
  });
  if (intent.state === 'closed') return { state: 'closed', intentId: intent.id };
  if (intent.state === 'fulfilled') return { state: 'fulfilled', intentId: intent.id };
  if (intent.checkoutUrl) return personalPlanCheckoutResultSchema.parse({ state: 'pending', intentId: intent.id, checkoutUrl: intent.checkoutUrl });
  // Remote work is outside DB locks. The immutable intent provides provider replay identity.
  if (!dependencies.provider) return { state: 'unconfigured', reason: 'provider_unconfigured' };
  const session = await dependencies.provider.create({ intentId: intent.id, idempotencyKey: `personal-checkout:${intent.id}`,
    subjectAccountId, offerId: intent.offerId, offerVersion: intent.offerVersion, priceId: price.priceId,
    amountMinorUnits: price.amountMinorUnits, currency: price.currency, providerAccountRef: price.providerAccountId, interval:'month',trial:'none', ...namespace });
  const answer = personalPlanCheckoutResultSchema.parse({ state: 'pending', intentId: intent.id, checkoutUrl: session.checkoutUrl });
  if (!session.sessionId || session.sessionId.length > 160) throw new Error('Provider session identity differs');
  await getDb().transaction(async tx => {
    const [current] = await tx.select().from(personalPlanCheckoutIntents).where(eq(personalPlanCheckoutIntents.id, intent.id)).for('update');
    if (!current || current.state === 'closed' || (current.providerSessionId && (current.providerSessionId !== session.sessionId || current.checkoutUrl !== session.checkoutUrl))) throw new ConflictError('Provider checkout replay differs');
    if (current.state !== 'fulfilled') await tx.update(personalPlanCheckoutIntents).set({ state: 'pending', providerSessionId: session.sessionId, checkoutUrl: session.checkoutUrl }).where(eq(personalPlanCheckoutIntents.id, intent.id));
  });
  return answer;
}

/** Trusted adapter observation only: never exposed as a browser cancellation endpoint.
 * A provider must prove the exact session is terminal and cannot charge before release.
 */
export async function closePersonalPlanCheckoutFromProvider(input: {
  intentId: string; subjectAccountId: string; mode: string; environment: string;
  providerAccountRef: string; providerSessionId: string; reason: 'expired' | 'canceled';
}) {
  return getDb().transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.subjectAccountId)).for('update');
    const [intent] = await tx.select().from(personalPlanCheckoutIntents).where(eq(personalPlanCheckoutIntents.id, input.intentId)).for('update');
    if (!intent || intent.subjectAccountId !== input.subjectAccountId || intent.mode !== input.mode
      || intent.environment !== input.environment || intent.providerAccountRef !== input.providerAccountRef
      || intent.providerSessionId !== input.providerSessionId || intent.state === 'fulfilled')
      throw new ConflictError('Terminal checkout observation differs');
    if (intent.state === 'closed' && intent.closedReason !== input.reason) throw new ConflictError('Terminal checkout observation differs');
    await tx.update(personalPlanCheckoutIntents).set({ state: 'closed', closedReason: input.reason }).where(eq(personalPlanCheckoutIntents.id, intent.id));
  });
}
