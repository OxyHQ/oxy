import { and, eq } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { intersectScopes } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';

export interface LiveAgencyServicePrincipal {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly scopes: readonly string[];
  readonly capabilities: readonly string[];
}

async function loadPrincipal(applicationId: string, credentialId: string) {
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      applicationType: applications.type,
      applicationIsOfficial: applications.isOfficial,
      applicationIsInternal: applications.isInternal,
      applicationScopes: applications.scopes,
      capabilities: applications.capabilities,
      credentialId: applicationCredentials.id,
      credentialType: applicationCredentials.type,
      credentialEnvironment: applicationCredentials.environment,
      credentialScopes: applicationCredentials.scopes,
      credentialStatus: applicationCredentials.status,
      credentialExpiresAt: applicationCredentials.expiresAt,
      ownerAccountStatus: users.accountStatus,
      ownerClosureFence: accountClosureFences.accountId,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(and(
      eq(applicationCredentials.id, credentialId),
      eq(applicationCredentials.applicationId, applicationId),
    ))
    .limit(1);
  if (
    !row
    || row.applicationStatus !== 'active'
    || !isTrustedApplication({
      type: row.applicationType,
      isOfficial: row.applicationIsOfficial,
      isInternal: row.applicationIsInternal,
    })
    || row.ownerAccountStatus !== 'active'
    || row.ownerClosureFence !== null
    || row.credentialType !== 'service'
    || !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
  ) return null;
  const scopes = row.credentialScopes.length > 0
    ? intersectScopes(row.credentialScopes, row.applicationScopes)
    : row.applicationScopes;
  return { row, scopes };
}

/** Re-resolves mutable app, credential, scope and capability authority on every control-plane call. */
export async function resolveLiveAgencyServicePrincipal(
  token: ServiceTokenPayload,
): Promise<LiveAgencyServicePrincipal | null> {
  const loaded = await loadPrincipal(token.appId, token.credentialId);
  if (
    !loaded
    || loaded.row.ownerAccountId !== token.ownerAccountId
    || loaded.row.credentialEnvironment !== token.environment
  ) return null;
  const row = loaded.row;
  return {
    applicationId: row.applicationId,
    credentialId: row.credentialId,
    ownerAccountId: row.ownerAccountId,
    scopes: intersectScopes(token.scopes, loaded.scopes),
    capabilities: row.capabilities,
  };
}

export async function resolveLiveAgencyCoordinator(
  applicationId: string,
  credentialId: string,
): Promise<LiveAgencyServicePrincipal | null> {
  const loaded = await loadPrincipal(applicationId, credentialId);
  if (!loaded) return null;
  return {
    applicationId: loaded.row.applicationId,
    credentialId: loaded.row.credentialId,
    ownerAccountId: loaded.row.ownerAccountId,
    scopes: loaded.scopes,
    capabilities: loaded.row.capabilities,
  };
}

export function principalHasCatalogCapability(
  principal: LiveAgencyServicePrincipal,
  appSlug: string,
): boolean {
  return principal.capabilities.includes(`catalog:${appSlug}`);
}
