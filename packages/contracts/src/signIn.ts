import { isLanguageTag } from './client/language';
import { campaignAttributionSchema } from './campaignAttribution';
import { integerCheck } from './numberChecks';
import { utf16MaxLength, utf16MinLength } from './stringChecks';
/**
 * Signing in: an email code or link, an optional password,
 * and an optional authenticator app (TOTP) as a second factor.
 *
 * Every Oxy app runs these from its own account dialog (official apps and
 * auth.oxy.so only; third parties sign in through OAuth on auth.oxy.so):
 *
 * 1. `POST /auth/signin/email/start` with a username or email. One email
 *    carries a 6-digit code AND a one-use link to auth.oxy.so; the answer is the
 *    same whether or not the account exists. The dialog keeps the
 *    `requestSecret` it is given: only it can collect the session.
 * 2. Either the code (`POST /auth/signin/email/confirm`), or the link opened in
 *    the SAME browser (`POST /auth/signin/email/link` from auth.oxy.so, proving
 *    the browser's shared device) followed by the dialog's
 *    `POST /auth/signin/email/collect`.
 * 3. Or a password (`POST /auth/signin/password`), when the account set one.
 * 4. When the account has an authenticator, every first factor answers a
 *    one-use second-factor challenge instead of a session, and
 *    `POST /auth/signin/second-factor` takes the TOTP (or a backup code).
 *
 * An email may hold several accounts (up to `EMAIL_ACCOUNTS_MAX`). Signing in
 * with the email, once the code or the link proves it, answers the accounts to
 * choose from when there are several, and `POST /auth/signin/email/choose`
 * names one. A username always names one account.
 *
 * `POST /auth/signup` creates an account from a username and an email confirmed
 * with `POST /auth/email/verify/{start,confirm}` (purpose `signup`).
 *
 * Every body that ends in a session may carry `device`, the proof of the
 * browser's shared device (ADR 0029 D2), so the account lands on it.
 */
import { z } from 'zod';
import { EMAIL_CODE_LENGTH, emailAddressSchema, emailTicketSchema } from './accountEmail';
import type { LoginResult } from './deviceBoot';
import { deviceProofSchema } from './deviceSession';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  TOTP_DIGITS,
  TOTP_BACKUP_CODE_COUNT,
  EMAIL_SIGNIN_LONG_CODE_ALPHABET,
  EMAIL_SIGNIN_LONG_CODE_LENGTH,
  normalizeEmailSignInCode,
  EMAIL_ACCOUNTS_MAX,
  REAUTH_ACTIONS,
} from './client/signIn';
export {
  EMAIL_SIGNIN_LINK_TTL_MS,
  SIGNIN_SECOND_FACTOR_TTL_MS,
  SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_BACKUP_CODE_COUNT,
  EMAIL_SIGNIN_LONG_CODE_ALPHABET,
  EMAIL_SIGNIN_LONG_CODE_LENGTH,
  normalizeEmailSignInCode,
  EMAIL_SIGNIN_CHOICE_TTL_MS,
  EMAIL_ACCOUNTS_MAX,
  isSecondFactorRequired,
  isEmailSignInChooseAccount,
  REAUTH_ACTIONS,
  SIGN_IN_ERROR_CODES,
} from './client/signIn';
export type { ReauthAction, SignInErrorCode } from './client/signIn';

const sixDigits = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`), `code must be ${EMAIL_CODE_LENGTH} digits`);

/**
 * 32 random bytes, base64url: a request secret, a link token, a challenge id.
 * The same shape as an email ticket.
 */
const opaqueTokenSchema = emailTicketSchema;

/** A username or an email. */
export const signInIdentifierSchema = z
  .string()
  .trim()
  .check(utf16MinLength(1))
  .check(utf16MaxLength(254));

/** A password as typed. Its policy applies only when one is set. */
export const passwordInputSchema = z
  .string()
  .check(utf16MinLength(1))
  .check(utf16MaxLength(PASSWORD_MAX_LENGTH));

/** A new password. */
export const newPasswordSchema = z
  .string()
  .check(
    utf16MinLength(
      PASSWORD_MIN_LENGTH,
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    ),
  )
  .check(
    utf16MaxLength(
      PASSWORD_MAX_LENGTH,
      `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    ),
  );

