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
export const signInIdentifierSchema = z.string().trim().min(1).max(254);

/** A password as typed. Its policy applies only when one is set. */
export const passwordInputSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** A new password. */
export const newPasswordSchema = z
    .string()
    .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `password must be at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * An authenticator code (6 digits) or a backup code (10 characters, with or
 * without its dash). Normalised server-side.
 */
export const secondFactorCodeSchema = z.string().trim().min(TOTP_DIGITS).max(16);

/** The device-session fields every body that ends in a session may carry. */
const sessionEnvelope = {
    deviceName: z.string().trim().min(1).max(120).optional(),
    deviceFingerprint: z.string().trim().min(1).max(256).optional(),
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
    requestId: z.string().min(1).max(64),
    requestSecret: opaqueTokenSchema,
    expiresAt: z.number().int().positive(),
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
                new RegExp(`^[${EMAIL_SIGNIN_LONG_CODE_ALPHABET}]{${EMAIL_SIGNIN_LONG_CODE_LENGTH}}$`).test(code)
            );
        },
        { message: `code must be ${EMAIL_CODE_LENGTH} digits or the ${EMAIL_SIGNIN_LONG_CODE_LENGTH}-character code from the email` },
    );

/** `POST /auth/signin/email/confirm` — the code from the email. */
export const emailSignInConfirmRequestSchema = z
    .object({
        requestId: z.string().trim().min(1).max(64),
        requestSecret: opaqueTokenSchema,
        code: emailSignInCodeSchema,
        ...sessionEnvelope,
    })
    .strict();
export type EmailSignInConfirmRequest = z.infer<typeof emailSignInConfirmRequestSchema>;

/** `POST /auth/signin/email/collect` — the dialog asks whether its link was opened. */
export const emailSignInCollectRequestSchema = z
    .object({
        requestId: z.string().trim().min(1).max(64),
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
        username: z.string().trim().min(1).max(60),
        email: emailAddressSchema,
        /** The ticket `POST /auth/email/verify/confirm` (purpose `signup`) returned. */
        emailTicket: emailTicketSchema,
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
    expiresAt: z.number().int().positive(),
});

/** The dialog's link has not been opened (in the right browser) yet. */
export interface EmailSignInPending {
    status: 'pending';
    expiresAt: number;
}

export const emailSignInPendingSchema: z.ZodType<EmailSignInPending> = z.object({
    status: z.literal('pending'),
    expiresAt: z.number().int().positive(),
});

/** What a first factor answers: a session, or the second-factor step. */
export type SignInStepResult = LoginResult | SecondFactorRequired;

/** Narrow a {@link SignInStepResult}. */
export function isSecondFactorRequired(result: SignInStepResult | EmailSignInPending): result is SecondFactorRequired {
    return (result as SecondFactorRequired).secondFactorRequired === true;
}

/**
 * What a re-verification email code confirms. The code is bound to it: a code
 * asked for one change never authorises another, and the email names it.
 */
export const REAUTH_ACTIONS = ['change_password', 'totp', 'link_commons', 'delete_account'] as const;
export type ReauthAction = (typeof REAUTH_ACTIONS)[number];

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
                verificationId: z.string().trim().min(1).max(64),
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

/** A proof by email code only (+ TOTP): deleting an account, linking Commons. */
export const emailReauthProofSchema = z
    .object({
        emailCode: z
            .object({
                verificationId: z.string().trim().min(1).max(64),
                code: sixDigits,
            })
            .strict(),
        totpCode: secondFactorCodeSchema.optional(),
    })
    .strict();
export type EmailReauthProof = z.infer<typeof emailReauthProofSchema>;

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
    backupCodesRemaining: z.number().int().min(0),
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
        code: z.string().trim().regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`)),
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
    backupCodes: z.array(z.string().regex(/^[a-z2-9]{5}-[a-z2-9]{5}$/)).length(TOTP_BACKUP_CODE_COUNT),
});

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
} as const;
export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[keyof typeof SIGN_IN_ERROR_CODES];
