/**
 * Application roles — permissions an APPLICATION declares about its own users,
 * and the grants that give them to Oxy users (`docs/auth/application-roles.md`).
 *
 * Two tables, because they are two different facts with two different lives:
 *
 * - `application_role_permissions` — the vocabulary. One row per key per
 *   declaration. A key is RETIRED, never deleted or renamed: retiring stamps
 *   `retired_at`, and declaring the same key again later inserts a NEW row with
 *   a new id. Grants hang off the row id, so a retired-then-redeclared key
 *   starts with nobody holding it — a revocation-by-retirement can never be
 *   undone by accident.
 * - `application_role_grants` — who holds which key. Append-only except for one
 *   transition: a live grant may be revoked, once, by stamping `revoked_at`
 *   (and who, and why). Re-granting inserts a new row. No `updated_at`, because
 *   nothing else about a grant ever changes.
 *
 * Both are guarded by triggers whose DDL lives in `applicationRolesImmutability.ts`
 * (a CHECK sees only the new row, and drizzle-kit cannot emit a trigger).
 *
 * ## Nothing here is an Oxy permission
 *
 * A key is meaningful only to the application that declared it; no Oxy gate
 * reads this table. The key CHECK is rendered from the SAME pattern source the
 * contract validates with, and that pattern cannot contain a colon — every Oxy
 * permission and scope has one — so the two vocabularies are disjoint by syntax.
 *
 * ## `ON DELETE`
 *
 * - `application_id` CASCADE: the vocabulary is the application's and means
 *   nothing without it (applications are soft-deleted, so this fires only when
 *   the owning account is erased, which already cascades the application).
 * - `permission_id` CASCADE, for the same reason one level down.
 * - grantee `user_id` CASCADE: a grant is a fact about a person, and their
 *   erasure removes it — leaving it would keep an erased person's power in the
 *   table under a dangling id.
 * - every `*_by_user_id` SET NULL: attribution, which an erasure must not turn
 *   into the loss of the record it attributes. The triggers admit exactly that
 *   nested foreign-key transition and nothing else.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  APPLICATION_PERMISSION_DESCRIPTION_MAX_LENGTH,
  APPLICATION_PERMISSION_KEY_MAX_LENGTH,
  APPLICATION_PERMISSION_KEY_PATTERN_SOURCE,
  APPLICATION_ROLE_REASON_MAX_LENGTH,
} from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** A SQL string literal of a constant; the pattern holds no quote. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const applicationRolePermissions = pgTable(
  'application_role_permissions',
  {
    id: generatedId(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** `payments.operate` — see the header and `@oxy.so/contracts`' pattern. */
    key: text().notNull(),
    /** What holding the key lets a person do, in the owner's words. */
    description: text().notNull(),
    /** The human who declared it (the operator, never an org acted as). */
    declaredByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Set once; a retired key confers nothing and is never un-retired. */
    retiredAt: timestamptz(),
    retiredByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** When it was declared. */
    createdAt: createdAt(),
    /** Moves only when the description changes or the key is retired. */
    updatedAt: updatedAt(),
  },
  (t) => [
    // One LIVE row per key per application; retired rows are history and may
    // repeat a key.
    uniqueIndex('application_role_permissions_live_key_idx')
      .on(t.applicationId, t.key)
      .where(sql`${t.retiredAt} is null`),
    // The vocabulary listing, history included, and the CASCADE scan.
    index('application_role_permissions_application_id_created_at_idx').on(
      t.applicationId,
      t.createdAt,
    ),
    check(
      'application_role_permissions_key_check',
      sql`${t.key} ~ ${sql.raw(literal(APPLICATION_PERMISSION_KEY_PATTERN_SOURCE))} and char_length(${t.key}) <= ${sql.raw(String(APPLICATION_PERMISSION_KEY_MAX_LENGTH))}`,
    ),
    check(
      'application_role_permissions_description_check',
      sql`char_length(${t.description}) between 1 and ${sql.raw(String(APPLICATION_PERMISSION_DESCRIPTION_MAX_LENGTH))}`,
    ),
    check(
      'application_role_permissions_retired_by_check',
      sql`${t.retiredByUserId} is null or ${t.retiredAt} is not null`,
    ),
  ],
);

export const applicationRoleGrants = pgTable(
  'application_role_grants',
  {
    id: generatedId(),
    /** The declared key (the ROW, not the string — see the header). */
    permissionId: text()
      .notNull()
      .references(() => applicationRolePermissions.id, { onDelete: 'cascade' }),
    /** The grantee: a person (`kind = 'personal'`, enforced by the service). */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The human who granted it. */
    grantedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    grantReason: text(),
    /** When it was granted. */
    createdAt: createdAt(),
    revokedAt: timestamptz(),
    revokedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    revokeReason: text(),
  },
  (t) => [
    // At most one LIVE grant of a key to a person, and the read path:
    // `roles/me` asks "which live grants does THIS user hold", so the index
    // leads with the grantee.
    uniqueIndex('application_role_grants_live_idx')
      .on(t.userId, t.permissionId)
      .where(sql`${t.revokedAt} is null`),
    // The management listing (newest first per key) and the CASCADE scan.
    index('application_role_grants_permission_id_created_at_idx').on(
      t.permissionId,
      t.createdAt.desc(),
    ),
    check(
      'application_role_grants_revocation_check',
      sql`${t.revokedAt} is not null or (${t.revokedByUserId} is null and ${t.revokeReason} is null)`,
    ),
    check(
      'application_role_grants_reason_length_check',
      sql`(${t.grantReason} is null or char_length(${t.grantReason}) between 1 and ${sql.raw(String(APPLICATION_ROLE_REASON_MAX_LENGTH))}) and (${t.revokeReason} is null or char_length(${t.revokeReason}) between 1 and ${sql.raw(String(APPLICATION_ROLE_REASON_MAX_LENGTH))})`,
    ),
  ],
);
