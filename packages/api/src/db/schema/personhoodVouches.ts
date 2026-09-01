/**
 * `personhood_vouches` — one staked, signed edge of the web-of-trust.
 *
 * Ported from `models/PersonhoodVouch.ts`. The voucher puts their own standing
 * on the line to assert the subject is a real, unique human; if the subject is
 * later proven fake, every ACTIVE voucher is slashed (`vouch_slashed`, −20) and
 * their vouch flips to `slashed`.
 *
 * ## The partial unique index is genuinely partial
 *
 * `UNIQUE (voucher_user_id, subject_user_id) WHERE status = 'active'` — exactly
 * one LIVE vouch per pair, while every withdrawn or slashed row stays as
 * history. This is NOT the Mongo-null workaround the other partial indexes in
 * this batch collapsed into a plain `UNIQUE`: the predicate is a real value
 * filter, and dropping it would make re-vouching after a withdrawal impossible.
 *
 * It is a CONCURRENCY backstop, not the whole rule. Service code additionally
 * refuses any HISTORICAL vouch for the same pair before issuing a new signed
 * record or award, which the database deliberately does not enforce — a
 * withdrawal followed by a legitimate re-vouch is a product decision, and
 * freezing it here would make that decision unchangeable without a migration.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { signedRecords } from './signedRecords';
import { users } from './users';

/** Vouch lifecycle. Only `active` counts toward a subject's personhood. */
export const PERSONHOOD_VOUCH_STATUSES = ['active', 'slashed', 'withdrawn'] as const;

export const personhoodVouches = pgTable(
  'personhood_vouches',
  {
    id: generatedId(),
    /** The account making — and staking on — the vouch. */
    voucherUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The account vouched for. */
    subjectUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Reputation points staked — the amount lost on a slash. */
    stakeAmount: integer().notNull(),
    /**
     * Content address of the voucher's signed `personhood_vouch` envelope.
     *
     * A real foreign key: the signed record IS the vouch, and this row is its
     * queryable projection. `CASCADE` follows the proof — a vouch whose
     * signature no longer exists cannot be checked by anyone, so keeping the
     * projection would be keeping an unverifiable claim.
     *
     * **Call-site consequence:** `personhood.service.ts:327` writes
     * `stored.record.recordId ?? ''`, and `''` is not a content address. Under
     * Mongo it produced a silently dangling reference; here it fails the
     * constraint loudly, which is what the port must fix rather than work around.
     */
    recordId: text()
      .notNull()
      .references(() => signedRecords.recordId, { onDelete: 'cascade' }),
    status: text({ enum: PERSONHOOD_VOUCH_STATUSES }).notNull().default('active'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The concurrency backstop. See the header on why this one stays partial.
    uniqueIndex('personhood_vouches_active_pair_key')
      .on(t.voucherUserId, t.subjectUserId)
      .where(sql`${t.status} = 'active'`),
    // The recompute aggregation: a subject's active vouchers.
    index('personhood_vouches_subject_id_status_idx').on(t.subjectUserId, t.status),

    check(
      'personhood_vouches_status_check',
      sql`${t.status} in (${sql.raw(inList(PERSONHOOD_VOUCH_STATUSES))})`
    ),
    check('personhood_vouches_stake_check', sql`${t.stakeAmount} >= 0`),
    // Vouching for yourself is not evidence. `submitVouch` already answers
    // `self_vouch`, and `graphExclusion` excludes `self`; the CHECK makes it
    // unrepresentable rather than dependent on both staying in place.
    check('personhood_vouches_not_self_check', sql`${t.voucherUserId} <> ${t.subjectUserId}`),
  ]
);
