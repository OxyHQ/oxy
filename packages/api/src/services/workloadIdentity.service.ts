import crypto from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { getRedisClient } from '../config/redis';
import { isProduction } from '../config/env';
import { isPrivilegedScope } from '../utils/applicationScopes';
import { isTrustedApplication } from '../utils/trustedApplication';
import { logger } from '../utils/logger';
import { mintServiceToken, SERVICE_TOKEN_EXPIRY } from './serviceTokenMint.service';
import {
  verifyWorkloadAttestation,
  type AttestationProvider,
  AttestationError,
} from './workloadAttestation.service';

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
    throw new WorkloadIdentityError(503, 'no_challenge_store', 'Workload identity is unavailable here.');
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
  if (!redis) return false;
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
}): Promise<WorkloadTokenGrant> {
  if (!(await spendChallenge(input.nonce))) {
    throw new WorkloadIdentityError(401, 'unknown_challenge', 'That challenge is unknown or already used.');
  }

  let attested;
  try {
    attested = await verifyWorkloadAttestation(input.provider, input.attestation, input.nonce);
  } catch (error: unknown) {
    if (error instanceof AttestationError) {
      logger.warn('[WorkloadIdentity] attestation refused', { provider: input.provider, reason: error.reason });
      throw new WorkloadIdentityError(401, error.reason, 'The attestation could not be verified.');
    }
    throw error;
  }

  const now = new Date();
  const [binding] = await getDb()
    .select({
      applicationId: applicationWorkloadIdentities.applicationId,
      appName: applications.name,
      ownerAccountId: applications.ownerAccountId,
      scopes: applications.scopes,
      status: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applicationWorkloadIdentities)
    .innerJoin(applications, eq(applications.id, applicationWorkloadIdentities.applicationId))
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
    logger.warn('[WorkloadIdentity] attested workload has no binding', { provider: attested.provider });
    throw new WorkloadIdentityError(403, 'unbound_workload', 'That workload is not bound to an application.');
  }

  if (binding.status !== 'active') {
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
    throw new WorkloadIdentityError(403, 'untrusted_application', 'Service tokens are only available to trusted applications.');
  }

  /**
   * Scopes are the application's own non-privileged grants.
   *
   * Identical to what a scopeless credential receives on the other path, and
   * for the same reason: privileged authority must be named on something a
   * human granted deliberately. An attestation says WHAT is calling, never what
   * it may do, so it can never widen an application's authority.
   */
  const scopes = binding.scopes.filter((scope) => !isPrivilegedScope(scope));

  const token = mintServiceToken({
    appId: binding.applicationId,
    appName: binding.appName,
    credentialId: attested.attestationId,
    ownerAccountId: binding.ownerAccountId,
    /**
     * The environment is the DEPLOYMENT's, not the caller's.
     *
     * A credential carries its own environment because a human chose one when
     * they issued it. An attestation carries none — a workload proves what it
     * is, never which environment it means — so the only honest answer is where
     * this API is running. Taking it from the request would let a caller mint
     * itself a production token from staging.
     */
    environment: isProduction() ? 'production' : 'development',
    scopes,
  });

  await getDb()
    .update(applications)
    .set({ lastUsedAt: now })
    .where(eq(applications.id, binding.applicationId));

  logger.info('[WorkloadIdentity] service token issued', {
    applicationId: binding.applicationId,
    appName: binding.appName,
    provider: attested.provider,
    attestationId: attested.attestationId,
  });

  return { token, expiresIn: SERVICE_TOKEN_EXPIRY, appName: binding.appName };
}
