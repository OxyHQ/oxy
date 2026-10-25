import { isSupervised } from './supervisionPolicy.service';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { intersectScopes } from '../utils/applicationScopes';
import { deploymentCredentialEnvironment } from '../utils/credentialEnvironment';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import {
  isWorkloadAttestationHandle,
  workloadAttestationHandle,
} from './workloadAttestation.service';

export interface LiveAgencyServicePrincipal {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly authority?: 'first_party' | 'external';
  readonly scopes?: readonly string[];
  readonly capabilities: readonly string[];
}

async function loadPrincipal(applicationId: string, credentialId: string, requireTrusted = true) {
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
    .where(
      and(
        eq(applicationCredentials.id, credentialId),
        eq(applicationCredentials.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (
    row?.applicationStatus !== 'active' ||
    (requireTrusted &&
      !isTrustedApplication({
        type: row.applicationType,
        isOfficial: row.applicationIsOfficial,
        isInternal: row.applicationIsInternal,
      })) ||
    row.ownerAccountStatus !== 'active' ||
    row.ownerClosureFence !== null ||
    row.credentialType !== 'service' ||
    !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
  )
    return null;
  if (await isSupervised(row.ownerAccountId)) return null;
  const scopes =
    row.credentialScopes.length > 0
      ? intersectScopes(row.credentialScopes, row.applicationScopes)
      : row.applicationScopes;
  return { row, scopes };
}

/**
 * Re-resolve live app, workload/credential and owner before every service call.
 * Own workloads require a provisioned environment, active binding and trusted
 * registry identity; their authority contains no scopes. External credentials
 * retain their live scope intersection; legacy workload tokens are refused.
 * Token owner/environment claims must match this current administrative binding.
 */
export async function resolveLiveAgencyServicePrincipal(
  token: ServiceTokenPayload,
): Promise<LiveAgencyServicePrincipal | null> {
  if (await isSupervised(token.ownerAccountId)) return null;
  if (isWorkloadAttestationHandle(token.credentialId)) {
    if (token.authority !== 'first_party') return null;
    const binding = await resolveLiveAgencyWorkloadByHandle(token.appId, token.credentialId);
    if (
      binding === null ||
      binding.ownerAccountId !== token.ownerAccountId ||
      token.environment !== binding.environment ||
      (token.authority === 'first_party' && !binding.environmentBound)
    )
      return null;
    return {
      applicationId: binding.applicationId,
      // The handle, which is what the token presented and what the usage ledger
      // records. Never some credential the application also happens to hold —
      // that would be checking a row this caller does not have and calling it a
      // ceiling.
      credentialId: binding.handle,
      ownerAccountId: binding.ownerAccountId,
      authority: 'first_party',
      capabilities: binding.capabilities,
    };
  }

  if (token.authority === 'first_party') return null;
  const loaded = await loadPrincipal(token.appId, token.credentialId);
  if (
    !loaded ||
    loaded.row.ownerAccountId !== token.ownerAccountId ||
    loaded.row.credentialEnvironment !== token.environment
  )
    return null;
  const row = loaded.row;
  return {
    applicationId: row.applicationId,
    credentialId: row.credentialId,
    ownerAccountId: row.ownerAccountId,
    authority: 'external',
    scopes: intersectScopes(token.scopes ?? [], loaded.scopes),
    capabilities: row.capabilities,
  };
}

/** Signed external service authority for a registered resource receiver.
 * Agency coordinator eligibility stays separate; branding cannot grant own authority.
 */
export async function resolveLiveExternalServicePrincipal(
  token: ServiceTokenPayload,
): Promise<LiveAgencyServicePrincipal | null> {
  if (token.authority === 'first_party') return null;
  if (isWorkloadAttestationHandle(token.credentialId))
    return resolveLiveAgencyServicePrincipal(token);
  const loaded = await loadPrincipal(token.appId, token.credentialId, false);
  if (
    !loaded ||
    loaded.row.ownerAccountId !== token.ownerAccountId ||
    loaded.row.credentialEnvironment !== token.environment
  )
    return null;
  return {
    applicationId: loaded.row.applicationId,
    credentialId: loaded.row.credentialId,
    ownerAccountId: loaded.row.ownerAccountId,
    authority: 'external',
    scopes: intersectScopes(token.scopes ?? [], loaded.scopes),
    capabilities: [],
  };
}

/**
 * The live coordinator a capability execution authorization or ticket names.
 *
 * The pair it is asked about is what `GET /capabilities/service-identity`
 * handed the coordinator, which is {@link resolveLiveAgencyServicePrincipal}'s
 * answer — so an ATTESTED coordinator (ADR 0026, a `wl_…` handle) must re-read
 * through the same binding arm that answered it. Without that arm every
 * execution authorization an attested Alia asked for was refused
 * `coordinator_not_active_or_authorized`, and every native app tool it offered
 * failed at the first call. The handle is also the materialised attribution
 * row's id, so it satisfies the `coordinator_credential_id` foreign key.
 *
 * A workload ROW is still never read through `loadPrincipal`: that requires
 * `type = 'service'`, and a handle is routed to the binding before it gets there.
 */
export async function resolveLiveAgencyCoordinator(
  applicationId: string,
  credentialId: string,
  authority: 'first_party' | 'external' = 'external',
): Promise<LiveAgencyServicePrincipal | null> {
  if (isWorkloadAttestationHandle(credentialId)) {
    if (authority !== 'first_party') return null;
    const binding = await resolveLiveAgencyWorkloadByHandle(applicationId, credentialId);
    if (binding === null || (authority === 'first_party' && !binding.environmentBound)) return null;
    return {
      applicationId: binding.applicationId,
      credentialId: binding.handle,
      ownerAccountId: binding.ownerAccountId,
      authority: 'first_party',
      capabilities: binding.capabilities,
    };
  }
  if (authority === 'first_party') return null;
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
 * authorises an attested caller. A workload has no service `ApplicationCredential`,
 * so its liveness is never read from some other credential of the same
 * application — that would check a row the caller does not hold and call it a
 * ceiling. `resolveLiveAgencyCoordinator` routes a handle here instead.
 */
export interface LiveAgencyWorkloadPrincipal {
  readonly bindingId: string;
  readonly applicationId: string;
  readonly environment: 'development' | 'staging' | 'production';
  readonly environmentBound: boolean;
  readonly provider: string;
  readonly subject: string;
  /** `wl_…` — what a token minted from this binding carries as `credentialId`. */
  readonly handle: string;
  readonly ownerAccountId: string;
  /**
   * The APPLICATION's capabilities, read exactly as the credential arm reads
   * them.
   *
   * A capability is staff-granted on the application and says what that service
   * IS — Kaana's `kaana:provider-credential-validation`, a catalogue owner's
   * `catalog:<slug>` — so it does not depend on which proof the caller presented
   * and there is no second vocabulary here. It is carried because
   * {@link resolveLiveAgencyServicePrincipal} needs it on both arms, and a
   * capability gate that silently saw an empty array would refuse an attested
   * caller with a message about the wrong thing.
   */
  readonly capabilities: readonly string[];
}

/**
 * The live registered identity for an attested caller, looked up by its subject.
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
 *   * the administratively bound environment differs from this deployment.
 *
 * Workload scopes are never projected. Explicit first-party authority is accepted
 * only after this live identity check.
 */
export async function resolveLiveAgencyWorkload(
  applicationId: string,
  provider: string,
  subject: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<LiveAgencyWorkloadPrincipal | null> {
  const [row] = await db
    .select({
      bindingId: applicationWorkloadIdentities.id,
      applicationId: applications.id,
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      applicationType: applications.type,
      applicationIsOfficial: applications.isOfficial,
      applicationIsInternal: applications.isInternal,
      capabilities: applications.capabilities,
      environment: applicationWorkloadIdentities.environment,
      ownerAccountStatus: users.accountStatus,
      ownerClosureFence: accountClosureFences.accountId,
    })
    .from(applicationWorkloadIdentities)
    .innerJoin(applications, eq(applications.id, applicationWorkloadIdentities.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(
      and(
        eq(applicationWorkloadIdentities.applicationId, applicationId),
        eq(applicationWorkloadIdentities.provider, provider),
        eq(applicationWorkloadIdentities.subject, subject),
        or(
          isNull(applicationWorkloadIdentities.expiresAt),
          gt(applicationWorkloadIdentities.expiresAt, now),
        ),
      ),
    )
    .limit(1);

  if (
    row?.applicationStatus !== 'active' ||
    row.environment === null ||
    row.environment !== deploymentCredentialEnvironment() ||
    !isTrustedApplication({
      type: row.applicationType,
      isOfficial: row.applicationIsOfficial,
      isInternal: row.applicationIsInternal,
    }) ||
    row.ownerAccountStatus !== 'active' ||
    row.ownerClosureFence !== null
  )
    return null;

  if (await isSupervised(row.ownerAccountId)) return null;
  return {
    bindingId: row.bindingId,
    applicationId: row.applicationId,
    provider,
    subject,
    environment: row.environment,
    environmentBound: row.environment !== null,
    handle: workloadAttestationHandle(subject),
    ownerAccountId: row.ownerAccountId,
    capabilities: row.capabilities,
  };
}

/**
 * The same live registered identity, addressed by the minted token handle.
 *
 * {@link resolveLiveAgencyWorkload} takes the role, for a caller that declared
 * the ARN it admits. A consumer of an attested token has only what the token
 * says: `credentialId` is
 * `workloadAttestationHandle(subject)`, and the handle is SHA-256, so the
 * subject cannot be read back out of it. This resolves the other way round —
 * find the binding whose subject DERIVES to this handle — and then asks
 * {@link resolveLiveAgencyWorkload} the liveness question, so there is exactly
 * one definition of "a live binding" and this cannot drift from it.
 *
 * ## Why `applicationId` scopes the search
 *
 * The candidate query is the bindings of the application the token names, and
 * the handle then has to match one of them exactly. `appId` and `credentialId`
 * are a PAIR this deployment's own mint wrote together
 * (`services/workloadIdentity.service.ts` takes both from the binding row), and
 * the pair is covered by the token's signature — so a caller cannot present one
 * application's handle under another application's name without forging the
 * JWT, which is the assumption every other re-read on this path already makes.
 * `resolveLiveAgencyServicePrincipal` scopes its credential lookup by
 * `token.appId` for the same reason. What it buys is an indexed lookup
 * (`application_workload_identities_application_idx`) instead of a scan of
 * every binding in the table on a request path the inference edge is on.
 *
 * It is a FILTER and never an answer: everything returned below comes from the
 * binding row and the rows it joins, and a binding re-pointed at another
 * application stops matching here — which is the revocation behaviour
 * {@link resolveLiveAgencyWorkload} documents.
 *
 * ## The candidate must also be MATERIALISED, and that is free here
 *
 * An attested caller resolved by this function goes on to spend, and the usage
 * ledger names the identity that authorised a spend with a foreign key to
 * `application_credentials.id` — satisfied by the `workload` row
 * `services/workloadAttributionIdentity.service.ts` materialises from the binding
 * (`db/schema/applicationCredentials.ts` has the argument). Both writers of that
 * row run before a token naming the handle can exist, so in practice it is always
 * there; if it were NOT, the first reservation would fail a constraint half way
 * through an authenticated request, which is exactly the 500 the edge's
 * `workload_attribution_unsupported` holding position existed to avoid.
 *
 * So the candidate query joins it, on the unique `workload_identity_id`, and the
 * handle has to match the row's id as well as derive from the subject. That costs
 * nothing — one more join on a unique index in a query already being run — and it
 * turns the missing-row case into the same clean refusal every other liveness
 * failure gets, while checking the binding→row LINK rather than only re-deriving
 * a hash. `resolveLiveAgencyWorkload` is deliberately left alone: its caller
 * declares an ARN and does not spend.
 */
export async function resolveLiveAgencyWorkloadByHandle(
  applicationId: string,
  handle: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<LiveAgencyWorkloadPrincipal | null> {
  // Cheap and total: the handle space and the credential-id space are disjoint
  // (`isWorkloadAttestationHandle`), so this refuses a credential id without a
  // query rather than looking for a binding that could never exist.
  if (!isWorkloadAttestationHandle(handle)) return null;

  const candidates = await db
    .select({
      provider: applicationWorkloadIdentities.provider,
      subject: applicationWorkloadIdentities.subject,
      /** The materialised row's id, or null when the binding has none. */
      attributionId: applicationCredentials.id,
    })
    .from(applicationWorkloadIdentities)
    .leftJoin(
      applicationCredentials,
      eq(applicationCredentials.workloadIdentityId, applicationWorkloadIdentities.id),
    )
    .where(eq(applicationWorkloadIdentities.applicationId, applicationId));

  const match = candidates.find(
    (candidate) =>
      workloadAttestationHandle(candidate.subject) === handle && candidate.attributionId === handle,
  );
  if (match === undefined) return null;

  return resolveLiveAgencyWorkload(applicationId, match.provider, match.subject, now, db);
}

export function principalHasCatalogCapability(
  principal: LiveAgencyServicePrincipal,
  appSlug: string,
): boolean {
  return (
    principal.authority === 'first_party' || principal.capabilities.includes(`catalog:${appSlug}`)
  );
}
