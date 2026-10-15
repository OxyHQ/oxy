import { z } from 'zod';
import { createHash } from 'node:crypto';
import { uuidv7 } from '@oxy.so/db';
import type { BillingTaxQuote } from '@peable.to/sdk';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  personalPlanCheckoutRequestSchema,
  productPlanCheckoutRequestSchema,
  type ProductPlanCheckoutRequest,
  personalPlanCheckoutResultSchema,
  type PersonalPlanCheckoutRequest,
  type PersonalPlanCheckoutResult,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { assertBillingDatabaseNamespace, billingNamespaceSchema } from '../config/billingNamespace';
import {
  users,
  accountClosureFences,
  accessSubscriptionSources,
  accessOfferSegments,
  personalPlanCheckoutIntents,
} from '../db/schema';
import { ApiError, ConflictError } from '../utils/error';
import {
  loadProductBillingCatalogue,
  productBillingCatalogueSchema,
  productBillingPriceSchema,
  type ProductBillingCatalogue,
} from './productBillingCatalogue.service';

/** Immutable SDK authority selected once for one checkout intent. */
export interface PersonalCheckoutSnapshot {
  applicationId: string;
  merchantId: string;
  subjectAccountId: string;
  planId: string;
  customerId: string;
  offerId: string;
  offerVersion: number;
  priceId: string;
  mode: string;
  environment: string;
  taxQuote: BillingTaxQuote;
  returnUrl: string;
}
export interface PersonalCheckoutInput {
  intentId: string;
  idempotencyKey: string;
  subjectAccountId: string;
  offerId: string;
  offerVersion: number;
  priceId: string;
  amountMinorUnits: number;
  currency: string;
  providerAccountRef: string;
  mode: string;
  environment: string;
  interval: 'month' | 'year';
  trial: 'none';
  snapshot?: PersonalCheckoutSnapshot;
  renewalSubscriptionId?: string;
}
export interface PersonalCheckoutProvider {
  kind: 'synthetic' | 'peable';
  prepare?(input: PersonalCheckoutInput): Promise<PersonalCheckoutSnapshot>;
  create(input: PersonalCheckoutInput): Promise<{
    sessionId: string;
    checkoutUrl: string;
    expiresAt?: string;
  }>;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** The approved price frozen at reservation, independent of the current catalogue. */
function frozenPrice(intent: typeof personalPlanCheckoutIntents.$inferSelect) {
  return productBillingPriceSchema.parse({
    priceId: intent.priceId,
    provider: intent.priceProvider,
    providerAccountId: intent.providerAccountRef,
    mode: intent.mode,
    environment: intent.environment,
    offerId: intent.offerId,
    offerVersion: intent.offerVersion,
    validFrom: intent.priceValidFrom.toISOString(),
    validUntil: intent.priceValidUntil?.toISOString() ?? null,
    currency: intent.currency,
    amountMinorUnits: intent.amountMinorUnits,
    interval: intent.billingInterval,
    offerKind: intent.offerKind,
    kind: intent.priceKind,
  });
}
export async function startPersonalPlanCheckout(
  subjectAccountId: string,
  raw: PersonalPlanCheckoutRequest,
  dependencies: {
    catalogue?: ProductBillingCatalogue;
    provider?: PersonalCheckoutProvider;
    now?: Date;
    /** Selected by the dedicated authenticated product route, never provider metadata. */
    productId?: string;
    renewalSourceId?: string;
  } = {},
): Promise<PersonalPlanCheckoutResult> {
  const request = personalPlanCheckoutRequestSchema.parse(raw);
  if (request.expectedSubjectAccountId !== subjectAccountId)
    throw new ApiError(403, 'Signed-in subject changed', 'SUBJECT_CHANGED');
  // No intent is reserved without the explicitly configured Peable authority.
  // Unrelated Stripe credentials never substitute for fiscal/FX evidence.
  if (!dependencies.provider) {
    const catalogue = productBillingCatalogueSchema.parse(
      dependencies.catalogue ?? (await loadProductBillingCatalogue()),
    );
    const published = (
      dependencies.productId
        ? catalogue.productPlans.filter((p) => p.productId === dependencies.productId)
        : catalogue.personalPlans
    ).some(
      (value) => value.offerId === request.offerId && value.offerVersion === request.offerVersion,
    );
    return {
      state: 'unconfigured',
      reason: published ? 'provider_unconfigured' : 'offer_unconfigured',
    };
  }
  const namespace = await assertBillingDatabaseNamespace(getDb());
  const idempotencyHash = hash(request.idempotencyKey);
  const [prior] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(
      and(
        eq(personalPlanCheckoutIntents.subjectAccountId, subjectAccountId),
        eq(personalPlanCheckoutIntents.mode, namespace.mode),
        eq(personalPlanCheckoutIntents.environment, namespace.environment),
        eq(personalPlanCheckoutIntents.idempotencyHash, idempotencyHash),
      ),
    );
  if (prior && (prior.offerId !== request.offerId || prior.offerVersion !== request.offerVersion))
    throw new ConflictError('Checkout idempotency key was reused for another selection');
  if (prior && prior.renewalSourceId !== (dependencies.renewalSourceId ?? null))
    throw new ConflictError('Checkout renewal source differs');
  if (prior && prior.offerKind !== (dependencies.productId ? 'individual' : 'bundle'))
    throw new ConflictError('Checkout kind differs from original selection');
  // A prior intent owns its frozen selection even after the catalogue changes.
  const catalogue = productBillingCatalogueSchema.parse(
    dependencies.catalogue ?? (await loadProductBillingCatalogue()),
  );
  const published = (
    dependencies.productId
      ? catalogue.productPlans.filter((p) => p.productId === dependencies.productId)
      : catalogue.personalPlans
  ).find(
    (value) => value.offerId === request.offerId && value.offerVersion === request.offerVersion,
  );
  if (!published && !prior) return { state: 'unconfigured', reason: 'offer_unconfigured' };
  if (!dependencies.provider && !prior)
    return { state: 'unconfigured', reason: 'provider_unconfigured' };
  if (process.env.NODE_ENV !== 'test' && dependencies.provider?.kind !== 'peable')
    throw new ApiError(
      503,
      'Consumer checkout provider is unconfigured',
      'CHECKOUT_NOT_CONFIGURED',
    );
  const now = dependencies.now ?? new Date();
  const prices = catalogue.prices.filter(
    (value) =>
      value.offerId === request.offerId &&
      value.offerVersion === request.offerVersion &&
      (!published?.price ||
        (value.amountMinorUnits === published.price.amountMinorUnits &&
          value.currency.toUpperCase() === published.price.currency &&
          value.interval === published.price.interval)) &&
      value.kind === (dependencies.productId ? 'existing_product' : 'oxy_one') &&
      value.offerKind === (dependencies.productId ? 'individual' : 'bundle') &&
      value.provider === 'peable' &&
      value.mode === namespace.mode &&
      value.environment === namespace.environment &&
      Date.parse(value.validFrom) <= now.getTime() &&
      (value.validUntil === null || Date.parse(value.validUntil) > now.getTime()),
  );
  if (!prior && prices.length === 0) return { state: 'unconfigured', reason: 'price_unconfigured' };
  if (!prior && prices.length !== 1)
    throw new ConflictError('Approved checkout price selection is ambiguous');
  const price = prior ? frozenPrice(prior) : prices[0];
  // The database refuses anything else; fail here with a domain error first.
  const offerKind = price.offerKind,
    priceKind = price.kind;
  if (
    offerKind !== (dependencies.productId ? 'individual' : 'bundle') ||
    priceKind !== (dependencies.productId ? 'existing_product' : 'oxy_one') ||
    (!dependencies.productId &&
      (price.amountMinorUnits !== 2999 || price.currency !== 'usd' || price.interval !== 'month'))
  )
    throw new ConflictError('Approved checkout price is not a personal bundle price');
  const requestHash = hash(
    JSON.stringify({
      offerId: request.offerId,
      offerVersion: request.offerVersion,
      renewalSourceId: dependencies.renewalSourceId ?? null,
      providerAccountRef: price.providerAccountId,
      priceId: price.priceId,
      amountMinorUnits: price.amountMinorUnits,
      currency: price.currency,
      ...(price.interval === 'year' ? { interval: price.interval } : {}),
    }),
  );
  const intent = await getDb().transaction(async (tx) => {
    // Account closure and all checkout intents serialize on the same account row.
    const [account] = await tx
      .select({ kind: users.kind, status: users.accountStatus })
      .from(users)
      .where(eq(users.id, subjectAccountId))
      .for('update');
    const fences = await tx
      .select({ id: accountClosureFences.accountId })
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, subjectAccountId));
    if (account?.kind !== 'personal' || account.status !== 'active' || fences.length)
      throw new ApiError(403, 'Personal account is unavailable', 'ACCOUNT_UNAVAILABLE');
    const scope = and(
      eq(personalPlanCheckoutIntents.subjectAccountId, subjectAccountId),
      eq(personalPlanCheckoutIntents.mode, namespace.mode),
      eq(personalPlanCheckoutIntents.environment, namespace.environment),
    );
    const [prior] = await tx
      .select()
      .from(personalPlanCheckoutIntents)
      .where(and(scope, eq(personalPlanCheckoutIntents.idempotencyHash, idempotencyHash)));
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new ConflictError('Checkout idempotency key was reused for another selection');
      return prior;
    }
    const [pending] = await tx
      .select({ id: personalPlanCheckoutIntents.id })
      .from(personalPlanCheckoutIntents)
      .where(and(scope, inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending'])));
    if (pending) throw new ConflictError('A personal bundle checkout is already pending');
    const [held] = await tx
      .select({ id: accessSubscriptionSources.id })
      .from(accessSubscriptionSources)
      .innerJoin(
        accessOfferSegments,
        eq(accessOfferSegments.subscriptionId, accessSubscriptionSources.id),
      )
      .where(
        and(
          eq(accessSubscriptionSources.beneficiaryAccountId, subjectAccountId),
          eq(accessSubscriptionSources.mode, namespace.mode),
          eq(accessSubscriptionSources.environment, namespace.environment),
          eq(accessOfferSegments.origin, offerKind),
          dependencies.productId
            ? inArray(
                accessOfferSegments.offerId,
                catalogue.offers
                  .filter(
                    (offer) =>
                      offer.kind === 'individual' &&
                      offer.benefits.some(
                        (benefit) => benefit.productId === dependencies.productId,
                      ),
                  )
                  .map((offer) => offer.id),
              )
            : undefined,
          gt(accessSubscriptionSources.periodEnd, now),
          inArray(accessSubscriptionSources.status, [
            'active',
            'trialing',
            'past_due',
            'unpaid',
            'paused',
            'incomplete',
          ]),
        ),
      );
    if (held && held.id !== dependencies.renewalSourceId)
      throw new ConflictError('A personal bundle subscription already exists');
    const [created] = await tx
      .insert(personalPlanCheckoutIntents)
      .values({
        id: uuidv7(),
        subjectAccountId,
        ...namespace,
        idempotencyHash,
        requestHash,
        offerId: request.offerId,
        offerVersion: request.offerVersion,
        providerAccountRef: price.providerAccountId,
        offerKind,
        priceId: price.priceId,
        priceProvider: price.provider,
        priceKind,
        currency: price.currency,
        amountMinorUnits: price.amountMinorUnits,
        billingInterval: price.interval,
        priceValidFrom: new Date(price.validFrom),
        priceValidUntil: price.validUntil === null ? null : new Date(price.validUntil),
        state: 'reserved',
        renewalSourceId: dependencies.renewalSourceId ?? null,
      })
      .returning();
    return created;
  });
  return resumePersonalPlanCheckout(intent.id, {
    provider: dependencies.provider,
    now: dependencies.now,
  });
}