/**
 * An authenticator code (6 digits) or a backup code (10 characters, with or
 * without its dash). Normalised server-side.
 */
export const secondFactorCodeSchema = z
  .string()
  .trim()
  .check(utf16MinLength(TOTP_DIGITS))
  .check(utf16MaxLength(16));

/** The device-session fields every body that ends in a session may carry. */
const sessionEnvelope = {
  deviceName: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(120)).optional(),
  deviceFingerprint: z
    .string()
    .trim()
    .check(utf16MinLength(1))
    .check(utf16MaxLength(256))
    .optional(),
  /** Proof of the browser's shared device; invalid → the session gets its own. */
  device: deviceProofSchema.optional(),
} as const;

/** `POST /auth/signin/email/start` */
export const emailSignInStartRequestSchema = z
  .object({
    identifier: signInIdentifierSchema,
    /** The requester's device: the email's link approves only in this browser. */
    device: deviceProofSchema.optional(),
  })
  .strict();
export type EmailSignInStartRequest = z.infer<typeof emailSignInStartRequestSchema>;

export interface EmailSignInStartResponse {
  /** Names the request. Returned whether or not an email was sent. */
  requestId: string;
  /** Only the caller holds it; confirming or collecting needs it. Keep it in memory. */
  requestSecret: string;
  /** Unix milliseconds after which the code is refused. */
  expiresAt: number;
  /**
   * Present ONLY when the request proved a device this account is already on
   * and no email could be sent right now (too many were): try again later.
   * Every other caller gets the ordinary answer whatever happened.
   */
  retryLater?: true;
}

export const emailSignInStartResponseSchema: z.ZodType<EmailSignInStartResponse> = z.object({
  requestId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
  requestSecret: opaqueTokenSchema,
  expiresAt: z.number().check(integerCheck()).positive(),
  retryLater: z.literal(true).optional(),
});

/**
 * The code from a sign-in email: 6 digits, or — for an account whose codes
 * were guessed at too often today — the 10-character long code
 * (`EMAIL_SIGNIN_LONG_CODE_ALPHABET`, with or without its dash, any case). The
 * UI must accept BOTH in one field: the email says which was sent, and the
 * start response is the same either way (it says nothing about the account).
 */
export const emailSignInCodeSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      const code = normalizeEmailSignInCode(value);
      return (
        new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(code) ||
        new RegExp(`^[${EMAIL_SIGNIN_LONG_CODE_ALPHABET}]{${EMAIL_SIGNIN_LONG_CODE_LENGTH}}$`).test(
          code,
        )
      );
    },
    {
      message: `code must be ${EMAIL_CODE_LENGTH} digits or the ${EMAIL_SIGNIN_LONG_CODE_LENGTH}-character code from the email`,
    },
  );

/** `POST /auth/signin/email/confirm` — the code from the email. */
export const emailSignInConfirmRequestSchema = z
  .object({
    requestId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    requestSecret: opaqueTokenSchema,
    code: emailSignInCodeSchema,
    ...sessionEnvelope,
  })
  .strict();
export type EmailSignInConfirmRequest = z.infer<typeof emailSignInConfirmRequestSchema>;

/** `POST /auth/signin/email/collect` — the dialog asks whether its link was opened. */
export const emailSignInCollectRequestSchema = z
  .object({
    requestId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    requestSecret: opaqueTokenSchema,
    ...sessionEnvelope,
  })
  .strict();
export type EmailSignInCollectRequest = z.infer<typeof emailSignInCollectRequestSchema>;

/**
 * `POST /auth/signin/email/link` — auth.oxy.so, where the email's link lands.
 * It proves auth.oxy.so's own credential for the browser's device; the request
 * is approved only when that is the device that asked.
 */
export const emailSignInLinkRequestSchema = z
  .object({
    token: opaqueTokenSchema,
    device: deviceProofSchema,
  })
  .strict();
export type EmailSignInLinkRequest = z.infer<typeof emailSignInLinkRequestSchema>;

export interface EmailSignInLinkResponse {
  /** The dialog that asked collects the session; the link page never receives one. */
  approved: true;
}

export const emailSignInLinkResponseSchema: z.ZodType<EmailSignInLinkResponse> = z.object({
  approved: z.literal(true),
});

