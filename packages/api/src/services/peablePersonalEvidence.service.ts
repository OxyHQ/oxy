import { integerCheck, isoDateTime, utf16MinLength } from '@oxy.so/contracts';
import { billingNamespaceSchema } from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import {
  accessSubscriptionSources,
  accessProviderPeriods,
  personalPlanCheckoutIntents,
} from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { reconcileProductAccessFinancialState } from './productAccessPersistence.service';
import { z } from 'zod';
import { oxyAccountIdSchema } from '@oxy.so/contracts';
import type { Peable, BillingPaidInvoice, BillingInvoiceState } from '@peable.to/sdk';
import {
  recordProductProviderPeriod,
  revokeProductProviderPaidPeriod,
  type ProductProviderPeriodInput,
} from './productProviderEvidence.service';
import {
  validatePersonalInvoiceForAction,
  personalFinalInvoiceSchema,
} from './peablePersonalBilling.service';
export const peablePaidEvidenceSchema = z
  .object({
    invoiceId: z.string().check(utf16MinLength(1)),
    lineId: z.string().check(utf16MinLength(1)),
    paymentIntentId: z.string().check(utf16MinLength(1)),
    providerSubscriptionId: z.string().check(utf16MinLength(1)),
    providerCustomerId: z.string().check(utf16MinLength(1)),
    providerPriceId: z.string().check(utf16MinLength(1)),
    storeId: z.string().check(utf16MinLength(1)),
    planId: z.string().check(utf16MinLength(1)),
    livemode: z.boolean(),
    currency: z.literal('USD'),
    amountPaid: z.string().regex(/^[1-9][0-9]*$/),
    netAmount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    taxAmount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    periodStart: z.string().check(isoDateTime()),
    periodEnd: z.string().check(isoDateTime()),
    paidAt: z.string().check(isoDateTime()),
    observedAt: z.string().check(isoDateTime()),
  })
  .strict();
/** Normalize the authenticated SDK wire response into Oxy's durable evidence shape. */
function paidEvidenceFromWire(value: BillingPaidInvoice) {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    invoiceId: value.invoice_id,
    lineId: value.line_id,
    paymentIntentId: value.payment_intent_id,
    providerSubscriptionId: value.provider_subscription_id,
    providerCustomerId: value.provider_customer_id,
    providerPriceId: value.provider_price_id,
    storeId: value.store_id,
    planId: value.plan_id,
    livemode: value.livemode,
    currency: value.currency,
    amountPaid: value.amount_paid,
    netAmount: value.net_amount,
    taxAmount: value.tax_amount,
    periodStart: iso(value.period_start),
    periodEnd: iso(value.period_end),
    paidAt: iso(value.paid_at),
    observedAt: iso(value.observed_at),
  };
}
export interface PeableInvoiceSource {
  invoiceId: string;
  paymentIntentId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  planId: string;
  merchantId: string;
  appId: string;
  mode: 'live' | 'test';
  environment: 'production' | 'test' | 'development' | 'staging';
}
export interface PeableEvidenceAuthority {
  /** Authenticated server read through the updated Peable SDK, not browser data. */
  client: Pick<Peable, 'merchants'> & {
    billing: Pick<
      Peable['billing'],
      'retrievePaidInvoice' | 'retrieveInvoiceState' | 'retrieveSubscription'
    >;
  };
  /** Verified SDK authority; no local fiscal or FX default. */
  readFinalInvoiceAuthority?: (
    source: PeableInvoiceSource,
  ) => Promise<{ source: PeableInvoiceSource; invoice: unknown; method: 'card' | 'faircoin' }>;
}
/** The SDK checks the signed envelope using deployment-pinned keys before this
 * consumer checks its exact frozen source. No response-provided key is trusted. */
