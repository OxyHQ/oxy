/**
 * `billing_reconciliation_runs` + `billing_reconciliation_discrepancies` — the
 * durable record of comparing Oxy's ledger against the payment processor.
 *
 * ## Why the report is a TABLE and not a log line
 *
 * #972's Stripe boundary asks for reconciliation, and the failure mode it names
 * is "a cron that hides drift". A reconciliation that logs and exits produces
 * exactly that: the pass either printed nothing (which is also what a pass that
 * crashed before reading anything prints) or printed a number nobody diffs
 * against yesterday's. Persisting each pass makes three questions answerable
 * that a log cannot answer — when was the last pass, did it finish, and is this
 * discrepancy new — and makes an UNRESOLVED discrepancy visible to a query
 * rather than to whoever happens to read the logs.
 *
 * ## Totals AND a list, never one or the other
 *
 * A run carries `ledger_total`, `external_total` and a list of discrepancies.
 * Both are needed, because they miss different faults: two totals can agree
 * exactly while the underlying sets differ (a charge recorded against the wrong
 * account offsets itself in a sum), and a list without totals cannot tell a
 * clean pass from a pass that read nothing.
 *
 * That second half is why `discrepancy_count` is a stored column beside a child
 * table rather than a `count(*)`: a run that failed midway has a real
 * `discrepancy_count` for what it had examined, and a `count(*)` over the child
 * would present a partial pass as a complete one.
 *
 * ## Discrepancies are append-only; runs are not
 *
 * A run transitions `running → completed | failed`, so it must be updatable. A
 * discrepancy is an observation about a moment and is never edited — a
 * correction is the NEXT run finding nothing.
 * `0045_account_billing_immutability.sql` guards the child accordingly.
 *
 * There is deliberately no `resolved` flag on a discrepancy. Resolution is not
 * an edit to a past observation; it is a later run that no longer reports it,
 * and asking "is this still broken" means looking at the latest run. A mutable
 * resolution flag is how a reconciliation report becomes a ticket queue that
 * drifts from the data it describes.
 *
 * ## `ON DELETE RESTRICT` on the account, `CASCADE` on the run
 *
 * The account reference is financial evidence, like every other in this family.
 * The run→discrepancy link is an ordinary parent/child within one document; the
 * parent is never deleted either, so the cascade never fires in practice and
 * exists so the pair can only ever be removed together if it ever does.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import {
  EXTERNAL_PAYMENT_PROVIDERS,
  RECONCILIATION_DISCREPANCY_KINDS,
  RECONCILIATION_RUN_STATUSES,
} from '@oxyhq/contracts';
import { billingLedgerEntries } from './billingLedgerEntries';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

/** Taken from the wire contracts so columns and schemas cannot drift. */
export const RECONCILIATION_RUN_STATUS_VALUES = RECONCILIATION_RUN_STATUSES;

export const RECONCILIATION_DISCREPANCY_KIND_VALUES = RECONCILIATION_DISCREPANCY_KINDS;

export type ReconciliationRunStatusValue = (typeof RECONCILIATION_RUN_STATUS_VALUES)[number];

export type ReconciliationDiscrepancyKindValue =
  (typeof RECONCILIATION_DISCREPANCY_KIND_VALUES)[number];

/* -------------------------------------------------------------------------- */
/*  The scheduled pass's four durations                                       */
/* -------------------------------------------------------------------------- */

/*
 * They live beside the table rather than in the service, for the reason
 * `AUTO_RECHARGE_SWEEP_INTERVAL_MS` lives beside
 * `billing_auto_recharge_attempts`: `server.ts` and the registration gate in
 * `src/__tests__/scheduledSweeps.test.ts` both need them, and importing them from
 * the service would drag the Stripe adapter's whole graph into a test whose
 * subject is one `setInterval`. `services/billingReconciliation.service.ts`
 * argues WHY each value is what it is; these are the values.
 */

/** The window one scheduled pass covers. */
export const RECONCILIATION_PERIOD_MS = 60 * 60 * 1000;

/**
 * How far behind the clock a window is reconciled, so a late
 * `payment_intent.succeeded` webhook is not reported as `missing_in_ledger`.
 */
export const RECONCILIATION_SETTLEMENT_LAG_MS = 60 * 60 * 1000;

/**
 * How long a `running` row is believed before it is treated as a crashed pass
 * and its window reclaimed. Longer than any pass can legitimately take.
 */
export const RECONCILIATION_LEASE_MS = 15 * 60 * 1000;

/**
 * How often the sweep looks for a window to claim.
 *
 * Shorter than {@link RECONCILIATION_PERIOD_MS}, so a restart across a period
 * boundary does not lose that window for a whole further period. The claim makes
 * the extra ticks free.
 */
