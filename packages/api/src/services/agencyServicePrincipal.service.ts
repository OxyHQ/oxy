import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import {
  intersectScopes,
  workloadBindingScopes,
  type ApplicationScope,
} from '../utils/applicationScopes';
import { workloadTokenEnvironment } from '../utils/credentialEnvironment';
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

/**
 * Re-resolves mutable app, credential, scope and capability authority on every
 * control-plane call — whichever proof the token was minted from.
 *
 * ## Why this needed a second arm
 *
 * It looked `token.credentialId` up in `application_credentials` and nowhere
 * else. An ADR 0026 attested token carries a `wl_…` attestation handle there, so
 * every route that re-reads its caller through this function refused an attested
 * first-party service. Measured against production from the same AWS account
 * minutes apart, `GET /capabilities/service-identity` answered `200` with Kaana's
 * key pair and `401 service_principal_no_longer_active` with a token attested
 * from `oxy-kaana-task` — and `authorizeKaanaValidation`
 * (`routes/inferenceProviderConnections.ts`), the gate on the BYOK validation
 * callback Kaana actually makes, is one of those routes. So Kaana could not give
 * its key pair up, and Mention — credential-free already and holding
 * `signals:write` — had the same defect latent behind
 * `req.serviceApp.credentialId` in `reputation.routes.ts` and `capabilities.ts`.
 *
 * `resolveServiceTokenPrincipal` (`services/attribution.service.ts`) fixed the
 * same shape of bug one resolver over. This is a second CALLER of the helper that
 * one added, {@link resolveLiveAgencyWorkloadByHandle}, not a second mechanism:
 * "what is a live binding" has exactly one definition and both hops ask it.
 *
 * ## The attested arm is not the weaker one
 *
 * {@link resolveLiveAgencyWorkloadByHandle} re-reads the binding on every call,
 * so deleting it — how a compromised workload is cut off — takes effect as fast
 * as revoking a credential does, and an expiry, a re-point, a suspended or
 * demoted application, a suspended owner, a closure fence and a scope the binding
 * no longer names all refuse there. It asks MORE than the credential arm does:
 * the credential arm does not care whether the application is still trusted
 * first-party, and this one does, because that is the gate the mint applies.
 *
 * The two claims checked HERE rather than there are the ones that are about this
 * token rather than about the binding, and they mirror the credential arm exactly:
 *
 *   * the owner account the token names must be the one the application has now,
 *     so a token cannot outlive a transfer;
 *   * the environment must be this deployment's. A binding has none — a workload
 *     proves what it is, never which environment it means — so
 *     `workloadTokenEnvironment()` is the whole answer, and it is the same single
 *     definition the mint wrote the claim from. A staging-minted token presented
 *     here is refused, which is what the credential arm's environment comparison
 *     buys on its side.
 *
 * Every refusal is still one `null`, and the callers still answer one
 * `service_principal_no_longer_active` — so an attested caller cannot probe
 * whether a binding exists, exactly as a credential caller cannot probe a
 * credential's lifecycle.
 */
export async function resolveLiveAgencyServicePrincipal(
  token: ServiceTokenPayload,
): Promise<LiveAgencyServicePrincipal | null> {
  if (isWorkloadAttestationHandle(token.credentialId)) {
    const binding = await resolveLiveAgencyWorkloadByHandle(token.appId, token.credentialId);
    if (
      binding === null
      || binding.ownerAccountId !== token.ownerAccountId
      || token.environment !== workloadTokenEnvironment()
    ) return null;
    return {
      applicationId: binding.applicationId,
      // The handle, which is what the token presented and what the usage ledger
      // records. Never some credential the application also happens to hold —
      // that would be checking a row this caller does not have and calling it a
      // ceiling.
      credentialId: binding.handle,
      ownerAccountId: binding.ownerAccountId,
      // `token ∩ live`, the same composition the credential arm applies: an
      // hour-old token can never do more than a fresh mint would give it, and
      // never more than it already claimed.
      scopes: intersectScopes(token.scopes, binding.scopes),
      capabilities: binding.capabilities,
    };
  }

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
  /** What `workloadBindingScopes` decides, in its own vocabulary. */
  readonly scopes: readonly ApplicationScope[];
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
      capabilities: applications.capabilities,
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
    capabilities: row.capabilities,
  };
}

/**
 * The same live ceiling, addressed by the HANDLE a minted token carries.
 *
 * {@link resolveLiveAgencyWorkload} takes the role because its caller declared
 * one — a native product agent entry point names the ARN it admits. Every other
 * consumer of an attested token has only what the token says: `credentialId` is
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
): Promise<LiveAgencyWorkloadPrincipal | null> {
  // Cheap and total: the handle space and the credential-id space are disjoint
  // (`isWorkloadAttestationHandle`), so this refuses a credential id without a
  // query rather than looking for a binding that could never exist.
  if (!isWorkloadAttestationHandle(handle)) return null;

  const candidates = await getDb()
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
      workloadAttestationHandle(candidate.subject) === handle
      && candidate.attributionId === handle,
  );
  if (match === undefined) return null;

  return resolveLiveAgencyWorkload(applicationId, match.provider, match.subject, now);
}

export function principalHasCatalogCapability(
  principal: LiveAgencyServicePrincipal,
  appSlug: string,
): boolean {
  return principal.capabilities.includes(`catalog:${appSlug}`);
}
