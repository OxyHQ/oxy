/**
 * `user_totp` and `user_totp_backup_codes` — an account's authenticator app
 * (RFC 6238), the second factor of every sign-in once it is on
 * (`services/totp.service.ts`).
 *
 * - The shared secret is stored ENCRYPTED (AES-256-GCM, `utils/secretBox.ts`),
 *   never in the clear: the server has to read it back to check a code, so a
 *   hash cannot stand in, and a database dump alone must not yield it.
 * - `enabled_at` null is an enrolment in progress: the secret was shown, and no
 *   sign-in asks for it until a first code confirms it.
 * - `last_used_step` is the 30-second step of the last accepted code, so one
 *   code is never accepted twice (replay).
 *
 * Backup codes are one-use, stored only as an HMAC under the server salt, and
 * replaced as a set. Both tables are protected columns (`protectedColumns.ts`).
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const userTotp = pgTable(
  'user_totp',
  {
    /** `CASCADE`: a deleted account's authenticator goes with it. */
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `v1.<iv>.<ciphertext>.<tag>` (base64url), see `utils/secretBox.ts`. */
    secretCiphertext: text().notNull(),
    enabledAt: timestamptz(),
    lastUsedStep: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('user_totp_secret_check', sql`${t.secretCiphertext} like 'v1.%'`)],
);

export const userTotpBackupCodes = pgTable(
  'user_totp_backup_codes',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256 (server salt) of the account id and the normalised code. */
    codeHash: text().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('user_totp_backup_codes_user_id_code_hash_key').on(t.userId, t.codeHash),
    index('user_totp_backup_codes_user_id_idx').on(t.userId),
    check('user_totp_backup_codes_hash_check', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
