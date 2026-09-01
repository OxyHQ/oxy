/**
 * `account_members` — one membership of a member on an account.
 *
 * Ported from `models/AccountMember.ts`. This single table replaced the legacy
 * `WorkspaceMember` + `ApplicationMember` + `ManagedAccount.managers[]` tables,
 * and it is what every RBAC decision in `routes/accounts.ts` and
 * `routes/applications.ts` resolves through: the NEAREST row over
 * `[accountId, ...account.ancestors]` wins, unless `inherit` is false.
 *
 * ## `permissions` is DERIVED; the two delta columns are the stored part
 *
 * Mongo stored a `permissions[]` array beside `role` that every write site set to
 * exactly `permissionsForAccountRole(role)` — a derivation of `role`, not data,
 * so it did not travel. `serializeMember` (`routes/accounts.ts`) keeps emitting
 * `permissions` on the wire, computed rather than read.
 *
 * What IS data is the per-member ADJUSTMENT: `permission_grants` and
 * `permission_revokes`. The role still picks the baseline; these two say what
 * this one member holds beyond it or is denied out of it, which is the thing a
 * role name cannot express. `resolveEffectivePermissions` (`utils/accountRoles.ts`)
 * combines all three and is the only place that does.
 *
 * ## Neither delta column carries a vocabulary CHECK, deliberately
 *
 * The obvious shape — `check (permission_grants <@ array[…ACCOUNT_PERMISSIONS…])`,
 * exactly like `users_account_categories_check` — is a trap here, because this
 * vocabulary is expected to lose entries: six of its strings are already read by
 * no code at all. Measured on Postgres 17.5: narrowing such an array makes every
 * later `UPDATE` of a row holding a now-absent value fail, INCLUDING an update
 * that names only `role`, and the error names a column the caller never
 * mentioned. `NOT VALID` does not rescue it — that only skips the existing-row
 * scan at `ALTER` time; the next update of such a row still fails.
 *
 * The vocabulary is enforced where it can be enforced without that hazard: the
 * zod schema 400s an unknown permission on the way in, and
 * `resolveEffectivePermissions` builds its result by filtering the vocabulary, so
 * a retired string is structurally incapable of granting anything on the way out.
 * The stored string is left in place rather than scrubbed — same reasoning as
 * `users.organization_category` in migration 0013 — so re-instating a permission
 * restores it rather than losing it.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { ACCOUNT_ROLES } from '../../utils/accountRoles';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * Membership lifecycle. `removed` is retained rather than deleted so a
 * re-invitation reactivates the same row (`addMember`).
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 *
 * `ACCOUNT_ROLES` lives in `utils/accountRoles.ts` and is imported directly.
 */
export const ACCOUNT_MEMBER_STATUSES = ['active', 'invited', 'removed'] as const;

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const accountMembers = pgTable(
  'account_members',
  {
    id: generatedId(),
    /** The account the membership is ON (a User of any `kind`). */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The member (a `personal` User). */
    memberUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: ACCOUNT_ROLES }).notNull(),
    /**
     * Permissions this member holds IN ADDITION to their role's baseline.
     *
     * `text[]` rather than a join table: the value is a small unordered set read
     * on every authorization decision alongside the row it belongs to, so a
     * second table would add a join to the hottest path in the account graph to
     * buy referential integrity against a vocabulary that lives in TypeScript
     * and not in the database.
     */
    permissionGrants: text().array().notNull().default([]),
    /**
     * Permissions this member is denied even though their role's baseline
     * carries them. Beats a grant naming the same permission.
     */
    permissionRevokes: text().array().notNull().default([]),
    /**
     * Whether the membership cascades to descendant accounts. `false` scopes it
     * to `account_id` alone — the member is NOT a member of its children.
     */
    inherit: boolean().notNull().default(true),
    status: text({ enum: ACCOUNT_MEMBER_STATUSES }).notNull().default('active'),
    /**
     * Who issued the invitation. Attribution — `SET NULL` so an inviter's
     * account erasure never removes a membership that is still valid.
     */
    invitedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one membership row per (account, member) — `addMember` reads this
    // to decide between reactivating and inserting.
    unique('account_members_account_id_member_user_id_key').on(t.accountId, t.memberUserId),
    // "What can this user reach" — drives `listAccessibleAccounts`.
    index('account_members_member_user_id_status_idx').on(t.memberUserId, t.status),
    // Mongo's standalone `{accountId}` and `{memberUserId}` are both dropped: a
    // btree serves any leading prefix, and the two indexes above already lead
    // with those columns.
    check('account_members_role_check', sql`${t.role} in (${sql.raw(inList(ACCOUNT_ROLES))})`),
    check(
      'account_members_status_check',
      sql`${t.status} in (${sql.raw(inList(ACCOUNT_MEMBER_STATUSES))})`
    ),
  ]
);
