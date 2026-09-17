/**
 * `identity_proof_challenges` — one-use challenges for root proofs (ADR 0024 D7).
 *
 * A challenge is minted for ONE account and ONE action, optionally pinned to the
 * root that was linked when it was minted, and is burned by the single
 * conditional UPDATE that accepts the proof that names it. A timestamp window is
 * not replay protection; this row is.
 *
 * Only the SHA-256 of the challenge is stored, so a database read cannot spend a
 * live one. Expiry is read-side first (every burn filters `expires_at`); the sweep
 * in `db/expiry.ts` only reclaims storage.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { IDENTITY_PROOF_ACTION_VALUES } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { users } from './users';

export const identityProofChallenges = pgTable(
  'identity_proof_challenges',
  {
    id: generatedId(),
    /** The account the challenge may be spent for. `CASCADE`: nothing to spend once it is gone. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text({ enum: IDENTITY_PROOF_ACTION_VALUES }).notNull(),
    /** SHA-256 hex of the challenge. The challenge itself is never stored. */
    challengeHash: text().notNull(),
    /** The root linked when the challenge was minted, or `null` for a keyless account's first link. */
    rootPublicKey: text(),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('identity_proof_challenges_challenge_hash_key').on(t.challengeHash),
    index('identity_proof_challenges_expires_at_idx').on(t.expiresAt),
    check('identity_proof_challenges_challenge_hash_check', sql`${t.challengeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
