/**
 * `sessions` — one signed-in account on one device, and the tokens that address it.
 *
 * Ported from `models/Session.ts`.
 *
 * ## `deviceInfo` becomes COLUMNS, not `jsonb`
 *
 * Mongo indexed `deviceInfo.fingerprint` and sorted on `deviceInfo.lastActive`.
 * A `jsonb` blob can serve neither without a hand-written expression index per
 * path, and the shape is fully known (eight fields), which is the opposite of
 * the shape-less data `jsonb` exists for. The flattening, so the backfill map is
 * unambiguous:
 *
 * | Mongo                      | Column               |
 * |----------------------------|----------------------|
 * | `deviceInfo.deviceName`    | `device_name`        |
 * | `deviceInfo.deviceType`    | `device_type`        |
 * | `deviceInfo.platform`      | `platform`           |
 * | `deviceInfo.browser`       | `browser`            |
 * | `deviceInfo.os`            | `os`                 |
 * | `deviceInfo.lastActive`    | `last_active_at`     |
 * | `deviceInfo.userAgent`     | `user_agent`         |
 * | `deviceInfo.fingerprint`   | `device_fingerprint` |
 *
 * `last_active_at` / `device_fingerprint` are renamed rather than transliterated:
 * once the path prefix is gone, `last_active` reads as a boolean and
 * `fingerprint` no longer says what it fingerprints. Every other date column in
 * this schema ends `_at`.
 *
 * `device_type` and `platform` are `NOT NULL` because the Mongoose subdocument
 * declared them `required: true`. Neither is a closed set there — `mobile`,
 * `desktop`, `tablet`, `web`, … are conventions the callers agree on, not an
 * enum the model enforced — so no CHECK is invented for them here.
 *
 * ## Expiry
 *
 * Mongo pruned expired sessions with a TTL index on `expiresAt`; the table is
 * registered in `db/expiry.ts` with `retentionSeconds: 0`. The sweep is
 * HOUSEKEEPING ONLY: `session.controller.ts:297` and every lookup in
 * `session.service.ts` already filter `expiresAt: { $gt: new Date() }`
 * alongside `isActive`. Port those filters verbatim — dropping one because "the
 * sweep handles it" turns a bounded lag into a live credential.
 *
 * ## The three Mongoose instance methods
 *
 * `updateLastActive`, `isValid` and `deactivate` are document behaviour with no
 * schema counterpart, and they are the reason three of these columns exist. They
 * become, at the call site:
 *
 * - `updateLastActive` → `update sessions set last_active_at = now() where …`
 * - `isValid`          → `is_active and expires_at > now()`
 * - `deactivate`       → `update sessions set is_active = false where …`
 *
 * Note `deactivate` never DELETES: nothing in the codebase deletes a session
 * row, only the expiry sweep does. That is what makes every `session_id`
 * reference from another table deliberately lifecycle-independent — see
 * `deferredForeignKeys.ts`.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { applications } from './applications';
import { deviceAccountContexts } from './deviceAccountContexts';
import { deviceSessions } from './deviceSessions';
import { users } from './users';

export const sessions = pgTable(
  'sessions',
  {
    id: generatedId(),
    /**
     * The UUID minted for this session and embedded in every access token. It is
     * the session's PUBLIC handle: `device_session_accounts.session_id` and
     * `auth_sessions.authorized_session_id` both name a session by this value,
     * not by `id`.
     */
    sessionId: text().notNull(),
    /** `CASCADE` — a session for an account that no longer exists is unvalidatable. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Central device id. Shared across users; not the key of any row — see the ledger. */
    deviceId: text().notNull(),

    // ---- deviceInfo (flattened; see the table in the header) ---------------
    deviceName: text(),
    deviceType: text().notNull(),
    platform: text().notNull(),
    browser: text(),
    os: text(),
    /** Mongoose defaulted this to `Date.now`, so every row carries one. */
    lastActiveAt: timestamptz().notNull().defaultNow(),
    userAgent: text(),
    /** Stable per-device hash used by `findExistingDeviceId` (`deviceUtils.ts:315`). */
    deviceFingerprint: text(),

    /**
     * The live bearer credential for this session. PROTECTED
     * (`protectedColumns.ts`): serializing it hands over the account.
     */
    accessToken: text().notNull(),
    /** Same — the refresh half. PROTECTED. */
    refreshToken: text().notNull(),
    /**
     * The just-superseded refresh token, honoured for a short grace window so a
     * multi-tab race presenting it still succeeds. Still a live credential
     * during that window, so it is PROTECTED too.
     */
    previousRefreshToken: text(),
    /** When `previous_refresh_token` was superseded; bounds the grace window. */
    tokenRotatedAt: timestamptz(),
    /**
     * The OPERATOR — the human who minted this session by switching INTO the
     * managed account in `user_id`. NULL for an ordinary first-party session.
     *
     * `CASCADE`, deliberately NOT `SET NULL`: NULL here means "not a delegated
     * session", so `SET NULL` would silently PROMOTE a delegated session into an
     * ordinary one on the managed account — and the `account:act_as` re-check
     * that binds its validity keys off this column being set. Deleting the
     * operator must kill the session, not launder it.
     */
    operatedByUserId: text().references(() => users.id, { onDelete: 'cascade' }),

    // ---- access token v2 binding (issue #937, Phase 6) ---------------------
    // What the token minted for this session is allowed to SAY, and what its
    // claims are checked back against on every request. The token is derived
    // from these columns and never the reverse, so a re-mint of a live session
    // reproduces the same binding and a claim that disagrees with the row is a
    // token that no longer describes its session.
    /**
     * The application this session BELONGS TO, when it belongs to exactly one.
     *
     * NULL is the ordinary shared device session that every official app on the
     * device uses — those are not one application's, so they carry no `azp`.
     * Set only where the session was minted for a single application and is
     * reachable by nothing else, which today means an untrusted OAuth client.
     *
     * `CASCADE`, deliberately NOT `SET NULL`, for the same reason
     * `operated_by_user_id` is: NULL here means "not an application's session",
     * so `SET NULL` would silently PROMOTE a third-party session into a
     * first-party one the moment the application row went away — laundering
     * exactly the isolation this column exists to enforce.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * `azp` — the `application_credentials.public_key` (the OAuth `client_id`)
     * that obtained this session. Stored beside `application_id` rather than
     * derived from it because an application has several credentials and may
     * rotate them; which one was used is a fact about this session.
     */
    clientId: text(),
    /**
     * `scope` — what `client_id` was granted. The intersection the authorize
     * step already computed, carried forward so the token's `scope` claim has
     * an authority to be checked against instead of being self-asserting.
     */
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * `device_session_id` / `device_context_id` — which device, and which
     * principal-acting-as-account on it (ADR 0001), this session serves.
     *
     * `SET NULL` here and NOT cascade, which is the opposite choice to
     * `application_id` above and for the opposite reason: losing the device
     * context must not delete a live session, it must only stop the token
     * claiming a context that no longer exists. Both are nullable because a
     * session minted before its device registered it has neither yet.
     */
    deviceSessionId: text().references(() => deviceSessions.id, { onDelete: 'set null' }),
    deviceContextId: text().references(() => deviceAccountContexts.id, { onDelete: 'set null' }),

    isActive: boolean().notNull().default(true),
    expiresAt: timestamptz().notNull(),
    /** Mongoose defaulted this to `Date.now`. */
    lastRefresh: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sessions_session_id_key').on(t.sessionId),
    // Mongo's `{accessToken:1}` / `{refreshToken:1}` were unique + SPARSE, but
    // both fields are `required: true`, so nothing was ever sparse about them —
    // a plain UNIQUE on a NOT NULL column is the exact same guarantee.
    unique('sessions_access_token_key').on(t.accessToken),
    unique('sessions_refresh_token_key').on(t.refreshToken),

    // "This user's session on this device" (`session.service.ts:473`).
    index('sessions_user_id_device_id_idx').on(t.userId, t.deviceId),
    // "This user's live sessions."
    index('sessions_user_id_is_active_expires_at_idx').on(t.userId, t.isActive, t.expiresAt),
    // "Everything signed in on this device" (`devices.controller.ts:46`).
    index('sessions_device_id_is_active_expires_at_idx').on(t.deviceId, t.isActive, t.expiresAt),
    // Grace-period lookup after a refresh rotation (`session.service.ts:657`).
    // Partial rather than Mongo's `sparse: true`, which is the same intent:
    // only a session mid-rotation carries a previous token.
    index('sessions_previous_refresh_token_rotated_at_idx')
      .on(t.previousRefreshToken, t.tokenRotatedAt)
      .where(sql`${t.previousRefreshToken} is not null`),
    // `findExistingDeviceId` (`deviceUtils.ts:315`). Partial: the query always
    // supplies a fingerprint, and `col = $1` implies `col is not null`, so the
    // planner still uses it while the index skips every fingerprint-less row.
    index('sessions_device_fingerprint_is_active_expires_at_idx')
      .on(t.deviceFingerprint, t.isActive, t.expiresAt)
      .where(sql`${t.deviceFingerprint} is not null`),
    // Supports the expiry sweep (`db/expiry.ts`) — the TTL-index replacement.
    // None of the compound indexes above can serve it: each leads with another
    // column, and the sweep's predicate is a bare range scan on `expires_at`.
    index('sessions_expires_at_idx').on(t.expiresAt),
    // Mongo also declared `{sessionId:1, isActive:1, expiresAt:1}`. Dropped as
    // redundant: `sessions_session_id_key` is UNIQUE, so a lookup by
    // `session_id` already resolves to at most one row and the remaining two
    // predicates are a free check on that single heap tuple.
    //
    // No CHECK constraint on this table. `expires_at > created_at` is true of
    // every row the application writes, but the Mongoose model never validated
    // it, so asserting it here would risk failing the backfill on production
    // data to restate something no read path depends on.
  ]
);
