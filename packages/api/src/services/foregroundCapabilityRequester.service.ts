import type { CapabilityRequesterOperation } from './capabilityRequester.service';
import { hasServiceAuthority } from '../utils/serviceAuthority';
/** Present-requester approval within the existing capability ticket family. */
import { createHash } from 'node:crypto';
import { ApiError } from '../utils/error';
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalCapabilityJson } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { appGrants } from '../db/schema/appGrants';
import { users } from '../db/schema/users';
import { checkAccessTokenBinding, validateAccessToken } from '../utils/sessionUtils';
import { isCredentialUsable } from '../utils/credentialUsability';
import type { CachedSession } from '../utils/sessionCache';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import { readSessionAgentBinding } from './agentKeyAuthority.service';
import sessionService from './session.service';

export interface ForegroundRequesterBinding {
  sessionId: string;
  principalAccountId: string;
  subjectAccountId: string;
  digest: string;
  expiresAt: Date;
  operation?: CapabilityRequesterOperation;
}

function sessionDigest(session: CachedSession): string {
  // Deliberately excludes access/refresh tokens and activity timestamps.
  return createHash('sha256')
    .update(
      canonicalCapabilityJson({
        sessionId: session.sessionId,
        subjectAccountId: session.userId,
        principalAccountId: session.operatedByUserId ?? session.userId,
        authMethodId: session.authMethodId,
        authMethodOwnerId: session.authMethodOwnerId,
        applicationId: session.applicationId,
        clientId: session.clientId,
        deviceSessionId: session.deviceSessionId,
        deviceContextId: session.deviceContextId,
        tokenRotatedAt: session.tokenRotatedAt?.toISOString() ?? null,
        scopes: [...session.scopes].sort(),
      }),
    )
    .digest('hex');
}

async function liveSession(sessionId: string, presenter: LiveAgencyServicePrincipal) {
  if (!hasServiceAuthority(presenter, 'user:read')) return null;
  // This checks managed membership and bot key liveness without the cached
  // positive authority result. Account status/fences below are also fresh SQL.
  const result = await sessionService.validateSessionById(sessionId, true, { useCache: false });
  if (!result) return null;
  const session = result.session;
  const principalAccountId = session.operatedByUserId ?? session.userId;
  const accountIds = [...new Set([principalAccountId, session.userId])];
  const accounts = await getDb()
    .select({ id: users.id, status: users.accountStatus, fence: accountClosureFences.accountId })
    .from(users)
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(inArray(users.id, accountIds));
  if (
    accounts.length !== accountIds.length ||
    accounts.some((account) => account.status !== 'active' || account.fence !== null)
  )
    return null;
  // A bot must name its actual live autonomous signer even when acting as an org.
  try {
    await readSessionAgentBinding(session.sessionId, principalAccountId);
  } catch (error) {
    // Concurrent withdrawal is a known refusal; SQL/programming errors stay 500.
    if (error instanceof ApiError && error.statusCode === 401 && error.code === 'INVALID_SESSION')
      return null;
    throw error;
  }
  // App-bound OAuth provenance stays external even if registry flags later change.
  if (presenter.authority === 'first_party' && session.applicationId !== null) return null;
  if (session.applicationId !== null) {
    if (
      session.applicationId !== presenter.applicationId ||
      !session.clientId ||
      !session.scopes.includes('user:read')
    )
      return null;
    const [client] = await getDb()
      .select({
        credential: {
          type: applicationCredentials.type,
          status: applicationCredentials.status,
          expiresAt: applicationCredentials.expiresAt,
          scopes: applicationCredentials.scopes,
        },
        application: {
          id: applications.id,
          status: applications.status,
          scopes: applications.scopes,
          type: applications.type,
          isOfficial: applications.isOfficial,
          isInternal: applications.isInternal,
        },
      })
      .from(applicationCredentials)
      .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
      .where(
        and(
          eq(applicationCredentials.publicKey, session.clientId),
          eq(applications.id, presenter.applicationId),
        ),
      )
      .limit(1);
    if (
      !client ||
      client.application.status !== 'active' ||
      !client.application.scopes.includes('user:read') ||
      !isCredentialUsable(client.credential) ||
      (client.credential.type !== 'public' && client.credential.type !== 'confidential') ||
      (client.credential.scopes.length > 0 && !client.credential.scopes.includes('user:read'))
    )
      return null;
    // OAuth provenance remains external, including credentials registered to
    // an Oxy-owned application. Registry branding cannot remove its live grant.
    const [grant] = await getDb()
      .select({ scopes: appGrants.scopes })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.userId, session.userId),
          eq(appGrants.applicationId, presenter.applicationId),
        ),
      )
      .limit(1);
    if (!grant?.scopes.includes('user:read')) return null;
  }
  // The presenter resolver independently proves current first-party trust for
  // shared sessions; no app ID supplied by the requester participates here.
  return {
    session,
    binding: {
      sessionId,
      principalAccountId,
      subjectAccountId: session.userId,
      digest: sessionDigest(session),
      expiresAt: session.expiresAt,
    } satisfies ForegroundRequesterBinding,
  };
}

export async function validateForegroundRequesterBearer(
  token: string,
  presenter: LiveAgencyServicePrincipal,
): Promise<ForegroundRequesterBinding | null> {
  const validation = validateAccessToken(token);
  if (!validation.valid || !validation.payload?.sessionId) return null;
  const current = await liveSession(validation.payload.sessionId, presenter);
  if (!current || current.session.accessToken !== token) return null;
  if (!checkAccessTokenBinding(validation.payload, current.session).ok) return null;
  if (typeof validation.payload.exp !== 'number') return null;
  return {
    ...current.binding,
    expiresAt: new Date(
      Math.min(current.binding.expiresAt.getTime(), validation.payload.exp * 1000),
    ),
  };
}

export async function revalidateForegroundRequester(
  binding: {
    sessionId: string;
    principalAccountId: string;
    subjectAccountId: string;
    digest: string;
  },
  presenter: LiveAgencyServicePrincipal,
): Promise<boolean> {
  const current = await liveSession(binding.sessionId, presenter);
  return (
    !!current &&
    current.binding.principalAccountId === binding.principalAccountId &&
    current.binding.subjectAccountId === binding.subjectAccountId &&
    current.binding.digest === binding.digest
  );
}
