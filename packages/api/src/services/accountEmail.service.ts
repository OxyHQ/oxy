/**
 * Recovery email codes and tickets (ADR 0029 D3).
 *
 * `start` records one `email_verifications` row and — only when there is
 * somewhere legitimate to send it — mails a 6-digit code. Every other case
 * records a DECOY row whose code nobody was sent, and answers identically, so
 * neither purpose tells a caller which emails or usernames have an account:
 *
 * - `signup` for an address that is already an account's recovery email: a
 *   decoy, and a notice to that address pointing at recovery;
 * - `recovery` naming nothing, a managed or archived account, or an account
 *   without a recovery email (a Commons account, which recovers in Commons): a
 *   decoy.
 *
 * Mail is sent after the answer is decided and is not awaited by it, so the
 * response time does not say which case ran. A code is confirmed at most
 * {@link EMAIL_CODE_MAX_ATTEMPTS} times; the right one mints a one-use ticket,
 * stored as its SHA-256, that registration spends in its own transaction.
 */
import crypto from 'node:crypto';
import { and, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  EMAIL_TICKET_TTL_MS,
  EMAIL_VERIFICATION_ERROR_CODES,
  type EmailVerificationConfirmResponse,
  type EmailVerificationPurpose,
  type EmailVerificationStartRequest,
  type EmailVerificationStartResponse,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { emailVerifications } from '../db/schema/emailVerifications';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendAccountExistsNotice, sendVerificationCode } from './accountEmail.mail';
import { SMTP_RELAYS } from '../config/email.config';

/** Codes sent to one address (or asked for one identifier) per hour. */
export const EMAIL_SENDS_PER_HOUR = 5;

function codeInvalid(): ApiError {
  return new ApiError(401, 'That code is not right, or it has expired.', EMAIL_VERIFICATION_ERROR_CODES.codeInvalid);
}

export function ticketInvalid(): ApiError {
  return new ApiError(401, 'This confirmation has expired. Start again.', EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** HMAC of the code under the server salt, bound to its row. */
function hashCode(verificationId: string, code: string): string {
  return crypto
    .createHmac('sha256', process.env.DEVICE_ID_SALT ?? '')
    .update(`email-code|${verificationId}|${code}`)
    .digest('hex');
}

function newCode(): string {
  return crypto.randomInt(0, 10 ** EMAIL_CODE_LENGTH).toString().padStart(EMAIL_CODE_LENGTH, '0');
}

function emailMatches(email: string) {
  return sql`lower(btrim(${users.email})) = lower(btrim(${email}))`;
}

/** What `start` decided, before anything is sent. */
interface Delivery {
  purpose: EmailVerificationPurpose;
  /** The rate-limit and matching key: `hashEmail` of the address (or of the identifier, for a decoy). */
  emailHash: string;
  userId: string | null;
  /** Where the code goes; `null` for a decoy. */
  sendCodeTo: string | null;
  /** A sign-up for an address that already has an account. */
  sendNoticeTo: string | null;
}

async function resolveDelivery(request: EmailVerificationStartRequest): Promise<Delivery> {
  const db = getDb();
  if (request.purpose === 'signup') {
    const [existing] = await db.select({ id: users.id }).from(users).where(emailMatches(request.email)).limit(1);
    return {
      purpose: 'signup',
      emailHash: hashEmail(request.email),
      userId: null,
      sendCodeTo: existing ? null : request.email,
      sendNoticeTo: existing ? request.email : null,
    };
  }

  const identifier = request.identifier.trim();
  const match = identifier.includes('@')
    ? emailMatches(identifier)
    : sql`lower(btrim(${users.username})) = lower(btrim(${identifier}))`;
  const [account] = await db
    .select({ id: users.id, kind: users.kind, email: users.email, publicKey: users.publicKey, accountStatus: users.accountStatus })
    .from(users)
    .where(match)
    .limit(1);
  const email = account?.email?.trim().toLowerCase() || null;
  // A deleted account kept for its financial records (`archived`) is not recovered.
  if (account && email && account.kind === 'personal' && !account.publicKey && account.accountStatus === 'active') {
    return { purpose: 'recovery', emailHash: hashEmail(email), userId: account.id, sendCodeTo: email, sendNoticeTo: null };
  }
  return { purpose: 'recovery', emailHash: hashEmail(identifier), userId: null, sendCodeTo: null, sendNoticeTo: null };
}

/** Hand the mail off without making the caller wait on it. */
function dispatch(delivery: Delivery, code: string): void {
  const send = delivery.sendCodeTo
    ? sendVerificationCode(delivery.sendCodeTo, code, delivery.purpose)
    : delivery.sendNoticeTo
      ? sendAccountExistsNotice(delivery.sendNoticeTo)
      : null;
  send?.catch((error: unknown) => {
    logger.error(
      'Recovery email could not be sent',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'accountEmail', purpose: delivery.purpose },
    );
  });
}

/** 503 when this server has no relay to send mail through. */
export function assertMailConfigured(): void {
  if (SMTP_RELAYS.length === 0) {
    throw new ApiError(503, 'Oxy cannot send email right now. Try again later.', EMAIL_VERIFICATION_ERROR_CODES.unavailable);
  }
}

/** 429 when {@link EMAIL_SENDS_PER_HOUR} codes already went to (or were asked for) `emailHash`. */
export async function assertEmailSendBudget(db: DatabaseOrTransaction, emailHash: string, now: Date): Promise<void> {
  const [recent] = await db
    .select({ value: count() })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.emailHash, emailHash),
        gt(emailVerifications.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    );
  if ((recent?.value ?? 0) >= EMAIL_SENDS_PER_HOUR) {
    throw new ApiError(429, 'Too many codes for this email. Try again in an hour.', 'RATE_LIMITED');
  }
}

