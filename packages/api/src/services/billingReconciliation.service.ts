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

import { createHash } from 'node:crypto';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
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
  RECONCILIATION_LEASE_MS,
  RECONCILIATION_PERIOD_MS,
  RECONCILIATION_SETTLEMENT_LAG_MS,
} from '../db/schema/billingReconciliation';
import { DEFAULT_LEDGER_CURRENCY } from '../db/schema/ledgerColumns';
import { userCredits } from '../db/schema/userCredits';
import { logger } from '../utils/logger';
import {
  exactDecimalToMinorUnits,
  minorUnitExponentFor,
  minorUnitsToExactDecimal,
  sameExactAmount,
} from '../utils/minorUnits';
import { stripePaymentProcessorLedger } from './stripeAccountBilling.service';

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
  const [run] = await getDb()
    .insert(billingReconciliationRuns)
    .values({
      provider: input.ledger.provider,
      accountId: input.accountId,
      currency: input.currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: 'running',
      startedAt: new Date(),
    })
    .returning();

  return executeReconciliationPass(run, input);
}

/**
 * The comparison itself, once a run row exists.
 *
 * Split out so the on-demand pass and {@link runScheduledReconciliation} share
 * ONE diff while claiming their run row differently: the staff-triggered pass
 * writes it unconditionally, the scheduled one has to win a window first. Two
 * copies of the diff would eventually disagree about a finding, and a
 * reconciliation that reports differently depending on who started it is worse
 * than no reconciliation.
 */
