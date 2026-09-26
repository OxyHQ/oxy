/**
 * `email_verifications` — a 6-digit code sent to a recovery email, and the
 * one-use ticket its confirmation mints (ADR 0029 D3).
 *
 * One row per code sent: a new passkey account proving its recovery email
 * (`signup`), or an account being recovered through it (`recovery`). A
 * `recovery` row that named no account — or an account with no recovery email —
 * is a decoy: its code was never sent, so it can never be confirmed, and the
 * caller cannot tell it from a real one.
 *
 * Nothing here is readable as a secret or as an address: the email is stored
 * only as `hashEmail`'s digest (the canonicalization of `users.hashed_email`),
 * the code as an HMAC under the server salt, and the ticket as its SHA-256.
 *
 * `expires_at` is the row's CURRENT deadline: the code's until it is
 * confirmed, then the ticket's. Every read filters it itself; the sweep in
 * `db/expiry.ts` only reclaims storage, an hour late, so the per-email rate
 * limit (which counts this table's rows) keeps seeing an hour of sends.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { EMAIL_VERIFICATION_PURPOSES } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { users } from './users';

export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: generatedId(),
    purpose: text({ enum: EMAIL_VERIFICATION_PURPOSES }).notNull(),
    /** `hashEmail` of the address the code went (or would have gone) to. */
    emailHash: text().notNull(),
    /**
     * Recovery only: the account the code recovers. `null` for a sign-up and for
     * a decoy. `CASCADE`: a deleted account has nothing left to recover.
     */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256 (server salt) of the row id and the code. */
    codeHash: text().notNull(),
    /** Wrong codes so far; the row stops accepting codes at the cap. */
    attempts: integer().notNull().default(0),
    expiresAt: timestamptz().notNull(),
    /** When the right code was given. */
    confirmedAt: timestamptz(),
    /** SHA-256 hex of the ticket `confirm` returned. */
    ticketHash: text(),
    /** When the ticket was spent. */
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('email_verifications_ticket_hash_key').on(t.ticketHash),
    index('email_verifications_email_hash_created_at_idx').on(t.emailHash, t.createdAt),
    index('email_verifications_expires_at_idx').on(t.expiresAt),
    index('email_verifications_user_id_idx').on(t.userId),
    check('email_verifications_purpose_check', sql`${t.purpose} in ('signup', 'recovery')`),
    check('email_verifications_ticket_check', sql`${t.ticketHash} is null or ${t.confirmedAt} is not null`),
    check('email_verifications_used_check', sql`${t.usedAt} is null or ${t.ticketHash} is not null`),
    check('email_verifications_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
