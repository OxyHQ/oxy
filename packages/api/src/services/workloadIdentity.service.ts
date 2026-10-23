import { serviceTokenScopesSchema } from '@oxy.so/contracts';
import { isLegacyWorkloadCohort } from '../config/legacyWorkloadTransition';
import { audienceRefusal } from '../config/serviceTokenAudiences';
import { workloadBindingScopes } from '../utils/applicationScopes';
import { workloadTokenEnvironment } from '../utils/credentialEnvironment';
import crypto from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { getRedisClient } from '../config/redis';
import { deploymentCredentialEnvironment } from '../utils/credentialEnvironment';
import { isTrustedApplication } from '../utils/trustedApplication';
import { logger } from '../utils/logger';
import { mintServiceToken, SERVICE_TOKEN_EXPIRY } from './serviceTokenMint.service';
import { isSupervised } from './supervisionPolicy.service';
import {
  KAANA_CONTROL_AUDIENCE,
  KAANA_CONTROL_APPLICATION_ID,
  KAANA_PUBLIC_AUDIENCE,
  serviceAudienceApplicationId,
  OXY_API_AUDIENCE,
  type ServiceTokenAudience,
} from '../config/serviceTokenAudiences';
import {
  verifyWorkloadAttestation,
  type AttestationProvider,
  AttestationError,
} from './workloadAttestation.service';
import {
  ensureWorkloadAttributionIdentity,
  WorkloadAttributionError,
} from './workloadAttributionIdentity.service';

/**
 * Minting a service token from a workload attestation — the credential-free
 * path for Oxy's own services.
 *
 * A first-party service proves what it is with an attestation its
 * infrastructure issued (`workloadAttestation.service.ts`), this module decides
 * which application that is and what it may do, and the token it receives is
 * the same one `/auth/service-token` mints from an api key and secret. Nothing
 * downstream is aware of which path a token came from, which is the property
 * that makes the migration off shared secrets a per-service decision rather
 * than a flag day.
 *
 * ## The challenge, and why it is not optional
 *
 * An attestation is a signed statement, and a signed statement can be replayed
 * by anyone who captures it. So a mint takes two calls: ask for a nonce, then
 * present an attestation that signs it. The nonce lives in Redis for a minute
 * and is DELETED as it is read, so a second use of the same attestation finds
 * nothing to match and is refused.
 *
 * Redis is a hard requirement here rather than a cache. Without it a nonce
 * cannot be single-use across the several API tasks that serve these calls, and
 * a replay window that is "however long the attacker likes" is not a degraded
 * mode worth having — so a deployment with no Redis refuses to mint at all.
 */

/** How long a challenge stands. Long enough to sign, short enough to matter. */
const CHALLENGE_TTL_SECONDS = 60;
const CHALLENGE_PREFIX = 'wl:challenge:';

export class WorkloadIdentityError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = 'WorkloadIdentityError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Issues a single-use challenge.
 *
 * The nonce is a random 32-byte value; it is never derived from the caller,
 * because a caller-derived nonce is one the caller can predict and pre-sign.
 */
export async function issueWorkloadChallenge(): Promise<{ nonce: string; expiresIn: number }> {
  const redis = getRedisClient();
  if (!redis) {
    throw new WorkloadIdentityError(
      503,
      'no_challenge_store',
      'Workload identity is unavailable here.',
    );
  }
  const nonce = crypto.randomBytes(32).toString('base64url');
  await redis.set(`${CHALLENGE_PREFIX}${nonce}`, '1', 'EX', CHALLENGE_TTL_SECONDS);
  return { nonce, expiresIn: CHALLENGE_TTL_SECONDS };
}

/**
 * Spends a challenge, returning whether it was outstanding.
 *
 * `GETDEL` rather than a read then a delete: two tasks racing on one nonce must
 * not both see it, and the atomic form is what makes "single-use" true under
 * concurrency rather than merely usually.
 */
async function spendChallenge(nonce: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    // Not the caller's fault: this task has no challenge store, so every
    // exchange it serves is refused. Loud, because it looks like a bad nonce.
    logger.error('[WorkloadIdentity] no challenge store on this task; refusing the exchange');
    return false;
  }
  const spent = await redis.getdel(`${CHALLENGE_PREFIX}${nonce}`);
  return spent !== null;
}

export interface WorkloadTokenGrant {
  token: string;
  expiresIn: number;
  appName: string;
}

/**
 * Exchanges an attestation for a service token.
 *
 * The order of checks is the security argument: the challenge is spent before
 * anything expensive happens (so a flood of replays costs one Redis call each),
 * the attestation is verified by its provider (so the identity comes from the
 * infrastructure, not the caller), and only then is a binding looked up.
 */
