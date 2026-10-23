/**
 * Error-narrowing helpers for errors propagated by the `@oxy.so/core`
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

/**
 * The message to toast for a failed action: the API's own sentence for a refusal it
 * authored (4xx validation and conflicts), the caller's fixed `fallback` for anything
 * else. A server fault (5xx or status 0) and the SDK's `[object Object]` carry no
 * sentence meant for a person, so they are never printed. An error with no status
 * is one the console itself raised (a validator), whose message is already copy.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }
  const { status } = error as ApiAugmentedError;
  if (status !== undefined && (status === 0 || status >= 500)) {
    return fallback;
  }
  if (/\[object \w+\]/.test(error.message)) {
    return fallback;
  }
  return error.message;
}

/** The answers the console speaks for, one fixed sentence each (see `ApiState`). */
export type ApiErrorKind =
  | 'forbidden'
  | 'missing'
  | 'conflict'
  | 'rateLimited'
  | 'unavailable'
  | 'unreachable'
  | 'unknown';

/**
 * Sort an error by its `status`, never its prose: the API's messages are
 * operator-facing text (or the SDK's `[object Object]`) and are never shown.
 * An error with no status at all never reached the server.
 */
export function classifyApiError(error: unknown): ApiErrorKind {
  if (!isApiAugmentedError(error)) {
    return 'unknown';
  }
  switch (error.status) {
    case 403:
      return 'forbidden';
    case 404:
      return 'missing';
    case 409:
      return 'conflict';
    case 429:
      return 'rateLimited';
    case 502:
    case 503:
    case 504:
      return 'unavailable';
    case undefined:
    case 0:
      return 'unreachable';
    default:
      return 'unknown';
  }
}
