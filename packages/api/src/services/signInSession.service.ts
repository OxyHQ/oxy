/**
 * The one tail every sign-in without a passkey ends in (email code, email
 * link, password, second factor, sign-up), and the gate between a first factor
 * and the session.
 *
 * - {@link completeFirstFactor}: the first factor passed. An account with an
 *   authenticator gets a one-use second-factor challenge and NO session; any
 *   other account gets its session.
 * - {@link completeSecondFactor}: the challenge and a code from the
 *   authenticator (or a backup code) → the session.
 * - {@link mintSignInSession}: the session itself — on the browser's shared
 *   device when the request PROVES it (ADR 0029 D2; the id is the server's own
 *   lookup of the presented secret, never a value read from the body), then
 *   `finalizeDeviceLogin`, then the bound access token. The same `AuthSuccess`
 *   shape as every other sign-in.
 *
 * Nothing here issues a session for an account with an authenticator except
 * {@link completeSecondFactor}, after the code passed.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS,
  SIGNIN_SECOND_FACTOR_TTL_MS,
  type DeviceProof,
  type LoginResult,
  type SecondFactorRequired,
} from '@oxy.so/contracts';
import { buildSessionAuthResponse, sessionCreateOptionsFromBody } from '../controllers/session.controller';
import { getDb } from '../config/postgres';
import { signInSecondFactorChallenges } from '../db/schema/signInChallenges';
import { users } from '../db/schema/users';
import { ApiError, InternalServerError } from '../utils/error';
import { logger } from '../utils/logger';
import { resolveProvenDeviceId } from './deviceJoin.service';
import { finalizeDeviceLogin } from './deviceLogin.service';
import securityActivityService from './securityActivityService';
import sessionService from './session.service';
import { isTotpEnabled, verifySecondFactor } from './totp.service';

/** The device-session fields a sign-in body may carry. */
export interface SignInEnvelope {
  deviceName?: string;
  deviceFingerprint?: string;
  device?: DeviceProof;
}

/** The `users` columns a session mint reads. */
export interface SignInAccount {
  id: string;
  username: string | null;
  avatar: string | null;
}

