/**
 * `signin_second_factor_challenges` — the step between a first factor (email
 * code, email link, password) and the session, for an account with an
 * authenticator (`services/signInSession.service.ts`).
 *
 * No session exists until the second factor passes: the first factor answers
 * only this challenge's id, 32 random bytes stored as their SHA-256. It is
 * bound to the account and to the device the first factor proved (or to none),
 * lives `SIGNIN_SECOND_FACTOR_TTL_MS` (contracts), accepts a few wrong codes, and is
 * spent by the one conditional update that passes it.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { users } from './users';

export const signInSecondFactorChallenges = pgTable(
  'signin_second_factor_challenges',
  {
    id: generatedId(),
    challengeHash: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The device the first factor proved; the second must prove the same one. */
    deviceId: text(),
    attempts: integer().notNull().default(0),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('signin_second_factor_challenges_hash_key').on(t.challengeHash),
    index('signin_second_factor_challenges_user_id_idx').on(t.userId),
    index('signin_second_factor_challenges_expires_at_idx').on(t.expiresAt),
    check('signin_second_factor_challenges_hash_check', sql`${t.challengeHash} ~ '^[0-9a-f]{64}$'`),
    check('signin_second_factor_challenges_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
