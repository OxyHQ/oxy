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
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  EMAIL_TICKET_TTL_MS,
  EMAIL_VERIFICATION_ERROR_CODES,
  SIGN_IN_ERROR_CODES,
  type EmailVerificationConfirmResponse,
  type EmailVerificationPurpose,
  type EmailVerificationStartRequest,
  type EmailVerificationStartResponse,
  type ReauthAction,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { emailVerifications } from '../db/schema/emailVerifications';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { SERVER_KEY_LABELS, serverHmacHex } from '../utils/serverKey';
import { normalizeSignInIdentifier } from '../utils/signInIdentifier';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendAccountExistsNotice, sendVerificationCode } from './accountEmail.mail';
import { reserveAttempt } from './loginLockout.service';
import { isTotpEnabled, verifySecondFactor } from './totp.service';
import { SMTP_RELAYS } from '../config/email.config';

/** Mails one requester (hashed IP) may cause to one address per hour. */
export const EMAIL_SENDS_PER_HOUR = 5;
/** Mails one address receives per hour from every requester together. */
export const EMAIL_SENDS_PER_ADDRESS_PER_HOUR = 10;
/**
 * A further slice per address and hour kept for requests that PROVE a device
 * the account is already on — so strangers exhausting the address's budget
 * cannot stop its owner's sign-in mail from their own browser.
 */
export const EMAIL_SENDS_RESERVED_FOR_KNOWN_DEVICE = 5;
/** Confirmation codes one signed-in account may ask for per hour. */
export const REAUTH_SENDS_PER_HOUR = 10;

/**
 * The separate send budgets: nothing a signed-out caller does can use up the
 * codes a signed-in person needs to confirm a change.
 */
export type SendBudgetGroup = 'public' | 'reauth';

function codeInvalid(): ApiError {
  return new ApiError(401, 'That code is not right, or it has expired.', EMAIL_VERIFICATION_ERROR_CODES.codeInvalid);
}

