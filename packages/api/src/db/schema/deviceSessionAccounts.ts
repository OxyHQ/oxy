/**
 * `device_session_accounts` — one account signed in on one device. SUPERSEDED.
 *
 * Ported from the `accounts[]` subdocument array in `models/DeviceSession.ts`,
 * and replaced by `device_principals` + `device_account_contexts` in issue #937
 * (ADR 0001). Nothing reads or writes this table any more: migration 0028
 * translated every row, and `deviceSession.service.ts` moved to the new pair.
 *
 * It is left in place rather than dropped in the same change, because a `pre`
 * migration lands while the PREVIOUS image is still serving and still writing
 * here. The drop is Phase 8's clean cut, once no supported client speaks the
 * flat `DeviceSessionState.accounts[]` contract.
 *
 * ## Why the shape had to go
 *
 * `UNIQUE(device_session_id, account_id)` made an ordinary state
 * unrepresentable: `Nate -> The Oxy Collective` and `Alice -> The Oxy
 * Collective` could not both exist on one device, though they are different
 * sessions with different permissions, audit actors and revocation paths. And
 * `authuser` was allocated per ACCOUNT, so adding an organization consumed a
 * human's signed-in slot.
 *
 * Everything below describes the table as it was written, and is kept because
 * the rows it describes are still here.
 *
 * A child table rather than `jsonb` for a reason stronger than style: each entry
 * carries TWO user references (`account_id` and, for a delegated switch,
 * `operated_by_user_id`). Inside a `jsonb` value both would be opaque strings —
 * no join, no constraint, and no `ON DELETE`, so deleting an account would leave
 * live entries pointing at it on every device it had ever been added to. Those
 * are exactly the entries `resolveActiveToken` mints access tokens from.
 *
 * ## `session_id` is a reference WITHOUT a constraint, deliberately
 *
 * It names a row of `sessions` by its natural key (`sessions.session_id`), and
 * the two lifecycles are INDEPENDENT ON PURPOSE: sessions are never deleted by
 * the application, only by the expiry sweep, and when one goes the entry must
 * SURVIVE so `resolveActiveToken` can answer "dead session" rather than the set
 * silently shrinking behind the client's back — a shrink that would also bypass
 * the `revision` bump every real membership change makes. A real FK could only
 * `CASCADE` (silent shrink) or `RESTRICT` (a sweep that cannot run). Recorded in
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with that reasoning.
 *
 * ## One birth column, not two
 *
 * The subdocument's `addedAt` IS this row's creation instant — `addAccount`
 * replaces an entry wholesale rather than mutating one — so there is no
 * `created_at` beside it. Sibling child tables (`user_auth_methods.linked_at`,
 * `user_verified_domains.verified_at`) carry both because their domain
 * timestamp and their row birth can genuinely differ; here they cannot.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxyhq/db';
import { deviceSessions } from './deviceSessions';
import { users } from './users';

export const deviceSessionAccounts = pgTable(
  'device_session_accounts',
  {
    id: generatedId(),
    /** `CASCADE` — an entry of a device that no longer exists addresses nothing. */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    /**
     * `CASCADE` — a deleted account must stop being mintable on every device at
     * once. `deviceSessionService.purgeAccountFromAllDevices` does this through
     * the ordinary signout cascade today; the constraint is what makes it true
     * even for a delete that never reaches the service.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `sessions.session_id` — see the header for why this carries no constraint. */
    sessionId: text().notNull(),
    /** Google-style `authuser` index, stable per account within the device. */
    authuser: integer().notNull(),
    addedAt: timestamptz().notNull().defaultNow(),
    /**
     * The OPERATOR for a delegated (`account:act_as`) entry; NULL for an
     * ordinary personal account.
     *
     * `CASCADE` — deleting the operator deletes the ENTRY, which is what
     * `signout` already does ("signing out an operator's own account must also
     * remove every managed account that operator switched into on this device").
     * `SET NULL` would leave the managed account sitting on the device as an
     * ordinary entry, mintable with no `account:act_as` re-check at all — a
     * privilege escalation dressed up as a null.
     */
    operatedByUserId: text().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    // One entry per account per device. Mongo enforced this only in application
    // code (`addAccount` replaces the existing entry), so a second write path
    // could produce a device listing the same account twice — with two
    // different `session_id`s, which `resolveActiveToken` would resolve
    // arbitrarily between.
    unique('device_session_accounts_device_session_id_account_id_key').on(
      t.deviceSessionId,
      t.accountId
    ),
    // "Every device this account is signed in on" — the read
    // `purgeAccountFromAllDevices` runs, which under Mongo scanned
    // `accounts.accountId` across the collection.
    index('device_session_accounts_account_id_idx').on(t.accountId),
    // "Every entry this operator is responsible for", the delegated-signout
    // cascade. Partial: an ordinary entry has no operator, and no read ever
    // asks for the NULL side.
    index('device_session_accounts_operated_by_user_id_idx')
      .on(t.operatedByUserId)
      .where(sql`${t.operatedByUserId} is not null`),
    // Mongoose's `min: 0`. A negative `authuser` would address a URL slot no
    // client can produce.
    check('device_session_accounts_authuser_check', sql`${t.authuser} >= 0`),
  ]
);
