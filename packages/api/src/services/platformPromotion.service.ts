/**
 * A platform's credential from the QR approval (ADR 0058 2.1, amended
 * 2026-11-08): `POST /session/device/platform`.
 *
 * Oxy signs a person in on a new device by approval: the QR the device shows
 * is approved by an identity the person already holds (Commons' key, or a
 * signed-in session), and the device CLAIMS the approved request, receiving a
 * session and a holder credential (`POST /auth/session/claim`). That approval
 * is the authentication; no password is involved, and an account may have
 * none. A platform's setup client (OxyOS's login screen) signs in that way,
 * and its platform service then needs a credential of its own, one only it
 * holds. This is how it gets one from the approval itself, the way the
 * password sign-in gives it one from the password.
 *
 * The proof is the claim's holder credential (`{deviceId, deviceSecret}`), and
 * it is redeemable only when ALL of these hold, checked on the rows, inside one
 * transaction that locks the device:
 *
 * - the secret proves a live, ordinary (not platform) holder credential of that
 *   device;
 * - that credential is the one a device-sign-in claim issued
 *   (`auth_sessions.claimed_credential_id`), and the request was consumed less
 *   than {@link PROMOTION_WINDOW_MS} ago: the proof is fresh;
 * - the request was started by the application the platform client names: a
 *   proof another client claimed cannot be redeemed by this one;
 * - the approved account is still signed in on that device, and is a personal,
 *   active account.
 *
 * Redeeming deletes the proof's credential in that same transaction, so the
 * setup client (whose JavaScript saw it) holds nothing that works afterwards,
 * and a replay of the proof alone, or a second request racing the first, finds
 * nothing. Every refusal is the same answer (`invalid_grant`, 401), whatever
 * failed, so the route says nothing about which devices, credentials or
 * accounts exist.
 *
 * **Repeating a redemption (R7).** The platform SERVICE may send a
 * `redemptionKey` with the first redemption: 256 random bits or more, never
 * shown to its setup client. The redemption is then recorded on the claim
 * (`auth_sessions.redeemed_proof_hash`, `redeemed_device_session_id`,
 * `redemption_key_hash`, `redemption_attempt`), and the same proof AND the same
 * key may be redeemed again, on the same device, by the same application,
 * within the claim's ORIGINAL ten minutes, the account still signed in there
 * and active: an answer lost on the way, or a setup the platform could not
 * finish on its side, is retried without a new QR. Without a key, or with
 * another, a spent proof is the same refusal: whoever saw only the proof (the
 * setup client) gains nothing. Each redemption is an ATTEMPT, numbered on the
 * claim, and only the latest issues: `issuePlatformCredential` revokes the
 * platform credential the previous attempt issued (its answer may have been
 * lost) and refuses an attempt a later one superseded (one still in flight),
 * so at most one platform credential from a redemption is ever live.
 *
 * **Confirming, and budgets (R8).** A platform that confirms
 * (`platformClient.confirms`) receives the credential PENDING until the
 * claim's window ends: it proves nothing until
 * `POST /session/device/platform/confirm`, and an unconfirmed one is gone with
 * the window (`deviceSession.service.ts`). A claim's proof has at most
 * {@link MAX_REDEMPTION_ATTEMPTS} redemptions, the first included. A
 * repetition the route recognises ({@link isRecordedRedemption}) is not a
 * guess and spends no anti-guessing budget.
 *
 * What is issued is exactly what the platform's password sign-in issues
 * (`mintSignInSession` with the platform client): a fresh session for the
 * account on the device, replacing the one the setup client held, and a
 * platform credential (`issuePlatformCredential`) with its rotation and
 * revocation. If issuing fails after the proof was spent, a keyed redemption is
 * repeated with its key; one without a key fails closed, and the setup starts
 * again with a new QR. A superseded attempt fails as an issuing failure does
 * (500): its caller has already repeated it.
 */