interface MintedSession {
  sessionId: string;
  deviceId: string;
  expiresAt: Date;
  accessToken?: string;
  deviceName?: string | null;
  deviceType?: string | null;
  platform?: string | null;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function secondFactorInvalid(): ApiError {
  return new ApiError(401, 'That code is not right, or this sign-in expired. Start again.', SIGN_IN_ERROR_CODES.secondFactorInvalid);
}

/**
 * Create the session for `account`. `provenDeviceId` is passed when the caller
 * already resolved the proof (it must be the server's own lookup).
 */
export async function mintSignInSession(
  req: Request,
  account: SignInAccount,
  envelope: SignInEnvelope,
  provenDeviceId?: string | null,
): Promise<LoginResult> {
  const deviceId = provenDeviceId === undefined ? await resolveProvenDeviceId(envelope.device) : provenDeviceId;
  const session: MintedSession = await sessionService.createSession(account.id, req, {
    ...sessionCreateOptionsFromBody(envelope),
    ...(deviceId ? { deviceId } : {}),
  });

  const baseResponse = buildSessionAuthResponse(session, {
    _id: account.id,
    username: account.username ?? undefined,
    avatar: account.avatar ?? undefined,
  });
  if (!baseResponse) {
    throw new InternalServerError('Failed to format user data');
  }
  const response: LoginResult = baseResponse;

  const deviceExtras = await finalizeDeviceLogin({ session, userId: account.id });
  if (deviceExtras.deviceSecret) {
    response.deviceSecret = deviceExtras.deviceSecret;
  }
  // Finalization binds the session to its device context; mint only afterwards.
  const boundToken = await sessionService.getAccessToken(session.sessionId);
  if (!boundToken) {
    throw new InternalServerError('Failed to mint the bound access token');
  }
  response.accessToken = boundToken.accessToken;
  response.expiresAt = boundToken.expiresAt.toISOString();

  try {
    await securityActivityService.logSignIn(account.id, req, session.deviceId, {
      deviceName: envelope.deviceName || session.deviceName || undefined,
      deviceType: session.deviceType ?? undefined,
      platform: session.platform ?? undefined,
    });
  } catch (error) {
    logger.error('Failed to log security event for sign-in', error instanceof Error ? error : new Error(String(error)), {
      component: 'signInSession',
      userId: account.id,
    });
  }
  return response;
}

/**
 * The account a first factor named, if it may still sign in: a personal,
 * active account. Managed accounts are operated only through the audited
 * account-switch flow.
 */
export async function readSignInAccount(userId: string): Promise<SignInAccount | null> {
  const [row] = await getDb()
    .select({
      id: users.id,
      username: users.username,
      avatar: users.avatar,
      kind: users.kind,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.kind !== 'personal' || row.accountStatus !== 'active') return null;
  return { id: row.id, username: row.username, avatar: row.avatar };
}

/**
 * A first factor passed for `userId`: the second-factor step when the account
 * has an authenticator, the session otherwise.
 */
export async function completeFirstFactor(
  req: Request,
  userId: string,
  envelope: SignInEnvelope,
  now: Date = new Date(),
): Promise<LoginResult | SecondFactorRequired> {
  const account = await readSignInAccount(userId);
  if (!account) {
    throw new ApiError(401, 'This account cannot sign in.', SIGN_IN_ERROR_CODES.invalidCredentials);
  }
  const provenDeviceId = await resolveProvenDeviceId(envelope.device);

  if (await isTotpEnabled(userId)) {
    const challengeId = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SIGNIN_SECOND_FACTOR_TTL_MS);
    await getDb().insert(signInSecondFactorChallenges).values({
      challengeHash: sha256Hex(challengeId),
      userId,
      deviceId: provenDeviceId,
      expiresAt,
    });
    return { secondFactorRequired: true, challengeId, expiresAt: expiresAt.getTime() };
  }

  return mintSignInSession(req, account, envelope, provenDeviceId);
}

/**
 * The second factor: a live challenge, presented with the SAME device proof
 * the first factor carried (or none, if it carried none), and a right code.
 * The challenge is spent by the one conditional update that passes it, so it
 * signs in at most once; every try counts against the challenge's cap and a
 * wrong one against the account's authenticator lockout.
 */
export async function completeSecondFactor(
  req: Request,
  input: SignInEnvelope & { challengeId: string; code: string },
  now: Date = new Date(),
): Promise<LoginResult> {
  const provenDeviceId = await resolveProvenDeviceId(input.device);
  const challengeHash = sha256Hex(input.challengeId);
  const db = getDb();

  const [challenge] = await db
    .select({
      id: signInSecondFactorChallenges.id,
      userId: signInSecondFactorChallenges.userId,
      deviceId: signInSecondFactorChallenges.deviceId,
      attempts: signInSecondFactorChallenges.attempts,
    })
    .from(signInSecondFactorChallenges)
    .where(
      and(
        eq(signInSecondFactorChallenges.challengeHash, challengeHash),
        isNull(signInSecondFactorChallenges.usedAt),
        gt(signInSecondFactorChallenges.expiresAt, now),
      ),
    )
    .limit(1);
  if (!challenge || challenge.attempts >= SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS) throw secondFactorInvalid();
  // Bound to the device the first factor proved: a challenge id carried to
  // another browser is worthless there.
  if ((challenge.deviceId ?? null) !== (provenDeviceId ?? null)) throw secondFactorInvalid();

  // Every try is counted BEFORE the code is checked, in one conditional update,
  // so concurrent guesses cannot exceed the cap and a lockout still counts.
  const counted = await db
    .update(signInSecondFactorChallenges)
    .set({ attempts: sql`${signInSecondFactorChallenges.attempts} + 1` })
    .where(
      and(
        eq(signInSecondFactorChallenges.id, challenge.id),
        isNull(signInSecondFactorChallenges.usedAt),
        lt(signInSecondFactorChallenges.attempts, SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS),
      ),
    )
    .returning({ id: signInSecondFactorChallenges.id });
  if (counted.length === 0) throw secondFactorInvalid();

  if (!(await verifySecondFactor(challenge.userId, input.code, now))) throw secondFactorInvalid();

  const spent = await db
    .update(signInSecondFactorChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(signInSecondFactorChallenges.id, challenge.id),
        isNull(signInSecondFactorChallenges.usedAt),
        gt(signInSecondFactorChallenges.expiresAt, now),
      ),
    )
    .returning({ id: signInSecondFactorChallenges.id });
  if (spent.length === 0) throw secondFactorInvalid();

  const account = await readSignInAccount(challenge.userId);
  if (!account) throw secondFactorInvalid();
  return mintSignInSession(req, account, input, provenDeviceId);
}
