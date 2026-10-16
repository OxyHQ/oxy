/**
 * `file_access_grants` — a person's consent, per (file, application), for an
 * application to READ that person's file with its service token (ADR 0042
 * stage 4c).
 *
 * Reading a person's private file from a service (`POST
 * /assets/service/linked-url`, a play session) needs the person's consent. It
 * has exactly two origins, and this table records the first and can override
 * both:
 *
 * - **The application stored the file for the person** — an upload, import,
 *   large upload or recording into the person's files with the act-as
 *   authority of `/assets/service/user-media` (`files:user-media:write`). That
 *   application may read back what it stored for them, by construction: a
 *   `granted` row with `source = 'upload'` is written when the file is stored.
 * - **The person attached the file to the application** — ADR 0021's
 *   owner-made reference (`file_references.created_by_user_id =
 *   files.owner_user_id`). No row is needed for it.
 *
 * The person can REVOKE an application's access (`DELETE
 * /assets/:id/access/:applicationId`): the row becomes `revoked`, which beats
 * both origins — a later re-upload of the same bytes by that application does
 * not bring it back. The person attaching the file to that application again
 * (`POST /assets/:id/links`) is a new, explicit consent and sets the row back
 * to `granted` (`source = 'owner'`).
 *
 * So for an account's file and an application:
 *
 *   row `granted`              → may read
 *   row `revoked`              → may not, whatever else holds
 *   no row                     → may read iff the owner referenced it to that application
 *
 * An application's OWN file needs no consent, and a platform namespace's file
 * is never readable this way. Rows go with the file (`CASCADE`); a tombstoned
 * file is not served anyway.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { files } from './files';
import { users } from './users';

/** `granted`: the application may read the file; `revoked`: the owner withdrew it. */
export const FILE_ACCESS_GRANT_STATES = ['granted', 'revoked'] as const;

export type FileAccessGrantState = (typeof FILE_ACCESS_GRANT_STATES)[number];

/**
 * Who set the row's current state: `upload` — the application stored the file
 * for the person; `owner` — the person (a revocation, or attaching the file to
 * the application again after one).
 */
export const FILE_ACCESS_GRANT_SOURCES = ['upload', 'owner'] as const;

export type FileAccessGrantSource = (typeof FILE_ACCESS_GRANT_SOURCES)[number];

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const fileAccessGrants = pgTable(
  'file_access_grants',
  {
    id: generatedId(),
    /** The person's file. `CASCADE`: consent about a file goes with it. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /**
     * The application consented to (or refused). `CASCADE`: an application row
     * only goes with its owning account's hard delete.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    state: text({ enum: FILE_ACCESS_GRANT_STATES }).notNull(),
    source: text({ enum: FILE_ACCESS_GRANT_SOURCES }).notNull(),
    /**
     * The person who last set the state (`source = 'owner'`); NULL for an
     * upload's grant. `SET NULL`: attribution only.
     */
    changedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** When the state last changed to `revoked`. */
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('file_access_grants_file_id_application_id_key').on(t.fileId, t.applicationId),
    // "Every file this application was granted" (an application's deletion, support).
    index('file_access_grants_application_id_idx').on(t.applicationId),
    index('file_access_grants_changed_by_user_id_idx').on(t.changedByUserId),
    check(
      'file_access_grants_state_check',
      sql`${t.state} in (${sql.raw(inList(FILE_ACCESS_GRANT_STATES))})`,
    ),
    check(
      'file_access_grants_source_check',
      sql`${t.source} in (${sql.raw(inList(FILE_ACCESS_GRANT_SOURCES))})`,
    ),
    check(
      'file_access_grants_revoked_check',
      sql`(${t.state} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
);

export type FileAccessGrantRecord = typeof fileAccessGrants.$inferSelect;
