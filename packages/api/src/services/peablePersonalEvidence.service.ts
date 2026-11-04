import { and, eq } from 'drizzle-orm';
import { oxyAccountIdSchema } from '@oxy.so/contracts';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { billingNamespaceSchema } from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import { accessProviderPeriods, personalPlanCheckoutIntents } from '../db/schema';
import { reconcileProductAccessFinancialState } from './productAccessPersistence.service';
import {
  recordProductProviderPeriod,
  revokeProductProviderPaidPeriod,
  type ProductProviderPeriodInput,
} from './productProviderEvidence.service';
import {
  peableAmountSchema,
  peableInstantToIso,
  peableReference,
  peableUnixSecondsSchema,
  readNativeSubscription,
  type PeableNativeSubscription,
} from './peablePersonalBilling.service';

/** The native Orbit objects paid-period evidence is read from — over Oxy's own
 * authenticated workload channel, never from a delivery body or a browser. */
export type PeableEvidenceClient = Pick<
  Peable,
  'merchants' | 'invoices' | 'subscriptions' | 'paymentIntents'
>;

export interface PeablePersonalPaidContext {
  /** Present only for the immutable initial paid invoice of an owned checkout. */
  checkoutIntentId?: string;
  /** Frozen central catalogue, never provider-reported commercial selection. */
  amountMinorUnits: number;
  interval: 'month' | 'year';
  origin: 'individual' | 'bundle';
  accountId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  merchantId: string;
  appId: string;
  mode: 'live' | 'test';
  environment: 'production' | 'test' | 'development' | 'staging';
  offerId: string;
  offerVersion: number;
}

async function assertPeableEvidenceOwner(
  client: PeableEvidenceClient,
  context: PeablePersonalPaidContext,
) {
  billingNamespaceSchema.parse({ mode: context.mode, environment: context.environment });
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== context.merchantId ||
    merchant.oxy_app_id !== context.appId ||
    merchant.environment !== context.environment
  )
    throw new Error('Peable credential owner differs');
}

/** The native subscription, bound to the persisted context. */
export async function readOwnedPeableSubscription(
  client: Pick<Peable, 'subscriptions'>,
  context: Pick<
    PeablePersonalPaidContext,
    'subscriptionId' | 'customerId' | 'priceId' | 'mode' | 'interval'
  >,
): Promise<PeableNativeSubscription> {
  const subscription = readNativeSubscription(
    await client.subscriptions.retrieve(context.subscriptionId),
  );
  if (
    subscription.id !== context.subscriptionId ||
    subscription.customerId !== context.customerId ||
    subscription.priceId !== context.priceId ||
    subscription.livemode !== (context.mode === 'live') ||
    subscription.interval !== context.interval ||
    subscription.trialEnd !== null
  )
    throw new Error('Peable current subscription differs');
  return subscription;
}

interface PaidInvoiceEvidence {
  invoiceId: string;
  lineId: string;
  priceId: string;
  paymentIntentId: string;
  periodStart: number;
  periodEnd: number;
  paidAt: number;
  amountPaid: string;
}

/** One paid invoice of the context's subscription: the exact approved price,
 * one line of quantity one, tax-inclusive totals that add up, paid in full. */
async function readPaidInvoice(
  client: PeableEvidenceClient,
  context: PeablePersonalPaidContext,
  invoiceId: string,
  now: Date,
): Promise<PaidInvoiceEvidence | { status: 'unpaid' }> {
  const invoice = await client.invoices.retrieve(invoiceId);
  if (
    invoice.id !== invoiceId ||
    invoice.livemode !== (context.mode === 'live') ||
    peableReference(invoice.customer) !== context.customerId ||
    peableReference(invoice.subscription) !== context.subscriptionId
  )
    throw new Error('Peable invoice ownership differs');
  if (invoice.status !== 'paid') return { status: 'unpaid' };
  const lines = invoice.lines.data;
  const line = lines[0];
  const paymentIntentId = peableReference(invoice.payment_intent);
  const paidAt = invoice.status_transitions.paid_at;
  if (
    lines.length !== 1 ||
    invoice.lines.has_more ||
    !line ||
    line.type !== 'subscription' ||
    line.proration ||
    line.quantity !== 1 ||
    line.price?.id !== context.priceId ||
    line.subscription !== context.subscriptionId ||
    !peableUnixSecondsSchema.safeParse(line.period.start).success ||
    !peableUnixSecondsSchema.safeParse(line.period.end).success ||
    line.period.end <= line.period.start ||
    invoice.currency.toUpperCase() !== 'USD' ||
    invoice.tax === null ||
    peableAmountSchema.parse(invoice.amount_paid) !== String(context.amountMinorUnits) ||
    invoice.total !== invoice.amount_paid ||
    BigInt(invoice.total_excluding_tax) + BigInt(invoice.tax) !== BigInt(invoice.total) ||
    !paymentIntentId ||
    paidAt === null ||
    paidAt * 1000 > now.getTime()
  )
    throw new Error('Peable paid invoice differs from the approved offer');
  return {
    invoiceId: invoice.id,
    lineId: line.id,
    priceId: context.priceId,
    paymentIntentId,
    periodStart: line.period.start,
    periodEnd: line.period.end,
    paidAt,
    amountPaid: invoice.amount_paid,
  };
}

/** Record one paid period. The context is frozen from an owned checkout or a
 * persisted source and the reviewed offer, never from metadata or a delivery. */
