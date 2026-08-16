/**
 * Reconciliation — comparing what Oxy recorded against what the payment
 * processor actually took, and PUBLISHING the difference.
 *
 * #972's Stripe boundary asks for reconciliation and names the failure mode it
 * wants avoided: "a cron that hides drift". A pass that logs and exits is
 * exactly that — its silence is indistinguishable from a pass that crashed
 * before reading anything. So every pass writes a `billing_reconciliation_runs`
 * row, every finding writes an append-only discrepancy row, and a pass that
 * throws marks its run `failed` rather than leaving a `running` row behind.
 *
 * ## Stripe is never the authority, in either direction
 *
 * This module does not import a balance from the processor and does not correct
 * one from it. It compares two independent records and REPORTS. A reconciliation
 * that silently credited the difference would make the processor the ledger,
 * which is the invariant the epic states outright.
 *
 * That is also why there is no `resolved` flag on a discrepancy: resolution is
 * not an edit to a past observation, it is the NEXT run no longer reporting it.
 * A mutable resolution flag turns a report into a ticket queue that drifts from
 * the data it describes.
 *
 * ## The processor is behind an interface, and that is not only for tests
 *
 * {@link PaymentProcessorLedger} is a two-method view of "what did you settle in
 * this window". The Stripe implementation lives in
 * `stripeAccountBilling.service.ts`; this module never imports the Stripe SDK.
 * The immediate benefit is that the diff can be exercised against a fake in a
 * suite with no Stripe account — see the report accompanying this change for
 * what that leaves unverified — but the durable one is that the comparison
 * cannot accidentally start reading a processor-computed total.
 *
 * ## Four findings, not one count
 *
 * `missing_in_ledger` costs a CUSTOMER (they paid and have no balance).
 * `missing_in_external` costs OXY (a balance with no charge behind it).
 * `amount_mismatch` is both. `account_unresolved` is money that arrived and
 * nobody owns. Collapsing them into one number is what makes a reconciliation
 * report something nobody acts on.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  reconciliationDiscrepancySchema,
  reconciliationReportSchema,
  reconciliationRunSchema,
  type ExternalPaymentKind,
  type ExternalPaymentProvider,
  type ReconciliationDiscrepancy,
  type ReconciliationDiscrepancyKind,
  type ReconciliationReport,
  type ReconciliationRun,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { billingExternalPayments } from '../db/schema/billingExternalPayments';
import {
  billingReconciliationDiscrepancies,
  billingReconciliationRuns,
} from '../db/schema/billingReconciliation';
import { userCredits } from '../db/schema/userCredits';
import {
  exactDecimalToMinorUnits,
  minorUnitExponentFor,
  minorUnitsToExactDecimal,
  sameExactAmount,
} from '../utils/minorUnits';

type ReconciliationRunRow = typeof billingReconciliationRuns.$inferSelect;

type ReconciliationDiscrepancyRow = typeof billingReconciliationDiscrepancies.$inferSelect;

/**
 * One settled payment as the processor reports it.
 *
 * `amountMinorUnits` is the processor's own integer, converted to an exact
 * decimal HERE rather than by the adapter — so every processor implementation
 * hands over the number it actually has, and exactly one piece of code decides
 * how minor units become money. `customerRef` is the processor's customer id,
 * which is what Oxy resolves back to an account; `null` when the processor
 * reported a payment with no customer attached, which is itself a finding.
 */
export interface ProcessorPayment {
  readonly externalKind: ExternalPaymentKind;
  readonly externalRef: string;
  readonly amountMinorUnits: number;
  /** ISO 4217, upper-case. Adapters normalise; processors are inconsistent. */
  readonly currency: string;
  readonly occurredAt: Date;
  readonly customerRef: string | null;
}

export interface ProcessorLedgerQuery {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
  /** Restrict to one processor customer. Absent means every customer. */
  readonly customerRef?: string;
}

/** What reconciliation needs from a payment processor, and nothing more. */
export interface PaymentProcessorLedger {
  readonly provider: ExternalPaymentProvider;
  listSettledPayments(query: ProcessorLedgerQuery): Promise<ProcessorPayment[]>;
}

