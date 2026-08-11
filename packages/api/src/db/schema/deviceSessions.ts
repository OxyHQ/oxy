/**
 * `device_sessions` — the SERVER AUTHORITY for what is signed in on one device.
 *
 * Ported from `models/DeviceSession.ts`. Every zero-cookie mint
 * (`POST /session/device/token`) resolves against this row, so it is the closest
 * thing in the schema to a credential store and each nullable column below is
 * load-bearing.
 *
 * ## What is signed in here lives in TWO child tables
 *
 * `device_principals` (the PEOPLE who authenticated on this device) and
 * `device_account_contexts` (one principal acting as one account). Issue #937,
 * ADR 0001. They replace the flat `device_session_accounts`, which is left in
 * place, unread and unwritten, until Phase 8's clean cut.
 *
 * Child tables rather than `jsonb` for a reason stronger than style: every id
 * involved is a real user, and inside a `jsonb` value each would be an
 * orphanable string — un-joinable, un-constrained, invisible to `ON DELETE`. The
 * foreign keys are what make deleting an account actually remove it from every
 * device instead of leaving a dangling entry the mint path has to defend
 * against.
 *
 * ## The `default: undefined` workaround does NOT travel
 *
 * `secretHash` is `default: undefined` in Mongoose (never `null`) purely because
 * a Mongo SPARSE unique index collides on nulls. Postgres unique indexes treat
 * NULLs as DISTINCT, so a plain `UNIQUE` on a nullable column is already
 * correct — and substituting `''` would be worse than the original problem,
 * since an empty string is a VALUE and therefore collides for real. The same
 * applies to the four other `default: undefined` fields here, none of which is
 * unique at all. `__tests__/authSession.test.ts` pins this.
 */

