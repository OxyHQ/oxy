import {
  handleHttpError,
  parseCommonsApprovalExpiresAt,
  type CommonsApprovalInfo,
} from '@oxy.so/core';
import { isNetworkOrTimeoutError } from '@/utils/auth/errorUtils';

/**
 * Why a "Sign in with Oxy" request cannot be approved, as a KIND the screen
 * turns into translated copy. The approval sheet used to show
 * `getCommonsApprovalBlockingReason`'s English sentence, or the thrown error's
 * raw `message`, so a Spanish user read English and every user could read a
 * transport message such as "Request failed with status code 404".
 *
 * - `unresolvedApp`: the server could not say which application is asking.
 * - `unavailable`: the request is not pending: invalid, already used or
 *   cancelled. A 4xx answer to the lookup or the approval means the same.
 * - `expired`: past its deadline.
 * - `network`: Oxy could not be reached; trying again can work.
 * - `failed`: anything else (a 5xx, a 429, an unknown throw).
 */
export type ApprovalErrorKind = 'unresolvedApp' | 'unavailable' | 'expired' | 'network' | 'failed';

/** The kind that blocks this resolved request, or `null` when it can be approved. */
export function approvalInfoBlockingKind(
  info: Pick<CommonsApprovalInfo, 'application' | 'status' | 'expiresAt'>,
  now: number = Date.now(),
): ApprovalErrorKind | null {
  if (!info.application?.id) return 'unresolvedApp';
  if (info.status !== 'pending') return 'unavailable';
  const expiresAtMs = parseCommonsApprovalExpiresAt(info.expiresAt);
  if (expiresAtMs !== null && expiresAtMs < now) return 'expired';
  return null;
}

/** The kind of a thrown lookup, approve or deny failure. */
export function approvalErrorKind(error: unknown): ApprovalErrorKind {
  if (isNetworkOrTimeoutError(error)) return 'network';
  const status = handleHttpError(error).status;
  if (status === 429) return 'failed';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'unavailable';
  return 'failed';
}

/** The translation key for each kind. */
export const APPROVAL_ERROR_KEYS: Record<ApprovalErrorKind, string> = {
  unresolvedApp: 'signInApproval.approve.errors.unresolvedApp',
  unavailable: 'signInApproval.approve.errorBody',
  expired: 'signInApproval.approve.errors.expired',
  network: 'signInApproval.approve.errors.network',
  failed: 'signInApproval.approve.errors.failed',
};