async function executeReconciliationPass(
  run: ReconciliationRunRow,
  input: ReconcileInput
): Promise<ReconciliationReport> {
  const db = getDb();

  try {
    /*
     * `customerRef: undefined` means EVERY customer to the adapter — the same
     * encoding a deliberate platform-wide pass uses. So an account-scoped pass
     * whose account has no processor customer must not reach the adapter at all:
     * it would compare one account's ledger rows against the whole platform's
     * payments and fill the report with findings naming other customers, under a
     * run row whose `account_id` is this account.
     *
     * Skipping is not a shortcut, it is the correct answer. Oxy only ever creates
     * a payment against a customer it recorded, so an account with no customer id
     * has no processor payments — and any ledger-side row in the window is then a
     * genuine `missing_in_external`, which is exactly what it should be reported
     * as.
     */
    const customerRef =
      input.accountId === undefined ? undefined : await stripeCustomerOf(input.accountId);
    const skipProcessor = input.accountId !== undefined && customerRef === undefined;

    const external = skipProcessor
      ? []
      : await input.ledger.listSettledPayments({
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

/* ===========================================================================
 * The scheduled pass — reconciliation drift as a STREAM
 * ===========================================================================
 *
 * A drift METRIC needs a series, and a staff-triggered pass produces a point. So
 * the same comparison runs on a timer, one window at a time, and
 * `GET /inference/admin/metrics` reads the runs back.
 *
 * ## Why a fixed interval is safe here, on a multi-instance service
 *
 * `oxy-api` runs N ECS tasks and every one of them registers every sweep in
 * `server.ts`. A pass that simply fired on each would produce N run rows per
 * window, N Stripe scans, and N copies of every discrepancy — the drift metric
 * would then read N× reality, which is worse than not having it.
 *
 * The interlock is the auto-recharge sweeper's, transferred: **claim the window
 * BEFORE calling the processor, and do nothing at all if you did not win it**
 * (`claimAutoRecharge`). It differs in one respect, and the difference is why
 * this is not a copy. Auto-recharge claims a row in a table it owns, and a lost
 * window there costs nothing because the next five-minute window retries the same
 * account. A reconciliation window is a distinct FACT — losing one leaves a
 * permanent hole in the series — so a claim that could be stranded by a crashed
 * instance is not acceptable, and the claim has to be reclaimable.
 *
 * So the claim is the `running` run row this module already writes first, taken
 * under a transaction-scoped advisory lock:
 *
 *  - the lock makes the read-then-insert atomic across instances, so two tasks on
 *    the same tick cannot both insert. It is `pg_try_advisory_xact_lock`, never a
 *    blocking wait: a loser has nothing to do, and waiting would only queue a
 *    second pass behind the first;
 *  - a `completed` row for the window means it is done — skip;
 *  - a `running` row inside {@link RECONCILIATION_LEASE_MS} means another task is
 *    mid-pass — skip;
 *  - a `running` row OLDER than the lease is a crashed pass. It is marked
 *    `failed` and the window is reclaimed. Without this the window would be
 *    blocked forever by a task that died, which is exactly the stranded claim
 *    above;
 *  - a `failed` row means the window's drift is UNKNOWN, not zero, so it is
 *    retried. (Auto-recharge deliberately does the opposite and keeps a declined
 *    claim — a declined card declines again. Nothing about a Stripe outage says
 *    the next attempt fails, and reporting no drift for an unread window would be
 *    the "cron that hides drift" this module exists to refuse.)
 *
 * The advisory lock is released when the claim transaction commits, well before
 * the processor is called. That is deliberate: after the commit the `running` row
 * IS the claim, and holding a database lock across a third-party HTTP call would
 * tie a Postgres connection to Stripe's latency.
 *
 * ## It disables itself where it cannot work
 *
 * With no `STRIPE_SECRET_KEY` there is no processor to compare against and
 * `getStripe()` would throw on the first window. `processor-unconfigured` is
 * returned instead — one log line per interval in a development deployment,
 * exactly as `runAutoRechargeSweep` does it.
 */

/*
 * The four durations live in `db/schema/billingReconciliation.ts`, beside the
 * table, so `server.ts` and the sweep-registration gate can read them without
 * importing the Stripe adapter's graph. Why each is what it is:
 *
 *  - `RECONCILIATION_PERIOD_MS` (1h) — the window one pass covers.
 *  - `RECONCILIATION_SETTLEMENT_LAG_MS` (1h) — a processor payment reaches
 *    `billing_external_payments` through the `payment_intent.succeeded` webhook,
 *    which can arrive after the payment. Reconciling the hour that just ended
 *    would report a real webhook delay as `missing_in_ledger` on every pass. The
 *    only cost of the lag is that drift is known an hour late.
 *  - `RECONCILIATION_LEASE_MS` (15m) — longer than a pass can legitimately take
 *    (`MAX_RECONCILIATION_PAGES` Stripe pages plus the ledger read). Too short
 *    reclaims a LIVE pass and produces exactly the duplicate work the claim
 *    exists to prevent, so it errs long.
 *  - `RECONCILIATION_SWEEP_INTERVAL_MS` (15m) — shorter than the period, so a
 *    restart across a boundary does not lose that window for a whole further
 *    period. The claim makes the extra ticks free.
 */

/** The complete period that ended at least one settlement lag ago. */
export function scheduledReconciliationWindow(now: Date): {
  periodStart: Date;
  periodEnd: Date;
} {
  const boundary =
    Math.floor((now.getTime() - RECONCILIATION_SETTLEMENT_LAG_MS) / RECONCILIATION_PERIOD_MS) *
    RECONCILIATION_PERIOD_MS;
  return {
    periodStart: new Date(boundary - RECONCILIATION_PERIOD_MS),
    periodEnd: new Date(boundary),
  };
}

/**
 * A stable signed 64-bit advisory-lock key, the same construction
 * `db/migrate.ts` uses for the migration lock.
 *
 * A hash collision between two different windows costs one skipped tick, never a
 * wrong answer: the loser writes nothing, and the window it did not claim has no
 * run row, so the next tick claims it.
 */
function windowLockKey(name: string): string {
  return createHash('sha256').update(name).digest().readBigInt64BE(0).toString();
}

type WindowClaim =
  | { readonly status: 'claimed'; readonly run: ReconciliationRunRow }
  | { readonly status: 'not-claimed'; readonly reason: 'locked' | 'completed' | 'in-flight' };

/**
 * Win the right to reconcile one (provider, currency, window), or find out that
 * somebody already has.
 *
 * Everything here runs in ONE transaction under the advisory lock, so the
 * existence check and the insert cannot interleave with another instance's.
 */
async function claimReconciliationWindow(input: {
  readonly provider: ExternalPaymentProvider;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly now: Date;
}): Promise<WindowClaim> {
  const key = windowLockKey(
    `reconciliation:${input.provider}:${input.currency}:${input.periodStart.toISOString()}`
  );

  return getDb().transaction(async (tx) => {
    const [lock] = await executeRows<{ locked: boolean }>(
      tx,
      sql`select pg_try_advisory_xact_lock(${key}::bigint) as locked`
    );
    if (lock?.locked !== true) {
      return { status: 'not-claimed', reason: 'locked' };
    }

    // Platform-wide runs only: `account_id is null`. A staff-triggered pass
    // always names an account, so an operator investigating one customer can
    // never consume the scheduled window or be blocked by it.
    const [existing] = await tx
      .select()
      .from(billingReconciliationRuns)
      .where(
        and(
          isNull(billingReconciliationRuns.accountId),
          eq(billingReconciliationRuns.provider, input.provider),
          eq(billingReconciliationRuns.currency, input.currency),
          eq(billingReconciliationRuns.periodStart, input.periodStart),
          eq(billingReconciliationRuns.periodEnd, input.periodEnd)
        )
      )
      .orderBy(sql`${billingReconciliationRuns.startedAt} desc`)
      .limit(1);

    if (existing?.status === 'completed') {
      return { status: 'not-claimed', reason: 'completed' };
    }

    if (existing?.status === 'running') {
      if (input.now.getTime() - existing.startedAt.getTime() < RECONCILIATION_LEASE_MS) {
        return { status: 'not-claimed', reason: 'in-flight' };
      }
      // A pass that has held the window past its lease is not running: the task
      // that started it is gone. `completed_at` is set in the same statement
      // because the CHECK ties it to leaving `running`.
      await tx
        .update(billingReconciliationRuns)
        .set({ status: 'failed', completedAt: input.now })
        .where(eq(billingReconciliationRuns.id, existing.id));
    }

    const [run] = await tx
      .insert(billingReconciliationRuns)
      .values({
        provider: input.provider,
        currency: input.currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: 'running',
        startedAt: input.now,
      })
      .returning();

    return { status: 'claimed', run };
  });
}

/**
 * The currencies one window has to be reconciled in.
 *
 * Whatever the window actually contains, plus {@link DEFAULT_LEDGER_CURRENCY}
 * unconditionally. The default is not a fallback for an empty window — it is what
 * makes a QUIET platform distinguishable from a DEAD scheduler: a completed run
 * with both totals zero says the pass ran and found nothing, whereas no run row
 * at all says nothing about whether anything is comparing the two records. One
 * extra processor call per hour buys that.
 */
async function reconciliationCurrencies(
  periodStart: Date,
  periodEnd: Date
): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ currency: billingExternalPayments.currency })
    .from(billingExternalPayments)
    .where(
      and(
        gte(billingExternalPayments.occurredAt, periodStart),
        lt(billingExternalPayments.occurredAt, periodEnd)
      )
    );

  return [...new Set([DEFAULT_LEDGER_CURRENCY, ...rows.map((row) => row.currency)])].sort();
}

export interface ScheduledReconciliationOutcome {
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Windows this task claimed and compared. */
  readonly reconciled: number;
  /** Windows another task had already claimed or completed. */
  readonly skipped: number;
  /** Passes that threw. Their run rows are `failed`, so the window is retried. */
  readonly failed: number;
  readonly discrepancies: number;
}

export type ScheduledReconciliationResult =
  | { readonly status: 'processor-unconfigured' }
  | { readonly status: 'ran'; readonly outcome: ScheduledReconciliationOutcome };

export interface ScheduledReconciliationOptions {
  /** The clock. Injected so the window arithmetic is testable at a fixed instant. */
  readonly now?: Date;
  /**
   * The processor to compare against. Absent means Stripe, gated on
   * `STRIPE_SECRET_KEY` — which is the only path `server.ts` uses.
   *
   * Supplying one is what makes the CLAIM testable without a Stripe account, and
   * it is the same seam {@link ReconcileInput} already has for the same stated
   * reason: the property under test is the diff and the interlock, never the SDK
   * call. A caller that hands over a ledger has already decided it has a
   * processor, so the environment gate does not apply to it.
   */
  readonly ledger?: PaymentProcessorLedger;
}

/**
 * Reconcile the window that is now due, in every currency it touches.
 *
 * Called on a fixed interval from `server.ts`. Never throws: a currency whose
 * pass fails is counted and logged, and the remaining currencies still run — one
 * unreachable Stripe page must not take a whole window's reconciliation with it.
 */
export async function runScheduledReconciliation(
  options: ScheduledReconciliationOptions = {}
): Promise<ScheduledReconciliationResult> {
  const now = options.now ?? new Date();
  if (options.ledger === undefined && !process.env.STRIPE_SECRET_KEY) {
    return { status: 'processor-unconfigured' };
  }

  const { periodStart, periodEnd } = scheduledReconciliationWindow(now);
  const ledger = options.ledger ?? stripePaymentProcessorLedger();
  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  let discrepancies = 0;

  for (const currency of await reconciliationCurrencies(periodStart, periodEnd)) {
    const claim = await claimReconciliationWindow({
      provider: ledger.provider,
      currency,
      periodStart,
      periodEnd,
      now,
    });

    if (claim.status === 'not-claimed') {
      skipped += 1;
      continue;
    }

    try {
      const report = await executeReconciliationPass(claim.run, {
        ledger,
        currency,
        periodStart,
        periodEnd,
      });
      reconciled += 1;
      discrepancies += report.run.discrepancyCount;
      if (report.run.discrepancyCount > 0) {
        logger.warn('billing.reconciliation.drift', {
          runId: report.run.id,
          currency,
          periodStart: periodStart.toISOString(),
          discrepancyCount: report.run.discrepancyCount,
        });
      }
    } catch (error) {
      // `executeReconciliationPass` has already marked the run `failed`, so the
      // window is reclaimable. What is left is to say so and carry on.
      failed += 1;
      logger.error(
        'billing.reconciliation.pass_failed',
        error instanceof Error ? error : new Error(String(error)),
        { currency, periodStart: periodStart.toISOString() }
      );
    }
  }

  return {
    status: 'ran',
    outcome: {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      reconciled,
      skipped,
      failed,
      discrepancies,
    },
  };
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
