/**
 * The message for a failed passkey sign-in, and whether it was rate-limited.
 *
 * A dismissed or timed-out browser prompt rejects with a `NotAllowedError` /
 * `AbortError` DOMException, often re-wrapped by `@simplewebauthn/browser` as a
 * `WebAuthnError` whose `cause` is the original — so the cancellation shape is
 * looked for along the cause chain, and reported calmly instead of as the raw
 * "The operation either timed out or was not allowed…".
 */

import type { Translate } from '../authChooser/types';

/** How long the surface waits after a 429 before it lets the person retry. */
export const RATE_LIMIT_SECONDS = 60;

function isCancellation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.name === 'NotAllowedError' || current.name === 'AbortError') return true;
    // `@simplewebauthn/browser`'s stable code for an aborted ceremony.
    if ((current as { code?: unknown }).code === 'ERROR_CEREMONY_ABORTED') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** An HTTP status off a thrown SDK error (ApiError- or axios-shaped). */
function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number } | undefined)?.status ??
    (error as { response?: { status?: number } } | undefined)?.response?.status
  );
}

export function isRateLimited(error: unknown): boolean {
  return errorStatus(error) === 429;
}

/** The inline message for a passkey ceremony that did not sign anyone in. */
export function describePasskeyError(error: unknown, t: Translate): string {
  if (isCancellation(error)) return t('signin.errors.passkeyCancelled');
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return t('signin.errors.passkeyFailed');
}