/**
 * Record one `email_verifications` row and return its (unsent) code. A decoy
 * is recorded exactly like a real one; only the caller decides whether the
 * code is ever mailed.
 */
export async function recordVerification(
  db: DatabaseOrTransaction,
  row: { purpose: EmailVerificationPurpose; emailHash: string; userId: string | null },
  now: Date,
): Promise<{ verificationId: string; code: string; expiresAt: Date }> {
  const code = newCode();
  const verificationId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
  await db.insert(emailVerifications).values({
    id: verificationId,
    purpose: row.purpose,
    emailHash: row.emailHash,
    userId: row.userId,
    codeHash: hashCode(verificationId, code),
    expiresAt,
  });
  return { verificationId, code, expiresAt };
}

export async function startEmailVerification(
  request: EmailVerificationStartRequest,
  now: Date = new Date(),
): Promise<EmailVerificationStartResponse> {
  assertMailConfigured();
  const delivery = await resolveDelivery(request);
  const db = getDb();
  await assertEmailSendBudget(db, delivery.emailHash, now);

  // A decoy's code is generated and hashed like a real one, and never sent.
  const { verificationId, code, expiresAt } = await recordVerification(db, delivery, now);
  dispatch(delivery, code);
  return { verificationId, expiresAt: expiresAt.getTime() };
}

/**
 * Check `code` against a live, unconfirmed `purpose` row inside `tx`, counting
 * a wrong one. The right one marks the row confirmed, so it is spent. Returns
 * the row's account on success, or the error to throw AFTER the transaction
 * commits (so the wrong attempt counts). A row with no account — a decoy —
 * never succeeds.
 */
export async function consumeEmailCode(
  tx: DatabaseOrTransaction,
  input: { verificationId: string; code: string; purpose: EmailVerificationPurpose; userId?: string },
  now: Date,
): Promise<{ userId: string } | { error: ApiError }> {
  const [row] = await tx
    .select({
      id: emailVerifications.id,
      userId: emailVerifications.userId,
      codeHash: emailVerifications.codeHash,
      attempts: emailVerifications.attempts,
    })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.id, input.verificationId),
        eq(emailVerifications.purpose, input.purpose),
        isNull(emailVerifications.confirmedAt),
        gt(emailVerifications.expiresAt, now),
        ...(input.userId ? [eq(emailVerifications.userId, input.userId)] : []),
      ),
    )
    .for('update')
    .limit(1);
  if (!row) return { error: codeInvalid() };
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { error: tooManyAttempts() };

  const expected = Buffer.from(row.codeHash, 'hex');
  const given = Buffer.from(hashCode(row.id, input.code), 'hex');
  const matches = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!matches || !row.userId) {
    const attempts = row.attempts + 1;
    await tx.update(emailVerifications).set({ attempts }).where(eq(emailVerifications.id, row.id));
    return { error: attempts >= EMAIL_CODE_MAX_ATTEMPTS ? tooManyAttempts() : codeInvalid() };
  }
  await tx
    .update(emailVerifications)
    .set({ attempts: row.attempts + 1, confirmedAt: now })
    .where(eq(emailVerifications.id, row.id));
  return { userId: row.userId };
}