export function createPeablePersonalEvidenceAuthority(client: Peable): PeableEvidenceAuthority {
  return {
    client,
    readFinalInvoiceAuthority: async (source) => {
      const value = await client.billing.retrieveFinalInvoiceAuthority(
        source.subscriptionId,
        source.invoiceId,
      );
      const actual: PeableInvoiceSource = {
        invoiceId: value.source.invoice_id,
        paymentIntentId: value.source.payment_intent_id,
        customerId: value.source.customer_id,
        subscriptionId: value.source.subscription_id,
        priceId: value.source.price_id,
        planId: value.source.plan_id,
        merchantId: value.source.merchant_id,
        appId: value.source.app_id,
        mode: value.source.mode,
        environment: value.source.environment,
      };
      if (
        (Object.keys(source) as (keyof PeableInvoiceSource)[]).some(
          (key) => actual[key] !== source[key],
        )
      )
        throw new Error('Peable authoritative invoice source differs');
      const invoice = value.invoice;
      const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
      return {
        source: actual,
        method: value.method,
        invoice: personalFinalInvoiceSchema.parse({
          platform: invoice.platform,
          currency: invoice.currency,
          grossMinorUnits: invoice.gross_minor_units,
          netMinorUnits: invoice.net_minor_units,
          taxMinorUnits: invoice.tax_minor_units,
          merchantFeeMinorUnits: invoice.merchant_fee_minor_units,
          taxTreatment: invoice.tax_treatment,
          sellerId: invoice.seller_id,
          invoiceIssuerId: invoice.invoice_issuer_id,
          taxQuoteId: invoice.tax_quote_id,
          customerLocationEvidenceId: invoice.customer_location_evidence_id,
          taxRateEvidenceId: invoice.tax_rate_evidence_id,
          context: {
            payerAccountId: invoice.context.payer_account_id,
            beneficiaryAccountId: invoice.context.beneficiary_account_id,
            providerSubscriptionId: invoice.context.provider_subscription_id,
            offerId: invoice.context.offer_id,
            offerVersion: invoice.context.offer_version,
            periodStart: iso(invoice.context.period_start),
            periodEnd: iso(invoice.context.period_end),
            mode: invoice.context.mode,
            environment: invoice.context.environment,
          },
          issuedAt: iso(invoice.issued_at),
          expiresAt: iso(invoice.expires_at),
          ...(invoice.faircoin_quote
            ? {
                faircoinQuote: {
                  id: invoice.faircoin_quote.id,
                  amountBaseUnits: invoice.faircoin_quote.amount_base_units,
                  quotedAt: iso(invoice.faircoin_quote.quoted_at),
                  expiresAt: iso(invoice.faircoin_quote.expires_at),
                  roundingEvidenceId: invoice.faircoin_quote.rounding_evidence_id,
                },
              }
            : {}),
        }),
      };
    },
  };
}
export interface PeablePersonalPaidContext {
  /** Present only for the immutable initial paid invoice of an owned checkout. */
  checkoutIntentId?: string;
  /** Frozen central catalogue, never provider-reported commercial selection. */
  amountMinorUnits?: number;
  interval?: 'month' | 'year';
  origin?: 'individual' | 'bundle';
  accountId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  planId: string;
  merchantId: string;
  appId: string;
  mode: 'live' | 'test';
  environment: 'production' | 'test' | 'development' | 'staging';
  offerId: string;
  offerVersion: number;
}
async function assertPeableEvidenceOwner(
  authority: PeableEvidenceAuthority,
  context: PeablePersonalPaidContext,
) {
  billingNamespaceSchema.parse({ mode: context.mode, environment: context.environment });
  if (!authority.client.merchants?.retrieve)
    throw new Error('Authenticated Peable merchant read unconfigured');
  const merchant = await authority.client.merchants.retrieve();
  if (
    merchant.id !== context.merchantId ||
    merchant.oxy_app_id !== context.appId ||
    merchant.environment !== context.environment
  )
    throw new Error('Peable credential owner differs');
}
/** Shared trusted context is frozen from an owned checkout/source and reviewed offer,
 * not metadata. Remains closed until real SDK and tax authority are supported. */