export function personalCheckoutSnapshotFromIntent(
  intent: typeof personalPlanCheckoutIntents.$inferSelect,
): PersonalCheckoutSnapshot | undefined {
  if (!intent.taxQuoteRef) return undefined;
  if (
    !intent.applicationRef ||
    !intent.customerRef ||
    !intent.planRef ||
    !intent.returnUrl ||
    !intent.taxQuoteCurrency ||
    intent.taxQuoteNetMinorUnits === null ||
    intent.taxQuoteTaxMinorUnits === null ||
    !intent.taxQuoteSellerRef ||
    !intent.taxQuoteInvoiceIssuerRef ||
    !intent.taxQuoteTaxRemitterRef ||
    !intent.taxQuoteTaxServiceRef ||
    !intent.taxQuoteCountry ||
    !intent.taxQuoteCoverageEvidenceRef ||
    !intent.taxQuoteTaxRateEvidenceRef ||
    !intent.taxQuoteCustomerLocationEvidenceRef ||
    !intent.taxQuoteQuotedAt ||
    !intent.taxQuoteExpiresAt ||
    !intent.taxQuoteQuotedAtLexeme ||
    !intent.taxQuoteExpiresAtLexeme ||
    !intent.taxQuoteSignatureKeyRef ||
    !intent.taxQuoteSignatureValue
  )
    throw new ConflictError('Stored checkout authority is incomplete');
  return {
    applicationId: intent.applicationRef,
    merchantId: intent.providerAccountRef,
    subjectAccountId: intent.subjectAccountId,
    planId: intent.planRef,
    customerId: intent.customerRef,
    offerId: intent.offerId,
    offerVersion: intent.offerVersion,
    priceId: intent.priceId,
    mode: intent.mode,
    environment: intent.environment,
    returnUrl: intent.returnUrl,
    taxQuote: {
      schemaVersion: 1,
      source: {
        merchantId: intent.providerAccountRef,
        appId: intent.applicationRef,
        storeId: intent.subjectAccountId,
        planId: intent.planRef,
        mode: billingNamespaceSchema.parse({ mode: intent.mode, environment: intent.environment })
          .mode,
        environment: z.enum(['development', 'staging', 'production']).parse(intent.environment),
      },
      quote: {
        id: intent.taxQuoteRef,
        currency: intent.taxQuoteCurrency,
        grossMinorUnits: intent.amountMinorUnits,
        netMinorUnits: intent.taxQuoteNetMinorUnits,
        taxMinorUnits: intent.taxQuoteTaxMinorUnits,
        taxTreatment: 'inclusive',
        sellerId: intent.taxQuoteSellerRef,
        invoiceIssuerId: intent.taxQuoteInvoiceIssuerRef,
        taxRemitterId: intent.taxQuoteTaxRemitterRef,
        taxServiceRef: intent.taxQuoteTaxServiceRef,
        country: intent.taxQuoteCountry,
        coverageEvidenceId: intent.taxQuoteCoverageEvidenceRef,
        taxRateEvidenceId: intent.taxQuoteTaxRateEvidenceRef,
        customerLocationEvidenceId: intent.taxQuoteCustomerLocationEvidenceRef,
        quotedAt: intent.taxQuoteQuotedAtLexeme,
        expiresAt: intent.taxQuoteExpiresAtLexeme,
      },
      signature: {
        algorithm: 'Ed25519',
        keyId: intent.taxQuoteSignatureKeyRef,
        value: intent.taxQuoteSignatureValue,
      },
    },
  };
}
/** Typed columns retain exact signed ISO lexemes alongside queryable timestamps. */
export function personalCheckoutSnapshotColumns(snapshot: PersonalCheckoutSnapshot) {
  const quote = snapshot.taxQuote.quote;
  return {
    returnUrl: snapshot.returnUrl,
    taxQuoteRef: quote.id,
    taxQuoteCurrency: quote.currency,
    taxQuoteNetMinorUnits: quote.netMinorUnits,
    taxQuoteTaxMinorUnits: quote.taxMinorUnits,
    taxQuoteSellerRef: quote.sellerId,
    taxQuoteInvoiceIssuerRef: quote.invoiceIssuerId,
    taxQuoteTaxRemitterRef: quote.taxRemitterId,
    taxQuoteTaxServiceRef: quote.taxServiceRef,
    taxQuoteCountry: quote.country,
    taxQuoteCoverageEvidenceRef: quote.coverageEvidenceId,
    taxQuoteTaxRateEvidenceRef: quote.taxRateEvidenceId,
    taxQuoteCustomerLocationEvidenceRef: quote.customerLocationEvidenceId,
    taxQuoteQuotedAt: sql`${quote.quotedAt}::timestamptz`,
    taxQuoteExpiresAt: sql`${quote.expiresAt}::timestamptz`,
    taxQuoteQuotedAtLexeme: quote.quotedAt,
    taxQuoteExpiresAtLexeme: quote.expiresAt,
    taxQuoteSignatureKeyRef: snapshot.taxQuote.signature.keyId,
    taxQuoteSignatureValue: snapshot.taxQuote.signature.value,
  };
}
function assertSnapshot(snapshot: PersonalCheckoutSnapshot, input: PersonalCheckoutInput) {
  const source = snapshot.taxQuote?.source;
  const quote = snapshot.taxQuote?.quote;
  if (
    !snapshot.applicationId ||
    !snapshot.planId ||
    !snapshot.customerId ||
    !snapshot.returnUrl ||
    new URL(snapshot.returnUrl).protocol !== 'https:' ||
    snapshot.merchantId !== input.providerAccountRef ||
    snapshot.subjectAccountId !== input.subjectAccountId ||
    snapshot.offerId !== input.offerId ||
    snapshot.offerVersion !== input.offerVersion ||
    snapshot.priceId !== input.priceId ||
    snapshot.mode !== input.mode ||
    snapshot.environment !== input.environment ||
    source?.merchantId !== snapshot.merchantId ||
    source.appId !== snapshot.applicationId ||
    source.storeId !== snapshot.subjectAccountId ||
    source.planId !== snapshot.planId ||
    source.mode !== snapshot.mode ||
    source.environment !== snapshot.environment ||
    snapshot.taxQuote.schemaVersion !== 1 ||
    snapshot.taxQuote.signature.algorithm !== 'Ed25519' ||
    quote?.grossMinorUnits !== input.amountMinorUnits ||
    quote.currency.toUpperCase() !== input.currency.toUpperCase() ||
    quote.taxTreatment !== 'inclusive' ||
    !Number.isFinite(Date.parse(quote.expiresAt))
  )
    throw new ConflictError('Prepared checkout authority differs');
}

