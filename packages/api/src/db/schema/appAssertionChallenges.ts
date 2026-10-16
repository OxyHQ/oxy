/**
 * `app_assertion_challenges` — single-use challenges for a device proof (ADR 0045).
 *
 * `POST /apps/assertions/challenge` mints one for ONE person, ONE session, ONE
 * application, ONE platform and ONE purpose (`assertion`, or `attest_key` to
 * register an App Attest key). The device binds it into its proof through the
 * challenge's `requestHash`, and the single conditional UPDATE that accepts the
 * proof burns it — BEFORE the proof is verified, so a refused proof cannot be
 * retried and a used Play Integrity token or App Attest assertion can never be
 * replayed.
 *
 * Only the SHA-256 of the challenge is stored, so a database read cannot spend a
 * live one. Expiry is read-side first (every burn filters `expires_at`); the
 * sweep in `db/expiry.ts` only reclaims storage.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { APP_ASSERTION_CHALLENGE_PURPOSES } from '@oxy.so/contracts';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** The platforms that prove with a challenge. The web proves with the browser's `Origin`. */
export const APP_ASSERTION_CHALLENGE_PLATFORMS = ['android', 'ios'] as const;

export const appAssertionChallenges = pgTable(
  'app_assertion_challenges',
  {
    id: generatedId(),
    /** SHA-256 hex of the challenge. The challenge itself is never stored. */
    challengeHash: text().notNull(),
    /** The person it may be spent by. `CASCADE`: nothing to spend once they are gone. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The session it may be spent in. Not a foreign key: a challenge outlives nothing. */
    sessionId: text().notNull(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    platform: text({ enum: APP_ASSERTION_CHALLENGE_PLATFORMS }).notNull(),
    purpose: text({ enum: APP_ASSERTION_CHALLENGE_PURPOSES }).notNull(),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('app_assertion_challenges_challenge_hash_key').on(t.challengeHash),
    index('app_assertion_challenges_expires_at_idx').on(t.expiresAt),
    check(
      'app_assertion_challenges_challenge_hash_check',
      sql`${t.challengeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'app_assertion_challenges_platform_check',
      sql`${t.platform} in (${sql.raw(inList(APP_ASSERTION_CHALLENGE_PLATFORMS))})`,
    ),
    check(
      'app_assertion_challenges_purpose_check',
      sql`${t.purpose} in (${sql.raw(inList(APP_ASSERTION_CHALLENGE_PURPOSES))})`,
    ),
    // Only iOS registers keys.
    check(
      'app_assertion_challenges_attest_key_check',
      sql`${t.purpose} <> 'attest_key' or ${t.platform} = 'ios'`,
    ),
  ],
);
