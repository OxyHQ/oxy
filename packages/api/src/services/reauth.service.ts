/**
 * Fresh proof that the PERSON, not only their session, asks for a sensitive
 * change: setting a password, turning the authenticator on or off, new backup
 * codes, linking Commons, deleting the account.
 *
 * The proof travels inside the request it authorises (`reauth` in the body),
 * so "recent" means "now": the current password, or a code just sent to the
 * account's email (`POST /users/me/reauth/email`, purpose `reauth`, bound to
 * the account and spent by the check) — and, when the account has an
 * authenticator, its code too. A session thief without the mailbox, the
 * password or the phone gets nothing from these routes.
 *
 * Passwords here count against the same per-account lockout as sign-in, and
 * authenticator codes against the authenticator's.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  type EmailReauthProof,
  type EmailVerificationStartResponse,
  type ReauthProof,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { ApiError, BadRequestError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendReauthCode } from './accountEmail.mail';
import { assertEmailSendBudget, assertMailConfigured, consumeEmailCode, recordVerification } from './accountEmail.service';
import { clearFailures, isLockedOut, recordFailure } from './loginLockout.service';
import { readPasswordHash, verifyPasswordOrDummy } from './password.service';
import { isTotpEnabled, verifySecondFactor } from './totp.service';

/** Lockout scope shared by password sign-in and password re-verification. */
export const PASSWORD_LOCKOUT_SCOPE = 'password';

/** The lockout key of an account: never the username or email in the clear. */
export function accountLockoutKey(userId: string): string {
  return `u:${userId}`;
}

/** The lockout key for an identifier that names no account. */
export function identifierLockoutKey(identifier: string): string {
  return `i:${crypto
    .createHmac('sha256', process.env.DEVICE_ID_SALT ?? '')
    .update(`lockout|${identifier.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function reauthInvalid(): ApiError {
  return new ApiError(401, 'That confirmation is not right.', SIGN_IN_ERROR_CODES.reauthInvalid);
}

function lockedOut(retryAfterSeconds?: number): ApiError {
  return new ApiError(
    429,
    'Too many wrong attempts. Try again later.',
    SIGN_IN_ERROR_CODES.locked,
    retryAfterSeconds ? { retryAfterSeconds } : undefined,
  );
}

async function accountEmail(userId: string): Promise<{ email: string | null; username: string | null }> {
  const [row] = await getDb()
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { email: row?.email?.trim().toLowerCase() || null, username: row?.username ?? null };
}

/** Send a confirmation code to the signed-in account's own email. */
export async function startReauthEmail(userId: string, now: Date = new Date()): Promise<EmailVerificationStartResponse> {
  assertMailConfigured();
  const { email, username } = await accountEmail(userId);
  if (!email) {
    throw new BadRequestError('This account has no email to send a code to');
  }
  const db = getDb();
  const emailHash = hashEmail(email);
  await assertEmailSendBudget(db, emailHash, now);
  const { verificationId, code, expiresAt } = await recordVerification(db, { purpose: 'reauth', emailHash, userId }, now);
  sendReauthCode(email, code, username).catch((error: unknown) => {
    logger.error('Confirmation email could not be sent', error instanceof Error ? error : new Error(String(error)), {
      component: 'reauth',
    });
  });
  return { verificationId, expiresAt: expiresAt.getTime() };
}

async function checkEmailCode(userId: string, emailCode: { verificationId: string; code: string }, now: Date): Promise<void> {
  const outcome = await getDb().transaction((tx) =>
    consumeEmailCode(tx, { ...emailCode, purpose: 'reauth', userId }, now),
  );
  if ('error' in outcome) throw outcome.error;
}

async function checkPassword(userId: string, password: string): Promise<void> {
  const key = accountLockoutKey(userId);
  const lockout = await isLockedOut({ scope: PASSWORD_LOCKOUT_SCOPE, identifier: key });
  if (lockout.locked) throw lockedOut(lockout.retryAfterSeconds);
  const ok = await verifyPasswordOrDummy(password, await readPasswordHash(userId));
  if (!ok) {
    const after = await recordFailure({ scope: PASSWORD_LOCKOUT_SCOPE, identifier: key });
    if (after.locked) throw lockedOut(after.retryAfterSeconds);
    throw reauthInvalid();
  }
  await clearFailures({ scope: PASSWORD_LOCKOUT_SCOPE, identifier: key });
}

async function checkTotp(userId: string, totpCode: string | undefined, now: Date): Promise<void> {
  if (!(await isTotpEnabled(userId))) return;
  if (!totpCode) {
    throw new ApiError(401, 'Enter the code from your authenticator app too.', SIGN_IN_ERROR_CODES.totpRequired);
  }
  if (!(await verifySecondFactor(userId, totpCode, now))) throw reauthInvalid();
}

/**
 * Check a {@link ReauthProof} for `userId`: the password or the email code,
 * then the authenticator code when the account has one. Throws when it fails;
 * every code it accepts is spent.
 */
export async function verifyReauth(userId: string, proof: ReauthProof | undefined, now: Date = new Date()): Promise<void> {
  if (!proof) {
    throw new ApiError(401, 'Confirm it is you first.', SIGN_IN_ERROR_CODES.reauthRequired);
  }
  // Asked first so a missing authenticator code never burns the email code.
  if (!proof.totpCode && (await isTotpEnabled(userId))) {
    throw new ApiError(401, 'Enter the code from your authenticator app too.', SIGN_IN_ERROR_CODES.totpRequired);
  }
  if (proof.emailCode) {
    await checkEmailCode(userId, proof.emailCode, now);
  } else if (proof.password !== undefined) {
    await checkPassword(userId, proof.password);
  } else {
    throw new ApiError(401, 'Confirm it is you first.', SIGN_IN_ERROR_CODES.reauthRequired);
  }
  await checkTotp(userId, proof.totpCode, now);
}

/** The email-only proof (deleting the account, linking Commons): the email code, plus the authenticator's. */
export async function verifyEmailReauth(userId: string, proof: EmailReauthProof, now: Date = new Date()): Promise<void> {
  await verifyReauth(userId, { emailCode: proof.emailCode, totpCode: proof.totpCode }, now);
}
