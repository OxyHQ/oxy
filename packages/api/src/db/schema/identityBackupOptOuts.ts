/**
 * `identity_backup_opt_outs` — a person who DELETED their encrypted identity
 * backup (`DELETE /identity/backup`) and has not chosen to create one since.
 *
 * Owner's decision, 2026-11-07: a key rotation (or any re-seal) must never
 * silently re-upload a backup the person deleted. The deletion is recorded on
 * the ACCOUNT, not on a device, so every device the person signs in on reads
 * it (`GET /identity/backup/status` answers `optedOut: true`) and respects it.
 * `POST /identity/backup` refuses an upload without the person's explicit
 * `optIn` (409 `IDENTITY_BACKUP_OPTED_OUT`); an accepted upload with it
 * deletes this row in the same transaction. Written and deleted only by
 * `routes/identityBackup.ts`.
 *
 * Its own table, not a column on `identity_backups`: deleting the backup
 * deletes that row, and this record must outlive it. Not on `users` either
 * (a hot table): an additive table needs no lock on it.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { users } from './users';

export const identityBackupOptOuts = pgTable(
  'identity_backup_opt_outs',
  {
    id: generatedId(),
    /** One per account. `CASCADE` — deleting the account deletes the choice with it. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** When the person deleted their backup. A later deletion keeps the first time. */
    optedOutAt: createdAt(),
  },
  (t) => [unique('identity_backup_opt_outs_user_id_key').on(t.userId)],
);