/** Recover using the persisted authority and provider replay key, without browser input. */
export async function resumePersonalPlanCheckout(
  intentId: string,
  dependencies: { provider: PersonalCheckoutProvider; now?: Date },
): Promise<PersonalPlanCheckoutResult> {
  // Synthetic adapters never execute outside tests. Real adapters are opt-in.
  if (process.env.NODE_ENV !== 'test' && dependencies.provider?.kind !== 'peable')
    throw new ApiError(
      503,
      'Consumer checkout provider is unconfigured',
      'CHECKOUT_NOT_CONFIGURED',
    );
  const namespace = await assertBillingDatabaseNamespace(getDb());
  const clock = () => dependencies.now ?? new Date();
  const load = async () => {
    const [intent] = await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(
        and(
          eq(personalPlanCheckoutIntents.id, intentId),
          eq(personalPlanCheckoutIntents.mode, namespace.mode),
          eq(personalPlanCheckoutIntents.environment, namespace.environment),
        ),
      );
    if (!intent) throw new ConflictError('Checkout intent is unavailable');
    return intent;
  };
  let intent = await load();
  const terminal = (row: typeof intent): PersonalPlanCheckoutResult | undefined => {
    if (row.state === 'closed') return { state: 'closed', intentId: row.id };
    if (row.state === 'fulfilled') return { state: 'fulfilled', intentId: row.id };
    if (row.checkoutUrl)
      return personalPlanCheckoutResultSchema.parse({
        state: 'pending',
        intentId: row.id,
        ...(row.providerSessionExpiresAt && row.providerSessionExpiresAt <= clock()
          ? {}
          : { checkoutUrl: row.checkoutUrl }),
      });
    return undefined;
  };
  const existing = terminal(intent);
  if (existing) return existing;
  const input: PersonalCheckoutInput = {
    intentId,
    idempotencyKey: `personal-checkout:${intentId}`,
    subjectAccountId: intent.subjectAccountId,
    offerId: intent.offerId,
    offerVersion: intent.offerVersion,
    priceId: intent.priceId,
    amountMinorUnits: intent.amountMinorUnits,
    currency: intent.currency,
    providerAccountRef: intent.providerAccountRef,
    mode: intent.mode,
    environment: intent.environment,
    interval: intent.billingInterval,
    trial: 'none',
  };
  if (intent.renewalSourceId) {
    const [source] = await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(
        and(
          eq(accessSubscriptionSources.id, intent.renewalSourceId),
          eq(accessSubscriptionSources.payerAccountId, intent.subjectAccountId),
          eq(accessSubscriptionSources.beneficiaryAccountId, intent.subjectAccountId),
          eq(accessSubscriptionSources.provider, 'peable'),
          eq(accessSubscriptionSources.providerAccountRef, intent.providerAccountRef),
          eq(accessSubscriptionSources.mode, intent.mode),
          eq(accessSubscriptionSources.environment, intent.environment),
        ),
      );
    if (!source) throw new ConflictError('Renewal source unavailable');
    input.renewalSubscriptionId = source.providerSubscriptionId;
  }
  let snapshot = personalCheckoutSnapshotFromIntent(intent);
  if (!snapshot && dependencies.provider.prepare) {
    // Preparation can race. Only the first stored authority wins; losing quotes
    // are never dispatched and never replace the winner after timeout/restart.
    const prepared = await dependencies.provider.prepare(input);
    assertSnapshot(prepared, input);
    await getDb().transaction(async (tx) => {
      const [account] = await tx
        .select({ kind: users.kind, status: users.accountStatus })
        .from(users)
        .where(eq(users.id, intent.subjectAccountId))
        .for('update');
      const [fence] = await tx
        .select()
        .from(accountClosureFences)
        .where(eq(accountClosureFences.accountId, intent.subjectAccountId));
      if (account?.kind !== 'personal' || account.status !== 'active' || fence)
        throw new ApiError(403, 'Personal account is unavailable', 'ACCOUNT_UNAVAILABLE');
      const [current] = await tx
        .select()
        .from(personalPlanCheckoutIntents)
        .where(eq(personalPlanCheckoutIntents.id, intentId))
        .for('update');
      if (!current || current.state === 'closed') throw new ConflictError('Checkout closed');
      if (!current.taxQuoteRef && current.state !== 'fulfilled')
        await tx
          .update(personalPlanCheckoutIntents)
          .set({
            applicationRef: prepared.applicationId,
            customerRef: prepared.customerId,
            planRef: prepared.planId,
            ...personalCheckoutSnapshotColumns(prepared),
          })
          .where(eq(personalPlanCheckoutIntents.id, intentId));
    });
    intent = await load();
    const result = terminal(intent);
    if (result) return result;
    snapshot = personalCheckoutSnapshotFromIntent(intent);
  }
  if (!snapshot && dependencies.provider.kind !== 'synthetic')
    throw new ConflictError('Checkout authority is unavailable');
  if (snapshot) {
    assertSnapshot(snapshot, input);
    if (Date.parse(snapshot.taxQuote.quote.expiresAt) <= clock().getTime())
      return { state: 'pending', intentId };
  }
  // Recheck closure before dispatch; no remote work runs under an account lock.
  const beforeDispatch = await getDb().transaction(async (tx) => {
    const [account] = await tx
      .select({ kind: users.kind, status: users.accountStatus })
      .from(users)
      .where(eq(users.id, intent.subjectAccountId))
      .for('update');
    const [fence] = await tx
      .select()
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, intent.subjectAccountId));
    if (account?.kind !== 'personal' || account.status !== 'active' || fence)
      throw new ApiError(403, 'Personal account is unavailable', 'ACCOUNT_UNAVAILABLE');
    const [current] = await tx
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.id, intentId))
      .for('update');
    if (!current) throw new ConflictError('Checkout intent is unavailable');
    return terminal(current);
  });
  if (beforeDispatch) return beforeDispatch;
  const session = await dependencies.provider.create({ ...input, snapshot });
  personalPlanCheckoutResultSchema.parse({
    state: 'pending',
    intentId,
    checkoutUrl: session.checkoutUrl,
  });
  if (
    !session.sessionId ||
    session.sessionId.length > 160 ||
    (session.expiresAt !== undefined && !Number.isFinite(Date.parse(session.expiresAt)))
  )
    throw new ConflictError('Provider session identity differs');
  await getDb().transaction(async (tx) => {
    const [account] = await tx
      .select({ status: users.accountStatus })
      .from(users)
      .where(eq(users.id, intent.subjectAccountId))
      .for('update');
    const [fence] = await tx
      .select()
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, intent.subjectAccountId));
    if (account?.status !== 'active' || fence)
      throw new ApiError(403, 'Personal account is unavailable', 'ACCOUNT_UNAVAILABLE');
    const [current] = await tx
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.id, intentId))
      .for('update');
    if (
      !current ||
      current.state === 'closed' ||
      (current.providerSessionId &&
        (current.providerSessionId !== session.sessionId ||
          current.checkoutUrl !== session.checkoutUrl ||
          current.providerSessionExpiresAt?.toISOString() !== session.expiresAt))
    )
      throw new ConflictError('Provider checkout replay differs');
    if (current.state !== 'fulfilled')
      await tx
        .update(personalPlanCheckoutIntents)
        .set({
          state: 'pending',
          providerSessionId: session.sessionId,
          checkoutUrl: session.checkoutUrl,
          providerSessionExpiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
        })
        .where(eq(personalPlanCheckoutIntents.id, intentId));
  });
  intent = await load();
  return terminal(intent) ?? { state: 'pending', intentId };
}

