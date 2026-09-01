/**
 * Resolve a human-friendly user identifier (username OR email) to an account.
 *
 * Member-invite endpoints accept an identifier real people actually know — a
 * username or an email address — instead of an opaque account id. This helper
 * centralises the "username or email → account" resolution so every invite path
 * behaves identically.
 *
 * ## The lookups are written as the unique indexes are built
 *
 * `users` is unique on `lower(btrim(username))`, `lower(btrim(email))` and
 * `lower(btrim(public_key))` (`db/schema/users.ts`). Both lookups below are
 * spelled `lower(btrim(column)) = lower(btrim($1))` because that is the
 * EXPRESSION those indexes are built on — a plain `email = $1` is
 * correct-looking, case-sensitive, and will not use the index.
 *
 * ## The ambiguity branch is gone, because the ambiguity is unrepresentable
 *
 * Mongo indexed `username` case-SENSITIVELY, so `Nate` and `nate` could coexist
 * while every lookup matched case-INSENSITIVELY. This function therefore had to
 * fetch two rows and refuse to resolve when both matched, so a membership grant
 * could not land on an arbitrary one of two look-alike accounts.
 *
 * `users_lower_username_key` makes that pair impossible to store: the second
 * insert fails on the unique index. (If two such accounts exist in production
 * today the BACKFILL fails and names them, which is the correct outcome — the
 * application cannot tell them apart either.) The guard is deleted rather than
 * carried, and `__tests__` pins the constraint that replaced it: the collision
 * is refused at write time, not tolerated at read time.
 *
 * ## What this returns, and the bug that changes
 *
 * It used to return the Mongoose document, and `routes/accounts.ts:719` reads
 * `.id` off it — the model's `id` VIRTUAL, which is `publicKey ?? _id`. So for
 * any account that had linked a Commons identity key, the invite path passed a
 * PUBLIC KEY where an account id belongs. That is a `text` column with a real
 * foreign key now, so the bad value would be rejected by
 * `account_members_user_id_users_id_fk` instead of being stored. Returning the
 * account id closes it at the source; the shape below is deliberately narrow so
 * nothing can read the virtual again.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';

/** The account an identifier resolved to. */
export interface ResolvedUserIdentity {
  /** The canonical account id — never the public key. */
  id: string;
  username?: string;
  email?: string;
}

/**
 * Resolve a username or email to its account.
 *
 * @param identifier A raw username or email address.
 * @returns The matching account, or `null` if not found / blank input.
 */
export async function resolveUserByIdentifier(
  identifier: string
): Promise<ResolvedUserIdentity | null> {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // An `@` means an email address; a username cannot contain one.
  const match = trimmed.includes('@')
    ? sql`lower(btrim(${users.email})) = lower(btrim(${trimmed}))`
    : sql`lower(btrim(${users.username})) = lower(btrim(${trimmed}))`;

  const [row] = await getDb()
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(match)
    .limit(1);

  if (!row) {
    return null;
  }

  // An absent optional is OMITTED, not emitted as null.
  return {
    id: row.id,
    username: row.username ?? undefined,
    email: row.email ?? undefined,
  };
}