export async function exchangeWorkloadAttestation(input: {
  provider: AttestationProvider;
  attestation: unknown;
  nonce: string;
  /** The resource server the token is for (Kaana ADR 0002); `oxy-api` when omitted. */
  audience?: ServiceTokenAudience;
  scopes?: string[];
  protocolVersion?: 2;
}): Promise<WorkloadTokenGrant> {
  const audience = input.audience ?? OXY_API_AUDIENCE;
  if (!(await spendChallenge(input.nonce))) {
    // Logged like every other refusal: an unlogged 401 here cost an incident
    // its diagnosis (2026-09-25, Mention's MCP refused for 28 minutes with no
    // trace on this side). The nonce itself is never logged.
    logger.warn('[WorkloadIdentity] attestation refused', {
      provider: input.provider,
      reason: 'unknown_challenge',
      nonceLength: typeof input.nonce === 'string' ? input.nonce.length : 0,
    });
    throw new WorkloadIdentityError(
      401,
      'unknown_challenge',
      'That challenge is unknown or already used.',
    );
  }

  let attested;
  try {
    attested = await verifyWorkloadAttestation(input.provider, input.attestation, input.nonce);
  } catch (error: unknown) {
    if (error instanceof AttestationError) {
      logger.warn('[WorkloadIdentity] attestation refused', {
        provider: input.provider,
        reason: error.reason,
      });
      throw new WorkloadIdentityError(401, error.reason, 'The attestation could not be verified.');
    }
    throw error;
  }

  const now = new Date();
  const [binding] = await getDb()
    .select({
      /** The row the attested identity's ledger attribution is materialised from. */
      bindingId: applicationWorkloadIdentities.id,
      applicationId: applicationWorkloadIdentities.applicationId,
      appName: applications.name,
      ownerAccountId: applications.ownerAccountId,
      ownerStatus: users.accountStatus,
      ownerClosure: accountClosureFences.accountId,
      environment: applicationWorkloadIdentities.environment,
      bindingScopes: applicationWorkloadIdentities.scopes,
      applicationScopes: applications.scopes,
      status: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applicationWorkloadIdentities)
    .innerJoin(applications, eq(applications.id, applicationWorkloadIdentities.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(
      and(
        eq(applicationWorkloadIdentities.provider, attested.provider),
        eq(applicationWorkloadIdentities.subject, attested.subject),
        or(
          isNull(applicationWorkloadIdentities.expiresAt),
          gt(applicationWorkloadIdentities.expiresAt, now),
        ),
      ),
    )
    .limit(1);

  if (!binding) {
    // The subject is NOT logged: it names a role in our own infrastructure, and
    // an unbound subject is exactly the case where the caller is not ours.
    logger.warn('[WorkloadIdentity] attested workload has no binding', {
      provider: attested.provider,
    });
    throw new WorkloadIdentityError(
      403,
      'unbound_workload',
      'That workload is not bound to an application.',
    );
  }

  if (
    binding.status !== 'active' ||
    binding.ownerStatus !== 'active' ||
    binding.ownerClosure !== null
  ) {
    throw new WorkloadIdentityError(403, 'application_inactive', 'That application is not active.');
  }

  /**
   * The same gate the credential path applies, restated because it is the one
   * that keeps this path first-party.
   *
   * A binding row should only ever name an official application, but "should"
   * is not a check: a third-party application that somehow acquired a row still
   * cannot mint here.
   */
  if (!isTrustedApplication(binding)) {
    throw new WorkloadIdentityError(
      403,
      'untrusted_application',
      'Service tokens are only available to trusted applications.',
    );
  }

  const firstParty = input.protocolVersion === 2;
  if (
    !firstParty &&
    !isLegacyWorkloadCohort({
      id: binding.bindingId,
      applicationId: binding.applicationId,
      provider: attested.provider,
      subject: attested.subject,
    })
  ) {
    throw new WorkloadIdentityError(
      400,
      'workload_protocol_upgrade_required',
      'Upgrade the service SDK to workload protocol version 2.',
    );
  }
  if (
    firstParty &&
    (binding.environment === null || binding.environment !== deploymentCredentialEnvironment())
  ) {
    throw new WorkloadIdentityError(
      403,
      'workload_environment_unbound',
      'The workload must be bound to this environment before it can mint.',
    );
  }
  if (firstParty && input.scopes !== undefined) {
    throw new WorkloadIdentityError(
      400,
      'workload_scopes_unsupported',
      'First-party workloads authenticate without scopes.',
    );
  }
  const environment = firstParty
    ? binding.environment!
    : (binding.environment ?? workloadTokenEnvironment());
  if (environment !== deploymentCredentialEnvironment()) {
    throw new WorkloadIdentityError(
      403,
      'workload_environment_unbound',
      'The workload belongs to another environment.',
    );
  }
  let legacyScopes: string[] | undefined;
  if (!firstParty) {
    const granted = workloadBindingScopes(binding.bindingScopes, binding.applicationScopes);
    legacyScopes =
      input.scopes === undefined ? granted : serviceTokenScopesSchema.parse(input.scopes);
    if (legacyScopes.some((scope) => !new Set<string>(granted).has(scope))) {
      throw new WorkloadIdentityError(
        403,
        'scope_not_granted',
        'A requested service scope is not granted.',
      );
    }
    const refusal = audienceRefusal(audience, binding.applicationId, legacyScopes);
    if (refusal || audience.startsWith('oxy-service:')) {
      throw new WorkloadIdentityError(
        403,
        refusal ?? 'invalid_service_audience',
        'Upgrade the service SDK for this audience.',
      );
    }
  }
  if (await isSupervised(binding.ownerAccountId)) {
    throw new WorkloadIdentityError(403, 'owner_unavailable', 'The owning account cannot operate.');
  }
  const receiverId = serviceAudienceApplicationId(audience);
  if (receiverId) {
    const [receiver] = await getDb()
      .select({
        status: applications.status,
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applications)
      .where(eq(applications.id, receiverId))
      .limit(1);
    if (!receiver || receiver.status !== 'active' || !isTrustedApplication(receiver)) {
      throw new WorkloadIdentityError(
        403,
        'unregistered_service_audience',
        'The receiving service is unavailable.',
      );
    }
  } else if (
    audience !== OXY_API_AUDIENCE &&
    audience !== KAANA_PUBLIC_AUDIENCE &&
    !(audience === KAANA_CONTROL_AUDIENCE && binding.applicationId === KAANA_CONTROL_APPLICATION_ID)
  ) {
    throw new WorkloadIdentityError(
      403,
      'invalid_service_audience',
      'The receiving service is unavailable.',
    );
  }

  /**
   * The row the spend will be attributed to, before the token exists.
   *
   * This is the single point at which a `wl_…` `credentialId` enters
   * circulation, so it is the right place to make "every token naming a handle
   * has a row the usage ledger can reference" a precondition rather than a hope.
   * `usage_reservations`, `usage_receipts`, `inference_usage_events` and
   * `inference_usage_daily_rollups` all carry that identity `NOT NULL` with a
   * foreign key to `application_credentials.id`, so without the row the first
   * reservation of an otherwise perfectly authenticated caller fails a
   * constraint mid-request — which is why the inference edge refused an attested
   * caller outright until this existed.
   *
   * Doing it here also means the bindings already live in production need no
   * backfill: their next mint writes the row. It is one indexed probe per mint,
   * and a mint is once an hour per task.
   */
  let attribution;
  try {
    attribution = await ensureWorkloadAttributionIdentity({
      bindingId: binding.bindingId,
      applicationId: binding.applicationId,
      subject: attested.subject,
    });
  } catch (error: unknown) {
    if (error instanceof WorkloadAttributionError) {
      // The role has spent money as another application. Refusing the mint is
      // the only answer that neither relabels that history nor issues a token
      // whose first reservation would fail.
      logger.error('[WorkloadIdentity] attested identity is attributed to another application', {
        provider: attested.provider,
        attestationId: attested.attestationId,
        applicationId: binding.applicationId,
      });
      throw new WorkloadIdentityError(
        403,
        'workload_attribution_conflict',
        'That workload identity is recorded against a different application.',
      );
    }
    throw error;
  }

  const token = mintServiceToken(
    {
      appId: binding.applicationId,
      appName: binding.appName,
      /**
       * The id of the row that was just materialised, not a second computation of
       * it.
       *
       * The two are the same value by definition — `attested.attestationId` IS
       * `workloadAttestationHandle(canonicalSubject)` and so is this — and taking
       * it from the write is what makes them impossible to disagree. What this
       * claim has to be is the id of a row the usage ledger can reference; using
       * the one that was written says so, where using the verifier's copy would be
       * a promise that two functions still agree.
       */
      credentialId: attribution.credentialId,
      ownerAccountId: binding.ownerAccountId,
      // Explicit staff-managed binding, checked against this deployment above.
      environment,
      // Only a trusted application passes the gate above: a workload identity is
      // always one of Oxy's own.
      tier: 'internal',
      ...(firstParty
        ? { authority: 'first_party' as const }
        : { authority: 'external' as const, scopes: legacyScopes! }),
    },
    audience,
  );

  await getDb()
    .update(applications)
    .set({ lastUsedAt: now })
    .where(eq(applications.id, binding.applicationId));

  logger.info('[WorkloadIdentity] service token issued', {
    applicationId: binding.applicationId,
    appName: binding.appName,
    provider: attested.provider,
    attestationId: attribution.credentialId,
    /** `created` the first time this workload ever mints; otherwise `unchanged`. */
    attribution: attribution.state,
    authority: firstParty ? 'first_party' : 'external',
    protocolVersion: firstParty ? 2 : 1,
    environment,
    audience,
  });

  return { token, expiresIn: SERVICE_TOKEN_EXPIRY, appName: binding.appName };
}
