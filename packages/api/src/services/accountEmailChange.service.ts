/**
 * Adding, changing and removing the email of a signed-in account without a
 * Commons key (ADR 0030). The email is not a profile field: it changes only
 * here, each time with fresh proof.
 *
 * - A new address is proven by a code sent to IT (`email_change`, bound to the
 *   account and that address), and the change by the person's proof
 *   (`reauth.service.ts`, action `change_email`). One address holds at most
 *   `EMAIL_ACCOUNTS_MAX` accounts, serialised per address like a sign-up.
 * - Removing the email needs a password, and is confirmed with it: the
 *   password is then the one way in, and the only way back.
 *
 * Either way every code the old address could still use goes, so a sign-in
 * already mailed there cannot finish.
 */
import { and, count, eq, ne, sql } from 'drizzle-orm';
import {
  EMAIL_ACCOUNTS_MAX,
  SIGN_IN_ERROR_CODES,
  type EmailVerificationStartResponse,
  type ReauthProof,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { emailVerifications } from '../db/schema/emailVerifications';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { ApiError, RateLimitedError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendEmailChangeCode } from './accountEmail.mail';
import {
  assertMailConfigured,
  consumeEmailCode,
  recordVerification,
  reserveSendBudget,
} from './accountEmail.service';
import { readPasswordHash } from './password.service';
import { verifyReauth } from './reauth.service';

function emailUnchanged(): ApiError {
  return new ApiError(
    400,
    'This is already the email of the account.',
    SIGN_IN_ERROR_CODES.emailUnchanged,
  );
}

/** Send a code to `email`, the address the account `userId` moves to. */
export async function startEmailChange(
  account: { userId: string; email: string | null; username: string | null },
  email: string,
  now: Date = new Date(),
): Promise<EmailVerificationStartResponse> {
  assertMailConfigured();
  if (account.email === email) throw emailUnchanged();
  const emailHash = hashEmail(email);
  const budget = await reserveSendBudget({
    group: 'reauth',
    emailHash,
    requesterKey: `u:${account.userId}`,
  });
  if (!budget.reserved) {
    throw new RateLimitedError('Too many codes. Try again later.', {
      retryAfterSeconds: budget.retryAfterSeconds,
    });
  }
  const { verificationId, code, expiresAt } = await recordVerification(
    getDb(),
    { purpose: 'email_change', emailHash, userId: account.userId },
    now,
  );
  sendEmailChangeCode(email, code, account.username).catch((error: unknown) => {
    logger.error(
      'Email change code could not be sent',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'accountEmailChange' },
    );
  });
  return { verificationId, expiresAt: expiresAt.getTime() };
}

/**
 * Make `email` the account's email: its code, then the person's proof, then
 * the address's room for one more account. Throws when any fails.
 */
export async function changeEmail(
  account: { userId: string; email: string | null },
  input: { email: string; verificationId: string; code: string; reauth: ReauthProof },
  now: Date = new Date(),
): Promise<void> {
  if (account.email === input.email) throw emailUnchanged();
  await verifyReauth(account.userId, input.reauth, 'change_email', now);
  const emailHash = hashEmail(input.email);
  const outcome = await getDb().transaction(async (tx) => {
    const consumed = await consumeEmailCode(
      tx,
      {
        verificationId: input.verificationId,
        code: input.code,
        purpose: 'email_change',
        userId: account.userId,
        emailHash,
      },
      now,
    );
    // Returned, not thrown: the wrong attempt it counted must commit.
    if ('error' in consumed) return consumed;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${emailHash}, 0))`);
    const [held] = await tx
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.hashedEmail, emailHash), ne(users.id, account.userId)));
    if ((held?.n ?? 0) >= EMAIL_ACCOUNTS_MAX) {
      throw new ApiError(
        409,
        'This email already holds as many accounts as it can.',
        SIGN_IN_ERROR_CODES.emailAccountsFull,
      );
    }
    await tx.update(users).set({ email: input.email }).where(eq(users.id, account.userId));
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, account.userId));
    return null;
  });
  if (outcome) throw outcome.error;
}

/**
 * Remove the account's email. Only with a password set, and confirmed with
 * that password (plus the authenticator's code when it is on).
 */
export async function removeEmail(
  account: { userId: string; email: string | null },
  reauth: ReauthProof,
  now: Date = new Date(),
): Promise<void> {
  if (!account.email) {
    throw new ApiError(400, 'This account has no email.', SIGN_IN_ERROR_CODES.lastSignInMethod);
  }
  if ((await readPasswordHash(account.userId)) === null) {
    throw new ApiError(
      400,
      'Set a password before removing the email.',
      SIGN_IN_ERROR_CODES.passwordRequired,
    );
  }
  if (reauth.password === undefined) {
    throw new ApiError(401, 'Confirm with your password.', SIGN_IN_ERROR_CODES.passwordRequired);
  }
  await verifyReauth(
    account.userId,
    { password: reauth.password, totpCode: reauth.totpCode },
    'change_email',
    now,
  );
  await getDb().transaction(async (tx) => {
    // The account row is locked, and the password checked again under it, so
    // removing the password at the same moment cannot leave no way in.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, account.userId)).for('update');
    if ((await readPasswordHash(account.userId, tx)) === null) {
      throw new ApiError(
        400,
        'Set a password before removing the email.',
        SIGN_IN_ERROR_CODES.passwordRequired,
      );
    }
    await tx.update(users).set({ email: null }).where(eq(users.id, account.userId));
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, account.userId));
  });
}
