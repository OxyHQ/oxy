/**
 * The live half of an APPLICATION TOKEN's verification (ADR 0058 2.4).
 *
 * `checkAccessTokenBinding` proves an application token still describes its
 * shared session (`sid`, subject, actor, device session and context, and that
 * `azp` sits beside a well-formed `host`). What it cannot read is the registry
 * and the credential table, so before a bearer with `host` is believed this
 * re-checks, on every request, that:
 *
 * - `host.credential` is a live PLATFORM credential of the token's device
 *   session, held by the platform `host.platform` names. Deleting the
 *   credential (OxyOS's Remove, sign-out-all, a newer platform sign-in that
 *   retired it) ends every application token minted under it at once;
 * - `azp` is a usable public client id of an ACTIVE, TRUSTED (first-party)
 *   application. Demoting or suspending the application ends its tokens at
 *   once, as `isTrustedApplication` decides everywhere else.
 *
 * Nothing here is cached: a credential row is deleted without an announcement
 * of its own, and the read is one indexed lookup per bearer.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { deviceCredentials } from '../db/schema/deviceCredentials';
import { isCredentialUsable } from '../utils/credentialUsability';
import type { PendingHostToken, VerifiedHostToken } from '../utils/sessionUtils';
import { isTrustedApplication } from '../utils/trustedApplication';

/**
 * Each pending application token verified, in order: the verified `host`, or
 * `null` when its platform credential or its application no longer stands.
 */
export async function verifyHostTokens(
  pending: readonly PendingHostToken[],
): Promise<(VerifiedHostToken | null)[]> {
  if (pending.length === 0) return [];
  const db = getDb();
  const credentialIds = [...new Set(pending.map((token) => token.credentialId))];
  const clientIds = [...new Set(pending.map((token) => token.clientId))];
  const [credentials, clients] = await Promise.all([
    db
      .select({
        id: deviceCredentials.id,
        deviceSessionId: deviceCredentials.deviceSessionId,
        platform: deviceCredentials.platform,
      })
      .from(deviceCredentials)
      .where(inArray(deviceCredentials.id, credentialIds)),
    db
      .select({
        publicKey: applicationCredentials.publicKey,
        applicationId: applicationCredentials.applicationId,
        status: applicationCredentials.status,
        expiresAt: applicationCredentials.expiresAt,
        applicationStatus: applications.status,
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applicationCredentials)
      .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
      .where(
        and(
          inArray(applicationCredentials.publicKey, clientIds),
          eq(applicationCredentials.type, 'public'),
          or(
            eq(applicationCredentials.status, 'active'),
            eq(applicationCredentials.status, 'deprecated'),
          ),
        ),
      ),
  ]);
  const credentialById = new Map(credentials.map((row) => [row.id, row]));
  const clientByKey = new Map(clients.map((row) => [row.publicKey, row]));
  return pending.map((token) => {
    const credential = credentialById.get(token.credentialId);
    if (
      !credential ||
      credential.deviceSessionId !== token.deviceSessionId ||
      credential.platform !== token.platform
    ) {
      return null;
    }
    const client = clientByKey.get(token.clientId);
    if (
      !client ||
      client.applicationStatus !== 'active' ||
      !isCredentialUsable(client) ||
      !isTrustedApplication(client)
    ) {
      return null;
    }
    return {
      platform: token.platform,
      credentialId: token.credentialId,
      clientId: token.clientId,
      applicationId: client.applicationId,
    };
  });
}

/** {@link verifyHostTokens} for one token. */
export async function verifyHostToken(
  pending: PendingHostToken,
): Promise<VerifiedHostToken | null> {
  const [verified] = await verifyHostTokens([pending]);
  return verified ?? null;
}
