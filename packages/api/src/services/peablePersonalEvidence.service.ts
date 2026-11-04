import { utf16MinLength } from '@oxy.so/contracts';
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
import type { Peable, BillingPaidInvoice, BillingInvoiceState, WebhookEvent } from '@peable.to/sdk';
import {
  recordProductProviderPeriod,
  revokeProductProviderPaidPeriod,
  type ProductProviderPeriodInput,
} from './productProviderEvidence.service';
import {
  peableInstantToIso,
  peableUnixSecondsSchema,
  validatePersonalInvoiceForAction,
  type personalFinalInvoiceSchema,
} from './peablePersonalBilling.service';
export const peablePaidEvidenceSchema = z
  .object({
    invoice_id: z.string().check(utf16MinLength(1)),
    line_id: z.string().check(utf16MinLength(1)),
    payment_intent_id: z.string().check(utf16MinLength(1)),
    provider_subscription_id: z.string().check(utf16MinLength(1)),
    provider_customer_id: z.string().check(utf16MinLength(1)),
    provider_price_id: z.string().check(utf16MinLength(1)),
    store_id: z.string().check(utf16MinLength(1)),
    plan_id: z.string().check(utf16MinLength(1)),
    livemode: z.boolean(),
    currency: z.literal('USD'),
    amount_paid: z.string().regex(/^[1-9][0-9]*$/),
    net_amount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    tax_amount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    period_start: peableUnixSecondsSchema,
    period_end: peableUnixSecondsSchema,
    paid_at: peableUnixSecondsSchema,
    observed_at: peableUnixSecondsSchema,
  })
  .strict();
