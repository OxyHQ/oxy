/**
 * Account-email constants and response checks, without Zod. Schemas: `../accountEmail.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  EmailVerificationConfirmResponse,
  EmailVerificationStartResponse,
} from '../accountEmail';
import {
  email,
  exact,
  int,
  maxLength,
  minLength,
  number,
  object,
  pattern,
  positive,
  string,
  toLowerCase,
  trim,
} from './check';

/**
 * - `signup`: above.
 * - `signin`: the code (and link) of an email sign-in (`POST /auth/signin/email/start`).
 * - `reauth`: a signed-in person proving it is them before a sensitive step
 *   (`POST /users/me/reauth/email`): a password, an authenticator, deleting the
 *   account, linking Commons.
 * - `email_change`: a signed-in account proving the NEW address it moves to
 *   (`POST /users/me/email/verify/start`); bound to the account and that address.
 */
export const EMAIL_VERIFICATION_PURPOSES = ['signup', 'signin', 'reauth', 'email_change'] as const;

export type EmailVerificationPurpose = (typeof EMAIL_VERIFICATION_PURPOSES)[number];

/** Digits in a code. */
export const EMAIL_CODE_LENGTH = 6;

/** How long a code can be confirmed. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

/** Wrong codes before a verification is spent and a new code is needed. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** How long a confirmed code's ticket can be spent. */
export const EMAIL_TICKET_TTL_MS = 15 * 60 * 1000;

/**
 * Stable error codes (`error.code` in the API error body). Clients map these
 * through their localization, never the English message.
 */
export const EMAIL_VERIFICATION_ERROR_CODES = {
  /** The code is wrong, or its verification expired or was spent. */
  codeInvalid: 'EMAIL_CODE_INVALID',
  /** Too many wrong codes: request a new one. */
  tooManyAttempts: 'EMAIL_CODE_TOO_MANY_ATTEMPTS',
  /** The ticket is unknown, expired, spent, or for another email or purpose. */
  ticketInvalid: 'EMAIL_TICKET_INVALID',
  /** A sign-up without a confirmed email. */
  ticketRequired: 'EMAIL_TICKET_REQUIRED',
  /** This server cannot send mail. */
  unavailable: 'EMAIL_UNAVAILABLE',
} as const;

export type EmailVerificationErrorCode =
  (typeof EMAIL_VERIFICATION_ERROR_CODES)[keyof typeof EMAIL_VERIFICATION_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

export const emailAddressCheck = string(trim, toLowerCase, minLength(3), maxLength(254), email);

export const emailTicketCheck = string(
  trim,
  pattern(/^[A-Za-z0-9_-]{43}$/, 'ticket must be 32 bytes of base64url'),
);

export const emailVerificationStartResponseCheck = exact<EmailVerificationStartResponse>()(
  object({ verificationId: string(minLength(1), maxLength(64)), expiresAt: number(int, positive) }),
);

export const emailVerificationConfirmResponseCheck = exact<EmailVerificationConfirmResponse>()(
  object({ ticket: emailTicketCheck, expiresAt: number(int, positive) }),
);
