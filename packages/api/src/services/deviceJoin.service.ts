/**
 * The browser bridge — how an official Oxy web app joins the browser's ONE
 * DeviceSession (ADR 0029 D2).
 *
 * Different domains share no storage, so the browser's Oxy session lives on
 * auth.oxy.so. The first time a person presses sign-in in an app that holds no
 * device credential, the app opens `auth.oxy.so/bridge` from that press:
 *
 *   1. the bridge loads auth.oxy.so's own holder credential — or registers a new,
 *      empty device when it has none ({@link DeviceJoinService.registerDevice});
 *   2. proves it and asks for a one-use code bound to the app, its exact
 *      registered redirect URI and the app's PKCE challenge
 *      ({@link DeviceJoinService.issueJoinCode});
 *   3. posts the code to the app's window (only to that redirect URI's origin)
 *      and closes;
 *   4. the app redeems it with its PKCE verifier and receives its OWN holder
 *      credential for the same device ({@link DeviceJoinService.redeemJoinCode}).
 *
 * Only OFFICIAL applications (`isTrustedApplication`) may join: a third party is
 * never given a credential for the browser's shared device, and keeps the
 * isolated per-(user, client) device `/oauth/token` gives it.
 *
 * {@link resolveProvenDeviceId} is the other half: a sign-in that carries a
 * device proof puts its new session on that device, so every holder sees the
 * account at once.
 */

import * as crypto from 'crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DeviceProof } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { deviceJoinCodes } from '../db/schema/deviceJoinCodes';
import { deviceSessions } from '../db/schema/deviceSessions';
import { isCredentialUsable } from '../utils/credentialUsability';
import { logger } from '../utils/logger';
import { isAllowedRedirectUri } from '../utils/oauthRedirect';
import { isTrustedApplication } from '../utils/trustedApplication';
import deviceSessionService from './deviceSession.service';
import {
  base64UrlEncode,
  canonicalizeOAuthRedirectUri,
  sha256Hex,
  timingSafeStringEqual,
} from './oauthCode.service';

/** A join code lives about a minute; the bridge window closes in well under a second. */
export const DEVICE_JOIN_CODE_TTL_MS = 60 * 1000;
const DEVICE_JOIN_CODE_BYTES = 32;

export type IssueJoinCodeOutcome =
  | { ok: true; code: string; expiresIn: number }
  | { ok: false; reason: 'invalid_device_secret' | 'invalid_client' | 'invalid_redirect_uri' };

export type RedeemJoinCodeOutcome =
  | { ok: true; deviceId: string; deviceSecret: string }
  | { ok: false; reason: 'invalid_grant' | 'invalid_client' };

