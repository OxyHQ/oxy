/**
 * Whether an application may act as a user from its own backend, with no
 * session of that user's anywhere in the request.
 *
 * ## The question, and why it has exactly one answer here
 *
 * A service token proves an APPLICATION. `X-Oxy-User-Id` is a header, and a
 * header is an input — so on its own it proves nothing at all, and attaching
 * `req.userId` from it would let any service holding any service token
 * impersonate any user by typing their id. `@oxyhq/core`'s `oxy.auth()` refuses
 * that by construction: it calls `GET /internal/service-acting-as/verify` on
 * every request carrying the header and rejects with 403 unless this function
 * says yes. There is no fail-open path there and none here.
 *
 * ## Platform trust is not user consent
 *
 * First-party and internal applications are trusted to hold a service
 * credential. That says who built the application; it says nothing about which
 * human authorized it to borrow their identity. Offline delegation therefore
 * always requires an `app_grants` row naming `acting-as:offline`, for trusted
 * applications exactly as for every other application.
 *
 * This is the boundary that keeps one leaked first-party credential from acting
 * as the entire user base. Its blast radius is the set of people who explicitly
 * consented, and each person's grant scopes narrow the token independently.
 *
 * ## Revocation is an explicit, persisted fact
 *
 * `service_acting_as_revocations` is the positive refusal record. The grant is
 * already required, but keeping the refusal explicit makes revoke win over a
 * stale or concurrently recreated grant and requires a fresh consent flow to
 * clear it.
 *
 * It is checked FIRST, before anything that could authorize, so no ordering
 * change can leave it consulted too late to matter.
 *
 * ## How scopes compose
 *
 * Two independent limits, and a delegated request must satisfy BOTH:
 *
 *   application ceiling  `applications.scopes`            staff / owner decide
 *          ∩ credential  `application_credentials.scopes` → the token's `scopes`
 *   this function                                         → what the USER allows
 *
 * `requireScope` in `@oxyhq/core` intersects them for a delegated request.
 *
 * This function returns only the user's grant scopes. The resource server then
 * intersects them with the service token, so neither the platform nor the user
 * can grant authority the other side withheld.
 *
 * Neither path re-intersects with the live ceiling. That intersection already
 * happens once, at mint, so a scope staff revoked from the application is absent
 * from `req.serviceApp.scopes` and `requireScope` fails on it regardless. Doing
 * it twice would give one rule two homes.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';
import { serviceActingAsRevocations } from '../db/schema/serviceActingAsRevocations';

/**
 * The scope every application's grant must name before it may act for a user.
 * Not merely one of the scopes a delegated call might need — it is the
 * permission to be delegated at all.
 *
 * It is also the key to the revocation door: because it is consent-required, a
 * request naming it always reaches a real consent screen, so approving one is
 * the explicit user decision that clears a revocation marker.
 */
export const SERVICE_ACTING_AS_SCOPE = 'acting-as:offline';

/**
 * The answer `GET /internal/service-acting-as/verify` returns, and the shape
 * `@oxyhq/core`'s `ServiceActingAsVerification` parses.
 *
 * `scopes` is `[]` whenever `authorized` is false, so a caller that ignores the
 * boolean and reads the array still gets an answer that authorises nothing.
 */
export interface ServiceActingAsGrant {
  authorized: boolean;
  scopes: string[];
}

/** The single unauthorized answer. Every refusal is this exact value. */
const DENIED: ServiceActingAsGrant = { authorized: false, scopes: [] };

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
 * Every negative outcome returns the SAME value. The caller cannot tell "no such
 * user" from "revoked" from "untrusted", which is what stops this endpoint
 * answering questions about who exists and who refused what. The reasons belong
 * in the server's own log, not in a response to another service.
 */
export async function resolveServiceActingAsGrant(
  applicationId: string,
  userId: string
): Promise<ServiceActingAsGrant> {
  if (applicationId.length === 0 || userId.length === 0) {
    return DENIED;
  }

  const db = getDb();

  // 1. An explicit refusal ends it. Checked before the application is even
  //    looked up, so there is no arrangement of the code below that can
  //    authorize past it.
  const [revocation] = await db
    .select({ id: serviceActingAsRevocations.id })
    .from(serviceActingAsRevocations)
    .where(
      and(
        eq(serviceActingAsRevocations.userId, userId),
        eq(serviceActingAsRevocations.applicationId, applicationId)
      )
    )
    .limit(1);

  if (revocation) {
    return DENIED;
  }

  // 2. An application that is no longer active cannot act, whatever it was
  //    granted.
  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
    .limit(1);

  if (!application) {
    return DENIED;
  }

  // 3. The explicit user grant is the only positive authorization path.
  const [grant] = await db
    .select({ scopes: appGrants.scopes })
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, application.id)))
    .limit(1);

  const grantedScopes = grant?.scopes ?? [];
  if (grantedScopes.includes(SERVICE_ACTING_AS_SCOPE)) {
    return { authorized: true, scopes: grantedScopes };
  }

  // 4. Missing, stale or weaker grants authorize nothing, regardless of trust.
  return DENIED;
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
  applicationId: string
): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(serviceActingAsRevocations)
    .values({ userId, applicationId, revokedAt: now })
    .onConflictDoUpdate({
      target: [serviceActingAsRevocations.userId, serviceActingAsRevocations.applicationId],
      set: { revokedAt: now, updatedAt: now },
    });
}

/**
 * Clear `userId`'s refusal of `applicationId`, if there is one.
 *
 * Called ONLY from `recordAppGrant` and ONLY when the granted scopes name
 * {@link SERVICE_ACTING_AS_SCOPE}. That scope is consent-required, so a request
 * carrying it always reaches the consent screen — for a trusted application
 * exactly as for a third-party one — and reaching authorize with it means a
 * person read that screen and approved.
 *
 * Clearing on any successful authorize would have made revocation worthless: a
 * first-party application is auto-approved, so its very next sign-in would
 * silently undo a deliberate refusal.
 */
export async function clearServiceActingAsRevocation(
  userId: string,
  applicationId: string
): Promise<void> {
  await getDb()
    .delete(serviceActingAsRevocations)
    .where(
      and(
        eq(serviceActingAsRevocations.userId, userId),
        eq(serviceActingAsRevocations.applicationId, applicationId)
      )
    );
}
