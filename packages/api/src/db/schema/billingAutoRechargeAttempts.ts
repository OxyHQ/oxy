/**
 * `billing_auto_recharge_attempts` — one row per attempt to top an account up
 * automatically, written BEFORE the processor is called.
 *
 * ## Why the row comes first
 *
 * Every other idempotency guard in this schema protects a BOOKKEEPING mistake:
 * a duplicate ledger entry is wrong, and it is fixable by a compensating row.
 * This one protects a real-world side effect — a charge against a customer's
 * saved card — which no compensating row undoes. So the claim is staked before
 * the side effect, not after it, and `idempotency_key` is unique.
 *
 * The key is composed from the account, the currency and the WINDOW the sweep
 * fired in (see `AUTO_RECHARGE_WINDOW_SECONDS`), so two instances of the sweep
 * racing, or one sweep re-running after a crash, contend on the index and
 * exactly one proceeds. A key derived from the balance instead would let a
 * second attempt through the moment the balance moved by a cent.
 *
 * ## Not append-only, unlike its neighbours
 *
 * A row transitions `pending → succeeded | failed`, so the immutability trigger
 * that guards `billing_external_payments` deliberately does NOT cover this
 * table. Nothing financial is recorded here: the MONEY of a successful recharge
 * is the `billing_external_payments` row and the ledger entry it names, both of
 * which are append-only. This table records only that an attempt was made and
 * how it ended.
 *
 * It is still on the `NEVER_SWEPT` list: an attempt explains a charge on a
 * customer's statement, and a support conversation about "why was I charged"
 * happens long after any telemetry window.
 *
 * ## `ON DELETE RESTRICT`
 *
 * Same posture as the rest of the family — see `billingExternalPayments.ts`.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { AUTO_RECHARGE_STATUSES } from '@oxyhq/contracts';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

/** Taken from the wire contract so column and schema cannot drift. */
export const AUTO_RECHARGE_STATUS_VALUES = AUTO_RECHARGE_STATUSES;

export type AutoRechargeStatusValue = (typeof AUTO_RECHARGE_STATUS_VALUES)[number];

/**
 * How long one auto-recharge claim covers.
 *
 * An hour. Short enough that a genuinely fast-spending account can recharge
 * again the same day, long enough that a sweep running every few minutes cannot
 * stack charges while a processor call is still in flight. It is a CLAIM window,
 * not a rate limit: a recharge that succeeds and is spent within the hour simply
 * waits for the next one, which is the conservative direction — the alternative
 * failure is charging a card twice in five minutes.
 */
export const AUTO_RECHARGE_WINDOW_SECONDS = 3600;

/**
 * How often the sweep looks for accounts below their threshold.
 *
 * Five minutes: short enough that a busy account is topped up before it runs
 * out, and far shorter than {@link AUTO_RECHARGE_WINDOW_SECONDS}, which is what
 * actually bounds how often a card is charged. The two numbers are deliberately
 * different — the interval decides how promptly a candidate is NOTICED, the
 * window decides how often one may be CHARGED, and collapsing them into one
 * value would make the safety bound a scheduling knob.
 */
export const AUTO_RECHARGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const billingAutoRechargeAttempts = pgTable(
  'billing_auto_recharge_attempts',
  {
    id: generatedId(),

    /**
     * The claim. `recharge:<accountId>:<currency>:<windowStart>` — composed by
     * `accountBilling.service.ts`, unique here so the composition is enforced
     * rather than trusted.
     */
    idempotencyKey: text().notNull(),

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    requestedAmount: exactAmount().notNull(),
    /** The spendable balance that triggered this — why the attempt exists. */
    balanceAtTrigger: exactAmount().notNull(),

    status: text({ enum: AUTO_RECHARGE_STATUS_VALUES }).notNull().default('pending'),
    /** The processor's payment-intent id, once there is one. */
    externalRef: text(),
    /**
     * The processor's own decline code (`card_declined`, `authentication_required`).
     * A CODE, never a message: a free-form processor string is where a card
     * number or a customer's name eventually ends up in a support export.
     */
    failureCode: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('billing_auto_recharge_attempts_idempotency_key_key').on(t.idempotencyKey),
    // "Has this account recharged recently, and how did it go" — the sweep's own
    // pre-check and the support view.
    index('billing_auto_recharge_attempts_account_created_at_idx').on(
      t.accountId,
      t.createdAt.desc()
    ),
    // The sweep's retry scan: attempts left `pending` by a crashed process.
    index('billing_auto_recharge_attempts_status_idx').on(t.status),

    check(
      'billing_auto_recharge_attempts_status_check',
      sql`${t.status} in (${sql.raw(inList(AUTO_RECHARGE_STATUS_VALUES))})`
    ),
    check('billing_auto_recharge_attempts_currency_check', currencyCodeCheck(t.currency)),
    check('billing_auto_recharge_attempts_amount_check', sql`${t.requestedAmount} > 0`),
    check(
      'billing_auto_recharge_attempts_balance_check',
      sql`${t.balanceAtTrigger} >= 0`
    ),
    // A succeeded attempt names the charge it produced. Without this an attempt
    // could report success with nothing to reconcile against, which reads
    // exactly like a successful recharge that credited nothing.
    check(
      'billing_auto_recharge_attempts_success_ref_check',
      sql`${t.status} <> 'succeeded' or ${t.externalRef} is not null`
    ),
    // A failure code belongs to a failure. An implication rather than a
    // biconditional: a processor may refuse without naming a code.
    check(
      'billing_auto_recharge_attempts_failure_code_check',
      sql`${t.failureCode} is null or ${t.status} = 'failed'`
    ),
    check(
      'billing_auto_recharge_attempts_failure_code_length_check',
      sql`${t.failureCode} is null or length(${t.failureCode}) between 1 and 64`
    ),
  ]
);

export type BillingAutoRechargeAttemptRow = typeof billingAutoRechargeAttempts.$inferSelect;
