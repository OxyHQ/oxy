/**
 * Who is asking, and what the user let them do — resolved from the server's own
 * records rather than from anything the caller says.
 *
 * ## The rule this exists to keep
 *
 * A follow operation is authorised by the SUBJECT USER, delegated to an
 * application. So a request has to answer two questions, and neither answer may
 * come from the request body or an unverified header:
 *
 *   1. which application is acting  → `applicationId`
 *   2. what did the user grant it   → `scopes`, from a revocable `app_grants` row
 *
 * A body field would let any caller name any application, which is the exact
 * forgery #809 forbids. A header is no better. Both are inputs; authority has to
 * be derived.
 *
 * ## Why this needs no new column and no token change
 *
 * The link already exists. An OAuth authorization writes an `auth_sessions` row
 * that knows the application, and stamps `authorized_session_id` with the
 * `sessions.session_id` it minted. The access token carries that `sessionId` and
 * the auth middleware has already verified it. So the application is one join
 * away from a session the server has authenticated, and nothing about the token
 * format changes — which matters, because `sessionUtils.ts` says plainly that
 * the token payload is a wire contract every ecosystem app parses.
 *
 * ## Sessions with no application
 *
 * A session created outside OAuth — a password sign-in on Commons, say — has no
 * `auth_sessions` row naming it, so it resolves to no application and therefore
 * to no follow capability. That is the correct answer, not a gap: nobody
 * delegated anything, so there is nothing to act on the user's behalf with. The
 * user's own first-party surfaces are a separate question and are not served by
 * pretending an application asked.
 */

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';
import { authSessions } from '../db/schema/authSessions';
import { isFollowScope } from '../utils/applicationScopes';

/** What a verified request is allowed to do on the user's follow graph. */
export interface FollowCapability {
  /** The user the follows belong to. Never taken from the request body. */
  userId: string;
  /** The application acting as delegate, resolved from the authorization record. */
  applicationId: string;
  /**
   * The grant the scopes came from.
   *
   * Carried so a written relationship can record WHICH consent produced it —
   * #809's `created_by_grant_id` provenance — and so revoking that grant can be
   * traced to what it authorised.
   */
  grantId: string;
  /** Exactly what the user consented to. Not what the application requested. */
  scopes: string[];
  /** The session the capability was derived from. */
  sessionId: string;
}

/**
 * Why a request has no follow capability.
 *
 * Separated from "denied" on purpose: a caller that never delegated is a
 * different situation from one whose grant was revoked, and telling them apart
 * is what lets the API answer usefully instead of returning one opaque 403.
 */
export type FollowCapabilityDenial =
  /** The session was not created through an application authorization. */
  | 'no_application'
  /** The application exists but the user has granted it nothing. */
  | 'no_grant'
  /** The application was deleted, suspended, or is otherwise not active. */
  | 'application_inactive';

export type FollowCapabilityResult =
  | { ok: true; capability: FollowCapability }
  | { ok: false; reason: FollowCapabilityDenial };

/**
 * Resolve the capability behind an authenticated session.
 *
 * `sessionId` must already have been verified by the auth middleware; this
 * function trusts it to name a session and nothing more.
 *
 * The newest authorization wins when a session has several. Re-authorizing is
 * how an application asks for more, so the latest row is the one describing what
 * the user most recently agreed to.
 */
export async function resolveFollowCapability(
  userId: string,
  sessionId: string
): Promise<FollowCapabilityResult> {
  const db = getDb();

  const [authorization] = await db
    .select({ applicationId: authSessions.applicationId })
    .from(authSessions)
    .where(
      and(eq(authSessions.authorizedSessionId, sessionId), eq(authSessions.authorizedUserId, userId))
    )
    .orderBy(desc(authSessions.updatedAt))
    .limit(1);

  if (!authorization) {
    return { ok: false, reason: 'no_application' };
  }

  // An application that is no longer active cannot act, whatever it was granted
  // once. Checked here rather than assumed from the grant's existence: a grant
  // outlives a suspension, and it should — suspending an app must not delete the
  // user's record of having authorized it.
  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, authorization.applicationId), eq(applications.status, 'active')))
    .limit(1);

  if (!application) {
    return { ok: false, reason: 'application_inactive' };
  }

  const [grant] = await db
    .select({ id: appGrants.id, scopes: appGrants.scopes })
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, application.id)))
    .limit(1);

  // No grant row means no standing consent, and that is the whole answer — there
  // is deliberately no fallback to what the application is *allowed* to request.
  // `applications.scopes` is the app's ceiling, not the user's decision, and
  // reading it here would reintroduce the bypass #809 exists to close.
  if (!grant) {
    return { ok: false, reason: 'no_grant' };
  }

  return {
    ok: true,
    capability: {
      userId,
      applicationId: application.id,
      grantId: grant.id,
      scopes: grant.scopes ?? [],
      sessionId,
    },
  };
}

/**
 * Whether a capability carries a specific scope.
 *
 * Consent-required scopes get no special case here on purpose. Their special
 * treatment happens once, at the consent screen, where the user is asked; by the
 * time a grant exists they are ordinary granted scopes. Re-checking "was this
 * consent-required?" at enforcement time would be asking a question whose answer
 * is already recorded, and giving it two homes is how the two drift apart.
 */
export function capabilityHasScope(capability: FollowCapability, scope: string): boolean {
  return capability.scopes.includes(scope);
}

/**
 * A follow scope the caller does NOT hold, or `null` when it holds them all.
 *
 * Returns the missing scope rather than a boolean so the API can name it: "this
 * app has not been granted permission to change who you follow" is actionable,
 * and a 403 with no subject is not.
 */
export function missingFollowScope(
  capability: FollowCapability,
  required: readonly string[]
): string | null {
  for (const scope of required) {
    if (!capabilityHasScope(capability, scope)) return scope;
  }
  return null;
}

/**
 * Guard against a required-scope list that names something outside the follow
 * family — a typo, or a scope from another domain reaching this authorization
 * path by accident.
 *
 * Exported for the routes to assert their own constants at module load, so the
 * mistake surfaces at boot rather than as a permanently-denied request.
 *
 * Asks {@link isFollowScope}, not `isUserConsentRequiredScope`. The two sets
 * were identical when this was written and are not any more — every follow scope
 * is consent-required, but not every consent-required scope is a follow scope.
 * Asking the wider question would let a scope from another domain through this
 * guard while the guard still read as if it checked something.
 */
export function assertFollowScopes(required: readonly string[]): void {
  for (const scope of required) {
    if (!isFollowScope(scope)) {
      throw new Error(
        `${scope} is not a follow scope; follow authorization must not be used to gate it`
      );
    }
  }
}
