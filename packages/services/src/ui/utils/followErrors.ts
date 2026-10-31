import { isSessionChangedError } from './sessionChangedError';

/**
 * What a failed follow read or write leaves behind: a stable CODE, never text.
 *
 * The follow stores and hooks have no translator and must not pretend to — an
 * English sentence written into a store reaches every locale's toast verbatim,
 * and so does a server's `message`. They keep one of these codes instead, and
 * the UI turns it into words in the user's language (`describeFollowError` in
 * `components/followLabels.ts`).
 *
 * A code says either what the caller was doing (`read_failed`, `update_failed`,
 * `mode_failed`) or — when the failure says more than that — why it failed,
 * taken from the API's machine code and HTTP status rather than its message.
 */
export type FollowErrorCode =
  /** The status could not be read. */
  | 'read_failed'
  /** A follow or unfollow was refused. */
  | 'update_failed'
  /** Switching a follow off or back on in this application was refused. */
  | 'mode_failed'
  /** No response arrived: the device is offline, or the request timed out. */
  | 'offline'
  /** The session is gone; signing in again is the only fix. */
  | 'signed_out'
  /** This application lacks the permission the write needs. */
  | 'forbidden'
  /** The target or the relationship no longer exists. */
  | 'not_found'
  /** Too many writes in a short window. */
  | 'rate_limited';

/** The codes that name the caller's action rather than a cause. */
export type FollowActionErrorCode = 'read_failed' | 'update_failed' | 'mode_failed';

const OFFLINE_CODES = new Set(['NETWORK_ERROR', 'CONNECTION_FAILED', 'TIMEOUT']);

/**
 * The code for whatever a follow request rejected with.
 *
 * Read structurally — every `OxyServices` call rejects with an `OxyApiError`
 * (or an `OxyAuthenticationError`), and both carry `status` and `code` — so a
 * second copy of `@oxy.so/core` in an app cannot defeat an `instanceof`.
 * Anything the cause does not explain falls back to the caller's `action`.
 */
export function toFollowErrorCode(error: unknown, action: FollowActionErrorCode): FollowErrorCode {
  if (isSessionChangedError(error)) return action;
  const { status, code } = (error && typeof error === 'object' ? error : {}) as {
    status?: unknown;
    code?: unknown;
  };
  if (typeof code === 'string' && OFFLINE_CODES.has(code)) return 'offline';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return action;
}
