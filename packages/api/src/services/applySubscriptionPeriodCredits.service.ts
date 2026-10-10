/** Receipt, cap assignment and per-grant credits share one rollback boundary. */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import {
  billingTransactions,
  subscriptionPeriodIdempotencyPredicate,
} from '../db/schema/billingTransactions';
import {
  type ProductProviderPeriodInput,
  recordProductProviderPeriod,
} from './productProviderEvidence.service';
import type { ReconciledCreditInvoice } from './stripeSubscriptionEvidence.service';
import {
  grantSubscriptionCredits,
  lockSubscriptionCreditAccount,
} from './subscriptionCreditLedger.service';
import { assertFrozenPeriodAssignments } from './subscriptionPeriodPolicy';
export async function applyReconciledPeriodInvoice(input: {
  userId: string;
  customerId: string;
  subscriptionId: string;
  providerAccountRef: string;
  productPeriod?: ProductProviderPeriodInput | null;
  periodStart: number;
  periodEnd: number;
  invoiceId: string;
  assignments: ReconciledCreditInvoice[];
}) {
  const target = input.assignments.find((row) => row.invoice.id === input.invoiceId);
  if (!target) throw new Error('Delivered invoice is absent from complete reconciled evidence');
  return getDb().transaction(async (tx) => {
    if (input.productPeriod)
      await recordProductProviderPeriod(input.productPeriod, tx, {
        verifiedHistoricalPaidEvidence: true,
      });
    await lockSubscriptionCreditAccount(tx, input.userId);
    const [mirror] = await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.stripeSubscriptionId, input.subscriptionId))
      .for('update');
    if (!mirror || mirror.userId !== input.userId || mirror.stripeCustomerId !== input.customerId)
      throw new Error('Reconciled subscription account differs');
    const existing = await tx
      .select()
      .from(billingTransactions)
      .where(
        and(
          eq(billingTransactions.stripeSubscriptionId, input.subscriptionId),
          eq(billingTransactions.stripeSubscriptionPeriodStart, new Date(input.periodStart * 1000)),
          sql`${billingTransactions.type} in ('subscription_payment','subscription_proration')`,
        ),
      );
    if (
      existing.some(
        (row) => row.userId !== input.userId || row.currency !== target.invoice.currency,
      )
    )
      throw new Error('Frozen period receipt attribution differs');
    const frozen = existing.map((row) => {
      if (row.stripeInvoiceId) return { invoiceId: row.stripeInvoiceId, credits: row.credits };
      const base = input.assignments.find((assignment) => assignment.kind === 'base');
      if (row.type !== 'subscription_payment' || !base)
        throw new Error('Legacy receipt cannot be attributed to the paid base');
      return { invoiceId: base.invoice.id, credits: row.credits };
    });
    assertFrozenPeriodAssignments(
      input.assignments.map((row) => ({
        invoiceId: row.invoice.id,
        credits: row.credits,
        kind: row.kind,
        capApplied: row.capApplied,
      })),
      frozen,
    );
    if (frozen.some((row) => row.invoiceId === input.invoiceId))
      return {
        outcome: 'duplicate' as const,
        detail: 'invoice credit assignment was already granted',
      };
    const type =
      target.kind === 'base'
        ? ('subscription_payment' as const)
        : ('subscription_proration' as const);
    const [receipt] = await tx
      .insert(billingTransactions)
      .values({
        userId: input.userId,
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        stripeSubscriptionPeriodStart: new Date(input.periodStart * 1000),
        stripeInvoiceId: target.invoice.id,
        type,
        amountMinorUnits: target.invoice.amount_paid,
        currency: target.invoice.currency,
        credits: target.credits,
        status: 'completed',
        description:
          target.kind === 'base'
            ? 'Subscription period credits'
            : 'Paid subscription upgrade top-up',
      })
      .onConflictDoNothing(
        type === 'subscription_payment'
          ? {
              target: [
                billingTransactions.stripeSubscriptionId,
                billingTransactions.stripeSubscriptionPeriodStart,
                billingTransactions.type,
              ],
              where: subscriptionPeriodIdempotencyPredicate(billingTransactions),
            }
          : {
              target: [billingTransactions.stripeInvoiceId, billingTransactions.type],
              where: sql`${billingTransactions.type} = 'subscription_proration' and ${billingTransactions.stripeInvoiceId} is not null`,
            },
      )
      .returning();
    if (!receipt) throw new Error('Invoice receipt conflicted with frozen attribution');
    const grant = await grantSubscriptionCredits(tx, {
      userId: input.userId,
      transactionId: receipt.id,
      providerAccountRef: input.providerAccountRef,
      invoiceId: target.invoice.id,
      subscriptionId: input.subscriptionId,
      sourceType: type,
      periodStart: new Date(input.periodStart * 1000),
      periodEnd: new Date(input.periodEnd * 1000),
      currency: target.invoice.currency,
      amountPaid: target.invoice.amount_paid,
      granted: target.credits,
    });
    return {
      outcome: 'granted' as const,
      detail: `credits ${target.credits}; issued ${grant.issued}${target.capApplied ? '; period cap applied' : ''}`,
    };
  });
}
