import { isSupervised } from './supervisionPolicy.service';
/**
 * External service delegation through a live user's OAuth grant.
 *
 * A token identifies an application; X-Oxy-User-Id alone proves no user
 * authority. This resolver applies only to external/legacy scoped callers:
 * their live app, credential and user grant intersect, and revocation wins.
 * An official application using an external credential follows these same rules.
 *
 * Verified first-party workloads instead present a live shared session or a
 * durable task bound to its original requester and coordinator. The internal
 * verify route resolves that proof and account authority separately, without
 * an app grant or scopes. No raw header can select a different account.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';
import { serviceActingAsRevocations } from '../db/schema/serviceActingAsRevocations';
import { serviceActingAsAuthorityEpochs } from '../db/schema/serviceActingAsAuthorityEpochs';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { isWorkloadAttestationHandle } from './workloadAttestation.service';
import { isCredentialUsable } from '../utils/credentialUsability';
import { intersectScopes } from '../utils/applicationScopes';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';

/** The database handle a helper runs on — the pool, or an open transaction. */
type Db = ReturnType<typeof getDb>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The scope every external application's grant must name before it may act for a user.
 * Not merely one of the scopes a delegated call might need — it is the
 * permission to be delegated at all.
 *
 * It is also the key to the revocation door: because it is consent-required, a
 * request naming it always reaches a real consent screen, so approving one is
 * the explicit user decision that clears a revocation marker.
 */
export const SERVICE_ACTING_AS_SCOPE = 'acting-as:offline';

/**
 * The external answer `GET /internal/service-acting-as/verify` returns, and the shape
 * `@oxy.so/core`'s `ServiceActingAsVerification` parses.
 *
 * `scopes` is `[]` whenever `authorized` is false, so a caller that ignores the
 * boolean and reads the array still gets an answer that authorises nothing.
 */
export interface ServiceActingAsGrant {
  authorized: boolean;
  scopes: string[];
  epoch: string;
}

/** The single unauthorized answer. Every refusal is this exact value. */
const DENIED: ServiceActingAsGrant = { authorized: false, scopes: [], epoch: '0' };

/**
 * Resolve whether `applicationId` holds live authority to act as `userId`.
 *
 * Order is the security property, so it is spelled out:
 *
 *   1. the user revoked this application            → no
 *   2. the application is missing or not active     → no
 *   3. the user granted it `acting-as:offline`      → yes, with the GRANT's scopes
 *   4. otherwise                                    → no
 *
 * Revocation is first because it must win over every later authorization fact.
 * Application trust is deliberately absent: it is a credential-mint decision,
 * not a per-user consent decision.
 *
 * Every refusal returns authorized:false and empty scopes. The decimal pair
 * epoch identifies authority generations, not a denial reason; this oracle
 * remains available only to authenticated platform-trusted services.
 */
export interface ServiceActingAsCredentialContext {
  credentialId: string;
  ownerAccountId: string;
  environment: OxyServiceEnvironment;
}

/** One durable pair generation. Keep the row across revoke/delete/regrant. */
export async function bumpServiceActingAsEpoch(
  userId: string,
  applicationId: string,
  db: Executor,
): Promise<string> {
  const [row] = await db
    .insert(serviceActingAsAuthorityEpochs)
    .values({ userId, applicationId, epoch: BigInt(1) })
    .onConflictDoUpdate({
      target: [serviceActingAsAuthorityEpochs.userId, serviceActingAsAuthorityEpochs.applicationId],
      set: { epoch: sql`${serviceActingAsAuthorityEpochs.epoch} + 1`, updatedAt: new Date() },
    })
    .returning({ epoch: serviceActingAsAuthorityEpochs.epoch });
  return row.epoch.toString();
}

