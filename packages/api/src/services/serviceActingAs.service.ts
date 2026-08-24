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
 * ## First-party applications are automatic — an OWNER DECISION, with a cost
 *
 * A first-party Oxy application acting for a user needs no consent screen. The
 * platform does not ask a user to authorize one Oxy app to act for them in
 * another; from the user's side it is one product. This is consistency rather
 * than an exception — `app_grants` already takes the same stance, auto-approving
 * trusted applications on the consent path and recording no grant row for them.
 *
 * **The trade-off, stated rather than implied: a leaked first-party service
 * credential can act as ANY user who has not explicitly revoked that
 * application.** The gate becomes "is this application trusted", which is a
 * platform fact, not "did this user agree", which is a per-user one — so the
 * blast radius of one stolen credential is the whole user base rather than the
 * set of people who opted in. That is the price of automatic, it was accepted
 * deliberately by the owner, and it is what makes credential rotation and the
 * `credentialId` claim's revocation story load-bearing rather than nice to have.
 *
 * Three things bound it, and each is a check below rather than an intention:
 * the application must be TRUSTED, it must be ACTIVE, and the user must not have
 * revoked it.
 *
 * ## Revocation is an explicit, persisted fact
 *
 * Automatic by default must not mean unrevocable, and for an automatic
 * application there is no grant row to delete — so the refusal needs a positive
 * record of its own. `service_acting_as_revocations` is that record, and its
 * docblock carries the reasoning for why absence cannot mean revoked and why a
 * second place to say NO is safe where a second place to say YES would not be.
 *
 * It is checked FIRST, before anything that could authorize, so no ordering
 * change can leave it consulted too late to matter.
 *
 * ## Non-trusted applications still need a real grant
 *
 * They cannot mint a trusted service token today — the mint refuses them
 * outright, bar the payments-only carve-out, and `/internal` refuses them again.
 * The grant path below is therefore unreachable for them right now. It is kept
 * anyway: "unreachable" is a property of two other files, and the day either
 * changes, this function must not start silently authorizing an application no
 * user ever agreed to. A grant naming `acting-as:offline` is what it takes.
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
 * For the AUTOMATIC path this function returns the application's own ceiling,
 * which means the intersection narrows nothing: the effective authority is the
 * token's scopes. That is the honest consequence of automatic consent, not an
 * oversight — there is no per-user decision to narrow by, because none was
 * asked for. For the GRANT path it returns the grant's scopes, which do narrow,
 * because there the user chose them.
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
import { isTrustedApplication } from '../utils/trustedApplication';

/**
 * The scope a NON-TRUSTED application's grant must name before it may act for a
 * user. Not merely one of the scopes a delegated call might need — it is the
 * permission to be delegated for at all.
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
 *   4. the application is platform-trusted          → yes, with the APP's scopes
 *   5. otherwise                                    → no
 *
 * Revocation is first because it must win over everything after it, including
 * trust. Trust is last because it is the weakest claim on the list — it says the
 * platform vouches for the application, not that this user did.
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

  // 2. An application that is no longer active cannot act, whatever it is or
  //    was granted. Trust and scopes are read in the same round trip because
  //    both answers below need them.
  const [application] = await db
    .select({
      id: applications.id,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      scopes: applications.scopes,
    })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
    .limit(1);

  if (!application) {
    return DENIED;
  }

  // 3. An explicit grant beats the automatic path and narrows it: a user who
  //    chose particular scopes gets those, not the application's whole ceiling.
  //    This is also the only path a non-trusted application has.
  const [grant] = await db
    .select({ scopes: appGrants.scopes })
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, application.id)))
    .limit(1);

  const grantedScopes = grant?.scopes ?? [];
  if (grantedScopes.includes(SERVICE_ACTING_AS_SCOPE)) {
    return { authorized: true, scopes: grantedScopes };
  }

  // 4. Automatic for first-party. `isTrustedApplication` is the platform's
  //    single source of truth for this — never `status: 'active'` alone, which
  //    every self-service third-party application also has.
  if (isTrustedApplication(application)) {
    return { authorized: true, scopes: application.scopes };
  }

  // 5. A third-party application with no grant. The mint already refuses it a
  //    service token, and `/internal` refuses it again; this is the third
  //    refusal and the only one that survives a change to either of the others.
  return DENIED;
}

/**
 * Record that `userId` refuses to let `applicationId` act as them.
 *
 * Upserted, so revoking twice refreshes the timestamp rather than failing on the
 * unique constraint or accumulating rows. Called by
 * `DELETE /auth/grants/:applicationId` beside the grant delete, so one user
 * action ends both an OAuth grant and an automatic first-party delegation.
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