import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { DeviceProof } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { authSessions } from '../db/schema/authSessions';
import { deviceAccountContexts } from '../db/schema/deviceAccountContexts';
import { deviceCredentials } from '../db/schema/deviceCredentials';
import { deviceSessions } from '../db/schema/deviceSessions';
import { users } from '../db/schema/users';
import { UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';
import deviceSessionService from './deviceSession.service';
import { sha256Hex } from './oauthCode.service';
import type { ResolvedPlatformClient } from './platformClient.service';

/** How long after its claim a device proof may be redeemed. */
export const PROMOTION_WINDOW_MS = 10 * 60 * 1000;

/** The account's promotion budget is spent; the proof was not. */
export class PromotionRateLimitedError extends Error {
  constructor() {
    super('Too many attempts');
    this.name = 'PromotionRateLimitedError';
  }
}

/** The one answer to every proof that is not redeemable. */
export function invalidDeviceProof(): UnauthorizedError {
  return new UnauthorizedError('invalid_grant');
}

/**
 * Record, on the device-sign-in request a claim answered, the holder
 * credential the claim issued: the proof {@link redeemDeviceProof} accepts.
 */
export async function recordClaimedCredential(
  authSessionId: string,
  deviceId: string,
  deviceSecret: string,
): Promise<void> {
  const credential = await deviceSessionService.readCredentialBySecret(deviceId, deviceSecret);
  if (!credential || credential.platform !== null) return;
  await getDb()
    .update(authSessions)
    .set({ claimedCredentialId: credential.id })
    .where(and(eq(authSessions.id, authSessionId), eq(authSessions.purpose, 'device_sign_in')));
}

/**
 * Which redemption of a claim's proof this is (R7): the claim, and the attempt
 * number recorded on it. Only the claim's latest attempt issues a credential.
 */
export interface ProofRedemption {
  authSessionId: string;
  attempt: number;
  /**
   * When the claim's window ends (its `consumed_at` + {@link PROMOTION_WINDOW_MS}):
   * how long the credential stays pending for a platform that confirms (R8).
   */
  pendingUntil: Date;
}

/** How many redemptions one claim's proof may have, the first and its repetitions (R8). */
export const MAX_REDEMPTION_ATTEMPTS = 10;

export interface RedeemedDeviceProof {
  userId: string;
  deviceId: string;
  username: string | null;
  avatar: string | null;
  redemption: ProofRedemption;
}

/**
 * Whether `proof` and `redemptionKey` name a redemption already recorded for
 * `client` (R8): the same proof spent with the same key on the same device,
 * its claim still in its window and under its attempt cap. Hash lookups alone,
 * nothing locked or counted: the route lets such a repetition through without
 * the per-device and per-account budgets, which are there against GUESSES, and
 * a request that presents both 256-bit secrets is not one. Everything else is
 * budgeted exactly as before.
 */
export async function isRecordedRedemption(
  proof: DeviceProof,
  client: ResolvedPlatformClient,
  redemptionKey: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: authSessions.id })
    .from(authSessions)
    .innerJoin(deviceSessions, eq(deviceSessions.id, authSessions.redeemedDeviceSessionId))
    .where(
      and(
        eq(authSessions.redeemedProofHash, sha256Hex(proof.deviceSecret)),
        eq(authSessions.redemptionKeyHash, sha256Hex(redemptionKey)),
        eq(deviceSessions.deviceId, proof.deviceId),
        eq(authSessions.purpose, 'device_sign_in'),
        eq(authSessions.status, 'consumed'),
        eq(authSessions.applicationId, client.applicationId),
        gt(authSessions.consumedAt, new Date(now.getTime() - PROMOTION_WINDOW_MS)),
        lt(authSessions.redemptionAttempt, MAX_REDEMPTION_ATTEMPTS),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Spend a claim's device proof for `client`: the account it signs in, or the
 * refusal ({@link invalidDeviceProof}). See the module docblock for the rules.
 */
export async function redeemDeviceProof(
  proof: DeviceProof,
  client: ResolvedPlatformClient,
  options: {
    /**
     * The account's own budget, asked once the proof is known to sign it in
     * and BEFORE it is spent: refused, the proof stays unspent and the
     * redemption answers {@link PromotionRateLimitedError}.
     */
    admitAccount?: (userId: string) => Promise<boolean>;
    /** The platform service's key (R7): the redemption may be repeated with it. */
    redemptionKey?: string;
    now?: Date;
  } = {},
): Promise<RedeemedDeviceProof> {
  const now = options.now ?? new Date();
  const secretHash = sha256Hex(proof.deviceSecret);
  const keyHash = options.redemptionKey ? sha256Hex(options.redemptionKey) : null;
  const fresh = new Date(now.getTime() - PROMOTION_WINDOW_MS);
  const redeemed = await getDb().transaction(async (tx) => {
    // The device row is the lock every credential write on the device takes
    // (`issuePlatformCredential`, revocation): concurrent redemptions of one
    // proof run one after the other, and the second finds the proof gone.
    const [device] = await tx
      .select({ id: deviceSessions.id, deviceId: deviceSessions.deviceId })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, proof.deviceId))
      .for('update');
    if (!device) return null;

    // The request answered for this application, consumed less than ten
    // minutes ago: what both a first redemption and a repetition require.
    const claimed = and(
      eq(authSessions.purpose, 'device_sign_in'),
      eq(authSessions.status, 'consumed'),
      eq(authSessions.applicationId, client.applicationId),
      gt(authSessions.consumedAt, fresh),
    );

    // A first redemption: the proof is a live credential the claim issued.
    const [unspent] = await tx
      .select({
        authSessionId: authSessions.id,
        credentialId: deviceCredentials.id,
        userId: authSessions.authorizedUserId,
        consumedAt: authSessions.consumedAt,
      })
      .from(deviceCredentials)
      .innerJoin(authSessions, eq(authSessions.claimedCredentialId, deviceCredentials.id))
      .where(
        and(
          eq(deviceCredentials.deviceSessionId, device.id),
          eq(deviceCredentials.secretHash, secretHash),
          isNull(deviceCredentials.platform),
          claimed,
        ),
      )
      .limit(1);

    // A repetition (R7): the proof was spent by a redemption that sent this
    // key, on this device. Never without a key.
    const [repeated] =
      unspent || !keyHash
        ? []
        : await tx
            .select({
              authSessionId: authSessions.id,
              userId: authSessions.authorizedUserId,
              consumedAt: authSessions.consumedAt,
            })
            .from(authSessions)
            .where(
              and(
                eq(authSessions.redeemedProofHash, secretHash),
                eq(authSessions.redeemedDeviceSessionId, device.id),
                eq(authSessions.redemptionKeyHash, keyHash),
                // R8: a claim's redemptions are bounded, the first included.
                lt(authSessions.redemptionAttempt, MAX_REDEMPTION_ATTEMPTS),
                claimed,
              ),
            )
            .limit(1);

    const claim = unspent ?? repeated;
    if (!claim?.userId || !claim.consumedAt) return null;

    // The approved account must still be signed in on this device, and be a
    // personal, active account (a managed account is operated only through the
    // audited account switch, never held by a platform).
    const [account] = await tx
      .select({ id: users.id, username: users.username, avatar: users.avatar })
      .from(deviceAccountContexts)
      .innerJoin(users, eq(users.id, deviceAccountContexts.accountId))
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, device.id),
          eq(deviceAccountContexts.accountId, claim.userId),
          isNull(deviceAccountContexts.revokedAt),
          eq(users.kind, 'personal'),
          eq(users.accountStatus, 'active'),
        ),
      )
      .limit(1);
    if (!account) return null;
    if (options.admitAccount && !(await options.admitAccount(account.id))) {
      throw new PromotionRateLimitedError();
    }

    let attempt: number;
    if (unspent) {
      // Spent here, once. The claim's reference goes with it (`SET NULL`);
      // what a repetition needs is recorded on the claim instead.
      const spent = await tx
        .delete(deviceCredentials)
        .where(eq(deviceCredentials.id, unspent.credentialId))
        .returning({ id: deviceCredentials.id });
      if (spent.length !== 1) return null;
      const [recorded] = await tx
        .update(authSessions)
        .set({
          redeemedProofHash: secretHash,
          redeemedDeviceSessionId: device.id,
          redemptionKeyHash: keyHash,
          redemptionAttempt: 1,
          redemptionCredentialId: null,
        })
        .where(eq(authSessions.id, unspent.authSessionId))
        .returning({ attempt: authSessions.redemptionAttempt });
      if (!recorded) return null;
      attempt = recorded.attempt;
    } else {
      // The latest attempt from now on: one still in flight issues nothing.
      const [recorded] = await tx
        .update(authSessions)
        .set({ redemptionAttempt: sql`${authSessions.redemptionAttempt} + 1` })
        .where(eq(authSessions.id, claim.authSessionId))
        .returning({ attempt: authSessions.redemptionAttempt });
      if (!recorded) return null;
      attempt = recorded.attempt;
    }

    return {
      userId: account.id,
      deviceId: device.deviceId,
      username: account.username,
      avatar: account.avatar,
      redemption: {
        authSessionId: claim.authSessionId,
        attempt,
        pendingUntil: new Date(claim.consumedAt.getTime() + PROMOTION_WINDOW_MS),
      },
      repeated: !unspent,
    };
  });
  if (!redeemed) throw invalidDeviceProof();
  const { repeated, ...result } = redeemed;
  logger.info('[PlatformPromotion] Device proof redeemed', {
    userId: result.userId,
    deviceId: result.deviceId.substring(0, 8),
    platform: client.platform,
    applicationId: client.applicationId,
    attempt: result.redemption.attempt,
    repeated,
  });
  return result;
}
