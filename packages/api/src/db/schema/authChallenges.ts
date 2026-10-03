/**
 * `auth_challenges` — short-lived challenges for the challenge-response signin
 * and key-rotation flows.
 *
 * Ported from `models/AuthChallenge.ts`.
 *
 * Mongo self-pruned these with a TTL index on `expiresAt`. Postgres has no
 * equivalent, so the table is registered in `db/expiry.ts` and swept — but the
 * sweep is HOUSEKEEPING ONLY here: every read path already filters
 * `expiresAt > now()` itself (`session.controller.ts:297`,
 * `authSession.service.ts:280`, `authLinking.ts:303`), exactly as it had to under
 * Mongo's ~60s-lagging TTL monitor. Those filters must survive the call-site
 * port; without them a challenge stays spendable for up to one sweep interval
 * past its deadline.
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
export const AUTH_CHALLENGE_PURPOSES = ['signin', 'rotate_key', 'agent_signin', 'agent_enroll', 'agent_rotate', 'agent_recover', 'agent_governance'] as const;

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
     * Mongo left this optional and every reader had to accept `null` for
     * documents predating the field (`purpose: { $in: ['signin', null] }`). Here
     * it is NOT NULL with the same default the model declared, so the backfill
     * maps absent/null to `'signin'` once and readers compare with plain
     * equality — the legacy null branch does not travel.
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
    check('auth_challenges_agent_binding_check', sql`${t.purpose} in ('signin', 'rotate_key') or (${t.accountId} is not null and ${t.actorId} is not null and ${t.bindingDigest} is not null)`),
    check('auth_challenges_binding_digest_check', sql`${t.bindingDigest} is null or ${t.bindingDigest} ~ '^[0-9a-f]{64}$'`),
    // Invalidate pending proofs when the governed account is archived/recovered.
    index('auth_challenges_account_id_idx').on(t.accountId).where(sql`${t.accountId} is not null`),
    unique('auth_challenges_challenge_key').on(t.challenge),
    // Supports the expiry sweep in `db/expiry.ts` — the replacement for Mongo's
    // TTL index on this column.
    index('auth_challenges_expires_at_idx').on(t.expiresAt),
    // Mongo also declared a `{publicKey: 1, challenge: 1}` compound index. It
    // was redundant there and is redundant here: every read is keyed on the
    // high-entropy `challenge`, which the unique index above answers directly.
    check(
      'auth_challenges_purpose_check',
      sql`${t.purpose} in (${sql.raw(AUTH_CHALLENGE_PURPOSES.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
