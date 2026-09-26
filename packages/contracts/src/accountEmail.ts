/**
 * Recovery email contracts (ADR 0029 D3).
 *
 * A web account is a username, a passkey and a recovery email. The email is
 * proven by a 6-digit code sent to it, and the proof is a short-lived one-use
 * ticket the next step spends:
 *
 * - `signup`: the ticket lets `POST /webauthn/register/verify` create the
 *   account with that email;
 * - `recovery`: the person names their username or email, the code goes to the
 *   account's recovery email, and the ticket lets them register a new passkey
 *   for that account.
 *
 * `start` answers the same whether or not an account exists, so neither purpose
 * tells anyone which emails or usernames have an Oxy account. An account with a
 * Commons key has no recovery email: it recovers in Commons.
 */
import { z } from 'zod';

/**
 * - `signup`, `recovery`: above.
 * - `signin`: the code (and link) of an email sign-in (`POST /auth/signin/email/start`).
 * - `reauth`: a signed-in person proving it is them before a sensitive step
 *   (`POST /users/me/reauth/email`): a password, an authenticator, deleting the
 *   account, linking Commons.
 */
export const EMAIL_VERIFICATION_PURPOSES = ['signup', 'recovery', 'signin', 'reauth'] as const;
export type EmailVerificationPurpose = (typeof EMAIL_VERIFICATION_PURPOSES)[number];

/** Digits in a code. */
export const EMAIL_CODE_LENGTH = 6;
/** How long a code can be confirmed. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes before a verification is spent and a new code is needed. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** How long a confirmed code's ticket can be spent. */
export const EMAIL_TICKET_TTL_MS = 15 * 60 * 1000;

/** An email address as the API stores it: trimmed and lowercase. */
export const emailAddressSchema = z.string().trim().toLowerCase().min(3).max(254).email();

/** An opaque one-use ticket (32 random bytes, base64url). */
export const emailTicketSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'ticket must be 32 bytes of base64url');

/** `POST /auth/email/verify/start` */
export const emailVerificationStartRequestSchema = z.discriminatedUnion('purpose', [
    z.object({ purpose: z.literal('signup'), email: emailAddressSchema }).strict(),
    z
        .object({
            purpose: z.literal('recovery'),
            /** The account's username, or its recovery email. */
            identifier: z.string().trim().min(1).max(254),
        })
        .strict(),
]);
export type EmailVerificationStartRequest = z.infer<typeof emailVerificationStartRequestSchema>;

export interface EmailVerificationStartResponse {
    /** Names this verification in `confirm`. Returned whether or not a code was sent. */
    verificationId: string;
    /** Unix milliseconds after which the code is refused. */
    expiresAt: number;
}

export const emailVerificationStartResponseSchema: z.ZodType<EmailVerificationStartResponse> = z.object({
    verificationId: z.string().min(1).max(64),
    expiresAt: z.number().int().positive(),
});

/** `POST /auth/email/verify/confirm` */
export const emailVerificationConfirmRequestSchema = z
    .object({
        verificationId: z.string().trim().min(1).max(64),
        code: z
            .string()
            .trim()
            .regex(new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`), `code must be ${EMAIL_CODE_LENGTH} digits`),
    })
    .strict();
export type EmailVerificationConfirmRequest = z.infer<typeof emailVerificationConfirmRequestSchema>;

export interface EmailVerificationConfirmResponse {
    ticket: string;
    /** Unix milliseconds after which the ticket is refused. */
    expiresAt: number;
    /** Recovery only: the account the ticket recovers. `null` for sign-up. */
    username: string | null;
}

export const emailVerificationConfirmResponseSchema: z.ZodType<EmailVerificationConfirmResponse> = z.object({
    ticket: emailTicketSchema,
    expiresAt: z.number().int().positive(),
    username: z.string().nullable(),
});

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
    /** A sign-up without a confirmed recovery email. */
    ticketRequired: 'EMAIL_TICKET_REQUIRED',
    /** This server cannot send mail. */
    unavailable: 'EMAIL_UNAVAILABLE',
} as const;
export type EmailVerificationErrorCode = (typeof EMAIL_VERIFICATION_ERROR_CODES)[keyof typeof EMAIL_VERIFICATION_ERROR_CODES];
