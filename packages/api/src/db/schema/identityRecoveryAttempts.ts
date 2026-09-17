/**
 * `identity_recovery_attempts` — signed-out recovery from a root (ADR 0024 D5).
 *
 * One short-lived row per attempt, advancing `challenged → started → completed`
 * through single conditional UPDATEs. Only hashes of the challenge and the ticket
 * are stored, so a database read cannot spend a live attempt. The account and
 * root are filled in only after the root has PROVEN itself; a `challenged` row
 * is linked to nothing.
 *
 * Expiry is read-side first (every transition filters `expires_at`); the sweep in
 * `db/expiry.ts` only reclaims storage.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const IDENTITY_RECOVERY_STATUSES = ['challenged', 'started', 'completed'] as const;

export const identityRecoveryAttempts = pgTable(
  'identity_recovery_attempts',
  {
    id: generatedId(),
    /** SHA-256 hex of the public challenge. */
    challengeHash: text().notNull(),
    /** SHA-256 hex of the ticket handed out once the root proved itself. */
    ticketHash: text(),
    /** `CASCADE` — an attempt for a deleted account has nothing to recover. */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** The root that proved itself, lowercase. */
    rootPublicKey: text(),
    /** The WebAuthn registration challenge issued for the new passkey (base64url). */
    registrationChallenge: text(),
    status: text({ enum: IDENTITY_RECOVERY_STATUSES }).notNull().default('challenged'),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_recovery_attempts_challenge_hash_key').on(t.challengeHash),
    unique('identity_recovery_attempts_ticket_hash_key').on(t.ticketHash),
    index('identity_recovery_attempts_expires_at_idx').on(t.expiresAt),
    check('identity_recovery_attempts_status_check', sql`${t.status} in ('challenged', 'started', 'completed')`),
    check(
      'identity_recovery_attempts_started_check',
      sql`(${t.status} = 'challenged') = (${t.ticketHash} is null and ${t.userId} is null and ${t.rootPublicKey} is null and ${t.registrationChallenge} is null)`,
    ),
  ],
);