/** Peable's signed invoice authority source, on its wire (ADR 0014). */
export interface PeableInvoiceSource {
  invoice_id: string;
  payment_intent_id: string;
  customer_id: string;
  subscription_id: string;
  price_id: string;
  plan_id: string;
  merchant_id: string;
  app_id: string;
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
        source.subscription_id,
        source.invoice_id,
      );
      if (
        Object.keys(source).some(
          (key) =>
            value.source[key as keyof PeableInvoiceSource] !==
            source[key as keyof PeableInvoiceSource],
        )
      )
        throw new Error('Peable authoritative invoice source differs');
      return { source: value.source, invoice: value.invoice, method: value.method };
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
  const value = peablePaidEvidenceSchema.parse(paid);
  const periodStart = peableInstantToIso(value.period_start),
    periodEnd = peableInstantToIso(value.period_end),
    paidAt = peableInstantToIso(value.paid_at);
  const validateTime = () => {
    const now = clock();
    if (
      value.amount_paid !== String(context.amountMinorUnits ?? 2999) ||
      value.invoice_id !== invoiceId ||
      value.provider_subscription_id !== context.subscriptionId ||
      value.provider_customer_id !== context.customerId ||
      value.provider_price_id !== context.priceId ||
      value.store_id !== context.accountId ||
      value.plan_id !== context.planId ||
      value.livemode !== (context.mode === 'live') ||
      value.observed_at * 1000 > now.getTime() ||
      now.getTime() - value.observed_at * 1000 > 60_000 ||
      value.paid_at * 1000 > now.getTime() ||
      value.period_end <= value.period_start
    )
      throw new Error('Peable paid period ownership/time differs');
  };
  validateTime();
  const source: PeableInvoiceSource = {
    invoice_id: value.invoice_id,
    payment_intent_id: value.payment_intent_id,
    customer_id: context.customerId,
    subscription_id: context.subscriptionId,
    price_id: context.priceId,
    plan_id: context.planId,
    merchant_id: context.merchantId,
    app_id: context.appId,
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
        payer_account_id: context.accountId,
        beneficiary_account_id: context.accountId,
        provider_subscription_id: context.subscriptionId,
        offer_id: context.offerId,
        offer_version: context.offerVersion,
        period_start: value.period_start,
        period_end: value.period_end,
        mode: context.mode,
        environment: context.environment,
      },
      method,
      clock(),
      new Date(paidAt),
      context.amountMinorUnits ?? 2999,
    );
  const invoice = validateInvoice();
  if (
    value.net_amount === null ||
    value.tax_amount === null ||
    BigInt(value.net_amount) !== BigInt(invoice.net_minor_units) ||
    BigInt(value.tax_amount) !== BigInt(invoice.tax_minor_units)
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
      period: { start: periodStart, end: periodEnd },
      cancelAtPeriodEnd: false,
    },
    offer: {
      offerId: context.offerId,
      offerVersion: context.offerVersion,
      origin: context.origin ?? 'bundle',
    },
    paidLine: {
      invoiceId: value.invoice_id,
      lineId: value.line_id,
      priceId: value.provider_price_id,
      quantity: 1,
      period: { start: periodStart, end: periodEnd },
    },
    event: { id: `peable-read:${value.invoice_id}:${value.line_id}`, createdAt: paidAt },
    providerObservedAt: new Date(value.observed_at * 1000),
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
    !peableUnixSecondsSchema.safeParse(subscription.current_period_start).success ||
    !peableUnixSecondsSchema.safeParse(subscription.current_period_end).success ||
    subscription.current_period_end <= subscription.current_period_start ||
    value.period_end > subscription.current_period_end ||
    (value.period_start < subscription.current_period_start &&
      value.period_end > subscription.current_period_start)
  )
    throw new Error('Peable current subscription differs');
  const currentPeriod = {
    start: peableInstantToIso(subscription.current_period_start),
    end: peableInstantToIso(subscription.current_period_end),
  };
  input.subscription.period = currentPeriod;
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
    period: currentPeriod,
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
      charge_id: z.string().check(utf16MinLength(1)),
      amount_refunded: z.string().regex(/^(0|[1-9][0-9]*)$/),
      state: z.enum(['paid', 'fully_refunded', 'partially_refunded']),
    })
    .parse(invoiceState);
  const now = clock().getTime();
  if (
    value.amount_paid !== String(context.amountMinorUnits ?? 2999) ||
    value.invoice_id !== invoiceId ||
    value.provider_subscription_id !== context.subscriptionId ||
    value.provider_customer_id !== context.customerId ||
    value.provider_price_id !== context.priceId ||
    value.store_id !== context.accountId ||
    value.plan_id !== context.planId ||
    value.livemode !== (context.mode === 'live') ||
    value.observed_at * 1000 > now ||
    now - value.observed_at * 1000 > 60_000 ||
    value.paid_at * 1000 > now
  )
    throw new Error('Peable invoice state ownership/time differs');
  const refunded = BigInt(value.amount_refunded),
    paid = BigInt(value.amount_paid);
  if (
    (value.state === 'paid' && refunded !== BigInt(0)) ||
    (value.state === 'fully_refunded' && refunded !== paid) ||
    (value.state === 'partially_refunded' && (refunded <= BigInt(0) || refunded >= paid))
  )
    throw new Error('Peable refund amount differs');
  if (value.state === 'paid') {
    if (value.period_end * 1000 <= now) {
      const [period] = await getDb()
        .select()
        .from(accessProviderPeriods)
        .where(
          and(
            eq(accessProviderPeriods.provider, 'peable'),
            eq(accessProviderPeriods.providerAccountRef, context.merchantId),
            eq(accessProviderPeriods.mode, context.mode),
            eq(accessProviderPeriods.environment, context.environment),
            eq(accessProviderPeriods.invoiceId, value.invoice_id),
            eq(accessProviderPeriods.lineId, value.line_id),
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
        period.periodStart.getTime() !== value.period_start * 1000 ||
        period.periodEnd.getTime() !== value.period_end * 1000
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
    invoiceId: value.invoice_id,
    lineId: value.line_id,
    priceId: value.provider_price_id,
    paymentIntentId: value.payment_intent_id,
    chargeId: value.charge_id,
    period: {
      start: peableInstantToIso(value.period_start),
      end: peableInstantToIso(value.period_end),
    },
    observedAt: new Date(value.observed_at * 1000),
  });
}

/** Secrets supplied only by approved server composition. The SDK verifies the
 * HMAC, the timestamp window and the event's shape (a `billing.observation.updated`
 * payload field by field); verified bytes still carry no payer/plan authority. */
export function createPeableObservationVerifier(client: Pick<Peable, 'webhooks'>, secret: string) {
  if (!secret) throw new Error('Peable observation signing is unconfigured');
  return (rawBody: string, signature: string): WebhookEvent =>
    client.webhooks.constructEvent(rawBody, signature, secret);
}
/** Context comes from the server's existing owner-bound
 * checkout/source, never from delivery fields. Replays reread current provider state. */
export async function handlePeablePersonalObservation(
  authority: PeableEvidenceAuthority,
  context: PeablePersonalPaidContext,
  rawBody: string,
  signature: string,
  verify: (body: string, signature: string) => WebhookEvent | Promise<WebhookEvent>,
  clock: () => Date = () => new Date(),
) {
  if (Buffer.byteLength(rawBody) > 1_048_576) throw new Error('Peable observation body too large');
  const event = await verify(rawBody, signature);
  if (event.type !== 'billing.observation.updated')
    throw new Error('Peable observation event type differs');
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
        start: peableInstantToIso(sub.current_period_start),
        end: peableInstantToIso(sub.current_period_end),
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
