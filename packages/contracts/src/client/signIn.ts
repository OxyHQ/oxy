/**
 * Sign-in constants, guards and response checks, without Zod. Schemas: `../signIn.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  EmailSignInAccountOption,
  EmailSignInChooseAccount,
  EmailSignInLinkResponse,
  EmailSignInPending,
  EmailSignInStartResponse,
  EmailSignInStepResult,
  ReauthProof,
  SecondFactorRequired,
  SignInMethods,
  TotpBackupCodesResponse,
  TotpEnrollResponse,
} from '../signIn';
import { EMAIL_CODE_LENGTH, emailTicketCheck } from './accountEmail';
import {
  array,
  boolean,
  exact,
  exactItems,
  int,
  literal,
  maxItems,
  maxLength,
  minItems,
  minLength,
  nonnegative,
  number,
  object,
  optional,
  pattern,
  positive,
  refine,
  startsWith,
  strictObject,
  string,
  trim,
} from './check';

/** How long the link in a sign-in email can be opened. */
export const EMAIL_SIGNIN_LINK_TTL_MS = 15 * 60 * 1000;

/** How long a second-factor challenge can be answered. */
export const SIGNIN_SECOND_FACTOR_TTL_MS = 5 * 60 * 1000;

/** Wrong second-factor codes one challenge accepts. */
export const SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS = 5;

/** Shortest password Oxy accepts when one is set. */
export const PASSWORD_MIN_LENGTH = 10;

/** Longest password Oxy accepts (characters). */
export const PASSWORD_MAX_LENGTH = 256;

/** Digits in an authenticator code. */
export const TOTP_DIGITS = 6;

/** Seconds each authenticator code lasts. */
export const TOTP_PERIOD_SECONDS = 30;

/** Backup codes issued when an authenticator is enabled or they are regenerated. */
export const TOTP_BACKUP_CODE_COUNT = 10;

/**
 * The long sign-in code: ten characters of Crockford base32 without the
 * look-alikes (no 0, O, 1, I, L, U), shown as `XXXXX-XXXXX`. An account whose
 * sign-in codes were guessed at too often today (the per-account ceiling) is
 * sent this instead of 6 digits for the rest of the day, so its owner can still
 * type a code while guessing one is infeasible.
 */
export const EMAIL_SIGNIN_LONG_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const EMAIL_SIGNIN_LONG_CODE_LENGTH = 10;

/**
 * Normalise a typed sign-in code: 6 digits stay as they are; a long code is
 * upper-cased with its dash and spaces removed. Anything else is returned
 * trimmed (and will simply be wrong).
 */
export function normalizeEmailSignInCode(code: string): string {
  const compact = code.trim().replace(/[\s-]/g, '').toUpperCase();
  return compact;
}

/**
 * How long, once the email is proven, the person has to choose which of its
 * accounts signs in.
 */
export const EMAIL_SIGNIN_CHOICE_TTL_MS = 5 * 60 * 1000;

/** Most accounts one email can hold; sign-up refuses another past it. */
export const EMAIL_ACCOUNTS_MAX = 20;

/** Narrow a {@link SignInStepResult}. */
export function isSecondFactorRequired(
  result: EmailSignInStepResult | EmailSignInPending,
): result is SecondFactorRequired {
  return (result as SecondFactorRequired).secondFactorRequired === true;
}

/** Narrow an {@link EmailSignInStepResult}. */
export function isEmailSignInChooseAccount(
  result: EmailSignInStepResult | EmailSignInPending,
): result is EmailSignInChooseAccount {
  return (result as EmailSignInChooseAccount).chooseAccount === true;
}

/**
 * What a re-verification email code confirms. The code is bound to it: a code
 * asked for one change never authorises another, and the email names it.
 */
export const REAUTH_ACTIONS = [
  'change_password',
  'totp',
  'link_commons',
  'delete_account',
  'credentials_manage',
] as const;

export type ReauthAction = (typeof REAUTH_ACTIONS)[number];

/**
 * Stable error codes (`error.code` in the API error body). Clients map these
 * through their localization, never the English message.
 */