export const RECONCILIATION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export const billingReconciliationRuns = pgTable(
  'billing_reconciliation_runs',
  {
    id: generatedId(),

    provider: text({ enum: EXTERNAL_PAYMENT_PROVIDERS }).notNull(),
    /** Absent for a platform-wide pass over every account. */
    accountId: text().references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),

    status: text({ enum: RECONCILIATION_RUN_STATUS_VALUES }).notNull().default('running'),

    /** Sum of what Oxy recorded as processor-funded, over the window. */
    ledgerTotal: exactAmount().notNull().default('0'),
    /** Sum of what the processor reports for the same window. */
    externalTotal: exactAmount().notNull().default('0'),
    discrepancyCount: integer().notNull().default(0),

    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),

    createdAt: createdAt(),
  },
  (t) => [
    // "The latest pass" — the question every operator asks first.
    index('billing_reconciliation_runs_started_at_idx').on(t.startedAt.desc()),
    index('billing_reconciliation_runs_account_started_at_idx').on(
      t.accountId,
      t.startedAt.desc()
    ),
    index('billing_reconciliation_runs_status_idx').on(t.status),

    check(
      'billing_reconciliation_runs_provider_check',
      sql`${t.provider} in (${sql.raw(inList(EXTERNAL_PAYMENT_PROVIDERS))})`
    ),
    check(
      'billing_reconciliation_runs_status_check',
      sql`${t.status} in (${sql.raw(inList(RECONCILIATION_RUN_STATUS_VALUES))})`
    ),
    check('billing_reconciliation_runs_currency_check', currencyCodeCheck(t.currency)),
    check('billing_reconciliation_runs_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check('billing_reconciliation_runs_ledger_total_check', sql`${t.ledgerTotal} >= 0`),
    check('billing_reconciliation_runs_external_total_check', sql`${t.externalTotal} >= 0`),
    check(
      'billing_reconciliation_runs_discrepancy_count_check',
      sql`${t.discrepancyCount} >= 0`
    ),
    // A pass that is no longer running says when it stopped. A `running` row
    // with a completion time would make "is a pass in flight" unanswerable.
    check(
      'billing_reconciliation_runs_completed_at_check',
      sql`(${t.status} = 'running') = (${t.completedAt} is null)`
    ),
  ]
);

export const billingReconciliationDiscrepancies = pgTable(
  'billing_reconciliation_discrepancies',
  {
    id: generatedId(),

    runId: text()
      .notNull()
      .references(() => billingReconciliationRuns.id, { onDelete: 'cascade' }),

    kind: text({ enum: RECONCILIATION_DISCREPANCY_KIND_VALUES }).notNull(),

    /** Absent for `account_unresolved` — that is the whole finding. */
    accountId: text().references(() => users.id, { onDelete: 'restrict' }),
    /** The processor's reference. Absent for `missing_in_external`. */
    externalRef: text(),
    /** Absent for `missing_in_ledger`. */
    ledgerEntryId: text().references(() => billingLedgerEntries.id, { onDelete: 'restrict' }),

    ledgerAmount: exactAmount(),
    externalAmount: exactAmount(),
    currency: currencyCode(),

    createdAt: createdAt(),
  },
  (t) => [
    index('billing_reconciliation_discrepancies_run_id_idx').on(t.runId),
    // One finding per external reference per kind per run. A partial unique
    // rather than a plain one: `missing_in_external` rows carry no reference,
    // and Postgres treats NULLs as DISTINCT, so a plain unique would admit
    // unbounded duplicates of exactly the rows it looks like it constrains.
    uniqueIndex('billing_reconciliation_discrepancies_run_ref_key')
      .on(t.runId, t.kind, t.externalRef)
      .where(sql`${t.externalRef} is not null`),

    check(
      'billing_reconciliation_discrepancies_kind_check',
      sql`${t.kind} in (${sql.raw(inList(RECONCILIATION_DISCREPANCY_KIND_VALUES))})`
    ),
    check(
      'billing_reconciliation_discrepancies_currency_check',
      currencyCodeCheck(t.currency)
    ),
    check(
      'billing_reconciliation_discrepancies_ledger_amount_check',
      sql`${t.ledgerAmount} is null or ${t.ledgerAmount} >= 0`
    ),
    check(
      'billing_reconciliation_discrepancies_external_amount_check',
      sql`${t.externalAmount} is null or ${t.externalAmount} >= 0`
    ),
    // Each kind must carry the evidence that makes it actionable. Written as an
    // implication per kind rather than a biconditional: a row may legitimately
    // carry MORE than the minimum (an `amount_mismatch` names both sides and the
    // account), and a biconditional would reject that.
    check(
      'billing_reconciliation_discrepancies_evidence_check',
      sql`(${t.kind} <> 'missing_in_ledger'
             or (${t.externalRef} is not null and ${t.externalAmount} is not null))
        and (${t.kind} <> 'missing_in_external'
             or (${t.ledgerEntryId} is not null and ${t.ledgerAmount} is not null))
        and (${t.kind} <> 'amount_mismatch'
             or (${t.externalRef} is not null
                 and ${t.ledgerAmount} is not null
                 and ${t.externalAmount} is not null))
        and (${t.kind} <> 'account_unresolved' or ${t.externalRef} is not null)`
    ),
  ]
);

export type BillingReconciliationRunRow = typeof billingReconciliationRuns.$inferSelect;

export type BillingReconciliationDiscrepancyRow =
  typeof billingReconciliationDiscrepancies.$inferSelect;