export interface ReconcileInput {
  readonly ledger: PaymentProcessorLedger;
  /** Restrict to one Oxy account. Absent means a platform-wide pass. */
  readonly accountId?: string;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

// ===========================================================================
// Serializers
// ===========================================================================

export function toReconciliationRun(row: ReconciliationRunRow): ReconciliationRun {
  return reconciliationRunSchema.parse({
    schemaVersion: 1,
    id: row.id,
    provider: row.provider,
    accountId: row.accountId ?? undefined,
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    ledgerTotal: row.ledgerTotal,
    externalTotal: row.externalTotal,
    discrepancyCount: row.discrepancyCount,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  });
}

export function toReconciliationDiscrepancy(
  row: ReconciliationDiscrepancyRow
): ReconciliationDiscrepancy {
  return reconciliationDiscrepancySchema.parse({
    schemaVersion: 1,
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    accountId: row.accountId ?? undefined,
    externalRef: row.externalRef ?? undefined,
    ledgerEntryId: row.ledgerEntryId ?? undefined,
    ledgerAmount: row.ledgerAmount ?? undefined,
    externalAmount: row.externalAmount ?? undefined,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
  });
}

// ===========================================================================
// The pass
// ===========================================================================

interface PendingDiscrepancy {
  readonly kind: ReconciliationDiscrepancyKind;
  readonly accountId?: string;
  readonly externalRef?: string;
  readonly ledgerEntryId?: string;
  readonly ledgerAmount?: string;
  readonly externalAmount?: string;
}

/**
 * Compare one window and publish the result.
 *
 * The run row is written FIRST, `running`, so a pass that dies mid-flight leaves
 * evidence that it started rather than nothing at all — and the
 * `(status = 'running') = (completed_at is null)` CHECK means a stale `running`
 * row is visibly stale rather than an ordinary-looking completed pass.
 *
 * Everything after that is read-only against the ledger. Nothing here writes to
 * `billing_external_payments`, `account_balances` or the journal: a
 * reconciliation that repaired what it found would remove the only signal that
 * something upstream is broken.
 */
export async function reconcilePayments(input: ReconcileInput): Promise<ReconciliationReport> {
  const db = getDb();
  const startedAt = new Date();

  const [run] = await db
    .insert(billingReconciliationRuns)
    .values({
      provider: input.ledger.provider,
      accountId: input.accountId,
      currency: input.currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: 'running',
      startedAt,
    })
    .returning();

  try {
    const customerRef =
      input.accountId === undefined ? undefined : await stripeCustomerOf(input.accountId);

    // An account-scoped pass for an account that has never touched the processor
    // has an empty external side by construction, which is CORRECT rather than a
    // reason to skip: any ledger-side rows in the window are then genuinely
    // `missing_in_external`.
    const external = await input.ledger.listSettledPayments({
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: input.currency,
      customerRef,
    });

    const recorded = await db
      .select({
        id: billingExternalPayments.id,
        accountId: billingExternalPayments.accountId,
        externalRef: billingExternalPayments.externalRef,
        amount: billingExternalPayments.amount,
        ledgerEntryId: billingExternalPayments.ledgerEntryId,
      })
      .from(billingExternalPayments)
      .where(
        and(
          eq(billingExternalPayments.provider, input.ledger.provider),
          eq(billingExternalPayments.currency, input.currency),
          gte(billingExternalPayments.occurredAt, input.periodStart),
          lt(billingExternalPayments.occurredAt, input.periodEnd),
          ...(input.accountId === undefined
            ? []
            : [eq(billingExternalPayments.accountId, input.accountId)])
        )
      );

    const recordedByRef = new Map(recorded.map((row) => [row.externalRef, row]));
    const exponent = minorUnitExponentFor(input.currency);
    const pending: PendingDiscrepancy[] = [];

    // Totals accumulate in MINOR UNITS, as integers. A window's charges summed
    // as decimals in JavaScript is the one place a float error is guaranteed to
    // appear and guaranteed to be small enough to look like a real discrepancy.
    let externalTotal = 0;

    for (const payment of external) {
      externalTotal += payment.amountMinorUnits;
      const externalAmount = minorUnitsToExactDecimal(payment.amountMinorUnits, exponent);
      const match = recordedByRef.get(payment.externalRef);

      if (match === undefined) {
        const owner =
          payment.customerRef === null ? undefined : await accountOfStripeCustomer(payment.customerRef);
        pending.push(
          owner === undefined
            ? {
                kind: 'account_unresolved',
                externalRef: payment.externalRef,
                externalAmount,
              }
            : {
                kind: 'missing_in_ledger',
                accountId: owner,
                externalRef: payment.externalRef,
                externalAmount,
              }
        );
        continue;
      }

      recordedByRef.delete(payment.externalRef);
      if (!sameExactAmount(match.amount, externalAmount)) {
        pending.push({
          kind: 'amount_mismatch',
          accountId: match.accountId,
          externalRef: payment.externalRef,
          ledgerEntryId: match.ledgerEntryId,
          ledgerAmount: match.amount,
          externalAmount,
        });
      }
    }

    // Whatever is left was recorded by Oxy and not reported by the processor.
    for (const leftover of recordedByRef.values()) {
      pending.push({
        kind: 'missing_in_external',
        accountId: leftover.accountId,
        externalRef: leftover.externalRef,
        ledgerEntryId: leftover.ledgerEntryId,
        ledgerAmount: leftover.amount,
      });
    }

    const ledgerTotal = recorded.reduce((total, row) => {
      const minorUnits = exactDecimalToMinorUnits(row.amount, exponent);
      if (minorUnits === null) {
        // A recorded processor payment carrying precision below the minor unit
        // cannot have come from the funding path, which only ever writes what
        // `minorUnitsToExactDecimal` produced. Reaching here means something else
        // wrote the row, and quietly rounding it would hide exactly that.
        throw new Error(
          `recorded payment ${row.externalRef} carries precision below the minor unit: ${row.amount}`
        );
      }
      return total + minorUnits;
    }, 0);

    const discrepancies =
      pending.length === 0
        ? []
        : await db
            .insert(billingReconciliationDiscrepancies)
            .values(
              pending.map((entry) => ({
                runId: run.id,
                kind: entry.kind,
                accountId: entry.accountId,
                externalRef: entry.externalRef,
                ledgerEntryId: entry.ledgerEntryId,
                ledgerAmount: entry.ledgerAmount,
                externalAmount: entry.externalAmount,
                currency: input.currency,
              }))
            )
            .returning();

    const [completed] = await db
      .update(billingReconciliationRuns)
      .set({
        status: 'completed',
        ledgerTotal: totalToExactDecimal(ledgerTotal, exponent),
        externalTotal: totalToExactDecimal(externalTotal, exponent),
        discrepancyCount: pending.length,
        completedAt: new Date(),
      })
      .where(eq(billingReconciliationRuns.id, run.id))
      .returning();

    return reconciliationReportSchema.parse({
      schemaVersion: 1,
      run: toReconciliationRun(completed),
      discrepancies: discrepancies.map(toReconciliationDiscrepancy),
    });
  } catch (error) {
    // A failed pass says so. Leaving it `running` would make the next operator
    // read a crashed pass as one still in flight, and the CHECK makes that state
    // permanent until somebody notices.
    await db
      .update(billingReconciliationRuns)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(billingReconciliationRuns.id, run.id));
    throw error;
  }
}

