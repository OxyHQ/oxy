/**
 * An application's token, minted for the platform that holds the session
 * (ADR 0058 2.2): `POST /session/device/app-token`.
 *
 * The platform proves its PLATFORM credential and attests which application
 * it runs; Oxy mints a five-minute token of the device's shared session named
 * for that application. Each check reads live rows, in this order, and a miss
 * is one refusal per step (`@oxy.so/contracts` `DEVICE_APP_TOKEN_ERROR_CODES`):
 *
 * 1. the secret proves a platform credential of the device
 *    (`invalid_device_secret`, the `/session/device/token` lockout's scope);
 * 2. the credential's platform is the attestation's;
 * 3. the attestation names an application: an OxyOS desktop entry id the
 *    registry holds, the platform's own application (`self`), or on Astro an
 *    exact web origin of the application whose client id it names;
 * 4. that application is active and trusted (first-party), has a usable
 *    public client id (the one named, when one is), and is not auth.oxy.so's,
 *    which is the identity carrier and keeps its own device
 *    (2 to 4: `application_not_recognised`, one generic refusal);
 * 5. the device has a live session for its active account, or for the pinned
 *    `accountId` (`no_active_session` / `account_not_on_device`).
 *
 * No step takes anything a person typed, and nothing in a refusal names an
 * account. The server cannot tell which process asks; it believes the
 * platform because the platform already holds the device credential, so the
 * token it gets here is strictly less than what it has (ADR 0058 2.8).
 */

import type { DeviceAppTokenAttestation, DeviceAppTokenRequest } from '@oxy.so/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthWebOrigin } from '../config/env';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import {
  applicationOxyosEntries,
  applicationRecognition,
  applicationWebOrigins,
} from '../db/schema/applicationRecognition';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from '../utils/credentialUsability';
import { normaliseOrigin } from '../utils/origin';
import {
  generateHostAccessToken,
  type HostPlatform,
  validateAccessToken,
} from '../utils/sessionUtils';
import { isTrustedApplication } from '../utils/trustedApplication';
import deviceSessionService from './deviceSession.service';

/** A proven platform credential. */
export interface PlatformCredential {
  id: string;
  deviceSessionId: string;
  platform: HostPlatform;
  platformApplicationId: string;
}

/** The application a mint is for: its id and the public client id `azp` names. */
export interface AttestedApplication {
  applicationId: string;
  clientId: string;
}

export type AppTokenMintOutcome =
  | {
      ok: true;
      accessToken: string;
      expiresAt: string;
      applicationId: string;
      accountId: string;
    }
  | { ok: false; reason: 'no_active_session' | 'account_not_on_device' };

/**
 * Step 1: the platform credential `deviceSecret` proves on `deviceId`.
 * `missing` when it proves no credential of the device (a guess, counted);
 * `not_platform` when it proves an ordinary holder credential, which never
 * mints here.
 */
export async function provePlatformCredential(
  deviceId: string,
  deviceSecret: string,
): Promise<
  | { status: 'ok'; credential: PlatformCredential }
  | { status: 'missing' }
  | { status: 'not_platform' }
> {
  const credential = await deviceSessionService.readCredentialBySecret(deviceId, deviceSecret);
  if (!credential) return { status: 'missing' };
  if (!credential.platform || !credential.platformApplicationId) return { status: 'not_platform' };
  return {
    status: 'ok',
    credential: {
      id: credential.id,
      deviceSessionId: credential.deviceSessionId,
      platform: credential.platform,
      platformApplicationId: credential.platformApplicationId,
    },
  };
}

/** Step 3's application id, before step 4 judges it; null when the attestation names none. */
async function attestedApplicationId(
  credential: PlatformCredential,
  attestation: DeviceAppTokenAttestation,
): Promise<string | null> {
  const db = getDb();
  if ('self' in attestation) {
    // The platform's own application, while it still declares this platform.
    const [row] = await db
      .select({ platformHost: applicationRecognition.platformHost })
      .from(applicationRecognition)
      .where(eq(applicationRecognition.applicationId, credential.platformApplicationId))
      .limit(1);
    return row?.platformHost === credential.platform ? credential.platformApplicationId : null;
  }
  if ('desktopEntryId' in attestation) {
    const [row] = await db
      .select({ applicationId: applicationOxyosEntries.applicationId })
      .from(applicationOxyosEntries)
      .where(eq(applicationOxyosEntries.desktopEntryId, attestation.desktopEntryId))
      .limit(1);
    return row?.applicationId ?? null;
  }
  // Astro: the committed origin must be exactly one of the web origins of the
  // application whose client id it names.
  const [row] = await db
    .select({ applicationId: applicationWebOrigins.applicationId })
    .from(applicationWebOrigins)
    .innerJoin(
      applicationCredentials,
      eq(applicationCredentials.applicationId, applicationWebOrigins.applicationId),
    )
    .where(
      and(
        eq(applicationWebOrigins.origin, attestation.origin),
        eq(applicationCredentials.publicKey, attestation.clientId),
      ),
    )
    .limit(1);
  return row?.applicationId ?? null;
}

