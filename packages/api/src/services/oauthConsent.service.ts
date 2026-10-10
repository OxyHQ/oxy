import { lockLiveAgentKeyForAuthorization } from './agentKeyAuthority.service';
/**
 * OAuth consent — ONE decision and ONE durable transition for every finalizer.
 *
 * Two endpoints turn an approved OAuth authorization into a code:
 *
 *  - `POST /auth/oauth/authorize` (`routes/auth.ts`), the auth UI's consent
 *    screen, approved by a signed-in bearer.
 *  - `finalizeOAuthAuthorization` (`authSession.service.ts`), an OAuth-bound
 *    `AuthSession` approved through any delivery surface (popup, push, QR,
 *    verified app link) and finalized by the originating client.
 *
 * They used to decide and persist consent separately, and they disagreed: the
 * first recorded a grant for a trusted application that was consented a
 * consent-required scope and could undo an `acting-as:offline` revocation; the
 * second recorded grants for third-party applications only. Both minted the code
 * FIRST and wrote the grant best-effort afterwards, swallowing a failure — so an
 * authorization could report success while the consent it rested on was never
 * stored, and the user met a repeated consent screen or a later denial depending
 * on which entry they happened to use.
 *
 * Now both call {@link decideOAuthConsent} for the decision and
 * {@link persistOAuthAuthorization} for the write, so the same request produces
 * the same `app_grants` row, the same revocation state and the same code on
 * either path.
 *
 * ## The decision
 *
 * A grant is recorded when the application is NOT trusted (every third-party
 * authorization is a revocable "Connected apps" entry), or when the request
 * EXPLICITLY named a consent-required scope that the code actually carries
 * (`USER_CONSENT_REQUIRED_SCOPES`): a trusted application is auto-approved for
 * everything else, but those scopes always reach a consent screen, and a
 * permission a person granted but cannot find or withdraw is worse than one they
 * were never asked for. No grant is written for an ordinary first-party
 * sign-in — that path is authorized natively by trust, and a redundant grant
 * would only clutter the revocable surface.
 *
 * Only explicit, carried `acting-as:offline` clears its revocation. Empty
 * requests from third parties fail with `invalid_scope`. Trusted applications
 * may fall back to their registered ordinary scopes, excluding every
 * consent-required scope. Trust never supplies explicit user consent.
 *
 * All entries use {@link resolveOAuthScopes} before making this decision, so
 * the consent screen, finalizers and code share the same registered ceiling.
 *
 * ## The transition
 *
 * Grant upsert, revocation clear and code insert run in ONE transaction. Either
 * every row commits or none does: there is no code without the consent it
 * depends on, and no consent recorded for a code that was never issued. A failure
 * propagates — the finalizer reports it and hands out nothing usable.
 *
 * Recovery is a fresh authorization, which is safe to repeat: the grant is an
 * upsert on `(user_id, application_id)` whose scope set is a UNION, so a retry or
 * a concurrent duplicate converges on one row and never duplicates a scope, and
 * `first_granted_at` keeps when the user first consented. The single-use
 * guarantee of a code belongs to its issuer — `finalizeOAuthAuthorization`
 * reserves the code id before calling here, and `exchangeAuthCode` spends a code
 * exactly once.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import {
  intersectScopes,
  isUserConsentRequiredScope,
  userConsentRequiredScopes,
} from '../utils/applicationScopes';
import { isTrustedApplication } from '../utils/trustedApplication';
import {
  issueAuthCode,
  type IssueCodeOptions,
  type IssueCodeResult,
  type OAuthCodeExecutor,
} from './oauthCode.service';
import {
  clearServiceActingAsRevocation,
  bumpServiceActingAsEpoch,
  SERVICE_ACTING_AS_SCOPE,
} from './serviceActingAs.service';

/** What decides trust — the same fields `isTrustedApplication` reads. */
export type ConsentApplication = Parameters<typeof isTrustedApplication>[0];

/** Null means invalid_scope: a third party must name its requested scopes. */
export function resolveOAuthScopes(
  application: ConsentApplication,
  requestedScopes: readonly string[],
  registeredScopes: readonly string[],
): string[] | null {
  if (requestedScopes.length > 0) return intersectScopes(requestedScopes, registeredScopes);
  if (!isTrustedApplication(application)) return null;
  return intersectScopes(registeredScopes, registeredScopes).filter(
    (scope) => !isUserConsentRequiredScope(scope),
  );
}

