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
 * Redeeming deletes the proof in that same transaction, so a proof is spent
 * once: a replay, or a second request racing the first, finds nothing. Every
 * refusal is the same answer (`invalid_grant`, 401), whatever failed, so the
 * route says nothing about which devices, credentials or accounts exist.
 *
 * What is issued is exactly what the platform's password sign-in issues
 * (`mintSignInSession` with the platform client): a fresh session for the
 * account on the device, replacing the one the setup client held, and a
 * platform credential (`issuePlatformCredential`) with its rotation and
 * revocation. If issuing fails after the proof was spent, the redemption fails
 * closed and the setup starts again with a new QR.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
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

export interface RedeemedDeviceProof {
  userId: string;
  deviceId: string;
  username: string | null;
  avatar: string | null;
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
    now?: Date;
  } = {},
): Promise<RedeemedDeviceProof> {
  const now = options.now ?? new Date();
  const secretHash = sha256Hex(proof.deviceSecret);
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

    const [claim] = await tx
      .select({
        credentialId: deviceCredentials.id,
        userId: authSessions.authorizedUserId,
      })
      .from(deviceCredentials)
      .innerJoin(authSessions, eq(authSessions.claimedCredentialId, deviceCredentials.id))
      .where(
        and(
          eq(deviceCredentials.deviceSessionId, device.id),
          eq(deviceCredentials.secretHash, secretHash),
          isNull(deviceCredentials.platform),
          eq(authSessions.purpose, 'device_sign_in'),
          eq(authSessions.status, 'consumed'),
          eq(authSessions.applicationId, client.applicationId),
          gt(authSessions.consumedAt, new Date(now.getTime() - PROMOTION_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (!claim?.userId) return null;

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

    // Spent here, once. The claim's reference goes with it (`SET NULL`).
    const spent = await tx
      .delete(deviceCredentials)
      .where(eq(deviceCredentials.id, claim.credentialId))
      .returning({ id: deviceCredentials.id });
    if (spent.length !== 1) return null;

    return {
      userId: account.id,
      deviceId: device.deviceId,
      username: account.username,
      avatar: account.avatar,
    };
  });
  if (!redeemed) throw invalidDeviceProof();
  logger.info('[PlatformPromotion] Device proof redeemed', {
    userId: redeemed.userId,
    deviceId: redeemed.deviceId.substring(0, 8),
    platform: client.platform,
    applicationId: client.applicationId,
  });
  return redeemed;
}