export async function resolveServiceActingAsGrant(
  applicationId: string,
  userId: string,
  credential?: ServiceActingAsCredentialContext,
): Promise<ServiceActingAsGrant> {
  if (!applicationId || !userId || (await isSupervised(userId))) return DENIED;
  // Every authority read, including epoch, closure, credential/workload ceiling,
  // belongs to one snapshot. Mixing several READ COMMITTED snapshots could
  // pair the pre-revoke grant with the post-revoke epoch.
  return getDb().transaction(
    async (tx) => {
      const [generation] = await tx
        .select({ epoch: serviceActingAsAuthorityEpochs.epoch })
        .from(serviceActingAsAuthorityEpochs)
        .where(
          and(
            eq(serviceActingAsAuthorityEpochs.userId, userId),
            eq(serviceActingAsAuthorityEpochs.applicationId, applicationId),
          ),
        )
        .limit(1);
      const denied: ServiceActingAsGrant = {
        authorized: false,
        scopes: [],
        epoch: generation?.epoch.toString() ?? '0',
      };
      const [revocation] = await tx
        .select({ id: serviceActingAsRevocations.id })
        .from(serviceActingAsRevocations)
        .where(
          and(
            eq(serviceActingAsRevocations.userId, userId),
            eq(serviceActingAsRevocations.applicationId, applicationId),
          ),
        )
        .limit(1);
      if (revocation) return denied;
      const [subject] = await tx
        .select({ status: users.accountStatus, fence: accountClosureFences.accountId })
        .from(users)
        .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
        .where(eq(users.id, userId))
        .limit(1);
      if (!subject || subject.status !== 'active' || subject.fence !== null) return denied;
      const [application] = await tx
        .select({
          id: applications.id,
          ownerId: applications.ownerAccountId,
          scopes: applications.scopes,
          status: applications.status,
        })
        .from(applications)
        .where(eq(applications.id, applicationId))
        .limit(1);
      if (!application || application.status !== 'active') return denied;
      const [owner] = await tx
        .select({ status: users.accountStatus, fence: accountClosureFences.accountId })
        .from(users)
        .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
        .where(eq(users.id, application.ownerId))
        .limit(1);
      if (!owner || owner.status !== 'active' || owner.fence !== null) return denied;
      const [grant] = await tx
        .select({ scopes: appGrants.scopes })
        .from(appGrants)
        .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
        .limit(1);
      if (!grant?.scopes.includes(SERVICE_ACTING_AS_SCOPE)) return denied;
      let liveScopes: readonly string[] = application.scopes;
      if (credential) {
        if (credential.ownerAccountId !== application.ownerId) return denied;
        // Own workloads use requester proofs, never external OAuth grants.
        if (isWorkloadAttestationHandle(credential.credentialId)) {
          return denied;
        } else {
          const [key] = await tx
            .select()
            .from(applicationCredentials)
            .where(
              and(
                eq(applicationCredentials.id, credential.credentialId),
                eq(applicationCredentials.applicationId, applicationId),
              ),
            )
            .limit(1);
          if (
            !key ||
            key.type !== 'service' ||
            key.environment !== credential.environment ||
            !isCredentialUsable(key)
          )
            return denied;
          liveScopes = key.scopes.length
            ? intersectScopes(key.scopes, application.scopes)
            : application.scopes;
        }
      }
      const scopes = intersectScopes(grant.scopes, liveScopes);
      if (!scopes.includes(SERVICE_ACTING_AS_SCOPE)) return denied;
      return { authorized: true, scopes, epoch: denied.epoch };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Record that `userId` refuses to let `applicationId` act as them.
 *
 * Upserted, so revoking twice refreshes the timestamp rather than failing on the
 * unique constraint or accumulating rows. Called by
 * `DELETE /auth/grants/:applicationId` beside the grant delete, so one user
 * action removes the grant and leaves a positive refusal marker behind.
 *
 * Deliberately NOT idempotent-by-existence-check-then-insert: two concurrent
 * revokes would race between the check and the insert, and the loser would throw
 * on a duplicate key. `ON CONFLICT DO UPDATE` makes the second one a no-op that
 * still succeeds, which is what a revoke button has to do.
 */
export async function revokeServiceActingAs(
  userId: string,
  applicationId: string,
  db?: Executor,
): Promise<void> {
  const write = async (tx: Executor) => {
    // Unknown applications preserve idempotent revoke without an existence oracle.
    const [application] = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!application) return;
    await bumpServiceActingAsEpoch(userId, applicationId, tx);
    await tx
      .delete(appGrants)
      .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)));
    const now = new Date();
    await tx
      .insert(serviceActingAsRevocations)
      .values({ userId, applicationId, revokedAt: now })
      .onConflictDoUpdate({
        target: [serviceActingAsRevocations.userId, serviceActingAsRevocations.applicationId],
        set: { revokedAt: now, updatedAt: now },
      });
  };
  if (db) await write(db);
  else await getDb().transaction(write);
}

/**
 * Clear `userId`'s refusal of `applicationId`, if there is one.
 *
 * Called ONLY from `persistOAuthAuthorization` (`oauthConsent.service.ts`),
 * inside the transaction that records the grant and writes the code, and ONLY
 * when the request EXPLICITLY named {@link SERVICE_ACTING_AS_SCOPE} and the code
 * carries it. That scope is consent-required, so a request carrying it always
 * reaches the consent screen — for a trusted application exactly as for a
 * third-party one — and reaching a finalizer with it means a person read that
 * screen and approved.
 *
 * Clearing on any successful authorize would have made revocation worthless: a
 * first-party application is auto-approved, so its very next sign-in would
 * silently undo a deliberate refusal.
 *
 * `db` is the pool by default, or the caller's open transaction — the clear must
 * never commit without the grant and the code it belongs to.
 */
export async function clearServiceActingAsRevocation(
  userId: string,
  applicationId: string,
  db: Executor = getDb(),
): Promise<void> {
  await db
    .delete(serviceActingAsRevocations)
    .where(
      and(
        eq(serviceActingAsRevocations.userId, userId),
        eq(serviceActingAsRevocations.applicationId, applicationId),
      ),
    );
}