export const SIGN_IN_ERROR_CODES = {
  /** Wrong identifier or password — never says which. */
  invalidCredentials: 'SIGNIN_INVALID_CREDENTIALS',
  /** The request is unknown, expired, spent, or its secret is wrong. */
  requestInvalid: 'SIGNIN_REQUEST_INVALID',
  /** The link is unknown, expired or already used. */
  linkInvalid: 'SIGNIN_LINK_INVALID',
  /** The link was opened in another browser: type the code in the app instead. */
  linkOtherDevice: 'SIGNIN_LINK_OTHER_DEVICE',
  /** The second-factor challenge or its code is wrong, expired or spent. */
  secondFactorInvalid: 'SECOND_FACTOR_INVALID',
  /** Too many failures for this account: wait and try again. */
  locked: 'SIGNIN_LOCKED',
  /** The step needs a fresh proof (`reauth`). */
  reauthRequired: 'REAUTH_REQUIRED',
  /** The fresh proof was wrong. */
  reauthInvalid: 'REAUTH_INVALID',
  /** The account has an authenticator: the proof must carry its code. */
  totpRequired: 'TOTP_REQUIRED',
  /** Enrolling or confirming an authenticator that is already on. */
  totpAlreadyEnabled: 'TOTP_ALREADY_ENABLED',
  /** Disabling, confirming or regenerating codes with no authenticator (or no pending one). */
  totpNotEnabled: 'TOTP_NOT_ENABLED',
  /** The code the authenticator showed at enrolment is wrong. */
  totpCodeInvalid: 'TOTP_CODE_INVALID',
  /** Only official Oxy apps and auth.oxy.so may sign people in here. */
  originNotAllowed: 'SIGNIN_ORIGIN_NOT_ALLOWED',
  /** The username is taken. */
  usernameTaken: 'USERNAME_TAKEN',
  /** The email already holds `EMAIL_ACCOUNTS_MAX` accounts: no sign-up adds another. */
  emailAccountsFull: 'EMAIL_ACCOUNTS_FULL',
} as const;

export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[keyof typeof SIGN_IN_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

const expiresAt = number(int, positive);

const sixDigits = string(
  trim,
  pattern(new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`), `code must be ${EMAIL_CODE_LENGTH} digits`),
);

const passwordInput = string(minLength(1), maxLength(PASSWORD_MAX_LENGTH));

const secondFactorCode = string(trim, minLength(TOTP_DIGITS), maxLength(16));

export const emailSignInStartResponseCheck = exact<EmailSignInStartResponse>()(
  object({
    requestId: string(minLength(1), maxLength(64)),
    requestSecret: emailTicketCheck,
    expiresAt,
    retryLater: optional(literal(true)),
  }),
);

export const emailSignInLinkResponseCheck = exact<EmailSignInLinkResponse>()(
  object({ approved: literal(true) }),
);

export const secondFactorRequiredCheck = exact<SecondFactorRequired>()(
  object({ secondFactorRequired: literal(true), challengeId: emailTicketCheck, expiresAt }),
);

export const emailSignInPendingCheck = exact<EmailSignInPending>()(
  object({ status: literal('pending'), expiresAt }),
);

const emailSignInAccountOption = exact<EmailSignInAccountOption>()(
  object({
    id: string(minLength(1), maxLength(64)),
    username: optional(string(minLength(1))),
    displayName: optional(string(minLength(1))),
    avatar: optional(string(minLength(1))),
  }),
);

export const emailSignInChooseAccountCheck = exact<EmailSignInChooseAccount>()(
  object({
    chooseAccount: literal(true),
    accounts: array(emailSignInAccountOption, minItems(2), maxItems(EMAIL_ACCOUNTS_MAX)),
    expiresAt,
  }),
);

export const signInMethodsCheck = exact<SignInMethods>()(
  object({
    hasEmail: boolean,
    hasPassword: boolean,
    totpEnabled: boolean,
    backupCodesRemaining: number(int, nonnegative),
  }),
);

export const totpEnrollResponseCheck = exact<TotpEnrollResponse>()(
  object({
    secret: string(pattern(/^[A-Z2-7]+$/)),
    otpauthUri: string(startsWith('otpauth://totp/')),
  }),
);

export const totpBackupCodesResponseCheck = exact<TotpBackupCodesResponse>()(
  object({
    backupCodes: array(
      string(pattern(/^[a-z2-9]{5}-[a-z2-9]{5}$/)),
      exactItems(TOTP_BACKUP_CODE_COUNT),
    ),
  }),
);

export const reauthProofCheck = exact<ReauthProof>()(
  refine(
    strictObject({
      password: optional(passwordInput),
      emailCode: optional(
        strictObject({
          verificationId: string(trim, minLength(1), maxLength(64)),
          code: sixDigits,
        }),
      ),
      totpCode: optional(secondFactorCode),
    }),
    (proof) => proof.password !== undefined || proof.emailCode !== undefined,
    'password or emailCode is required',
  ),
);
