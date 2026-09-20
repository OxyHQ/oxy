import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { intersectScopes, workloadBindingScopes } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import { workloadAttestationHandle } from './workloadAttestation.service';

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

/**
 * What an ATTESTED first-party caller is, re-read live.
 *
 * `LiveAgencyServicePrincipal`'s counterpart for ADR 0026: same application,
 * trust, owner and closure-fence questions, asked of the row that actually
 * authorises an attested caller. A workload has no `ApplicationCredential`, so
 * `resolveLiveAgencyCoordinator` can answer nothing about it and must not be
 * asked a question about some other credential of the same application instead
 * — that would check a row the caller does not hold and call it a ceiling.
 */
export interface LiveAgencyWorkloadPrincipal {
  readonly applicationId: string;
  readonly provider: string;
  readonly subject: string;
  /** `wl_…` — what a token minted from this binding carries as `credentialId`. */
  readonly handle: string;
  readonly ownerAccountId: string;
  readonly scopes: readonly string[];
}

/**
 * The live ceiling for an attested caller, looked up by the ROLE it attested.
 *
 * Every refusal below is a live revocation taking effect on the next call,
 * which is the property this exists for — an attested token lives an hour, and
 * nothing in it may outlive the row that authorised it:
 *
 *   * the binding row was DELETED (how a compromised workload is cut off) or
 *     `expiresAt` has passed (how a retiring one is wound down);
 *   * the binding was re-pointed at another application, so it no longer
 *     authorises `applicationId`;
 *   * the application is no longer `active`, or is no longer trusted
 *     first-party — the same gate `exchangeWorkloadAttestation` applies at mint;
 *   * the owner account was suspended or is behind a closure fence;
 *   * the scopes the binding names no longer reach `inference:invoke`, decided
 *     by the same `workloadBindingScopes` the mint used, so what an hour-old
 *     token may still do can never exceed what a fresh one would be given.
 */
export async function resolveLiveAgencyWorkload(
  applicationId: string,
  provider: string,
  subject: string,
  now: Date = new Date(),
): Promise<LiveAgencyWorkloadPrincipal | null> {
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      applicationType: applications.type,
      applicationIsOfficial: applications.isOfficial,
      applicationIsInternal: applications.isInternal,
      applicationScopes: applications.scopes,
      bindingScopes: applicationWorkloadIdentities.scopes,
      ownerAccountStatus: users.accountStatus,
      ownerClosureFence: accountClosureFences.accountId,
    })
    .from(applicationWorkloadIdentities)
    .innerJoin(applications, eq(applications.id, applicationWorkloadIdentities.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(and(
      eq(applicationWorkloadIdentities.applicationId, applicationId),
      eq(applicationWorkloadIdentities.provider, provider),
      eq(applicationWorkloadIdentities.subject, subject),
      or(
        isNull(applicationWorkloadIdentities.expiresAt),
        gt(applicationWorkloadIdentities.expiresAt, now),
      ),
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
  ) return null;

  return {
    applicationId: row.applicationId,
    provider,
    subject,
    handle: workloadAttestationHandle(subject),
    ownerAccountId: row.ownerAccountId,
    scopes: workloadBindingScopes(row.bindingScopes, row.applicationScopes),
  };
}

export function principalHasCatalogCapability(
  principal: LiveAgencyServicePrincipal,
  appSlug: string,
): boolean {
  return principal.capabilities.includes(`catalog:${appSlug}`);
}
