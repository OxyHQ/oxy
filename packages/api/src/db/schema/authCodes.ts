/**
 * `auth_codes` — single-use OAuth2 authorization codes (`authorize` → `token`).
 *
 * Ported from `models/AuthCode.ts`.
 *
 * ## Expiry — the 5-minute pad is the whole point
 *
 * Mongo's TTL was `{ expiresAt: 1 }, { expireAfterSeconds: 300 }`: the row
 * deliberately OUTLIVES its own deadline so a replay of a just-expired code is
 * still recognised as a replay (`oauthCode.service.ts:145` reads `usedAt` and
 * refuses) rather than answering "no such code". Registered in `db/expiry.ts`
 * with `retentionSeconds: 300` — the same shape, the same grace. Reducing it to
 * 0 would silently turn a detected replay into an indistinguishable miss.
 *
 * The read path filters expiry itself, so the sweep is housekeeping.
 *
 * ## `appId` → `application_id`
 *
 * The Mongoose field is an untyped `String` holding an `Application` `_id`. It
 * is renamed on port so that every reference to `applications` in this schema
 * carries one name (`push_tokens.application_id`,
 * `app_affinity_seen_events.application_id`, `auth_sessions.application_id`,
 * `identity_bindings.application_id`). Unrelated to the service-token JWT claim
 * also called `appId`, which is a wire contract and is NOT touched.
 *
 * The constraint itself is deferred — `applications` has not landed yet. See
 * `deferredForeignKeys.ts`.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** PKCE transforms accepted at issue time. `plain` is refused at the edge. */
export const AUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;

export const authCodes = pgTable(
  'auth_codes',
  {
    id: generatedId(),
    /**
     * `sha256` of the raw code. The code itself is a bearer credential and is
     * NEVER stored, so this is a verifier rather than a secret.
     */
    codeHash: text().notNull(),
    /**
     * SUBJECT of the grant — for a delegated authorization this is the
     * ORGANIZATION account, not the human who approved it. `CASCADE`: a code
     * that grants access to a deleted account grants nothing.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * OPERATOR for a delegated grant — the human who approved the app to act as
     * `user_id`. `CASCADE` for the same reason as `sessions.operated_by_user_id`:
     * NULL means "an ordinary self-grant", so `SET NULL` would launder a
     * delegated code into one, and the session minted at exchange time would
     * lose the `account:act_as` binding that constrains it.
     */
    operatedByUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The application the code was issued TO. `CASCADE`, as the deferred-FK
     * ledger decided before `applications` landed: with the application gone
     * there is nobody to exchange the code, and it is unusable within five
     * minutes anyway.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Bound at issue time, re-checked at exchange time. */
    redirectUri: text().notNull(),
    /** PKCE challenge. NULL only for a confidential client presenting a secret. */
    codeChallenge: text(),
    codeChallengeMethod: text({ enum: AUTH_CODE_CHALLENGE_METHODS }),
    /**
     * Scopes bound at issue time. `NOT NULL DEFAULT '{}'` because Mongoose
     * declared `default: []` — an empty list is a VALUE here ("no scopes"), not
     * an absence, which is the distinction `webauthn_credentials.transports`
     * makes in the other direction.
     */
    scopes: text().array().notNull().default([]),
    /** Threads the exchange onto the originating device. Not a row id. */
    deviceId: text(),
    /**
     * Set by the atomic single-use claim. Its presence — not the row's absence —
     * is what distinguishes a REPLAY from an unknown code, which is why the
     * retention pad above exists.
     */
    usedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('auth_codes_code_hash_key').on(t.codeHash),
    index('auth_codes_user_id_idx').on(t.userId),
    index('auth_codes_application_id_idx').on(t.applicationId),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('auth_codes_expires_at_idx').on(t.expiresAt),
    // Mongo declared a standalone `{usedAt: 1}` index. Dropped: nothing queries
    // by it. The single-use claim is `findOneAndUpdate({_id, usedAt: null})`
    // (`oauthCode.service.ts:190`) — keyed on the primary key, with `used_at`
    // only as a guard predicate on the one row it already found.
    check(
      'auth_codes_code_challenge_method_check',
      sql`${t.codeChallengeMethod} in (${sql.raw(AUTH_CODE_CHALLENGE_METHODS.map((value) => `'${value}'`).join(', '))})`
    ),
    // A public client (no secret at exchange) must present PKCE, and PKCE is
    // meaningless without its method. Mongo allowed a challenge with no method
    // and a method with no challenge; neither can be verified.
    check(
      'auth_codes_pkce_pair_check',
      sql`(${t.codeChallenge} is null) = (${t.codeChallengeMethod} is null)`
    ),
  ]
);