/** Whether `applicationId` is the identity carrier (it declares auth.oxy.so's origin). */
async function isIdentityCarrier(applicationId: string): Promise<boolean> {
  const authOrigin = normaliseOrigin(getAuthWebOrigin());
  if (!authOrigin) return false;
  const [row] = await getDb()
    .select({ origin: applicationWebOrigins.origin })
    .from(applicationWebOrigins)
    .where(
      and(
        eq(applicationWebOrigins.applicationId, applicationId),
        eq(applicationWebOrigins.origin, authOrigin),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Steps 2 to 4: the application the platform may mint for, with the public
 * client id its token names; null for every refusal (`application_not_recognised`).
 */
export async function resolveAttestedApplication(
  credential: PlatformCredential,
  request: Pick<DeviceAppTokenRequest, 'attestation' | 'clientId'>,
): Promise<AttestedApplication | null> {
  const { attestation } = request;
  if (attestation.platform !== credential.platform) return null;

  const named = [
    request.clientId,
    'clientId' in attestation ? attestation.clientId : undefined,
  ].filter((value): value is string => value !== undefined);
  if (new Set(named).size > 1) return null;
  const namedClientId = named[0];

  const applicationId = await attestedApplicationId(credential, attestation);
  if (!applicationId) return null;

  const rows = await getDb()
    .select({
      publicKey: applicationCredentials.publicKey,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
      environment: applicationCredentials.environment,
      applicationStatus: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.applicationId, applicationId),
        eq(applicationCredentials.type, 'public'),
      ),
    )
    .orderBy(asc(applicationCredentials.createdAt), asc(applicationCredentials.id));
  const usable = rows.filter(
    (row) =>
      row.publicKey !== null &&
      row.applicationStatus === 'active' &&
      isTrustedApplication(row) &&
      isCredentialUsable(row),
  );
  // A named client id must be one of this application's; otherwise the
  // production client is the one `azp` names, as the seed registers it.
  const chosen = namedClientId
    ? usable.find((row) => row.publicKey === namedClientId)
    : (usable.find((row) => row.environment === 'production') ?? usable[0]);
  if (!chosen?.publicKey) return null;
  if (await isIdentityCarrier(applicationId)) return null;
  return { applicationId, clientId: chosen.publicKey };
}

/**
 * Step 5 and the token: a fresh application token of the device's live session
 * for its active account (or the pinned one).
 *
 * The session is resolved and re-validated exactly as `/session/device/token`
 * resolves it (the same resolvers, which also slide its idle window), and the
 * token's binding is read from the device's own current token, which those
 * resolvers guarantee describes the row.
 */
export async function mintApplicationToken(input: {
  deviceId: string;
  deviceSecret: string;
  accountId?: string;
  credential: PlatformCredential;
  application: AttestedApplication;
}): Promise<AppTokenMintOutcome> {
  const { deviceId, deviceSecret, accountId } = input;
  const missing = {
    ok: false as const,
    reason: accountId ? ('account_not_on_device' as const) : ('no_active_session' as const),
  };
  let state = await deviceSessionService.getStateBySecret(deviceId, deviceSecret);
  if (!state) return { ok: false, reason: 'no_active_session' };
  let deviceToken = accountId
    ? await deviceSessionService.resolveTokenForAccount(state, accountId)
    : await deviceSessionService.resolveActiveToken(state);
  if (!deviceToken && !accountId) {
    // As `/session/device/token`: follow exactly one newer revision.
    const refreshed = await deviceSessionService.getStateBySecret(deviceId, deviceSecret);
    if (refreshed && refreshed.revision !== state.revision) {
      state = refreshed;
      deviceToken = await deviceSessionService.resolveActiveToken(state);
    }
  }
  if (!deviceToken) return missing;

  const verified = validateAccessToken(deviceToken.accessToken);
  const claims = verified.valid ? verified.payload : undefined;
  const actor = claims?.act?.sub;
  if (
    !claims ||
    claims.ver !== 2 ||
    typeof claims.sub !== 'string' ||
    typeof claims.sid !== 'string' ||
    typeof actor !== 'string' ||
    claims.azp !== undefined ||
    claims.scope !== undefined ||
    claims.device_session_id !== input.credential.deviceSessionId ||
    typeof claims.device_context_id !== 'string'
  ) {
    return missing;
  }

  const minted = generateHostAccessToken(
    {
      subjectAccountId: claims.sub,
      principalUserId: actor,
      sessionId: claims.sid,
      deviceId,
      deviceSessionId: claims.device_session_id,
      deviceContextId: claims.device_context_id,
      clientId: null,
      scopes: [],
    },
    { clientId: input.application.clientId },
    { platform: input.credential.platform, credential: input.credential.id },
  );
  return {
    ok: true,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt.toISOString(),
    applicationId: input.application.applicationId,
    accountId: claims.sub,
  };
}
