/**
 * `device_principals` — one PERSON who has authenticated onto one device.
 *
 * A principal is a human. Never an organization, project, channel or bot: those
 * are subjects a principal ACTS AS, and they live in `device_account_contexts`
 * (ADR 0001, `docs/auth/principals-and-account-contexts.md`).
 *
 * ## Why this table exists at all
 *
 * `device_session_accounts` collapsed four different facts into one row shape —
 * a person, that person's own account, an organization, and the person a
 * delegated account is operated through — and its `UNIQUE(device_session_id,
 * account_id)` therefore made an ordinary state unrepresentable: `Nate → The Oxy
 * Collective` and `Alice → The Oxy Collective` cannot both exist on one device,
 * even though they are different sessions with different permissions, different
 * audit actors and different revocation paths.
 *
 * ## `authuser` belongs HERE, and that is the point
 *
 * The Google-style signed-in-user slot names a HUMAN. On the flat table it was
 * allocated per ACCOUNT, so adding an organization consumed a slot and the
 * number stopped meaning what its name says. Adding an organization now consumes
 * nothing.
 *
 * The compatibility projection in `deviceSession.service.ts` therefore reports a
 * delegated account under its OPERATOR's `authuser`, which is a deliberate
 * consequence: on a device where one person operates an organization, the two
 * flat entries now share a slot number. Nothing keys on it. The switcher does
 * not read the flat shape at all any more — it renders the directory, where
 * `authuser` sits on the PRINCIPAL (`deviceDirectory.ts`), which is the level
 * the slot always meant. The only client that still sees a per-account
 * `authuser` is `@oxyhq/core`'s `projectSessionState`, which copies it through
 * as display metadata and never groups or dedupes on it. The alternative would
 * be to keep allocating a human slot to a thing.
 *
 * ## `personal_session_id` is a reference WITHOUT a constraint, deliberately
 *
 * Same reasoning as `device_session_accounts.session_id`, recorded in
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY`: it names a `sessions` row by its natural key
 * and the two lifecycles are independent on purpose, so the principal must
 * survive its session's expiry sweep in order to answer "dead session" rather
 * than silently vanishing from the device.
 *
 * It is the session minted when this PERSON authenticated here, which ADR 0002's
 * activation step 3 ("verify the principal's personal session is live") reads
 * without joining contexts. Today it is written from the same value as the
 * personal context's `session_id`, at the one site that creates both.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxyhq/db';
import { deviceSessions } from './deviceSessions';
import { users } from './users';

export const devicePrincipals = pgTable(
  'device_principals',
  {
    id: generatedId(),
    /** `CASCADE` — a principal of a device that no longer exists names nobody. */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    /**
     * The human. `CASCADE` — deleting the person removes them, and through
     * `device_account_contexts.principal_id`'s own cascade every context they
     * reached, from every device at once. That is ADR 0001's "removing a
     * principal removes exactly its own contexts, and no other principal's",
     * enforced for a delete that never reaches the service.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The signed-in-HUMAN slot. See the header for why it is not on a context. */
    authuser: integer().notNull(),
    /** `sessions.session_id` — see the header for why this carries no constraint. */
    personalSessionId: text(),
    addedAt: timestamptz().notNull().defaultNow(),
    lastAuthenticatedAt: timestamptz().notNull().defaultNow(),
    /**
     * Set when the person is removed from the device but the row is kept for
     * audit. A revoked principal is invisible to every read; the projection
     * filters on it rather than on row existence, so "was Alice ever here"
     * stays answerable.
     */
    revokedAt: timestamptz(),
  },
  (t) => [
    // One row per person per device. Two rows for one human would split their
    // contexts across two `authuser` slots and make "remove this principal"
    // ambiguous.
    unique('device_principals_device_session_id_user_id_key').on(t.deviceSessionId, t.userId),
    // The slot is the identity a URL carries (`?authuser=1`), so it must address
    // exactly one person on the device.
    unique('device_principals_device_session_id_authuser_key').on(t.deviceSessionId, t.authuser),
    // "Every device this person is a principal of" — the read a global
    // "sign out everywhere" and an account deletion both run.
    index('device_principals_user_id_idx').on(t.userId),
    // The constant is a LITERAL in the template, never an interpolation:
    // `${0}` would bind a parameter and drizzle-kit would emit the placeholder
    // `$1` into the migration, which fails at APPLY time.
    check('device_principals_authuser_check', sql`${t.authuser} >= 0`),
  ]
);
