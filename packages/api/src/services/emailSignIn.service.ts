/**
 * Signing in with an email: one message carries a 6-digit code and a one-use
 * link to auth.oxy.so; either signs the person in.
 *
 * `start` answers the same for every identifier — an account that can sign in
 * this way (personal, active, with an email and no Commons key), one that
 * cannot, or none at all — and does the same work: it resolves the account,
 * checks the per-address send budget, proves the requester's device, and
 * writes one `email_verifications` row and one `email_signin_requests` row.
 * Only a real account is mailed, after the answer is decided and without
 * waiting on the relay. A decoy's code and link exist, were never sent, and can
 * never succeed.
 *
 * Who gets the session:
 *
 * - The code is confirmed by the caller that holds the request's
 *   `requestSecret` — only the dialog that asked was given it.
 * - The link does not sign in whoever opens it. auth.oxy.so proves its own
 *   credential for the browser's shared device, and the request is APPROVED
 *   only when that is the device the dialog proved at `start` (the same
 *   browser); the dialog then collects the session with its `requestSecret`
 *   and, again, that same device. A link requested for someone else's email and
 *   opened by its owner therefore approves nothing for the requester, and the
 *   owner's click never hands a session to the page that opened.
 *
 * Every spend is one conditional update filtered on expiry, so a code, a link
 * or an approval signs in at most once.
 */
import crypto from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  EMAIL_SIGNIN_LINK_TTL_MS,
  SIGN_IN_ERROR_CODES,
  normalizeEmailSignInCode,
  type EmailSignInPending,
  type EmailSignInStartRequest,
  type EmailSignInStartResponse,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { emailSignInRequests } from '../db/schema/emailSignInRequests';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendSignInEmail } from './accountEmail.mail';
import { assertMailConfigured, consumeEmailCode, recordVerification, reserveSendBudget } from './accountEmail.service';
import { clearFailures, isLockedOut, reserveAttempt } from './loginLockout.service';
import { resolveProvenDevice, resolveProvenDeviceId } from './deviceJoin.service';
import { SERVER_KEY_LABELS, serverHmacHex } from '../utils/serverKey';
import { normalizeSignInIdentifier } from '../utils/signInIdentifier';

/** Code attempts one requester gets per account per day, across its sign-in requests. */
export const SIGNIN_CODE_FAILURES_PER_DAY = 10;
/** 6-digit code attempts one account gets per day from every requester together (see `confirmEmailSignIn`). */
export const SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY = 50;
const SIGNIN_CODE_REQUESTER_SCOPE = 'signin-code-requester';
const SIGNIN_CODE_ACCOUNT_SCOPE = 'signin-code-account';