/**
 * A window total, accumulated in integer minor units, as an exact decimal.
 *
 * Refuses rather than truncates: a total outside the safe integer range means
 * either a genuinely enormous window or a corrupt row, and both deserve a stack
 * trace rather than a plausible-looking number in a report.
 */
function totalToExactDecimal(totalMinorUnits: number, exponent: number): string {
  if (!Number.isSafeInteger(totalMinorUnits)) {
    throw new Error(`reconciliation total exceeds the safe integer range: ${totalMinorUnits}`);
  }
  return minorUnitsToExactDecimal(totalMinorUnits, exponent);
}

/** The processor customer id Oxy holds for an account, if any. */
async function stripeCustomerOf(accountId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ stripeCustomerId: userCredits.stripeCustomerId })
    .from(userCredits)
    .where(eq(userCredits.userId, accountId))
    .limit(1);
  return row?.stripeCustomerId ?? undefined;
}

/**
 * The account a processor customer belongs to.
 *
 * `user_credits.stripe_customer_id` carries a partial UNIQUE index, so this
 * resolves at most one account — the same lookup the subscription webhook
 * performs, and deliberately the same column rather than a second one: two
 * Stripe-customer columns that disagree is money credited to the wrong account.
 */
async function accountOfStripeCustomer(customerRef: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ userId: userCredits.userId })
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, customerRef))
    .limit(1);
  return row?.userId;
}

/** The most recent passes, newest first. */
export async function listReconciliationRuns(
  accountId: string | undefined,
  limit = 20
): Promise<ReconciliationRun[]> {
  const rows = await getDb()
    .select()
    .from(billingReconciliationRuns)
    .where(accountId === undefined ? undefined : eq(billingReconciliationRuns.accountId, accountId))
    .orderBy(sql`${billingReconciliationRuns.startedAt} desc`)
    .limit(limit);
  return rows.map(toReconciliationRun);
}

/** One pass and everything it found. */
export async function getReconciliationReport(
  runId: string
): Promise<ReconciliationReport | undefined> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(billingReconciliationRuns)
    .where(eq(billingReconciliationRuns.id, runId))
    .limit(1);
  if (!run) return undefined;

  const discrepancies = await db
    .select()
    .from(billingReconciliationDiscrepancies)
    .where(eq(billingReconciliationDiscrepancies.runId, runId))
    .orderBy(billingReconciliationDiscrepancies.createdAt);

  return reconciliationReportSchema.parse({
    schemaVersion: 1,
    run: toReconciliationRun(run),
    discrepancies: discrepancies.map(toReconciliationDiscrepancy),
  });
}