import { type AnyPgColumn, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { deviceAccountContexts } from './deviceAccountContexts';
import { users } from './users';

export const deviceSessions = pgTable(
  'device_sessions',
  {
    id: generatedId(),
    /**
     * The device's own identifier — per web origin, per native app group. It is
     * this row's natural key, not a reference to anything (see the ledger).
     */
    deviceId: text().notNull(),
    /**
     * Whichever account of the device's set is currently active.
     *
     * Since issue #937 this is a PROJECTION of `active_context_id` below, not an
     * authority: `deviceSession.service.ts`'s `resolveActiveFields` derives it
     * from the elected context at the one site that writes either column, so the
     * two cannot disagree. It survives only while the flat
     * `DeviceSessionState.accounts[]` wire contract has consumers, and is
     * ambiguous by construction on a device where two people can reach the same
     * organization — which is exactly why `contextId` is what the activation
     * endpoint takes.
     *
     * `SET NULL`, and NULL is a first-class state here (the Mongoose default):
     * "signed in, nothing selected". `CASCADE` would delete the whole DEVICE
     * when one of possibly several accounts is deleted, taking every other
     * account's entry with it. `resolveActiveToken` refuses to mint for a null
     * or dead active account, and `healActiveAccount` re-elects one on the next
     * `getState`, so `SET NULL` fails closed.
     */
    activeAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    /**
     * The device's active CONTEXT — one principal acting as one account, and the
     * authority `active_account_id` above is now derived from (ADR 0002).
     *
     * An account id cannot name what to activate on a device holding two people:
     * `Nate → The Oxy Collective` and `Alice → The Oxy Collective` are different
     * sessions with different permissions and different audit actors, and
     * resolving that ambiguity server-side would mean guessing inside an
     * authorization path.
     *
     * `SET NULL` for the same reason `active_account_id` is: NULL is the
     * first-class "signed in, nothing selected" state, and `CASCADE` would
     * delete the whole DEVICE when one of several contexts goes.
     *
     * ## This closes a cycle, and the cycle is real
     *
     * `device_account_contexts.device_session_id` points back here. Both
     * constraints must exist — a column-level circular reference has been
     * silently dropped from a generated migration and its snapshot before now,
     * with nothing failing — so `__tests__/devicePrincipals.test.ts` reads both
     * out of `pg_constraint` rather than trusting the declaration. The reference
     * is a lazily-evaluated arrow returning `AnyPgColumn`, which is what keeps
     * the module cycle from resolving to `undefined` at definition time.
     */
    activeContextId: text().references((): AnyPgColumn => deviceAccountContexts.id, {
      onDelete: 'set null',
    }),
    /**
     * `sha256(deviceSecret)` — the zero-cookie transport's proof. The raw secret
     * is held only by the client, so this is a verifier, not a credential: a
     * dump of this column cannot forge a mint. Unique so one secret can never
     * address two devices; NULL for a device that has not been bound to a
     * secret yet.
     */
    secretHash: text(),
    /** The just-rotated secret's hash, honoured until `prev_secret_expires_at`. */
    prevSecretHash: text(),
    prevSecretExpiresAt: timestamptz(),
    /**
     * `sha256` of the non-rotating background credential, presented by native
     * background code at `POST /session/device/background-token`. Deliberately
     * separate from `secret_hash` so a widget worker never contends with the
     * rotating secret the JS runtime depends on.
     */
    backgroundSecretHash: text(),
    /**
     * The single account the background credential may mint for.
     *
     * `SET NULL` is the fail-CLOSED choice here, which is the opposite of the
     * `push_tokens.application_id` trap: `mintFromBackgroundSecret`
     * (`deviceSession.service.ts:470`) rejects the presentation outright when
     * `boundAccountId` is falsy, so nulling this column disarms the credential
     * rather than widening it. `signout` already clears the whole triple when
     * the bound account leaves the device; the constraint is the backstop for a
     * delete that bypasses the service.
     */
    backgroundSecretAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    backgroundSecretExpiresAt: timestamptz(),
    /**
     * `sha256` of the BROWSER HUB handle — the opaque value inside
     * `__Host-oxy-device` at `auth.oxy.so` (issue #937 Phase 5, ADR 0003).
     *
     * A third credential rather than a reuse of `secret_hash`, for the same
     * reason the background one is a fourth: the two have different holders,
     * different lifetimes and different rotation rules, and a shared column
     * would make each a writer of a value the other depends on. This one is
     * held by nothing the user can read — the browser stores it `HttpOnly`, so
     * no script on the IdP origin can reach it, and the raw value exists in
     * exactly two places: that cookie jar and the `Set-Cookie` line that put it
     * there.
     *
     * ## Why this one is looked up BY hash and the others are not
     *
     * Every other credential here is verified after the row has already been
     * found by `device_id`, because its holder knows the device id. The hub's
     * holder does not: the cookie carries the handle and NOTHING else — no
     * device id, no user id, no account id, no serialized state — so the hash is
     * the only address there is. Hence the UNIQUE below, which is both the
     * lookup index and the guarantee that one handle can never address two
     * browsers.
     */
    hubSecretHash: text(),
    /**
     * The just-rotated hub handle's hash, honoured until
     * `hub_prev_secret_expires_at`.
     *
     * The grace exists because a cookie jar is shared across a browser's tabs:
     * a rotation committed by one tab lands in the jar of every other, and a
     * request already in flight from a sibling tab still carries the old value.
     * Without the window that races into a spurious sign-out on an ordinary
     * rotation. Indexed, unlike `prev_secret_hash`, for the reason above: a
     * grace-window presentation has no other way in.
     */
    hubPrevSecretHash: text(),
    hubPrevSecretExpiresAt: timestamptz(),
    /**
     * When the current hub handle stops resolving, server-side.
     *
     * The cookie's `Max-Age` is derived from the SAME constant
     * (`BROWSER_HUB_HANDLE_TTL_MS` in `@oxyhq/contracts`), so the credential and
     * the thing addressing it expire together. NULL means no hub handle has been
     * issued for this device, which is every native device and every browser
     * that has not authenticated at the IdP.
     */
    hubSecretExpiresAt: timestamptz(),
    /** Bumped on every mutation; the client's cross-app resync signal. */
    revision: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('device_sessions_device_id_key').on(t.deviceId),
    // Mongo: `{secretHash: 1}, { unique: true, sparse: true }`. Sparse exists
    // only to stop nulls colliding, which Postgres does not do — so this is a
    // plain UNIQUE on a nullable column and means exactly the same thing.
    unique('device_sessions_secret_hash_key').on(t.secretHash),
    // `prev_secret_hash` and `background_secret_hash` are deliberately NOT
    // indexed: both are read only after the row has already been found by
    // `device_id`, and both churn on every rotation.
    //
    // The two hub columns ARE indexed, and the asymmetry is the point: the hub
    // handle is the only credential here whose holder cannot name the device it
    // belongs to, so the hash is the sole lookup key. UNIQUE on the live one
    // additionally makes "one handle addresses one browser" a constraint rather
    // than a property of the random generator.
    unique('device_sessions_hub_secret_hash_key').on(t.hubSecretHash),
    index('device_sessions_hub_prev_secret_hash_idx').on(t.hubPrevSecretHash),
  ]
);