/** The per-account daily ceiling on sign-in code attempts, as a lockout. */
function accountCeiling(accountKey: string) {
  return {
    scope: SIGNIN_CODE_ACCOUNT_SCOPE,
    identifier: accountKey,
    maxAttempts: SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY,
    windowSeconds: 24 * 60 * 60,
  };
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashesEqual(storedHex: string, candidate: string): boolean {
  const expected = Buffer.from(storedHex, 'hex');
  const given = Buffer.from(sha256Hex(candidate), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function requestInvalid(): ApiError {
  return new ApiError(401, 'This sign-in expired or was already used. Start again.', SIGN_IN_ERROR_CODES.requestInvalid);
}

function linkInvalid(): ApiError {
  return new ApiError(401, 'This link expired or was already used.', SIGN_IN_ERROR_CODES.linkInvalid);
}

function linkOtherDevice(): ApiError {
  return new ApiError(
    403,
    'This link only works in the browser where you asked to sign in. Enter the code from the email in the app instead.',
    SIGN_IN_ERROR_CODES.linkOtherDevice,
  );
}

interface SignInTarget {
  userId: string | null;
  /** The per-address rate-limit key. */
  emailHash: string;
  sendTo: string | null;
  username: string | null;
}

async function resolveTarget(identifier: string): Promise<SignInTarget> {
  const trimmed = identifier.trim();
  // One normalisation for the match and every key (`utils/signInIdentifier.ts`);
  // outside it the same query runs against a value nothing matches: a decoy.
  const lookup = normalizeSignInIdentifier(identifier) ?? '';
  const match = lookup.includes('@')
    ? sql`lower(btrim(${users.email})) = ${lookup}`
    : sql`lower(btrim(${users.username})) = ${lookup}`;
  const [account] = await getDb()
    .select({
      id: users.id,
      username: users.username,
      kind: users.kind,
      email: users.email,
      publicKey: users.publicKey,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(match)
    .limit(1);
  const email = account?.email?.trim().toLowerCase() || null;
  // A Commons account signs in with Commons: linking deleted its email, and one
  // that still has an address is not signed in through it either.
  if (account && email && account.kind === 'personal' && !account.publicKey && account.accountStatus === 'active') {
    return { userId: account.id, emailHash: hashEmail(email), sendTo: email, username: account.username };
  }
  return { userId: null, emailHash: hashEmail(trimmed), sendTo: null, username: null };
}

export async function startEmailSignIn(
  request: EmailSignInStartRequest,
  requesterKey: string,
  now: Date = new Date(),
): Promise<EmailSignInStartResponse> {
  assertMailConfigured();
  let target = await resolveTarget(request.identifier);
  const provenDevice = await resolveProvenDevice(request.device);
  const requesterDeviceId = provenDevice?.deviceId ?? null;
  // A device this account is already signed in on: it may use the budget's
  // reserved slice, and only it is ever told the mail could not go.
  const knownDevice = Boolean(target.userId && provenDevice?.accountIds.includes(target.userId));
  const db = getDb();
  // An account whose codes were guessed at too often today gets the long code
  // for the rest of the day: its owner can still type it, nobody can guess it.
  // (Decided for real and decoy targets alike; the answer never says which.)
  const longCode = target.userId ? (await isLockedOut(accountCeiling(target.userId))).locked : false;
  // Over the send budget: answered like any other request, as a decoy that
  // sends nothing — the budget is never visible (`reserveSendBudget`).
  let retryLater = false;
  if (!(await reserveSendBudget({ group: 'public', emailHash: target.emailHash, requesterKey, knownDevice }))) {
    retryLater = knownDevice;
    target = { ...target, userId: null, sendTo: null };
  }

  const requestSecret = newToken();
  const linkToken = newToken();
  const linkExpiresAt = new Date(now.getTime() + EMAIL_SIGNIN_LINK_TTL_MS);
  const { requestId, code, expiresAt } = await db.transaction(async (tx) => {
    const verification = await recordVerification(
      tx,
      { purpose: 'signin', emailHash: target.emailHash, userId: target.userId, longCode },
      now,
    );
    const [row] = await tx
      .insert(emailSignInRequests)
      .values({
        verificationId: verification.verificationId,
        userId: target.userId,
        requestSecretHash: sha256Hex(requestSecret),
        linkTokenHash: sha256Hex(linkToken),
        requesterDeviceId,
        longCode,
        expiresAt: linkExpiresAt,
      })
      .returning({ id: emailSignInRequests.id });
    return { requestId: row.id, code: verification.code, expiresAt: verification.expiresAt };
  });

  if (target.sendTo) {
    const shown = longCode ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
    sendSignInEmail(target.sendTo, { code: shown, linkToken, username: target.username }).catch((error: unknown) => {
      logger.error('Sign-in email could not be sent', error instanceof Error ? error : new Error(String(error)), {
        component: 'emailSignIn',
      });
    });
  }
  return { requestId, requestSecret, expiresAt: expiresAt.getTime(), ...(retryLater ? { retryLater: true as const } : {}) };
}

/**
 * The code, from the dialog that holds `requestSecret`. Spends the request and
 * the code; returns the account to finish signing in. A wrong code counts
 * against the code's attempts (committed before the error is thrown).
 */
export async function confirmEmailSignIn(
  input: {
    requestId: string;
    requestSecret: string;
    code: string;
    requesterKey: string;
    device?: { deviceId: string; deviceSecret: string };
  },
  now: Date = new Date(),
): Promise<string> {
  const provenDevice = await resolveProvenDevice(input.device);
  const outcome = await getDb().transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: emailSignInRequests.id,
        verificationId: emailSignInRequests.verificationId,
        userId: emailSignInRequests.userId,
        requestSecretHash: emailSignInRequests.requestSecretHash,
        longCode: emailSignInRequests.longCode,
      })
      .from(emailSignInRequests)
      .where(
        and(
          eq(emailSignInRequests.id, input.requestId),
          isNull(emailSignInRequests.completedAt),
          gt(emailSignInRequests.expiresAt, now),
        ),
      )
      .for('update')
      .limit(1);
    if (!request || !hashesEqual(request.requestSecretHash, input.requestSecret)) {
      return { error: requestInvalid() };
    }
    // Code attempts across requests, reserved atomically before the check:
    // - per (account, requester): SIGNIN_CODE_FAILURES_PER_DAY — the strict
    //   cap. The requester is the hashed IP, kept only in the lockout store
    //   (Redis / memory), never persisted; a right code resets it;
    // - per account: SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY across every
    //   requester. It is NOT reset by a right code and nobody is exempt by IP
    //   (an attacker can start requests from any number of addresses). Past
    //   it, a 6-digit code is refused with the same generic error unless the
    //   request comes from a device the account is already signed in on; and
    //   every NEW email for the account that day carries the long code
    //   (`startEmailSignIn`), which the ceiling does not apply to — so the
    //   owner can still sign in by code while guessing is infeasible. The link
    //   (which needs the requester's own browser) keeps working throughout.
    // A decoy counts on keys of its own.
    const accountKey = request.userId ?? `request:${request.id}`;
    const requesterBucket = serverHmacHex(SERVER_KEY_LABELS.lockoutIdentifier, `${accountKey}|${input.requesterKey}`);
    const perRequester = await reserveAttempt({
      scope: SIGNIN_CODE_REQUESTER_SCOPE,
      identifier: requesterBucket,
      maxAttempts: SIGNIN_CODE_FAILURES_PER_DAY,
      windowSeconds: 24 * 60 * 60,
    });
    const perAccount = await reserveAttempt(accountCeiling(accountKey));
    const exempt = request.longCode || Boolean(request.userId && provenDevice?.accountIds.includes(request.userId));
    const refuse = perRequester.locked || (perAccount.locked && !exempt);
    const checked = await consumeEmailCode(
      tx,
      { verificationId: request.verificationId, code: normalizeEmailSignInCode(input.code), purpose: 'signin', refuse },
      now,
    );
    if ('error' in checked) return checked;
    await clearFailures({ scope: SIGNIN_CODE_REQUESTER_SCOPE, identifier: requesterBucket });
    if (!request.userId || checked.userId !== request.userId) return { error: requestInvalid() };
    await tx.update(emailSignInRequests).set({ completedAt: now }).where(eq(emailSignInRequests.id, request.id));
    return { userId: request.userId };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.userId;
}

/**
 * The email's link, opened on auth.oxy.so. Approves the request only when
 * auth.oxy.so proves the device the dialog proved at `start`; the approval is
 * collected by the dialog, never returned here. A link opened elsewhere is
 * refused and stays usable in the right browser.
 */
export async function approveEmailSignInLink(
  input: { token: string; device: { deviceId: string; deviceSecret: string } },
  now: Date = new Date(),
): Promise<void> {
  const provenDeviceId = await resolveProvenDeviceId(input.device);
  const db = getDb();
  const [request] = await db
    .select({ id: emailSignInRequests.id, requesterDeviceId: emailSignInRequests.requesterDeviceId })
    .from(emailSignInRequests)
    .where(
      and(
        eq(emailSignInRequests.linkTokenHash, sha256Hex(input.token)),
        isNotNull(emailSignInRequests.userId),
        isNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .limit(1);
  if (!request) throw linkInvalid();
  if (!request.requesterDeviceId || !provenDeviceId || provenDeviceId !== request.requesterDeviceId) {
    throw linkOtherDevice();
  }
  const approved = await db
    .update(emailSignInRequests)
    .set({ approvedAt: now })
    .where(
      and(
        eq(emailSignInRequests.id, request.id),
        isNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .returning({ id: emailSignInRequests.id });
  if (approved.length === 0) throw linkInvalid();
}

/**
 * The dialog asks whether its link was opened. Pending until it was; then the
 * request is spent and the account returned — only to the holder of
 * `requestSecret`, and only with the device proof the request was made with.
 */
export async function collectEmailSignIn(
  input: { requestId: string; requestSecret: string; device?: { deviceId: string; deviceSecret: string } },
  now: Date = new Date(),
): Promise<{ userId: string; provenDeviceId: string } | EmailSignInPending> {
  const provenDeviceId = await resolveProvenDeviceId(input.device);
  const db = getDb();
  const [request] = await db
    .select({
      id: emailSignInRequests.id,
      userId: emailSignInRequests.userId,
      requestSecretHash: emailSignInRequests.requestSecretHash,
      requesterDeviceId: emailSignInRequests.requesterDeviceId,
      approvedAt: emailSignInRequests.approvedAt,
      expiresAt: emailSignInRequests.expiresAt,
    })
    .from(emailSignInRequests)
    .where(
      and(
        eq(emailSignInRequests.id, input.requestId),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .limit(1);
  if (!request || !hashesEqual(request.requestSecretHash, input.requestSecret)) throw requestInvalid();
  if (!request.approvedAt || !request.userId || !request.requesterDeviceId) {
    return { status: 'pending', expiresAt: request.expiresAt.getTime() };
  }
  if (provenDeviceId !== request.requesterDeviceId) throw requestInvalid();

  const spent = await db
    .update(emailSignInRequests)
    .set({ completedAt: now })
    .where(
      and(
        eq(emailSignInRequests.id, request.id),
        isNotNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .returning({ id: emailSignInRequests.id });
  if (spent.length === 0) throw requestInvalid();
  return { userId: request.userId, provenDeviceId };
}
