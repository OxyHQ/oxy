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
 * ## The store is `app_grants`, not a second table
 *
 * `app_grants` is already the user's revocable record of what they let an
 * application do: written by the OAuth consent path (`recordAppGrant`), listed
 * by `GET /auth/grants`, deleted by `DELETE /auth/grants/:applicationId`, and
 * read at request time by `followCapability.service.ts`.
 *
 * A dedicated `service_acting_as` table was the alternative and is rejected for
 * one reason that outweighs the rest: it would create a SECOND revocation
 * surface. A user who revokes an application in "Connected apps" means "stop
 * acting for me", and a design where that leaves an offline delegation running
 * is a safety bug no amount of extra UI repairs. One row, one revoke, total.
 *
 * ## `acting-as:offline` is the gate, and a grant row alone is not
 *
 * Reusing the table brings a hazard that has to be closed explicitly: a user has
 * an `app_grants` row for every third-party app they ever signed into. If the
 * mere EXISTENCE of a row authorised delegation, every one of those apps would
 * silently gain the right to act as them. So authorisation requires the grant to
 * name `acting-as:offline` — a scope that is privileged (staff-only to add to an
 * application's ceiling) and consent-required (never auto-approved, whoever the
 * application is). See `utils/applicationScopes.ts`.
 *
 * ## How scopes compose
 *
 * Two independent limits, and a delegated request must satisfy BOTH:
 *
 *   application ceiling  `applications.scopes`            staff / owner decide
 *          ∩ credential  `application_credentials.scopes` → the token's `scopes`
 *   user grant           `app_grants.scopes`              → what THIS user allowed
 *
 * The token's scopes are app-wide: they say what the application may ever do.
 * The grant's scopes are per-user: they say what one user allowed. `requireScope`
 * in `@oxyhq/core` intersects them for a delegated request, which is the correct
 * composition — a user cannot grant an application authority the platform never
 * gave it, and the platform's grant is not the user's consent.
 *
 * This function returns the GRANT's scopes and deliberately does not re-intersect
 * them with the application's live ceiling. That intersection already happens,
 * once, at the point it can be enforced: the ceiling is what the token's scopes
 * were minted from, so a scope staff revoked from the application is absent from
 * `req.serviceApp.scopes` and `requireScope` fails on it regardless of what the
 * user's historical grant still lists. Doing it twice would give one rule two
 * homes, which is how the two drift apart.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';

/**
 * The scope a user's grant must name before that user may be acted for by a
 * service token. Not merely one of the scopes a delegated call might need — it
 * is the permission to be delegated for at all.
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
 * Every negative outcome — no such application, a suspended one, no such user,
 * no grant, a grant that does not name {@link SERVICE_ACTING_AS_SCOPE} — returns
 * the SAME value. The caller cannot tell them apart, which is what stops the
 * verify endpoint answering questions about which users and applications exist.
 * The reasons are worth having, but they belong in the server's own log, not in
 * a response to another service.
 */
export async function resolveServiceActingAsGrant(
  applicationId: string,
  userId: string
): Promise<ServiceActingAsGrant> {
  if (applicationId.length === 0 || userId.length === 0) {
    return DENIED;
  }

  const db = getDb();

  // An application that is no longer active cannot act, whatever it was granted
  // once. Checked separately from the grant rather than inferred from it: a
  // grant OUTLIVES a suspension, and it should — suspending an application must
  // not erase the user's record of having authorized it, or restoring the
  // application would silently restore an authority the user can no longer see.
  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
    .limit(1);

  if (!application) {
    return DENIED;
  }

  const [grant] = await db
    .select({ scopes: appGrants.scopes })
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, application.id)))
    .limit(1);

  // No row means no standing consent, and that is the whole answer. There is
  // deliberately no fallback to what the application is ALLOWED to request:
  // `applications.scopes` is the platform's ceiling, not the user's decision,
  // and reading it here would authorise every trusted application to act as
  // every user — the exact impersonation this endpoint exists to prevent.
  if (!grant) {
    return DENIED;
  }

  const scopes = grant.scopes ?? [];
  if (!scopes.includes(SERVICE_ACTING_AS_SCOPE)) {
    return DENIED;
  }

  return { authorized: true, scopes };
}