/** The official application a `clientId` names, or null. */
async function resolveOfficialApplication(
  clientId: string,
): Promise<{ id: string; redirectUris: string[] } | null> {
  const [row] = await getDb()
    .select({
      id: applications.id,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      redirectUris: applications.redirectUris,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(and(eq(applicationCredentials.publicKey, clientId), eq(applications.status, 'active')))
    .limit(1);
  if (!row || !isCredentialUsable(row) || !isTrustedApplication(row)) return null;
  return { id: row.id, redirectUris: row.redirectUris ?? [] };
}

function pkceS256(verifier: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

export class DeviceJoinService {
  /** A new, empty browser device with auth.oxy.so's holder credential. */
  registerDevice(): Promise<{ deviceId: string; deviceSecret: string }> {
    return deviceSessionService.registerDevice();
  }

  /**
   * Prove auth.oxy.so's device and mint a one-use join code for an official
   * application. The raw code is returned exactly once; only its hash is stored.
   */
  async issueJoinCode(input: {
    deviceId: string;
    deviceSecret: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
  }): Promise<IssueJoinCodeOutcome> {
    const state = await deviceSessionService.getStateBySecret(input.deviceId, input.deviceSecret);
    if (!state) return { ok: false, reason: 'invalid_device_secret' };

    const app = await resolveOfficialApplication(input.clientId);
    if (!app) return { ok: false, reason: 'invalid_client' };
    if (!isAllowedRedirectUri(app, input.redirectUri)) return { ok: false, reason: 'invalid_redirect_uri' };

    const db = getDb();
    const [device] = await db
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, input.deviceId))
      .limit(1);
    if (!device) return { ok: false, reason: 'invalid_device_secret' };

    const code = base64UrlEncode(crypto.randomBytes(DEVICE_JOIN_CODE_BYTES));
    await db.insert(deviceJoinCodes).values({
      codeHash: sha256Hex(code),
      deviceSessionId: device.id,
      applicationId: app.id,
      redirectUri: canonicalizeOAuthRedirectUri(input.redirectUri),
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(Date.now() + DEVICE_JOIN_CODE_TTL_MS),
    });
    return { ok: true, code, expiresIn: Math.round(DEVICE_JOIN_CODE_TTL_MS / 1000) };
  }

  /**
   * Redeem a join code: unused, unexpired, issued to this application for this
   * exact redirect URI, and the verifier matches its challenge. The code is
   * spent by ONE conditional update, so two concurrent redemptions cannot both
   * succeed — and it is spent even when the checks after the lookup fail, so a
   * guessed verifier gets exactly one try. Returns a NEW holder credential.
   */
  async redeemJoinCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<RedeemJoinCodeOutcome> {
    const db = getDb();
    const now = new Date();
    const [claimed] = await db
      .update(deviceJoinCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(deviceJoinCodes.codeHash, sha256Hex(input.code)),
          isNull(deviceJoinCodes.usedAt),
          gt(deviceJoinCodes.expiresAt, now),
        ),
      )
      .returning({
        deviceSessionId: deviceJoinCodes.deviceSessionId,
        applicationId: deviceJoinCodes.applicationId,
        redirectUri: deviceJoinCodes.redirectUri,
        codeChallenge: deviceJoinCodes.codeChallenge,
      });
    if (!claimed) return { ok: false, reason: 'invalid_grant' };

    const app = await resolveOfficialApplication(input.clientId);
    if (!app || app.id !== claimed.applicationId) return { ok: false, reason: 'invalid_client' };
    if (
      !timingSafeStringEqual(claimed.redirectUri, canonicalizeOAuthRedirectUri(input.redirectUri)) ||
      !timingSafeStringEqual(claimed.codeChallenge, pkceS256(input.codeVerifier))
    ) {
      return { ok: false, reason: 'invalid_grant' };
    }

    const [device] = await db
      .select({ deviceId: deviceSessions.deviceId })
      .from(deviceSessions)
      .where(eq(deviceSessions.id, claimed.deviceSessionId))
      .limit(1);
    if (!device) return { ok: false, reason: 'invalid_grant' };

    const deviceSecret = await deviceSessionService.issueDeviceSecret(device.deviceId);
    if (!deviceSecret) return { ok: false, reason: 'invalid_grant' };
    return { ok: true, deviceId: device.deviceId, deviceSecret };
  }
}

/**
 * The device a sign-in's optional proof names, when the proof is valid — or
 * null. Never throws: an invalid, stale or unverifiable proof leaves the sign-in
 * exactly as it was without one (its own device), because a person must never
 * fail to sign in over the browser-sharing optimisation.
 */
export async function resolveProvenDeviceId(proof: DeviceProof | undefined | null): Promise<string | null> {
  if (!proof) return null;
  try {
    const state = await deviceSessionService.getStateBySecret(proof.deviceId, proof.deviceSecret);
    return state ? state.deviceId : null;
  } catch (error) {
    logger.warn('deviceJoin.resolveProvenDeviceId: proof check failed', { error });
    return null;
  }
}

export const deviceJoinService = new DeviceJoinService();
export default deviceJoinService;
