/**
 * Resolve a human-friendly user identifier (username OR email) to an account.
 *
 * Member-invite endpoints accept an identifier real people actually know — a
 * username or an email address — instead of an opaque account id. This helper
 * centralises the "username or email → account" resolution so every invite path
 * behaves identically.
 *
 * ## The lookups are written as the indexes are built
 *
 * `users` is unique on `lower(btrim(username))` and indexed (not unique) on
 * `lower(btrim(email))` (`db/schema/users.ts`). Both lookups below are spelled
 * `lower(btrim(column)) = lower(btrim($1))` because that is the EXPRESSION
 * those indexes are built on — a plain `email = $1` is correct-looking,
 * case-sensitive, and will not use the index.
 *
 * ## A username is never ambiguous; an email can be
 *
 * Every lookup matches case-INSENSITIVELY, so `Nate` and `nate` coexisting
 * would let a membership grant land on an arbitrary one of two look-alike
 * accounts. `users_lower_username_key` makes that pair impossible to store: the
 * second insert fails on the unique index, and `__tests__` pins that
 * constraint: the collision is refused at write time, not tolerated at read
 * time.
 *
 * One email may hold several accounts, though. An email that does is REFUSED
 * (409, "use the username") rather than resolved to an arbitrary one of them:
 * a grant must land on the account the inviter meant.
 *
 * ## What this returns
 *
 * The ACCOUNT id, never `publicKey ?? id`: `routes/accounts.ts` passes it to an
 * invite, and a PUBLIC KEY where an account id belongs would be rejected by
 * `account_members_user_id_users_id_fk`. The shape below is deliberately narrow
 * so nothing can read a public key in its place.
 */

import { eq, or, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { ConflictError } from './error';

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
 * @throws ConflictError when the email holds more than one account.
 */
export async function resolveUserByIdentifier(
  identifier: string,
): Promise<ResolvedUserIdentity | null> {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // An `@` means an email address; a username cannot contain one.
  const match = trimmed.includes('@')
    ? sql`lower(btrim(${users.email})) = lower(btrim(${trimmed}))`
    : sql`lower(btrim(${users.username})) = lower(btrim(${trimmed}))`;

  const rows = await getDb()
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(match)
    .limit(2);

  if (rows.length > 1) {
    throw new ConflictError('Several accounts use this email. Use the username instead.');
  }
  const [row] = rows;
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

/**
 * The columns an operator script decides on. Named, never a whole-row
 * `select()`: `users` carries protected columns (`protectedColumns.test.ts`).
 */
const operatorAccountColumns = {
  id: users.id,
  username: users.username,
  email: users.email,
  publicKey: users.publicKey,
  type: users.type,
  kind: users.kind,
  accountStatus: users.accountStatus,
  verified: users.verified,
};

/** An account an operator named, or why the name does not pick exactly one. */
export type OperatorAccountResolution =
  | { account: { [K in keyof typeof operatorAccountColumns]: (typeof users.$inferSelect)[K] } }
  | { reason: 'no such account' | 'names more than one account' };

/**
 * Resolve an operator script's argument — an account id or a username — to
 * exactly one account. The username side is spelled as the index is built, like
 * `resolveUserByIdentifier` above.
 */
export async function resolveOperatorAccount(
  identifier: string,
): Promise<OperatorAccountResolution> {
  const matches = await getDb()
    .select(operatorAccountColumns)
    .from(users)
    .where(
      or(
        eq(users.id, identifier),
        sql`lower(btrim(${users.username})) = lower(btrim(${identifier}))`,
      ),
    )
    .limit(2);
  if (matches.length === 1) return { account: matches[0] };
  return { reason: matches.length === 0 ? 'no such account' : 'names more than one account' };
}