export async function confirmEmailVerification(
  verificationId: string,
  code: string,
  now: Date = new Date(),
): Promise<EmailVerificationConfirmResponse> {
  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + EMAIL_TICKET_TTL_MS);

  const outcome = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: emailVerifications.id,
        purpose: emailVerifications.purpose,
        userId: emailVerifications.userId,
        codeHash: emailVerifications.codeHash,
        attempts: emailVerifications.attempts,
      })
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.id, verificationId),
          // A sign-in or re-verification code is confirmed only by its own route.
          inArray(emailVerifications.purpose, ['signup', 'recovery']),
          isNull(emailVerifications.confirmedAt),
          gt(emailVerifications.expiresAt, now),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) return { error: codeInvalid() };
    if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { error: tooManyAttempts() };

    const expected = Buffer.from(row.codeHash, 'hex');
    const given = Buffer.from(hashCode(row.id, code), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      const attempts = row.attempts + 1;
      await tx.update(emailVerifications).set({ attempts }).where(eq(emailVerifications.id, row.id));
      return { error: attempts >= EMAIL_CODE_MAX_ATTEMPTS ? tooManyAttempts() : codeInvalid() };
    }

    await tx
      .update(emailVerifications)
      .set({ attempts: row.attempts + 1, confirmedAt: now, ticketHash: sha256Hex(ticket), expiresAt })
      .where(eq(emailVerifications.id, row.id));

    let username: string | null = null;
    if (row.purpose === 'recovery' && row.userId) {
      const [account] = await tx.select({ username: users.username }).from(users).where(eq(users.id, row.userId)).limit(1);
      username = account?.username ?? null;
    }
    return { username };
  });

  // A wrong attempt is committed before the error is thrown, so it counts.
  if ('error' in outcome) throw outcome.error;
  return { ticket, expiresAt: expiresAt.getTime(), username: outcome.username };
}

function tooManyAttempts(): ApiError {
  return new ApiError(429, 'Too many wrong codes. Ask for a new one.', EMAIL_VERIFICATION_ERROR_CODES.tooManyAttempts);
}

function liveTicket(ticket: string, purpose: EmailVerificationPurpose, now: Date) {
  return and(
    eq(emailVerifications.ticketHash, sha256Hex(ticket)),
    eq(emailVerifications.purpose, purpose),
    isNull(emailVerifications.usedAt),
    gt(emailVerifications.expiresAt, now),
  );
}

/**
 * Spend a sign-up ticket for `email`, inside the transaction that creates the
 * account — a failed creation rolls the spend back, so the person can retry.
 */
export async function spendSignupTicket(
  tx: DatabaseOrTransaction,
  ticket: string,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  const spent = await tx
    .update(emailVerifications)
    .set({ usedAt: now })
    .where(and(liveTicket(ticket, 'signup', now), eq(emailVerifications.emailHash, hashEmail(email))))
    .returning({ id: emailVerifications.id });
  if (spent.length === 0) throw ticketInvalid();
}

/** The account a live recovery ticket recovers, without spending it (registration options). */
export async function readRecoveryTicket(ticket: string, now: Date = new Date()): Promise<string> {
  const [row] = await getDb()
    .select({ userId: emailVerifications.userId })
    .from(emailVerifications)
    .where(liveTicket(ticket, 'recovery', now))
    .limit(1);
  if (!row?.userId) throw ticketInvalid();
  return row.userId;
}

/** Spend a recovery ticket inside the transaction that adds the new passkey. */
export async function spendRecoveryTicket(tx: DatabaseOrTransaction, ticket: string, now: Date = new Date()): Promise<string> {
  const [row] = await tx
    .update(emailVerifications)
    .set({ usedAt: now })
    .where(liveTicket(ticket, 'recovery', now))
    .returning({ userId: emailVerifications.userId });
  if (!row?.userId) throw ticketInvalid();
  return row.userId;
}
