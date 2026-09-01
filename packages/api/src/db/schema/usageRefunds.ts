/**
 * `usage_refunds` — the immutable reversal.
 *
 * ADR 0009's fourth record: an unused hold released, or money already booked
 * given back. Both are APPENDED; settled history is compensated, never
 * rewritten, because an invoice a customer already received must remain
 * reconstructible.
 *
 * Immutability is enforced by `LEDGER_IMMUTABILITY_DDL`
 * (`db/schema/ledgerImmutability.ts`) rather than by convention, and the absence
 * of an `updated_at` column is the visible half of it.
 *
 * ## The subject is a DISCRIMINATED union, not one nullable id
 *
 * "release the rest of the hold" and "give back money already booked" hit
 * different ledger accounts and only the second is visible on an invoice. They
 * are stored as two nullable foreign keys plus a `subject_kind` discriminant,
 * with a CHECK that exactly the matching one is set — so a row cannot claim to
 * be one and point at the other, and a query for "money actually returned" can
 * never accidentally sweep up released holds.
 *
 * Two nullable foreign keys rather than one polymorphic id, because both parents
 * are tables in THIS database: a polymorphic column would throw away two real
 * relational links to save one column.
 *
 * ## `amount` is non-negative, like every amount in this schema
 *
 * The direction is carried by the record BEING a refund, never by a sign a
 * consumer could read the wrong way round.
 *
 * ## Reasons are a closed set, with two rules the contract states and this
 * table enforces
 *
 *  - `unused_reservation` acts on a RESERVATION. Releasing an unused hold
 *    against a receipt is not a smaller version of the same thing; it is a
 *    different event.
 *  - `billing_correction` and `duplicate_charge` act on a RECEIPT. They reverse
 *    money that was booked, which a hold never was.
 *
 * An expiring reservation is `unused_reservation` too — ADR 0009 says an expiry
 * IS a refund with a reason, never a silent release. The two are still
 * distinguishable, because the ledger entry that accompanies them carries
 * `reservation_expiry` rather than `reservation_release`.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { usageRefundReasonSchema } from '@oxyhq/contracts';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { usageReceipts } from './usageReceipts';
import { usageReservations } from './usageReservations';
import { users } from './users';

/** What a reversal acts on. */
export const USAGE_REFUND_SUBJECT_KINDS = ['reservation', 'receipt'] as const;

export type UsageRefundSubjectKind = (typeof USAGE_REFUND_SUBJECT_KINDS)[number];

/** Why money was given back or a hold released, from the wire contract's enum. */
export const USAGE_REFUND_REASONS = usageRefundReasonSchema.options;

/** Reasons that can only ever act on a settled charge. */
export const RECEIPT_ONLY_REFUND_REASONS = ['billing_correction', 'duplicate_charge'] as const;

export const usageRefunds = pgTable(
  'usage_refunds',
  {
    id: generatedId(),

    /** Caller-supplied. A retried refund releases the same money once. */
    idempotencyKey: text().notNull(),

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The correlation key, carried so a refund is findable beside its request. */
    requestId: text().notNull(),

    subjectKind: text({ enum: USAGE_REFUND_SUBJECT_KINDS }).notNull(),
    reservationId: text().references(() => usageReservations.id, { onDelete: 'restrict' }),
    receiptId: text().references(() => usageReceipts.id, { onDelete: 'restrict' }),

    reason: text({ enum: USAGE_REFUND_REASONS }).notNull(),
    amount: exactAmount().notNull(),
    currency: currencyCode(),

    createdAt: createdAt(),
  },
  (t) => [
    unique('usage_refunds_idempotency_key_key').on(t.idempotencyKey),

    index('usage_refunds_account_id_created_at_idx').on(t.accountId, t.createdAt.desc()),
    index('usage_refunds_reservation_id_idx').on(t.reservationId),
    index('usage_refunds_receipt_id_idx').on(t.receiptId),
    index('usage_refunds_request_id_idx').on(t.requestId),

    check(
      'usage_refunds_subject_kind_check',
      sql`${t.subjectKind} in (${sql.raw(inList(USAGE_REFUND_SUBJECT_KINDS))})`
    ),
    check(
      'usage_refunds_reason_check',
      sql`${t.reason} in (${sql.raw(inList(USAGE_REFUND_REASONS))})`
    ),
    check('usage_refunds_currency_check', currencyCodeCheck(t.currency)),
    // A refund of nothing is a record that money moved when it did not.
    check('usage_refunds_amount_check', sql`${t.amount} > 0`),
    check('usage_refunds_request_id_check', sql`length(${t.requestId}) > 0`),
    // Exactly the subject the discriminant names, and nothing else. Written as
    // a biconditional per arm rather than as "one of the two is null", because
    // the latter admits a `receipt`-kind row pointing at a reservation.
    check(
      'usage_refunds_subject_check',
      sql`(${t.subjectKind} = 'reservation'
            and ${t.reservationId} is not null and ${t.receiptId} is null)
        or (${t.subjectKind} = 'receipt'
            and ${t.receiptId} is not null and ${t.reservationId} is null)`
    ),
    // An unused reservation is released against the reservation, not a receipt.
    check(
      'usage_refunds_unused_reservation_check',
      sql`${t.reason} <> 'unused_reservation' or ${t.subjectKind} = 'reservation'`
    ),
    // A correction reverses a settled charge, so it acts on a receipt.
    check(
      'usage_refunds_receipt_only_reason_check',
      sql`${t.reason} not in (${sql.raw(inList(RECEIPT_ONLY_REFUND_REASONS))})
        or ${t.subjectKind} = 'receipt'`
    ),
  ]
);
