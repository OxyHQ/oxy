/**
 * Classify a driver failure — which Postgres error, and which constraint.
 *
 * Every check-then-write in this codebase is a RACE. The probe answers "is this
 * name free?", the insert happens a moment later, and between the two another
 * request can take it. The unique index is what makes the outcome correct — no
 * duplicate can exist — but the loser's failure arrives as a driver error, and
 * an unclassified driver error is a 500. So the guard produces a clean 409 for
 * the caller who lost the probe and a 500 for the caller who lost the race, for
 * the same conflict.
 *
 * These live here rather than beside one caller because the reading is subtle
 * and was already written twice over. Drizzle wraps a postgres.js failure in its
 * own error, so `code` and `constraint_name` are on the `cause` — walking the
 * chain is what keeps the question "did THIS constraint fire?" rather than
 * "did something throw?".
 */

/** SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Read a field off a driver error, following the `cause` chain.
 *
 * `cause` is read through `Reflect.get` rather than `error.cause`: this package
 * compiles against the `es6` lib, where `Error.cause` is not declared.
 */
export function pgField(error: unknown, field: string): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = Reflect.get(current, 'cause')) {
    const value: unknown = Reflect.get(current, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Whether a failure is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return pgField(error, 'code') === UNIQUE_VIOLATION;
}

/**
 * Whether a failure is a unique violation on ONE named index.
 *
 * The name matters. A `users` insert can violate `users_lower_email_key` or
 * `users_lower_public_key_key` just as easily as `users_lower_username_key`, and
 * reporting any of them as "that username is taken" would send the caller to fix
 * the wrong field — a plausible, confidently wrong error message, which is worse
 * than the 500 it replaced.
 */
export function violatesUniqueIndex(error: unknown, indexName: string): boolean {
  return isUniqueViolation(error) && pgField(error, 'constraint_name') === indexName;
}
