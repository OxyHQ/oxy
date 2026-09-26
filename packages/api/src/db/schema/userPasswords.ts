/**
 * `user_passwords` — an account's optional password (`services/password.service.ts`).
 *
 * One row per account that set one. Only the scrypt hash is stored, in a
 * self-describing versioned string (`$scrypt$v=1$ln=…,r=…,p=…$salt$hash`) so
 * the parameters can grow without a migration. It is a protected column
 * (`protectedColumns.ts`): never read by a whole-row select, never serialized.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const userPasswords = pgTable(
  'user_passwords',
  {
    /** `CASCADE`: a deleted account's password goes with it. */
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text().notNull(),
    /** When the password last changed. */
    changedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('user_passwords_hash_check', sql`${t.passwordHash} like '$scrypt$%'`)],
);