export interface OAuthConsentInput {
  application: ConsentApplication;
  /** The scopes the REQUEST named, as the client sent them. May be empty. */
  requestedScopes: readonly string[];
  /**
   * The scopes the CODE will carry — what the authorization actually grants:
   * the request narrowed to the application's registered scopes
   * (`intersectScopes`), or the trusted ordinary fallback when none were named.
   */
  grantedScopes: readonly string[];
}

export interface OAuthConsentDecision {
  /** Whether this authorization writes (or refreshes) an `app_grants` row. */
  recordGrant: boolean;
  /** The scopes the grant records — the code's, de-duplicated in order. */
  grantScopes: string[];
  /** Consent-required scopes the request named explicitly and the code carries. */
  consentedScopes: string[];
  /** Whether this authorization undoes an `acting-as:offline` refusal. */
  clearsActingAsRevocation: boolean;
}

/** De-duplicate, keeping each scope's first position. */
function distinct(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}

/**
 * Decide what an approved authorization records. Pure — no I/O — so both
 * finalizers can be shown to agree on every input.
 */
export function decideOAuthConsent(input: OAuthConsentInput): OAuthConsentDecision {
  const granted = new Set(input.grantedScopes);
  const explicitlyGranted = distinct(input.requestedScopes).filter((scope) => granted.has(scope));
  const consentedScopes = userConsentRequiredScopes(explicitlyGranted);
  const recordGrant = !isTrustedApplication(input.application) || consentedScopes.length > 0;
  return {
    recordGrant,
    grantScopes: distinct(input.grantedScopes),
    consentedScopes,
    clearsActingAsRevocation: recordGrant && consentedScopes.includes(SERVICE_ACTING_AS_SCOPE),
  };
}

/**
 * Record (or refresh) a user's standing consent for an application — the
 * "Connected apps" entry. Upsert on `(user_id, application_id)`.
 *
 * The scope merge is Mongo's `$addToSet: { scopes: { $each } }`: the granted set
 * is a UNION that keeps each scope's FIRST position, so an existing grant keeps
 * the order it was written in and genuinely new scopes are appended.
 * `first_granted_at` is deliberately absent from the conflict branch — that is
 * `$setOnInsert`, and re-stamping it would erase when the user first consented.
 *
 * `updated_at` is set explicitly: drizzle's `$onUpdate` fires for `db.update()`,
 * not for the update arm of an upsert.
 */
async function recordAppGrant(
  db: OAuthCodeExecutor,
  userId: string,
  applicationId: string,
  scopes: string[],
  now: Date,
): Promise<void> {
  await db
    .insert(appGrants)
    .values({ userId, applicationId, scopes, firstGrantedAt: now, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [appGrants.userId, appGrants.applicationId],
      set: {
        lastUsedAt: now,
        updatedAt: now,
        scopes: sql`(
          select coalesce(array_agg(scope order by first_seen), '{}'::text[])
          from (
            select scope, min(pos) as first_seen
            from unnest(${appGrants.scopes} || excluded.scopes)
              with ordinality as merged(scope, pos)
            group by scope
          ) as unioned
        )`,
      },
    });
}

export interface PersistOAuthAuthorizationInput {
  decision: OAuthConsentDecision;
  /**
   * Everything the code is issued with. `userId` and `appId` are also the
   * grant's subject and application — the consent belongs to the account the
   * code authorizes, never to a delegated approver.
   */
  code: Omit<IssueCodeOptions, 'db'>;
}

/**
 * Commit an approved authorization: the grant the decision calls for, the
 * revocation clear it calls for, and the code — atomically. Throws when any of
 * them cannot be stored; nothing is then left behind and no code exists.
 */
export async function persistOAuthAuthorization(
  input: PersistOAuthAuthorizationInput,
): Promise<IssueCodeResult> {
  const { decision, code } = input;
  return getDb().transaction(async (tx) => {
    if (code.authMethod) {
      await lockLiveAgentKeyForAuthorization(
        tx,
        code.authMethod,
        code.operatedByUserId ?? code.userId,
      );
    }
    if (decision.recordGrant || decision.clearsActingAsRevocation) {
      await bumpServiceActingAsEpoch(code.userId, code.appId, tx);
    }
    if (decision.recordGrant) {
      await recordAppGrant(tx, code.userId, code.appId, decision.grantScopes, new Date());
    }
    if (decision.clearsActingAsRevocation) {
      await clearServiceActingAsRevocation(code.userId, code.appId, tx);
    }
    return issueAuthCode({ ...code, db: tx });
  });
}
