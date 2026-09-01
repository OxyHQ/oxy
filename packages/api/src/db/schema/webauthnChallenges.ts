/**
 * `webauthn_challenges` — the single-use challenge for one WebAuthn ceremony.
 *
 * Ported from `models/WebauthnChallenge.ts`. Mirrors `auth_challenges`: the
 * `challenge` is unique, the row expires, and `used` is flipped atomically the
 * moment the verify step burns it, so a challenge can never be replayed.
 *
 * `user_id` is NULL for a prospective signup and for a usernameless /
 * discoverable login — the ceremony is not bound to a known account yet. That
 * absence is meaningful, so the column is nullable rather than defaulted.
 *
 * Registered in `db/expiry.ts` with `retentionSeconds: 0` (Mongo:
 * `expireAfterSeconds: 0` on `expiresAt`). Housekeeping only — the verify step
 * checks the deadline itself.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Which ceremony the challenge was minted for. One can never spend the other's. */
export const WEBAUTHN_CHALLENGE_TYPES = ['registration', 'authentication'] as const;

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: generatedId(),
    /** Sent to the authenticator to sign. Public by construction, not a secret. */
    challenge: text().notNull(),
    type: text({ enum: WEBAUTHN_CHALLENGE_TYPES }).notNull(),
    /**
     * The account the ceremony is bound to, when there is one. `CASCADE` — a
     * challenge bound to a deleted account can never be completed.
     */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    used: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('webauthn_challenges_challenge_key').on(t.challenge),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('webauthn_challenges_expires_at_idx').on(t.expiresAt),
    // No `user_id` index: every read is keyed on the high-entropy `challenge`,
    // which the unique index answers directly. `auth_challenges` dropped its
    // equivalent compound for the same reason.
    check(
      'webauthn_challenges_type_check',
      sql`${t.type} in (${sql.raw(WEBAUTHN_CHALLENGE_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