/** Trusted adapter observation only: never exposed as a browser cancellation endpoint.
 * A provider must prove the exact session is terminal and cannot charge before release.
 */
export async function closePersonalPlanCheckoutFromProvider(input: {
  intentId: string;
  subjectAccountId: string;
  mode: string;
  environment: string;
  providerAccountRef: string;
  providerSessionId: string;
  reason: 'expired' | 'canceled';
}) {
  return getDb().transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.subjectAccountId))
      .for('update');
    const [intent] = await tx
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.id, input.intentId))
      .for('update');
    if (
      !intent ||
      intent.subjectAccountId !== input.subjectAccountId ||
      intent.mode !== input.mode ||
      intent.environment !== input.environment ||
      intent.providerAccountRef !== input.providerAccountRef ||
      intent.providerSessionId !== input.providerSessionId ||
      intent.state === 'fulfilled'
    )
      throw new ConflictError('Terminal checkout observation differs');
    if (intent.state === 'closed' && intent.closedReason !== input.reason)
      throw new ConflictError('Terminal checkout observation differs');
    await tx
      .update(personalPlanCheckoutIntents)
      .set({ state: 'closed', closedReason: input.reason })
      .where(eq(personalPlanCheckoutIntents.id, intent.id));
  });
}

export async function startProductPlanCheckout(
  subjectAccountId: string,
  raw: ProductPlanCheckoutRequest,
  dependencies: Omit<
    NonNullable<Parameters<typeof startPersonalPlanCheckout>[2]>,
    'productId'
  > = {},
): Promise<PersonalPlanCheckoutResult> {
  const { productId, ...request } = productPlanCheckoutRequestSchema.parse(raw);
  const catalogue = productBillingCatalogueSchema.parse(
    dependencies.catalogue ?? (await loadProductBillingCatalogue()),
  );
  const offer = catalogue.offers.find(
    (o) => o.id === request.offerId && o.version === request.offerVersion,
  );
  if (
    offer?.kind !== 'individual' ||
    !offer.benefits.length ||
    offer.benefits.some((b) => b.productId !== productId)
  )
    return { state: 'unconfigured', reason: 'offer_unconfigured' };
  return startPersonalPlanCheckout(subjectAccountId, request, {
    ...dependencies,
    catalogue,
    productId,
  });
}
