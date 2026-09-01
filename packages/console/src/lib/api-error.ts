/**
 * Error-narrowing helpers for errors propagated by the `@oxyhq/core`
 * `OxyServices` client. `handleError` rethrows a standard `Error` augmented
 * with optional `code` / `status` / `details` fields (see `OxyServices.base.ts`),
 * so we narrow against those without `as any`.
 */

/** An `Error` carrying the optional API fields that `handleError` attaches. */
interface ApiAugmentedError extends Error {
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
}

function isApiAugmentedError(error: unknown): error is ApiAugmentedError {
  return error instanceof Error;
}

/** Message shown when an invited username/email does not resolve to a user. */
export const USER_NOT_FOUND_MESSAGE = 'No user found with that username or email.';

/**
 * Robustly detect an HTTP 404 "User not found" from an invite/member call.
 * Matches the attached `status === 404` (primary signal) and falls back to the
 * API's "User not found" message in case status is unavailable.
 */
export function isUserNotFoundError(error: unknown): boolean {
  if (!isApiAugmentedError(error)) {
    return false;
  }
  if (error.status === 404) {
    return true;
  }
  return /user not found/i.test(error.message);
}

/**
 * Did the API REFUSE this read, as opposed to failing it?
 *
 * A 403 from an account-scoped route is an answer — the caller's membership does
 * not carry the permission the route demands — and it is stable: the same
 * request will be refused again. Screens use it to say so plainly, and the audit
 * reads use it to decline to retry, because a retry only delays the message
 * behind a spinner that reads as a system fault.
 *
 * Narrowed on `status`, never on the prose. The message names the missing
 * permission (`Missing required permission: credentials:read`) and is
 * operator-facing text that is free to change.
 */
export function isPermissionRefused(error: unknown): boolean {
  return isApiAugmentedError(error) && error.status === 403;
}

/** Extract a human-readable message from an unknown error, with a fallback. */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
