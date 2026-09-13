/**
 * `families` / `family_members` — Oxy Family, an account-grouping primitive
 * (organizer + member personal accounts) that platform apps can build on —
 * e.g. Willo's "Home" wants its members to be distinct from a user's "Family".
 *
 * ## Why this is NOT `users.kind` + `account_members`
 *
 * The existing unified Account system (`db/schema/accountMembers.ts`,
 * `utils/accountRoles.ts`) collapsed three legacy membership tables into one by
 * giving every non-`personal` `users` row the SAME membership shape, because
 * every one of those kinds (`organization`, `project`, `bot`, `channel`) is an
 * OPERABLE account: it can be switched into, own applications, hold billing,
 * mint credentials, parent child accounts. A family is none of those things —
 * it is a closed set of personal accounts, and every route that resolves
 * `account:act_as` / `apps:*` / `billing:*` / `children:*` for `:id` does so
 * purely from the caller's RESOLVED ROLE, never from `users.kind`. Every
 * `AccountRole` in `ROLE_PERMISSIONS` — even `viewer` — carries at least
 * `apps:read` / `children:read` / `billing:read`, and `owner` carries every
 * `ACCOUNT_PERMISSION` there is, `apps:create` and `billing:manage` included.
 * Minting a family as a `users` row with an `account_members` row would
 * therefore hand its organizer, for free, the ability to create child accounts,
 * applications and billing profiles under the family through routes this
 * feature never touches — exactly the "shared subscriptions/billing" and
 * unrelated-account-surface exposure this pass is scoped to NOT build, and
 * closing it back down would mean auditing and hardening every generic account
 * route (`/accounts/:id`, `/accounts/:id/children`, `/applications`,
 * `/accounts/:id/billing*`, …) to refuse `kind === 'family'` — a wide-blast-radius
 * change against a mature surface for a feature that only needs membership.
 *
 * Piggybacking a family onto the organizer's own PERSONAL account (no new
 * account row at all) is refused for the opposite, structural reason:
 * `isOperatorSwitchTargetKind` and `POST /accounts/:id/switch` treat "become a
 * member of a personal account" as impersonation — "a personal account is a
 * human login and must never be assumed" (`routes/accounts.ts`) — so `personal`
 * is not a legal membership TARGET at all, by design, regardless of what the
 * membership would grant.
 *
 * So Family reuses the PATTERN `account_members` established — a status
 * lifecycle of `invited` / `active` / `removed`, `invitedByUserId` attribution,
 * one row per (parent, member) — without wiring into the account/app/billing
 * RBAC surface those tables share. Two small, dedicated tables, never joined
 * into `resolveEffectivePermissions` or any `requireAccountPermission` gate.
 *
 * ## Deliberately out of scope for this pass
 *
 * Parental controls, shared subscriptions/billing, and content restrictions are
 * not built here. The extension point is `family_members.role`: a future pass
 * that needs a THIRD role (e.g. a supervised child member) adds a value to
 * {@link FAMILY_MEMBER_ROLES} and a migration widening the CHECK, the same way
 * every closed-vocabulary column in this schema grows.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

/**
 * `organizer` created the family (or received ownership — there is no
 * transfer endpoint in this pass, so today that is only ever the creator).
 * `member` is everyone else. Neither carries any `ACCOUNT_PERMISSIONS` —
 * see the header above for why that vocabulary does not apply here at all.
 *
 * A `const` tuple, same shape as `ACCOUNT_MEMBER_STATUSES`: it renders the
 * CHECK below, and `check-drizzle-snapshot-sync` holds that rendering against
 * the migration the database was actually built from.
 */
export const FAMILY_MEMBER_ROLES = ['organizer', 'member'] as const;

export type FamilyMemberRole = (typeof FAMILY_MEMBER_ROLES)[number];

/**
 * Same vocabulary and same order as `ACCOUNT_MEMBER_STATUSES` — an invite the
 * invitee must accept, never a silent add. `removed` is retained rather than
 * deleted so a re-invitation reactivates the same row, for the identical
 * reason `account_members` keeps it.
 */
export const FAMILY_MEMBER_STATUSES = ['invited', 'active', 'removed'] as const;

export type FamilyMemberStatus = (typeof FAMILY_MEMBER_STATUSES)[number];

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * `families` — the group itself. Deliberately minimal: no owner/organizer
 * column, because "who organizes this family" is a `family_members.role`
 * question, not a fact this row duplicates (the same reason `account_members`
 * does not carry an `is_owner` flag).
 */
export const families = pgTable('families', {
  id: generatedId(),
  /** Optional display name ("The Smiths"). Absent is a nameless family. */
  name: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const familyMembers = pgTable(
  'family_members',
  {
    id: generatedId(),
    /** The family this membership is on. */
    familyId: text()
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /**
     * The member — always a `personal` User. Enforced at the service layer
     * (a family invite resolves and validates the target's `kind`), not by a
     * CHECK here: a CHECK cannot see a value on `users`, only on this row.
     */
    memberUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: FAMILY_MEMBER_ROLES }).notNull(),
    status: text({ enum: FAMILY_MEMBER_STATUSES }).notNull(),
    /** Who sent the invitation. `SET NULL` — same reasoning as `account_members`. */
    invitedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Set when the invite is accepted. NULL while `invited`. */
    joinedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one membership row per (family, member) — mirrors
    // `account_members_account_id_member_user_id_key` exactly, and for the
    // same reason: it is what lets a re-invitation reactivate the row instead
    // of racing a second insert.
    unique('family_members_family_id_member_user_id_key').on(t.familyId, t.memberUserId),

    // ---- one family at a time ----------------------------------------------
    // A person may hold at most one ACTIVE family membership. Enforced here as
    // the backstop and in `family.service.ts` as the friendly, pre-checked
    // error — see that file's header for why both layers exist. Pending
    // (`invited`) rows are NOT covered: a person may hold invites from several
    // families at once and simply cannot ACCEPT a second while active
    // elsewhere, matching Google Family Group's own behaviour.
    uniqueIndex('family_members_member_user_id_active_key')
      .on(t.memberUserId)
      .where(sql`${t.status} = 'active'`),

    // At most one ACTIVE organizer per family — never zero enforced (a family
    // that loses its only organizer by that organizer leaving alone is simply
    // an empty family; see `FamilyService.leaveFamily`), but never two, which
    // is the ambiguity a constraint can actually rule out.
    uniqueIndex('family_members_family_id_organizer_key')
      .on(t.familyId)
      .where(sql`${t.role} = 'organizer' and ${t.status} = 'active'`),

    // "Who is in this family" — the roster query.
    index('family_members_family_id_status_idx').on(t.familyId, t.status),
    // "What family is this person in" — mirrors
    // `account_members_member_user_id_status_idx`.
    index('family_members_member_user_id_status_idx').on(t.memberUserId, t.status),

    check(
      'family_members_role_check',
      sql`${t.role} in (${sql.raw(inList(FAMILY_MEMBER_ROLES))})`
    ),
    check(
      'family_members_status_check',
      sql`${t.status} in (${sql.raw(inList(FAMILY_MEMBER_STATUSES))})`
    ),
  ]
);
