import crypto from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { getRedisClient } from '../config/redis';
import { isProduction } from '../config/env';
import { intersectScopes, isPrivilegedScope } from '../utils/applicationScopes';
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
      /** What this binding names, or empty for "names none" — see the scope block below. */
      bindingScopes: applicationWorkloadIdentities.scopes,
      /** The ceiling. Nothing the binding names can exceed it.  */
      applicationScopes: applications.scopes,
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
   * Scopes, decided exactly as the credential path decides them.
   *
   * ## The rule that has not changed
   *
   * Privileged authority must be named on something a human granted
   * deliberately. An attestation says WHAT is calling, never what it may do, so
   * an attestation can never widen an application's authority — and the ceiling
   * is still the application's own grants, so nothing here can exceed what a
   * human granted the application.
   *
   * ## What that rule was being read to mean, and why it was wrong
   *
   * It was read as "a workload token can never carry a privileged scope", by
   * filtering privileged scopes out of the APPLICATION's grants. That conflated
   * two different things. The attestation is not the only deliberate human act
   * on this path: the binding row is one too. A row in
   * `application_workload_identities` is written by staff, names exactly one IAM
   * role and exactly one application, carries a human-authored `description`,
   * and is gated at creation by the same staff check that gates a credential's
   * scopes (`services/workloadIdentityBinding.service.ts`). It is the
   * attestation path's equivalent of an `ApplicationCredential` — so it names
   * authority the same way one does, and the rule above is satisfied by it, not
   * violated.
   *
   * The attestation still names nothing. It selects a binding; the binding
   * names the scopes. A workload that proves what it is gains no say at all in
   * what it may do.
   *
   * ## The rule, then
   *
   * Identical to `POST /auth/service-token`, deliberately — two ways to prove
   * who you are must not be two authorities:
   *
   *   * The binding NAMES scopes → the intersection with the application's, so
   *     a privileged scope survives only when BOTH the binding and the
   *     application hold it. Either one losing it is enough to lose it here.
   *   * The binding names NONE → the application's non-privileged grants, which
   *     is what this path did before the column existed and what a scopeless
   *     credential still receives. Every binding written before today reads as
   *     this case, so nothing changed under an existing deployment.
   *
   * ## Why this had to change
   *
   * Because the old reading was not "privileged scopes are unreachable here",
   * it was "a service holding one cannot migrate". Mention's credential named
   * `federation:write`, `signals:write` and `catalogs:write`; taking the pair
   * off its task definition took all three away and its federation worker
   * failed every six minutes until the pair was restored. mention-mcp needs
   * `catalogs:write` for its own post-deploy registration and Alia needs
   * `capabilities:read` to build its tool catalogue — so the filter was not
   * holding a line, it was making ADR 0026's clean cut impossible for exactly
   * the services it was written for.
   */
  const scopes =
    binding.bindingScopes.length > 0
      ? intersectScopes(binding.bindingScopes, binding.applicationScopes)
      : binding.applicationScopes.filter((scope) => !isPrivilegedScope(scope));

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
    // The scopes, because the question an operator asks after a 403 is "what
    // did that token actually carry?" and the binding is where the answer is
    // now decided. Scope names are a bounded vocabulary, not caller data.
    scopes,
  });

  return { token, expiresIn: SERVICE_TOKEN_EXPIRY, appName: binding.appName };
}