/** `POST /auth/signin/password` */
export const passwordSignInRequestSchema = z
  .object({
    identifier: signInIdentifierSchema,
    password: passwordInputSchema,
    ...sessionEnvelope,
  })
  .strict();
export type PasswordSignInRequest = z.infer<typeof passwordSignInRequestSchema>;

/** `POST /auth/signin/second-factor` */
export const secondFactorSignInRequestSchema = z
  .object({
    challengeId: opaqueTokenSchema,
    code: secondFactorCodeSchema,
    ...sessionEnvelope,
  })
  .strict();
export type SecondFactorSignInRequest = z.infer<typeof secondFactorSignInRequestSchema>;

/** `POST /auth/signup` — the account, from a username and a confirmed email. */
export const signUpRequestSchema = z
  .object({
    username: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(60)),
    email: emailAddressSchema,
    /** The ticket `POST /auth/email/verify/confirm` (purpose `signup`) returned. */
    emailTicket: emailTicketSchema,
    languages: z
      .array(z.string().refine(isLanguageTag, 'Invalid language tag'))
      .min(1)
      .max(10)
      .optional(),
    campaignAttribution: campaignAttributionSchema.optional(),
    ...sessionEnvelope,
  })
  .strict();
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

/** A first factor passed and the account has an authenticator: no session yet. */
export interface SecondFactorRequired {
  secondFactorRequired: true;
  /** One use, bound to the account and the device that passed the first factor. */
  challengeId: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export const secondFactorRequiredSchema: z.ZodType<SecondFactorRequired> = z.object({
  secondFactorRequired: z.literal(true),
  challengeId: opaqueTokenSchema,
  expiresAt: z.number().check(integerCheck()).positive(),
});

/** The dialog's link has not been opened (in the right browser) yet. */
export interface EmailSignInPending {
  status: 'pending';
  expiresAt: number;
}

export const emailSignInPendingSchema: z.ZodType<EmailSignInPending> = z.object({
  status: z.literal('pending'),
  expiresAt: z.number().check(integerCheck()).positive(),
});

/** What a first factor answers: a session, or the second-factor step. */
export type SignInStepResult = LoginResult | SecondFactorRequired;

/** One account an email holds, as the choice after proving it shows it. */
export interface EmailSignInAccountOption {
  id: string;
  username?: string;
  /** The account's own display name; absent → show the handle. */
  displayName?: string;
  /** Asset id of the avatar. */
  avatar?: string;
}

export const emailSignInAccountOptionSchema: z.ZodType<EmailSignInAccountOption> = z.object({
  id: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
  username: z.string().check(utf16MinLength(1)).optional(),
  displayName: z.string().check(utf16MinLength(1)).optional(),
  avatar: z.string().check(utf16MinLength(1)).optional(),
});

/**
 * The email was signed in with, and it holds several accounts: the person
 * chooses one (`POST /auth/signin/email/choose`) before `expiresAt`. Only the
 * holder of the request's `requestSecret` ever sees this, after the code or
 * the link proved the mailbox; a sign-in by username names one account and
 * never asks.
 */
export interface EmailSignInChooseAccount {
  chooseAccount: true;
  accounts: EmailSignInAccountOption[];
  /** Unix milliseconds. */
  expiresAt: number;
}

export const emailSignInChooseAccountSchema: z.ZodType<EmailSignInChooseAccount> = z.object({
  chooseAccount: z.literal(true),
  accounts: z.array(emailSignInAccountOptionSchema).min(2).max(EMAIL_ACCOUNTS_MAX),
  expiresAt: z.number().check(integerCheck()).positive(),
});

/** What proving an email answers: a session, the second-factor step, or the account choice. */
export type EmailSignInStepResult = SignInStepResult | EmailSignInChooseAccount;

/** `POST /auth/signin/email/choose` — the account, from those {@link EmailSignInChooseAccount} listed. */
export const emailSignInChooseRequestSchema = z
  .object({
    requestId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    requestSecret: opaqueTokenSchema,
    userId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    ...sessionEnvelope,
  })
  .strict();
export type EmailSignInChooseRequest = z.infer<typeof emailSignInChooseRequestSchema>;

/** `POST /users/me/reauth/email` */
export const reauthEmailStartRequestSchema = z.object({ action: z.enum(REAUTH_ACTIONS) }).strict();
export type ReauthEmailStartRequest = z.infer<typeof reauthEmailStartRequestSchema>;

/**
 * A fresh proof that the person, not only their session, is asking: the
 * current password, or a code just sent to the account's email
 * (`POST /users/me/reauth/email`) — plus the authenticator code when the
 * account has one. Carried inside the request it authorises.
 */
export const reauthProofSchema = z
  .object({
    password: passwordInputSchema.optional(),
    emailCode: z
      .object({
        verificationId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
        code: sixDigits,
      })
      .strict()
      .optional(),
    /** Required when the account has an authenticator: its code or a backup code. */
    totpCode: secondFactorCodeSchema.optional(),
  })
  .strict()
  .refine((proof) => proof.password !== undefined || proof.emailCode !== undefined, {
    message: 'password or emailCode is required',
  });
export type ReauthProof = z.infer<typeof reauthProofSchema>;

/** `PUT /users/me/password` — set or change the password. */
export const passwordSetRequestSchema = z
  .object({
    newPassword: newPasswordSchema,
    reauth: reauthProofSchema,
    /** Sign every other session of the account out. */
    revokeOtherSessions: z.boolean().optional(),
  })
  .strict();
export type PasswordSetRequest = z.infer<typeof passwordSetRequestSchema>;

/**
 * `DELETE /users/me/password` — only while the account has an email to sign
 * in with; `DELETE /users/me/email` — only while it has a password, and
 * confirmed with that password.
 */
export const signInMethodRemoveRequestSchema = z.object({ reauth: reauthProofSchema }).strict();
export type SignInMethodRemoveRequest = z.infer<typeof signInMethodRemoveRequestSchema>;

/** `POST /users/me/email/verify/start` — a code to the address the account moves to. */
export const emailChangeStartRequestSchema = z.object({ email: emailAddressSchema }).strict();
export type EmailChangeStartRequest = z.infer<typeof emailChangeStartRequestSchema>;

/**
 * `PUT /users/me/email` — add or change the email: the NEW address and the
 * code it got (`verificationId`, `code`), and the proof it is the person (the
 * password, or a code to the current email; plus the authenticator's).
 */
export const emailSetRequestSchema = z
  .object({
    email: emailAddressSchema,
    verificationId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    code: sixDigits,
    reauth: reauthProofSchema,
  })
  .strict();
export type EmailSetRequest = z.infer<typeof emailSetRequestSchema>;

/** `GET /users/me/sign-in-methods` */
export interface SignInMethods {
  hasEmail: boolean;
  hasPassword: boolean;
  totpEnabled: boolean;
  /** Unused backup codes; 0 without an authenticator. */
  backupCodesRemaining: number;
}

export const signInMethodsSchema: z.ZodType<SignInMethods> = z.object({
  hasEmail: z.boolean(),
  hasPassword: z.boolean(),
  totpEnabled: z.boolean(),
  backupCodesRemaining: z.number().check(integerCheck()).min(0),
});

/** `POST /users/me/totp/enroll` — a new secret, not active until confirmed. */
export interface TotpEnrollResponse {
  /** Base32, for typing into an authenticator by hand. */
  secret: string;
  /** `otpauth://totp/…`, for the QR. */
  otpauthUri: string;
}

export const totpEnrollResponseSchema: z.ZodType<TotpEnrollResponse> = z.object({
  secret: z.string().regex(/^[A-Z2-7]+$/),
  otpauthUri: z.string().startsWith('otpauth://totp/'),
});

/** `POST /users/me/totp/confirm` — the first code from the authenticator turns it on. */
export const totpConfirmRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`)),
    reauth: reauthProofSchema,
  })
  .strict();
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;

/** `POST /users/me/totp/disable` and `POST /users/me/totp/backup-codes` */
export const totpReauthRequestSchema = z.object({ reauth: reauthProofSchema }).strict();
export type TotpReauthRequest = z.infer<typeof totpReauthRequestSchema>;

/** Shown once; each works one time. */
export interface TotpBackupCodesResponse {
  backupCodes: string[];
}

export const totpBackupCodesResponseSchema: z.ZodType<TotpBackupCodesResponse> = z.object({
  backupCodes: z
    .array(z.string().regex(/^[a-z2-9]{5}-[a-z2-9]{5}$/))
    .length(TOTP_BACKUP_CODE_COUNT),
});
