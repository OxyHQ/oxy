import { integerCheck } from './numberChecks';
import { utf16MaxLength, utf16MinLength } from './stringChecks';
/**
 * Email codes and tickets (ADR 0030).
 *
 * A web account is a username and an email; a password and an authenticator
 * app are optional and added later. The email is proven by a 6-digit code sent
 * to it, and the proof is a short-lived one-use ticket the next step spends:
 *
 * - `signup`: the ticket lets `POST /auth/signup` create the account with that
 *   email. `start` answers the same whether or not the address already has an
 *   account, so it never tells anyone which emails have an Oxy account.
 *
 * Signing in by email (`signin`) and re-verifying before a sensitive change
 * (`reauth`) use the same code, through their own routes (`signIn.ts`).
 */
import { z } from '@oxy.so/zod4';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import { EMAIL_CODE_LENGTH } from './client/accountEmail';
export {
  EMAIL_VERIFICATION_PURPOSES,
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_TTL_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_TICKET_TTL_MS,
  EMAIL_VERIFICATION_ERROR_CODES,
} from './client/accountEmail';
export type { EmailVerificationPurpose, EmailVerificationErrorCode } from './client/accountEmail';

/** An email address as the API stores it: trimmed and lowercase. */
export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .check(utf16MinLength(3))
  .check(utf16MaxLength(254))
  .email();

/** An opaque one-use ticket (32 random bytes, base64url). */
export const emailTicketSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'ticket must be 32 bytes of base64url');

/** `POST /auth/email/verify/start` */
export const emailVerificationStartRequestSchema = z
  .object({ purpose: z.literal('signup'), email: emailAddressSchema })
  .strict();
export type EmailVerificationStartRequest = z.infer<typeof emailVerificationStartRequestSchema>;

export interface EmailVerificationStartResponse {
  /** Names this verification in `confirm`. Returned whether or not a code was sent. */
  verificationId: string;
  /** Unix milliseconds after which the code is refused. */
  expiresAt: number;
}

export const emailVerificationStartResponseSchema: z.ZodType<EmailVerificationStartResponse> =
  z.object({
    verificationId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
    expiresAt: z.number().check(integerCheck()).positive(),
  });

/** `POST /auth/email/verify/confirm` */
export const emailVerificationConfirmRequestSchema = z
  .object({
    verificationId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
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
}

export const emailVerificationConfirmResponseSchema: z.ZodType<EmailVerificationConfirmResponse> =
  z.object({
    ticket: emailTicketSchema,
    expiresAt: z.number().check(integerCheck()).positive(),
  });
