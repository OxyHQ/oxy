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
import { assertEmailSendBudget, assertMailConfigured, consumeEmailCode, recordVerification } from './accountEmail.service';
import { resolveProvenDeviceId } from './deviceJoin.service';

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
  const match = trimmed.includes('@')
    ? sql`lower(btrim(${users.email})) = lower(btrim(${trimmed}))`
    : sql`lower(btrim(${users.username})) = lower(btrim(${trimmed}))`;
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
  now: Date = new Date(),
): Promise<EmailSignInStartResponse> {
  assertMailConfigured();
  const target = await resolveTarget(request.identifier);
  const requesterDeviceId = await resolveProvenDeviceId(request.device);
  const db = getDb();
  await assertEmailSendBudget(db, target.emailHash, now);

  const requestSecret = newToken();
  const linkToken = newToken();
  const linkExpiresAt = new Date(now.getTime() + EMAIL_SIGNIN_LINK_TTL_MS);
  const { requestId, code, expiresAt } = await db.transaction(async (tx) => {
    const verification = await recordVerification(tx, { purpose: 'signin', emailHash: target.emailHash, userId: target.userId }, now);
    const [row] = await tx
      .insert(emailSignInRequests)
      .values({
        verificationId: verification.verificationId,
        userId: target.userId,
        requestSecretHash: sha256Hex(requestSecret),
        linkTokenHash: sha256Hex(linkToken),
        requesterDeviceId,
        expiresAt: linkExpiresAt,
      })
      .returning({ id: emailSignInRequests.id });
    return { requestId: row.id, code: verification.code, expiresAt: verification.expiresAt };
  });

  if (target.sendTo) {
    sendSignInEmail(target.sendTo, { code, linkToken, username: target.username }).catch((error: unknown) => {
      logger.error('Sign-in email could not be sent', error instanceof Error ? error : new Error(String(error)), {
        component: 'emailSignIn',
      });
    });
  }
  return { requestId, requestSecret, expiresAt: expiresAt.getTime() };
}

/**
 * The code, from the dialog that holds `requestSecret`. Spends the request and
 * the code; returns the account to finish signing in. A wrong code counts
 * against the code's attempts (committed before the error is thrown).
 */
export async function confirmEmailSignIn(
  input: { requestId: string; requestSecret: string; code: string },
  now: Date = new Date(),
): Promise<string> {
  const outcome = await getDb().transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: emailSignInRequests.id,
        verificationId: emailSignInRequests.verificationId,
        userId: emailSignInRequests.userId,
        requestSecretHash: emailSignInRequests.requestSecretHash,
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
    const checked = await consumeEmailCode(
      tx,
      { verificationId: request.verificationId, code: input.code, purpose: 'signin' },
      now,
    );
    if ('error' in checked) return checked;
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
