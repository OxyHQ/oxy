/**
 * `auth_challenges` — short-lived challenges for the challenge-response signin
 * and key-rotation flows.
 *
 * Ported from `models/AuthChallenge.ts`.
 *
 * The table is registered in `db/expiry.ts` and swept — but the sweep is
 * HOUSEKEEPING ONLY here: every read path filters `expires_at > now()` itself.
 * Those filters must stay; without them a challenge stays spendable for up to
 * one sweep interval past its deadline.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

/**
 * What a challenge may be spent on. A challenge minted for one flow can never be
 * redeemed by another, so an unrecognised value must fail loudly at insert
 * rather than quietly produce a challenge nothing can spend.
 */
export const AUTH_CHALLENGE_PURPOSES = [
  'signin',
  'rotate_key',
  'agent_signin',
  'agent_enroll',
  'agent_rotate',
  'agent_recover',
  'agent_governance',
] as const;

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: generatedId(),
    /**
     * The device public key the challenge is bound to. NOT a foreign key: the
     * key is what IDENTIFIES the user during signin, and the challenge is minted
     * before any user has been resolved from it.
     */
    publicKey: text().notNull(),
    challenge: text().notNull(),
    /**
     * NOT NULL, defaulting to `'signin'`, so readers compare with plain
     * equality and never need a null branch.
     */
    purpose: text({ enum: AUTH_CHALLENGE_PURPOSES }).notNull().default('signin'),
    /** Explicit target and actor for the payload-bound agent proof. Account deletion retires it. */
    accountId: text().references(() => users.id, { onDelete: 'cascade' }),
    actorId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the canonical operation payload; no secret or arbitrary request fields. */
    bindingDigest: text(),
    expiresAt: timestamptz().notNull(),
    used: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'auth_challenges_agent_binding_check',
      sql`${t.purpose} in ('signin', 'rotate_key') or (${t.accountId} is not null and ${t.actorId} is not null and ${t.bindingDigest} is not null)`,
    ),
    check(
      'auth_challenges_binding_digest_check',
      sql`${t.bindingDigest} is null or ${t.bindingDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    // Invalidate pending proofs when the governed account is archived/recovered.
    index('auth_challenges_account_id_idx').on(t.accountId).where(sql`${t.accountId} is not null`),
    unique('auth_challenges_challenge_key').on(t.challenge),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('auth_challenges_expires_at_idx').on(t.expiresAt),
    // No `(public_key, challenge)` index: it would be redundant, since every
    // read is keyed on the
    // high-entropy `challenge`, which the unique index above answers directly.
    check(
      'auth_challenges_purpose_check',
      sql`${t.purpose} in (${sql.raw(AUTH_CHALLENGE_PURPOSES.map((value) => `'${value}'`).join(', '))})`,
    ),
  ],
);
