import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  accountClosureFences,
  applicationCredentials,
  applications,
  appGrants,
} from '../db/schema';
import { checkAccessTokenBinding, validateAccessToken } from '../utils/sessionUtils';
import { intersectScopes } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import sessionService from './session.service';
import { readSessionAgentBinding } from './agentKeyAuthority.service';
import { ApiError } from '../utils/error';

/** Resource OAuth authority: provenance is app-bound even for an Oxy-branded registration. */
export async function resolveExternalResourceSession(token: string) {
  const [proof] = await sessionService.validateSessionProofs([token]);
  if (!proof || proof.supervised) return null;
  const session = proof.session;
  if (!session.applicationId || !session.clientId || session.accessToken !== token) return null;
  const validation = validateAccessToken(token);
  if (!validation.valid || !validation.payload || typeof validation.payload.exp !== 'number')
    return null;
  const binding = checkAccessTokenBinding(validation.payload, session);
  if (!binding.ok) return null;
  const principalAccountId = session.operatedByUserId ?? session.userId;
  try {
    await readSessionAgentBinding(session.sessionId, principalAccountId);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401 && error.code === 'INVALID_SESSION')
      return null;
    throw error;
  }
  const [fence] = await getDb()
    .select({ id: accountClosureFences.accountId })
    .from(accountClosureFences)
    .where(inArray(accountClosureFences.accountId, [principalAccountId, session.userId]))
    .limit(1);
  if (fence) return null;
  const [client] = await getDb()
    .select({
      credential: {
        type: applicationCredentials.type,
        status: applicationCredentials.status,
        expiresAt: applicationCredentials.expiresAt,
        scopes: applicationCredentials.scopes,
      },
      application: { status: applications.status, scopes: applications.scopes },
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.publicKey, session.clientId),
        eq(applications.id, session.applicationId),
      ),
    )
    .limit(1);
  if (
    client?.application.status !== 'active' ||
    !isCredentialUsable(client.credential) ||
    !['public', 'confidential'].includes(client.credential.type)
  )
    return null;
  const [grant] = await getDb()
    .select({ scopes: appGrants.scopes })
    .from(appGrants)
    .where(
      and(eq(appGrants.userId, session.userId), eq(appGrants.applicationId, session.applicationId)),
    )
    .limit(1);
  if (!grant) return null;
  const scopes = intersectScopes(
    intersectScopes(binding.identity.scopes, grant.scopes),
    intersectScopes(
      client.credential.scopes.length ? client.credential.scopes : client.application.scopes,
      client.application.scopes,
    ),
  );
  return {
    accountId: session.userId,
    requesterAccountId: principalAccountId,
    effectiveAccountId: session.userId,
    applicationId: session.applicationId,
    sessionId: session.sessionId,
    scopes,
    expiresAt: new Date(
      Math.min(session.expiresAt.getTime(), validation.payload.exp * 1000),
    ).toISOString(),
  };
}