export function ticketInvalid(): ApiError {
  return new ApiError(401, 'This confirmation has expired. Start again.', EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** HMAC of the code under a key derived from the server secret, bound to its row. Fails closed. */
function hashCode(verificationId: string, code: string): string {
  return serverHmacHex(SERVER_KEY_LABELS.emailCode, `email-code|${verificationId}|${code}`);
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
  // The one sign-in normalisation (`utils/signInIdentifier.ts`); outside it a decoy.
  const lookup = normalizeSignInIdentifier(identifier) ?? '';
  const match = lookup.includes('@')
    ? sql`lower(btrim(${users.email})) = ${lookup}`
    : sql`lower(btrim(${users.username})) = ${lookup}`;
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

/**
 * Reserve one mail to `emailHash` for `requesterKey` (a hashed IP, or the
 * signed-in account). Atomic (`reserveAttempt`: Redis `INCR`), counted per
 * requester AND per address, per budget group. Answers whether the mail may
 * go; the caller NEVER tells its caller which it was — an over-budget request
 * is answered exactly like any other and simply sends nothing, so the budget
 * is neither an enumeration oracle nor a switch a stranger can flip to stop
 * someone's mail (one requester exhausts only its own slice).
 */
export async function reserveSendBudget(input: {
  group: SendBudgetGroup;
  emailHash: string;
  requesterKey: string;
  /** The request proved a device this account is already signed in on. */
  knownDevice?: boolean;
}): Promise<boolean> {
  const address = serverHmacHex(SERVER_KEY_LABELS.mailBudget, `${input.group}|${input.emailHash}`);
  const perRequester = await reserveAttempt({
    scope: `mail-requester-${input.group}`,
    identifier: serverHmacHex(SERVER_KEY_LABELS.mailBudget, `${address}|${input.requesterKey}`),
    maxAttempts: input.group === 'reauth' ? REAUTH_SENDS_PER_HOUR : EMAIL_SENDS_PER_HOUR,
    windowSeconds: 60 * 60,
  });
  if (perRequester.locked) return false;
  const perAddress = await reserveAttempt({
    scope: `mail-address-${input.group}`,
    identifier: address,
    maxAttempts: EMAIL_SENDS_PER_ADDRESS_PER_HOUR,
    windowSeconds: 60 * 60,
  });
  if (!perAddress.locked) return true;
  if (!input.knownDevice) return false;
  const reserved = await reserveAttempt({
    scope: `mail-address-known-device-${input.group}`,
    identifier: address,
    maxAttempts: EMAIL_SENDS_RESERVED_FOR_KNOWN_DEVICE,
    windowSeconds: 60 * 60,
  });
  return !reserved.locked;
}

/**
 * Record one `email_verifications` row and return its (unsent) code. A decoy
 * is recorded exactly like a real one; only the caller decides whether the
 * code is ever mailed.
 */
export async function recordVerification(
  db: DatabaseOrTransaction,
  row: { purpose: EmailVerificationPurpose; emailHash: string; userId: string | null; reauthAction?: ReauthAction },
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
    reauthAction: row.purpose === 'reauth' ? (row.reauthAction ?? null) : null,
    codeHash: hashCode(verificationId, code),
    expiresAt,
  });
  return { verificationId, code, expiresAt };
}

export async function startEmailVerification(
  request: EmailVerificationStartRequest,
  requesterKey: string,
  now: Date = new Date(),
): Promise<EmailVerificationStartResponse> {
  assertMailConfigured();
  let delivery = await resolveDelivery(request);
  const db = getDb();
  if (!(await reserveSendBudget({ group: 'public', emailHash: delivery.emailHash, requesterKey }))) {
    // Over budget: the same answer, a decoy row, and nothing sent.
    delivery = { ...delivery, userId: null, sendCodeTo: null, sendNoticeTo: null };
  }

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
  input: {
    verificationId: string;
    code: string;
    purpose: EmailVerificationPurpose;
    userId?: string;
    /** `reauth`: the change this code must have been asked for. */
    reauthAction?: ReauthAction;
    /** Refuse even the right code (a cap was reached), counting it like a wrong one. */
    refuse?: boolean;
  },
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
        // A re-verification code confirms only the change it was asked for.
        ...(input.purpose === 'reauth'
          ? [input.reauthAction ? eq(emailVerifications.reauthAction, input.reauthAction) : sql`false`]
          : []),
      ),
    )
    .for('update')
    .limit(1);
  if (!row) return { error: codeInvalid() };
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { error: tooManyAttempts() };

  const expected = Buffer.from(row.codeHash, 'hex');
  const given = Buffer.from(hashCode(row.id, input.code), 'hex');
  const matches = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!matches || !row.userId || input.refuse) {
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

/**
 * Confirm a sign-up or recovery code into a one-use ticket.
 *
 * A RECOVERY of an account with an authenticator also needs its code (or a
 * backup code): a recovery ticket adds a passkey and signs in, so the email
 * alone must not be enough to get past the second factor. Without one the
 * answer is `TOTP_REQUIRED` and nothing is spent; a wrong one counts against
 * the row's attempts and the authenticator's lockout.
 */
export async function confirmEmailVerification(
  verificationId: string,
  code: string,
  now: Date = new Date(),
  totpCode?: string,
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

    if (row.purpose === 'recovery' && row.userId && (await isTotpEnabled(row.userId))) {
      if (!totpCode) {
        return { error: new ApiError(401, 'Enter the code from your authenticator app too.', SIGN_IN_ERROR_CODES.totpRequired) };
      }
      if (!(await verifySecondFactor(row.userId, totpCode, now))) {
        const attempts = row.attempts + 1;
        await tx.update(emailVerifications).set({ attempts }).where(eq(emailVerifications.id, row.id));
        return {
          error: new ApiError(401, 'That authenticator code is not right.', SIGN_IN_ERROR_CODES.secondFactorInvalid),
        };
      }
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