export async function reconcilePeablePersonalPaidInvoice(
  authority: PeableEvidenceAuthority,
  context: PeablePersonalPaidContext,
  invoiceId: string,
  clock: () => Date = () => new Date(),
) {
  if (!authority.client.billing.retrievePaidInvoice || !authority.readFinalInvoiceAuthority)
    throw new Error('Authoritative Peable evidence is unconfigured');
  await assertPeableEvidenceOwner(authority, context);
  const paid: BillingPaidInvoice = await authority.client.billing.retrievePaidInvoice(
    context.subscriptionId,
    invoiceId,
  );
  const value = peablePaidEvidenceSchema.parse(paidEvidenceFromWire(paid));
  const validateTime = () => {
    const now = clock();
    if (
      value.amountPaid !== String(context.amountMinorUnits ?? 2999) ||
      value.invoiceId !== invoiceId ||
      value.providerSubscriptionId !== context.subscriptionId ||
      value.providerCustomerId !== context.customerId ||
      value.providerPriceId !== context.priceId ||
      value.storeId !== context.accountId ||
      value.planId !== context.planId ||
      value.livemode !== (context.mode === 'live') ||
      Date.parse(value.observedAt) > now.getTime() ||
      now.getTime() - Date.parse(value.observedAt) > 60_000 ||
      Date.parse(value.paidAt) > now.getTime() ||
      Date.parse(value.periodEnd) <= Date.parse(value.periodStart)
    )
      throw new Error('Peable paid period ownership/time differs');
  };
  validateTime();
  const source: PeableInvoiceSource = {
    invoiceId: value.invoiceId,
    paymentIntentId: value.paymentIntentId,
    customerId: context.customerId,
    subscriptionId: context.subscriptionId,
    priceId: context.priceId,
    planId: context.planId,
    merchantId: context.merchantId,
    appId: context.appId,
    mode: context.mode,
    environment: context.environment,
  };
  const authorityResult = await authority.readFinalInvoiceAuthority(Object.freeze({ ...source }));
  if (
    !authorityResult.source ||
    Object.keys(source).some(
      (k) =>
        authorityResult.source[k as keyof PeableInvoiceSource] !==
        source[k as keyof PeableInvoiceSource],
    )
  )
    throw new Error('Peable authoritative invoice source differs');
  const method = z.enum(['card', 'faircoin']).parse(authorityResult.method);
  const validateInvoice = () =>
    validatePersonalInvoiceForAction(
      authorityResult.invoice,
      {
        payerAccountId: context.accountId,
        beneficiaryAccountId: context.accountId,
        providerSubscriptionId: context.subscriptionId,
        offerId: context.offerId,
        offerVersion: context.offerVersion,
        periodStart: value.periodStart,
        periodEnd: value.periodEnd,
        mode: context.mode,
        environment: context.environment,
      },
      method,
      clock(),
      new Date(value.paidAt),
      context.amountMinorUnits ?? 2999,
    );
  const invoice = validateInvoice();
  if (
    value.netAmount === null ||
    value.taxAmount === null ||
    BigInt(value.netAmount) !== BigInt(invoice.netMinorUnits) ||
    BigInt(value.taxAmount) !== BigInt(invoice.taxMinorUnits)
  )
    throw new Error('Peable authoritative invoice totals differ');
  // Replays retain the original immutable initial-checkout attribution. This
  // lookup is local and exact; later subscription invoices never inherit it.
  const initialIntents = await getDb()
    .select({ id: personalPlanCheckoutIntents.id })
    .from(personalPlanCheckoutIntents)
    .where(
      and(
        eq(personalPlanCheckoutIntents.subjectAccountId, context.accountId),
        eq(personalPlanCheckoutIntents.providerAccountRef, context.merchantId),
        eq(personalPlanCheckoutIntents.mode, context.mode),
        eq(personalPlanCheckoutIntents.environment, context.environment),
        eq(personalPlanCheckoutIntents.initialInvoiceId, invoiceId),
        eq(personalPlanCheckoutIntents.state, 'fulfilled'),
      ),
    );
  if (
    initialIntents.length > 1 ||
    (context.checkoutIntentId &&
      initialIntents.length &&
      initialIntents[0].id !== context.checkoutIntentId)
  )
    throw new Error('Peable initial checkout attribution differs');
  const checkoutIntentId = context.checkoutIntentId ?? initialIntents[0]?.id;
  const accountId = oxyAccountIdSchema.parse(context.accountId);
  const input: ProductProviderPeriodInput = {
    ...(checkoutIntentId ? { checkoutIntentId } : {}),
    binding: {
      providerAccountRef: context.merchantId,
      mode: context.mode,
      environment: context.environment,
    },
    subscription: {
      schemaVersion: 1,
      beneficiaryAccountId: accountId,
      payerAccountId: accountId,
      provider: 'peable',
      providerSubscriptionId: context.subscriptionId,
      status: 'active',
      period: { start: value.periodStart, end: value.periodEnd },
      cancelAtPeriodEnd: false,
    },
    offer: {
      offerId: context.offerId,
      offerVersion: context.offerVersion,
      origin: context.origin ?? 'bundle',
    },
    paidLine: {
      invoiceId: value.invoiceId,
      lineId: value.lineId,
      priceId: value.providerPriceId,
      quantity: 1,
      period: { start: value.periodStart, end: value.periodEnd },
    },
    event: { id: `peable-read:${value.invoiceId}:${value.lineId}`, createdAt: value.paidAt },
    providerObservedAt: new Date(value.observedAt),
  };
  // Only paid period is authoritative here. Do not overwrite cancellation/status
  // from an invoice read: read fresh subscription via the same owned SDK mapping.
  const subscription = await authority.client.billing.retrieveSubscription(context.subscriptionId);
  const subscriptionObservedAt = clock();
  input.providerObservedAt = subscriptionObservedAt;
  if (
    subscription.provider_subscription_id !== context.subscriptionId ||
    subscription.interval !== (context.interval ?? 'month') ||
    subscription.trial_ends_at !== null ||
    subscription.store_id !== context.accountId ||
    subscription.plan_id !== context.planId ||
    subscription.provider_customer_id !== context.customerId ||
    subscription.provider_price_id !== context.priceId ||
    subscription.livemode !== (context.mode === 'live') ||
    !Number.isFinite(subscription.current_period_start * 1000) ||
    !Number.isFinite(subscription.current_period_end * 1000) ||
    subscription.current_period_end * 1000 <= subscription.current_period_start * 1000 ||
    Date.parse(value.periodEnd) > subscription.current_period_end * 1000 ||
    (Date.parse(value.periodStart) < subscription.current_period_start * 1000 &&
      Date.parse(value.periodEnd) > subscription.current_period_start * 1000)
  )
    throw new Error('Peable current subscription differs');
  input.subscription.period = {
    start: new Date(subscription.current_period_start * 1000).toISOString(),
    end: new Date(subscription.current_period_end * 1000).toISOString(),
  };
  input.subscription.status = subscription.status;
  input.subscription.cancelAtPeriodEnd = subscription.cancel_at_period_end;
  validateTime();
  validateInvoice();
  const result = await recordProductProviderPeriod(input, undefined, {
    verifiedHistoricalPaidEvidence: true,
    quotaWindow:
      context.interval === 'year' && context.origin === 'individual' ? 'month' : undefined,
  });
  // A paid-line replay does not update an existing source snapshot. Explicitly
  // reconcile the later owned subscription read, preserving cancellation/status.
  await reconcileProductAccessFinancialState({
    sourceId: result.sourceId,
    beneficiaryAccountId: context.accountId,
    payerAccountId: context.accountId,
    provider: 'peable',
    providerSubscriptionId: context.subscriptionId,
    providerBinding: input.binding,
    providerObservedAt: subscriptionObservedAt,
    status: subscription.status,
    period: {
      start: new Date(subscription.current_period_start * 1000).toISOString(),
      end: new Date(subscription.current_period_end * 1000).toISOString(),
    },
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
  return result;
}
export type PersonalInvoiceAuthority = z.infer<typeof personalFinalInvoiceSchema>;

/** Wake-up reconciliation: never grant from webhook amounts/status. The
 * authenticated SDK re-read determines current state even for delayed paid events.
 * Partial refund policy is unselected: report review_required, no proportional grant.
 * Existing paid-period evidence is required before exact-line revocation. */
export async function reconcilePeablePersonalInvoiceState(
  authority: PeableEvidenceAuthority,
  context: PeablePersonalPaidContext,
  invoiceId: string,
  clock: () => Date = () => new Date(),
) {
  if (!authority.client.billing.retrieveInvoiceState)
    throw new Error('Authoritative Peable invoice state unconfigured');
  await assertPeableEvidenceOwner(authority, context);
  const invoiceState: BillingInvoiceState = await authority.client.billing.retrieveInvoiceState(
    context.subscriptionId,
    invoiceId,
  );
  const value = peablePaidEvidenceSchema
    .extend({
      chargeId: z.string().check(utf16MinLength(1)),
      amountRefunded: z.string().regex(/^(0|[1-9][0-9]*)$/),
      state: z.enum(['paid', 'fully_refunded', 'partially_refunded']),
    })
    .parse({
      ...paidEvidenceFromWire(invoiceState),
      chargeId: invoiceState.charge_id,
      amountRefunded: invoiceState.amount_refunded,
      state: invoiceState.state,
    });
  const now = clock().getTime();
  if (
    value.amountPaid !== String(context.amountMinorUnits ?? 2999) ||
    value.invoiceId !== invoiceId ||
    value.providerSubscriptionId !== context.subscriptionId ||
    value.providerCustomerId !== context.customerId ||
    value.providerPriceId !== context.priceId ||
    value.storeId !== context.accountId ||
    value.planId !== context.planId ||
    value.livemode !== (context.mode === 'live') ||
    Date.parse(value.observedAt) > now ||
    now - Date.parse(value.observedAt) > 60_000 ||
    Date.parse(value.paidAt) > now
  )
    throw new Error('Peable invoice state ownership/time differs');
  const refunded = BigInt(value.amountRefunded),
    paid = BigInt(value.amountPaid);
  if (
    (value.state === 'paid' && refunded !== BigInt(0)) ||
    (value.state === 'fully_refunded' && refunded !== paid) ||
    (value.state === 'partially_refunded' && (refunded <= BigInt(0) || refunded >= paid))
  )
    throw new Error('Peable refund amount differs');
  if (value.state === 'paid') {
    if (Date.parse(value.periodEnd) <= now) {
      const [period] = await getDb()
        .select()
        .from(accessProviderPeriods)
        .where(
          and(
            eq(accessProviderPeriods.provider, 'peable'),
            eq(accessProviderPeriods.providerAccountRef, context.merchantId),
            eq(accessProviderPeriods.mode, context.mode),
            eq(accessProviderPeriods.environment, context.environment),
            eq(accessProviderPeriods.invoiceId, value.invoiceId),
            eq(accessProviderPeriods.lineId, value.lineId),
          ),
        );
      if (!period) return reconcilePeablePersonalPaidInvoice(authority, context, invoiceId, clock);
      if (
        period.payerAccountId !== context.accountId ||
        period.beneficiaryAccountId !== context.accountId ||
        period.providerSubscriptionId !== context.subscriptionId ||
        period.priceId !== context.priceId ||
        period.offerId !== context.offerId ||
        period.offerVersion !== context.offerVersion ||
        period.periodStart.toISOString() !== value.periodStart ||
        period.periodEnd.toISOString() !== value.periodEnd
      )
        throw new Error('Peable historical paid ownership differs');
      return {
        status: 'historical_replayed' as const,
        sourceId: period.sourceId,
        segmentId: period.segmentId,
      };
    }
    return reconcilePeablePersonalPaidInvoice(authority, context, invoiceId, clock);
  }
  if (value.state === 'partially_refunded')
    return {
      status: 'review_required' as const,
      reason: 'partial_refund_entitlement_policy_unconfigured' as const,
    };
  return revokeProductProviderPaidPeriod({
    binding: {
      providerAccountRef: context.merchantId,
      mode: context.mode,
      environment: context.environment,
    },
    accountId: context.accountId,
    subscriptionId: context.subscriptionId,
    invoiceId: value.invoiceId,
    lineId: value.lineId,
    priceId: value.providerPriceId,
    paymentIntentId: value.paymentIntentId,
    chargeId: value.chargeId,
    period: { start: value.periodStart, end: value.periodEnd },
    observedAt: new Date(value.observedAt),
  });
}

/** Secrets supplied only by approved server composition. Updated SDK HMAC/timestamp
 * verification is mandatory; verified bytes still carry no payer/plan authority. */
export function createPeableObservationVerifier(client: Pick<Peable, 'webhooks'>, secret: string) {
  if (!secret) throw new Error('Peable observation signing is unconfigured');
  return (rawBody: string, signature: string): unknown =>
    client.webhooks.constructEvent(rawBody, signature, secret);
}
export const peablePersonalObservationSchema = z
  .object({
    id: z.string().check(utf16MinLength(1)),
    object: z.literal('event'),
    type: z.literal('billing.observation.updated'),
    livemode: z.boolean(),
    created: z.number().check(integerCheck()).nonnegative(),
    data: z
      .object({
        object: z
          .object({
            object: z.literal('billing_observation'),
            livemode: z.boolean(),
            resource_kind: z.enum(['subscription', 'invoice']),
            resource_id: z.string().check(utf16MinLength(1)),
            subscription_id: z.string().check(utf16MinLength(1)).optional(),
            revision: z.number().check(integerCheck()).positive(),
            observed_at: z.number().check(integerCheck()).nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (event) => event.livemode === event.data.object.livemode,
    'Peable observation mode differs',
  );
/** Context comes from the server's existing owner-bound
 * checkout/source, never from delivery fields. Replays reread current provider state. */
export async function handlePeablePersonalObservation(
  authority: PeableEvidenceAuthority,
  context: PeablePersonalPaidContext,
  rawBody: string,
  signature: string,
  verify: (body: string, signature: string) => unknown | Promise<unknown>,
  clock: () => Date = () => new Date(),
) {
  if (Buffer.byteLength(rawBody) > 1_048_576) throw new Error('Peable observation body too large');
  const event = peablePersonalObservationSchema.parse(await verify(rawBody, signature));
  if (event.livemode !== (context.mode === 'live'))
    throw new Error('Peable observation mode differs');
  await assertPeableEvidenceOwner(authority, context);
  const resource = event.data.object;
  if (resource.resource_kind === 'invoice')
    return reconcilePeablePersonalInvoiceState(authority, context, resource.resource_id, clock);
  if (resource.resource_id !== context.subscriptionId)
    throw new Error('Peable observation subscription differs');
  const sub = await authority.client.billing.retrieveSubscription(context.subscriptionId);
  const subscriptionObservedAt = clock();
  if (
    sub.provider_subscription_id !== context.subscriptionId ||
    sub.provider_customer_id !== context.customerId ||
    sub.provider_price_id !== context.priceId ||
    sub.store_id !== context.accountId ||
    sub.plan_id !== context.planId ||
    sub.livemode !== (context.mode === 'live')
  )
    throw new Error('Peable observation ownership differs');
  const [source] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(
      and(
        eq(accessSubscriptionSources.provider, 'peable'),
        eq(accessSubscriptionSources.providerSubscriptionId, context.subscriptionId),
        eq(accessSubscriptionSources.providerAccountRef, context.merchantId),
        eq(accessSubscriptionSources.payerAccountId, context.accountId),
        eq(accessSubscriptionSources.beneficiaryAccountId, context.accountId),
        eq(accessSubscriptionSources.mode, context.mode),
        eq(accessSubscriptionSources.environment, context.environment),
      ),
    );
  if (!source) return { status: 'not_recorded' as const };
  return {
    status: await reconcileProductAccessFinancialState({
      sourceId: source.id,
      beneficiaryAccountId: context.accountId,
      payerAccountId: context.accountId,
      provider: 'peable',
      providerSubscriptionId: context.subscriptionId,
      providerBinding: {
        providerAccountRef: context.merchantId,
        mode: context.mode,
        environment: context.environment,
      },
      providerObservedAt: subscriptionObservedAt,
      status: sub.status,
      period: {
        start: new Date(sub.current_period_start * 1000).toISOString(),
        end: new Date(sub.current_period_end * 1000).toISOString(),
      },
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    }),
  };
}

/** Applied/replayed outcomes complete reconciliation; no_invoice means recovery
 * found no invoice work. Unknown or review outcomes remain retryable. */
export function assertPeablePersonalReconciliationComplete(result: unknown): void {
  const parsed = z
    .object({
      status: z.enum([
        'recorded',
        'replayed',
        'historical_replayed',
        'fenced',
        'revoked',
        'updated',
        'stale',
        'no_invoice',
      ]),
    })
    .safeParse(result);
  if (!parsed.success) throw new Error('Peable personal reconciliation deferred');
}
