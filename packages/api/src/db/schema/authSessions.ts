/**
 * `auth_sessions` — one cross-app authorization REQUEST, from QR to approval.
 *
 * Ported from `models/AuthSession.ts`. One request model, one state machine
 * (`pending → authorized → consumed`, plus `cancelled` / `expired`), every
 * delivery surface (popup / push / QR / deep link) converging on it.
 *
 * ## Progress is timestamps, never statuses
 *
 * `push_sent_at` and `opened_at` ride BESIDE `status`, never inside it, so a
 * delivery signal can never be mistaken for an authorization. That is a schema
 * property here, not a convention: `status` has a CHECK listing five values and
 * neither "pushed" nor "opened" is among them.
 *
 * ## `oauth` stays NULL as a WHOLE
 *
 * Mongoose declares the OAuth binding as its own sub-schema specifically so the
 * path stays `undefined` on a device-sign-in row instead of materialising an
 * empty object that reads as truthy. Flattening it to columns preserves exactly
 * that, and states it as a constraint the model could only ever hope for:
 *
 *   - `auth_sessions_oauth_binding_check` — every `oauth_*` column is NULL
 *     together or present together. There is no half-bound request.
 *   - `auth_sessions_oauth_purpose_check` — the binding is present if and only
 *     if `purpose = 'oauth_authorization'`, which is what
 *     `resolveOAuthContext` (`authSession.service.ts:64`) already refuses to
 *     read otherwise, and what the single write site
 *     (`routes/auth.ts:759`) already writes as a pair.
 *
 * `oauth_subject_account_id` is OUTSIDE the all-or-nothing group: it is optional
 * even within a bound request (`subjectAccountId` defaults to null in the
 * sub-schema), so folding it in would forbid an ordinary non-delegated OAuth
 * request.
 *
 * ## Expiry
 *
 * Mongo TTL `{ expiresAt: 1 }, { expireAfterSeconds: 3600 }` — a one-hour grace
 * past the deadline so a late poll gets "expired" rather than "never existed".
 * Registered in `db/expiry.ts` with `retentionSeconds: 3600`.
 * `authSession.service.ts:280` filters `expiresAt > now` itself, so the sweep is
 * housekeeping.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { COMMONS_DENY_REASONS } from '@oxyhq/contracts';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** The authoritative state machine. Delivery progress is never one of these. */
export const AUTH_SESSION_STATUSES = [
  'pending',
  'authorized',
  'consumed',
  'expired',
  'cancelled',
] as const;

/** What the request authorizes: a device sign-in, or an OAuth code. */
export const AUTH_SESSION_PURPOSES = ['device_sign_in', 'oauth_authorization'] as const;

/** PKCE transform accepted on a bound request. `plain` is refused at bind time. */
export const AUTH_SESSION_CHALLENGE_METHODS = ['S256'] as const;

/**
 * Longest `requester_label` the approval screen will store.
 *
 * Mongoose's `maxlength: 64` is a fail-CLOSED guard, not formatting: every
 * derived label is a handful of characters ("Chrome on Windows"), so a future
 * writer that tried to persist a full User-Agent here fails instead of quietly
 * turning this column into a fingerprint. It survives the port as a CHECK, which
 * is safe for the backfill precisely because Mongoose already validated it.
 */