export async function reconcilePeablePersonalPaidInvoice(
  client: PeableEvidenceClient,
  context: PeablePersonalPaidContext,
  invoiceId: string,
  clock: () => Date = () => new Date(),
) {
  await assertPeableEvidenceOwner(client, context);
  const value = await readPaidInvoice(client, context, invoiceId, clock());
  if ('status' in value) return { status: 'no_invoice' as const };
  const periodStart = peableInstantToIso(value.periodStart),
    periodEnd = peableInstantToIso(value.periodEnd),
    paidAt = peableInstantToIso(value.paidAt);
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
  // Only the paid period is authoritative from the invoice; status and
  // cancellation come from a fresh read of the subscription itself.
  const subscription = await readOwnedPeableSubscription(client, context);
  const subscriptionObservedAt = clock();
  if (
    value.periodEnd > subscription.currentPeriodEnd ||
    (value.periodStart < subscription.currentPeriodStart &&
      value.periodEnd > subscription.currentPeriodStart)
  )
    throw new Error('Peable current subscription differs');
  const currentPeriod = {
    start: peableInstantToIso(subscription.currentPeriodStart),
    end: peableInstantToIso(subscription.currentPeriodEnd),
  };
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
      status: subscription.status,
      period: currentPeriod,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    },
    offer: {
      offerId: context.offerId,
      offerVersion: context.offerVersion,
      origin: context.origin,
    },
    paidLine: {
      invoiceId: value.invoiceId,
      lineId: value.lineId,
      priceId: value.priceId,
      quantity: 1,
      period: { start: periodStart, end: periodEnd },
    },
    event: { id: `peable-read:${value.invoiceId}:${value.lineId}`, createdAt: paidAt },
    providerObservedAt: subscriptionObservedAt,
  };
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
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  });
  return result;
}

/** Reconcile one invoice from authoritative reads: never grant from delivery
 * amounts or status. Refunds are the invoice payment's own figure — its
 * `amount_refunded`, the sum of succeeded refunds. Partial refund policy is
 * unselected: report review_required, no proportional grant. Existing paid
 * evidence is required before exact-line revocation. */
export async function reconcilePeablePersonalInvoiceState(
  client: PeableEvidenceClient,
  context: PeablePersonalPaidContext,
  invoiceId: string,
  clock: () => Date = () => new Date(),
) {
  await assertPeableEvidenceOwner(client, context);
  const value = await readPaidInvoice(client, context, invoiceId, clock());
  if ('status' in value) return { status: 'no_invoice' as const };
  const payment = await client.paymentIntents.retrieve(value.paymentIntentId);
  const refunded = BigInt(peableAmountSchema.parse(payment.amount_refunded)),
    paid = BigInt(value.amountPaid);
  if (
    payment.id !== value.paymentIntentId ||
    peableReference(payment.customer) !== context.customerId ||
    payment.metadata.invoice !== value.invoiceId ||
    refunded < BigInt(0) ||
    refunded > paid
  )
    throw new Error('Peable invoice payment differs');
  if (refunded === BigInt(0)) {
    if (value.periodEnd * 1000 <= clock().getTime()) {
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
      if (!period) return reconcilePeablePersonalPaidInvoice(client, context, invoiceId, clock);
      if (
        period.payerAccountId !== context.accountId ||
        period.beneficiaryAccountId !== context.accountId ||
        period.providerSubscriptionId !== context.subscriptionId ||
        period.priceId !== context.priceId ||
        period.offerId !== context.offerId ||
        period.offerVersion !== context.offerVersion ||
        period.periodStart.getTime() !== value.periodStart * 1000 ||
        period.periodEnd.getTime() !== value.periodEnd * 1000
      )
        throw new Error('Peable historical paid ownership differs');
      return {
        status: 'historical_replayed' as const,
        sourceId: period.sourceId,
        segmentId: period.segmentId,
      };
    }
    return reconcilePeablePersonalPaidInvoice(client, context, invoiceId, clock);
  }
  if (refunded < paid)
    return {
      status: 'review_required' as const,
      reason: 'partial_refund_entitlement_policy_unconfigured' as const,
    };
  const chargeId = peableReference(payment.latest_charge);
  if (!chargeId) throw new Error('Peable refunded payment has no charge');
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
    priceId: value.priceId,
    paymentIntentId: value.paymentIntentId,
    chargeId,
    period: {
      start: peableInstantToIso(value.periodStart),
      end: peableInstantToIso(value.periodEnd),
    },
    observedAt: clock(),
  });
}

/** A subscription's lifecycle (status, period, scheduled cancellation) from a
 * fresh read; it never awards rights. */
export async function reconcilePeablePersonalSubscriptionState(
  client: PeableEvidenceClient,
  context: PeablePersonalPaidContext,
  sourceId: string,
  clock: () => Date = () => new Date(),
) {
  await assertPeableEvidenceOwner(client, context);
  const subscription = await readOwnedPeableSubscription(client, context);
  return {
    status: await reconcileProductAccessFinancialState({
      sourceId,
      beneficiaryAccountId: context.accountId,
      payerAccountId: context.accountId,
      provider: 'peable',
      providerSubscriptionId: context.subscriptionId,
      providerBinding: {
        providerAccountRef: context.merchantId,
        mode: context.mode,
        environment: context.environment,
      },
      providerObservedAt: clock(),
      status: subscription.status,
      period: {
        start: peableInstantToIso(subscription.currentPeriodStart),
        end: peableInstantToIso(subscription.currentPeriodEnd),
      },
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    }),
  };
}

/** Applied/replayed outcomes complete reconciliation; no_invoice and ignored
 * mean there was no work. Unknown or review outcomes remain retryable. */
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
        'ignored',
      ]),
    })
    .safeParse(result);
  if (!parsed.success) throw new Error('Peable personal reconciliation deferred');
}
