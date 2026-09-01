/**
 * Shared validation utilities for API
 * Consolidates validation logic used across controllers and routes
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { NotFoundError, BadRequestError, ValidationError } from './error';
import { logger } from './logger';

/**
 * The two shapes an account id can have.
 *
 * `@oxyhq/db`'s `generatedId()` explains why there are two: every row that
 * existed before the cutover keeps its 24-char ObjectId hex verbatim (which is
 * how every foreign key survived the backfill), and every row created since is
 * a uuid v7. The column type is uniform `text`; only the VALUE format is mixed.
 */
const ACCOUNT_ID_PATTERN =
  /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Whether `id` has the shape of an account id — EITHER format.
 *
 * Use this, not {@link isValidObjectId}, for anything that must keep working
 * for accounts created after the cutover.
 */
export function isAccountIdFormat(id: string): boolean {
  return ACCOUNT_ID_PATTERN.test(id);
}

/**
 * Whether `id` is a 24-character hexadecimal ObjectId.
 *
 * LEGACY SHAPE, and knowingly so: it recognises only the PRE-CUTOVER half of
 * {@link isAccountIdFormat}, so it rejects the uuid v7 every account created
 * since is given. Every remaining caller lives in a batch that has not been
 * ported yet; each of those guards is either deleted (it only ever existed to
 * stop a Mongoose `CastError`, and a `text` id simply matches no rows) or
 * replaced with {@link isAccountIdFormat} where a 400 is a real contract.
 *
 * The implementation no longer goes through mongoose: `ObjectId.isValid` also
 * accepts any 12-character string, which no caller here wanted — every test
 * that stubs this module already stubs it as exactly this regex.
 */
export function isValidObjectId(id: string): boolean {
  return /^[0-9a-f]{24}$/i.test(id);
}

/**
 * Validates required fields in an object
 * Throws ValidationError if any required fields are missing
 */
export function validateRequiredFields(
  data: Record<string, unknown>,
  fields: string[]
): void {
  const missing = fields.filter(field => {
    const value = data[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields: ${missing.join(', ')}`
    );
  }
}

/**
 * Validates pagination parameters
 * Returns normalized limit and offset with defaults
 * Handles Express query parameter types (string | ParsedQs | array | undefined)
 */
export function validatePagination(
  limit?: unknown,
  offset?: unknown,
  maxLimit = 100,
  defaultLimit = 50
): { limit: number; offset: number } {
  // Convert to string first, then parse
  const limitStr = limit !== undefined ? String(limit) : undefined;
  const offsetStr = offset !== undefined ? String(offset) : undefined;

  const parsedLimit = limitStr !== undefined
    ? Math.min(Math.max(Number.parseInt(limitStr, 10) || defaultLimit, 1), maxLimit)
    : defaultLimit;

  const parsedOffset = offsetStr !== undefined
    ? Math.max(Number.parseInt(offsetStr, 10) || 0, 0)
    : 0;

  return { limit: parsedLimit, offset: parsedOffset };
}

/**
 * Resolve a caller-supplied user identifier — an account id or a `publicKey` —
 * to the canonical account id.
 *
 * An identifier already SHAPED like an account id is returned verbatim, with no
 * round trip and no existence check. That absence is deliberate and must not be
 * "fixed": `routes/privacy.ts` compares the resolved value against the caller's
 * own id and answers 400 on a mismatch, so verifying existence here would make a
 * non-existent id answer 404 while an existing stranger's id answers 400 —
 * turning an ownership check into an account-existence oracle.
 *
 * Anything else is treated as a public key. The lookup is written
 * `lower(btrim(public_key)) = lower(btrim($1))` because that is the EXPRESSION
 * the unique index is built on (`db/schema/users.ts`); a plain `public_key = $1`
 * is correct-looking, case-sensitive, and will not use it.
 *
 * @throws {BadRequestError} When the identifier is empty.
 * @throws {NotFoundError} When no account holds that public key.
 */
export async function resolveUserIdToObjectId(userId: string): Promise<string> {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    logger.warn('resolveUserIdToObjectId: Empty or invalid userId provided', { userId });
    throw new BadRequestError('User ID is required');
  }

  const trimmedUserId = userId.trim();

  if (isAccountIdFormat(trimmedUserId)) {
    return trimmedUserId;
  }

  logger.debug('resolveUserIdToObjectId: Treating userId as publicKey', { userId: trimmedUserId });
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${trimmedUserId}))`)
    .limit(1);

  if (!row) {
    logger.warn('resolveUserIdToObjectId: User not found for publicKey', { userId: trimmedUserId });
    throw new NotFoundError('User not found');
  }

  return row.id;
}
