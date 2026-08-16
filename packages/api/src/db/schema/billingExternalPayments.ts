/**
 * `billing_external_payments` — the record of a payment processor charge that
 * funded an Oxy balance, and the only place the two systems are joined.
 *
 * ## Why a table rather than an idempotency-key convention
 *
 * `billing_ledger_entries.idempotency_key` is already unique, and the funding
 * path writes `stripe:payment_intent:<id>` into it, so in principle a Stripe
 * charge could be matched back to its ledger entry by PARSING that string. A
 * parser is not a foreign key: it silently stops matching when a prefix changes,
 * it cannot be indexed by external reference, and reconciliation — the one job
 * that has to be right — would be built on a string convention nothing enforces.
 *
 * So the link is a row, with a real foreign key into the journal and a unique
 * key on the processor's own reference.
 *
 * ## `(provider, external_ref)` unique IS the webhook idempotency
 *
 * Stripe redelivers webhooks by design. The ledger's own idempotency key already
 * makes a redelivered `checkout.session.completed` a no-op, and this index is
 * the SECOND, independent guard on the same fact — deliberately, because the two
 * fail differently: the ledger key is composed by application code and a change
 * to how it is composed would silently re-open the double-credit, while this one
 * is the processor's own identifier and cannot drift.
 *
 * ## Append-only
 *
 * A processor charge is a historical fact. It is never edited and never deleted
 * — `0045_account_billing_immutability.sql` enforces both halves, unlike the
 * BYOK audit trail's UPDATE-only guard, because this table has no retention
 * sweep and is on the `NEVER_SWEPT` list in `db/__tests__/inferenceLedgerRetention.test.ts`.
 *
 * ## `ON DELETE RESTRICT`
 *
 * The same posture as every other financial table here: this is the evidence
 * that reconciles Oxy's books against the processor's, and deleting an account
 * must not delete it. Account erasure therefore has to make an explicit
 * retention decision — see `accountFinancialHolds.service.ts`, which is what
 * turns that constraint into an answer rather than a 500.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { EXTERNAL_PAYMENT_KINDS, EXTERNAL_PAYMENT_PROVIDERS } from '@oxyhq/contracts';
import { billingLedgerEntries } from './billingLedgerEntries';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

/**
 * Taken from the wire contract rather than restated, so the column and
 * `externalPaymentProviderSchema` cannot drift.
 */
export const EXTERNAL_PAYMENT_PROVIDER_VALUES = EXTERNAL_PAYMENT_PROVIDERS;

export const EXTERNAL_PAYMENT_KIND_VALUES = EXTERNAL_PAYMENT_KINDS;

export type ExternalPaymentProviderValue = (typeof EXTERNAL_PAYMENT_PROVIDER_VALUES)[number];

export type ExternalPaymentKindValue = (typeof EXTERNAL_PAYMENT_KIND_VALUES)[number];

export const billingExternalPayments = pgTable(
  'billing_external_payments',
  {
    id: generatedId(),

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    provider: text({ enum: EXTERNAL_PAYMENT_PROVIDER_VALUES }).notNull(),
    /**
     * WHICH processor record this is. A payment intent and the invoice it paid
     * are two records of one movement of money; counting both would double the
     * external total a reconciliation compares against.
     */
    externalKind: text({ enum: EXTERNAL_PAYMENT_KIND_VALUES }).notNull(),
    /** The processor's own id. Deliberately not named `*_id` — it is not a row here. */
    externalRef: text().notNull(),

    amount: exactAmount().notNull(),

    /**
     * The journal entry this payment produced. NOT NULL: a recorded payment that
     * credited nothing is exactly the state reconciliation exists to find, and
     * allowing it here would let that state be created by an ordinary insert
     * rather than only by a genuine fault.
     */
    ledgerEntryId: text()
      .notNull()
      .references(() => billingLedgerEntries.id, { onDelete: 'restrict' }),

    /** When the processor says the money moved, not when Oxy heard about it. */
    occurredAt: timestamptz().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // The webhook idempotency guard, and the reconciliation lookup key.
    unique('billing_external_payments_provider_ref_key').on(t.provider, t.externalRef),
    // "What did this account pay, over this window" — the reconciliation scan.
    index('billing_external_payments_account_occurred_at_idx').on(
      t.accountId,
      t.occurredAt.desc()
    ),
    // The reverse lookup: which payment produced this entry.
    index('billing_external_payments_ledger_entry_id_idx').on(t.ledgerEntryId),

    check(
      'billing_external_payments_provider_check',
      sql`${t.provider} in (${sql.raw(inList(EXTERNAL_PAYMENT_PROVIDER_VALUES))})`
    ),
    check(
      'billing_external_payments_external_kind_check',
      sql`${t.externalKind} in (${sql.raw(inList(EXTERNAL_PAYMENT_KIND_VALUES))})`
    ),
    check('billing_external_payments_currency_check', currencyCodeCheck(t.currency)),
    check('billing_external_payments_external_ref_check', sql`length(${t.externalRef}) > 0`),
    // A payment of nothing funded nothing. Strictly positive, not non-negative:
    // a zero-amount row would inflate a reconciliation's match count while
    // moving no money, which is the shape a mis-parsed webhook takes.
    check('billing_external_payments_amount_check', sql`${t.amount} > 0`),
  ]
);

export type BillingExternalPaymentRow = typeof billingExternalPayments.$inferSelect;
