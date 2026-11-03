/**
 * What a failed SDK call means to the person who made it.
 *
 * Every screen and mutation that shows a failure words it here, from the API's
 * machine code and HTTP status. A server `message` is never shown: it is
 * English, and for a validation failure it is "Validation failed".
 */

import { EMAIL_VERIFICATION_ERROR_CODES, SIGN_IN_ERROR_CODES } from '@oxy.so/contracts/client';
import type { Translate } from '../hooks/useI18n';

/** How long a screen waits after a 429 that names no wait of its own. */
export const RATE_LIMIT_SECONDS = 60;

/** The API error code a thrown SDK error carries (`error.code`), if any. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** An HTTP status off a thrown SDK error. */
export function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number } | undefined)?.status ??
    (error as { response?: { status?: number } } | undefined)?.response?.status
  );
}

/** A 429: too many attempts or emails. */
export function isRateLimited(error: unknown): boolean {
  return errorStatus(error) === 429;
}

/** How long to wait after a 429, from the API's `retryAfterSeconds` when it sent one. */
export function retryAfterSeconds(error: unknown): number {
  const seconds = (error as { details?: { retryAfterSeconds?: unknown } } | undefined)?.details
    ?.retryAfterSeconds;
  return typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds) : RATE_LIMIT_SECONDS;
}

/**
 * A failed API call, in the person's language — never the server's `message`,
 * which is English and written for developers. Never says whether an account
 * exists: every "no" is the same sentence.
 *
 * `fallback` names what the caller was doing ("Couldn't save your profile"),
 * for a failure with no more specific reason; it defaults to the generic line.
 */
export function describeApiError(error: unknown, t: Translate, fallback?: string): string {
  switch (errorCode(error)) {
    case SIGN_IN_ERROR_CODES.invalidCredentials:
      return t('signin.errors.invalidCredentials');
    case SIGN_IN_ERROR_CODES.requestInvalid:
    case SIGN_IN_ERROR_CODES.linkInvalid:
      return t('signin.errors.requestExpired');
    case SIGN_IN_ERROR_CODES.secondFactorInvalid:
    case SIGN_IN_ERROR_CODES.totpCodeInvalid:
      return t('signin.errors.secondFactorInvalid');
    case SIGN_IN_ERROR_CODES.reauthInvalid:
    case SIGN_IN_ERROR_CODES.reauthRequired:
      return t('reauth.errors.invalid');
    case SIGN_IN_ERROR_CODES.totpRequired:
      return t('reauth.errors.totpRequired');
    case SIGN_IN_ERROR_CODES.originNotAllowed:
      return t('signin.errors.originNotAllowed');
    case SIGN_IN_ERROR_CODES.usernameTaken:
      return t('signup.username.taken');
    case SIGN_IN_ERROR_CODES.emailAccountsFull:
      return t('signin.errors.emailAccountsFull');
    case SIGN_IN_ERROR_CODES.lastSignInMethod:
      return t('signInSecurity.errors.lastSignInMethod');
    case SIGN_IN_ERROR_CODES.passwordRequired:
      return t('signInSecurity.errors.passwordRequired');
    case SIGN_IN_ERROR_CODES.emailUnchanged:
      return t('signInSecurity.errors.emailUnchanged');
    case EMAIL_VERIFICATION_ERROR_CODES.codeInvalid:
      return t('emailCode.errors.codeInvalid');
    case EMAIL_VERIFICATION_ERROR_CODES.tooManyAttempts:
      return t('emailCode.errors.tooManyAttempts');
    case EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid:
    case EMAIL_VERIFICATION_ERROR_CODES.ticketRequired:
      return t('emailCode.errors.expired');
    case EMAIL_VERIFICATION_ERROR_CODES.unavailable:
      return t('emailCode.errors.unavailable');
    // A malformed request: every screen checks the contract before sending, so
    // this is the backstop for a rule the client does not know yet.
    case 'BAD_REQUEST':
      return t('signin.errors.invalidInput');
    case 'NETWORK_ERROR':
    case 'CONNECTION_FAILED':
    case 'TIMEOUT':
      return t('signin.errors.network');
    default: {
      if (isRateLimited(error))
        return t('signin.errors.rateLimited', { seconds: retryAfterSeconds(error) });
      const status = errorStatus(error);
      if (status === 0) return t('signin.errors.network');
      if (status !== undefined && status >= 500) return t('signin.errors.server');
      return fallback ?? t('signin.errors.generic');
    }
  }
}

/** Whether the confirmation this flow holds is gone and it must start again. */
export function isTicketExpired(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid ||
    code === EMAIL_VERIFICATION_ERROR_CODES.ticketRequired
  );
}