export const AUTH_SESSION_REQUESTER_LABEL_MAX_LENGTH = 64;

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: generatedId(),
    /**
     * The 128-bit SECRET held only by the originating client; presenting it
     * claims the result. PROTECTED (`protectedColumns.ts`) — `POST
     * /auth/session/claim` takes no bearer, so disclosing this column is
     * account takeover.
     */
    sessionToken: text().notNull(),
    /**
     * The PUBLIC single-use approval handle carried in the QR / deep link. Safe
     * to display by construction — approving with it is key-signed.
     *
     * Nullable + plain `UNIQUE`. Mongo needed `sparse: true` and no `default:
     * null` because its sparse unique index collides on nulls; Postgres treats
     * NULLs as DISTINCT, so the workaround does not travel and must NOT become
     * `''`, which would collide for real.
     */
    authorizeCode: text(),
    /** Browser Origin the request was started from; shown on the approval screen. */
    boundOrigin: text(),
    /**
     * Anti-phishing signal: a platform-trusted Application proved it was running
     * on one of its OWN registered redirect origins. Never a gate by itself.
     */
    originVerified: boolean().notNull().default(false),
    /**
     * COARSE, display-only client label ("Chrome on Windows"), derived
     * SERVER-side from the request's own User-Agent. This is the WHOLE requester
     * descriptor: no raw User-Agent, no IP, no geolocation, no country is stored
     * anywhere on this path (platform-wide no-IP-at-rest invariant). NULL for a
     * native caller. See the length CHECK below.
     */
    requesterLabel: text(),
    /** Random nonce echoed in the QR payload. Audit only; not a binding check. */
    challengeNonce: text(),
    /**
     * The application asking. `CASCADE`, as the deferred-FK ledger decided
     * before `applications` landed: the whole approval screen — name, icon,
     * scopes — is resolved from it, so a request that can no longer name who is
     * asking must not be approvable.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Central device id of the browser that STARTED the request. Not a row id. */
    deviceId: text(),
    status: text({ enum: AUTH_SESSION_STATUSES }).notNull().default('pending'),
    purpose: text({ enum: AUTH_SESSION_PURPOSES }).notNull().default('device_sign_in'),

    // ---- the OAuth binding (all-or-nothing; see the header) ----------------
    /** Exact redirect URI, validated against the Application allowlist at bind time. */
    oauthRedirectUri: text(),
    oauthCodeChallenge: text(),
    oauthCodeChallengeMethod: text({ enum: AUTH_SESSION_CHALLENGE_METHODS }),
    /** `NOT NULL` only in the sense the group CHECK enforces; `{}` means "no scopes". */
    oauthScopes: text().array(),
    /**
     * OPTIONAL delegated subject — the account the app will act AS. `CASCADE`:
     * a request to act as a deleted account can never be finalized, and `SET
     * NULL` would convert a delegated request into a plain self-grant, dropping
     * the `account:act_as` re-check that runs at both approval and finalize.
     */
    oauthSubjectAccountId: text().references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The `auth_codes.id` RESERVED for this request's one and only code.
     *
     * Deliberately carries NO foreign key. `finalizeCommonsOAuth`
     * (`authSession.service.ts:581`) mints the id and writes it in the SAME
     * atomic update that spends the request — BEFORE `issueAuthCode` inserts the
     * row, and the mint may then fail, leaving an id that will never become one.
     * A constraint would reject that write and destroy the single-use guarantee
     * it exists to provide; `SET NULL` would be worse still, resurrecting a
     * spent request as un-finalized the moment the code's own 5-minute sweep ran
     * and letting it mint a SECOND authorization code. Recorded in
     * `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.
     */
    finalizedAuthCodeId: text(),
    /**
     * Why a pending request was denied, from a closed set. `'not_me'` marks a
     * denial the approver reported as one they never started; an ordinary cancel
     * is `'declined'` or absent.
     */
    deniedReason: text({ enum: COMMONS_DENY_REASONS }),
    /** Public key of the identity that approved. */
    authorizedBy: text(),
    /**
     * The approving identity. `CASCADE`: an approval by a deleted account must
     * not stay claimable, and `SET NULL` would leave an `authorized` row whose
     * approver is unknown.
     */
    authorizedUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** `sessions.session_id` of the minted session. No constraint — see the ledger. */
    authorizedSessionId: text(),
    /** DELIVERY PROGRESS — when the request was pushed to capable installs. */
    pushSentAt: timestamptz(),
    /** DELIVERY PROGRESS — when an approval surface first opened it. Written once. */
    openedAt: timestamptz(),
    consumedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('auth_sessions_session_token_key').on(t.sessionToken),
    unique('auth_sessions_authorize_code_key').on(t.authorizeCode),
    index('auth_sessions_application_id_idx').on(t.applicationId),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('auth_sessions_expires_at_idx').on(t.expiresAt),
    // Mongo also declared `{sessionToken: 1, status: 1}`. Dropped as redundant:
    // `auth_sessions_session_token_key` is UNIQUE, so the lookup already lands
    // on one row and `status` is a free check on it.

    check(
      'auth_sessions_status_check',
      sql`${t.status} in (${sql.raw(AUTH_SESSION_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'auth_sessions_purpose_check',
      sql`${t.purpose} in (${sql.raw(AUTH_SESSION_PURPOSES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'auth_sessions_denied_reason_check',
      sql`${t.deniedReason} in (${sql.raw(COMMONS_DENY_REASONS.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'auth_sessions_oauth_code_challenge_method_check',
      sql`${t.oauthCodeChallengeMethod} in (${sql.raw(AUTH_SESSION_CHALLENGE_METHODS.map((value) => `'${value}'`).join(', '))})`
    ),
    // The binding is present as a WHOLE or absent as a whole — the schema-level
    // statement of what the Mongoose sub-schema achieved by staying `undefined`.
    check(
      'auth_sessions_oauth_binding_check',
      sql`(${t.oauthRedirectUri} is null and ${t.oauthCodeChallenge} is null and ${t.oauthCodeChallengeMethod} is null and ${t.oauthScopes} is null)
        or (${t.oauthRedirectUri} is not null and ${t.oauthCodeChallenge} is not null and ${t.oauthCodeChallengeMethod} is not null and ${t.oauthScopes} is not null)`
    ),
    // …and it belongs to exactly one purpose. A device-sign-in row carrying an
    // OAuth binding, or an `oauth_authorization` row carrying none, is a request
    // no path can finalize — `resolveOAuthContext` refuses both.
    check(
      'auth_sessions_oauth_purpose_check',
      sql`(${t.purpose} = 'oauth_authorization') = (${t.oauthRedirectUri} is not null)`
    ),
    // A delegated subject only means something inside a bound request.
    check(
      'auth_sessions_oauth_subject_requires_binding_check',
      sql`${t.oauthSubjectAccountId} is null or ${t.oauthRedirectUri} is not null`
    ),
    // The fail-closed length guard Mongoose declared as `maxlength: 64`.
    check(
      'auth_sessions_requester_label_length_check',
      sql`${t.requesterLabel} is null or char_length(${t.requesterLabel}) <= ${sql.raw(String(AUTH_SESSION_REQUESTER_LABEL_MAX_LENGTH))}`
    ),
  ]
);
