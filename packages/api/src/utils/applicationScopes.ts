/**
 * Application / credential scope vocabulary and the pure authorisation helpers
 * that operate on it.
 *
 * This module is intentionally DEPENDENCY-FREE (no Mongoose, no DB) so the scope
 * logic can be imported and unit-tested without loading a model. The
 * `Application` Mongoose schema imports `APPLICATION_SCOPES` from here for its
 * enum; the application routes and the service-token mint import the helpers.
 */

/**
 * Allowed OAuth scopes for an Application.
 * - `federation:write` permits internal services to sign HTTP-Signatures as, and
 *   resolve/mutate, federated users (`routes/federation.ts`, `PUT /users/resolve`)
 *   for federation/agent/automation flows. PRIVILEGED — see
 *   {@link PRIVILEGED_APPLICATION_SCOPES}; only Oxy platform staff may grant it.
 * - `reputation:write` permits service credentials to create reputation ledger
 *   awards/penalties for arbitrary users. PRIVILEGED — only Oxy platform staff
 *   may grant it.
 * - `signals:write` permits trusted services to write cross-app ranking signals
 *   (endorsement/interest edges) that influence recommendation rankings and can
 *   trigger reputation awards. PRIVILEGED — only Oxy platform staff may grant it.
 * - `notifications:write` permits trusted services to create realtime
 *   notifications for arbitrary recipients. PRIVILEGED — only Oxy platform staff
 *   may grant it.
 * - `payments:read` / `payments:write` permit a service credential to read and
 *   manage the Oxy Pay Gateway resources (merchants, payment intents, webhook
 *   deliveries) belonging to ITS OWN Application. Non-privileged — same
 *   pattern as `files:write`/`updates:publish`: authority is scoped to the
 *   app's own tenant, never cross-tenant.
 */
export const APPLICATION_SCOPES = [
  'files:read',
  'files:write',
  'files:delete',
  'user:read',
  'webhooks:receive',
  'chat:completions',
  'models:read',
  'updates:publish',
  'federation:write',
  'signals:write',
  'reputation:write',
  'notifications:write',
  'capabilities:read',
  'catalogs:write',
  'capability-tickets:issue',
  'capability-audit:write',
  'capability-events:publish',
  'payments:read',
  'payments:write',
] as const;

export type ApplicationScope = (typeof APPLICATION_SCOPES)[number];

/**
 * Scopes that confer cross-tenant / act-on-behalf authority and therefore MUST
 * NOT be self-grantable by an ordinary application owner. They may only be added
 * to an Application's `scopes` by Oxy platform staff (`User.isStaff === true`),
 * mirroring how `type` / `isOfficial` / `isInternal` / `capabilities` are
 * staff-gated on the application update path.
 *
 * - `federation:write` lets a service credential sign HTTP-Signatures as, and
 *   resolve/mutate, ARBITRARY federated users. A self-granting owner could
 *   otherwise register an app with a victim domain's redirectUri and impersonate
 *   that domain's users.
 * - `reputation:write` lets a service credential mutate the global reputation
 *   ledger for arbitrary users. A self-granting owner could otherwise inflate or
 *   penalise trust tiers outside its own tenant.
 * - `signals:write` lets a service credential write cross-app ranking signals
 *   and can trigger reputation awards for arbitrary Oxy users. A self-granting
 *   owner could otherwise submit forged endorsement edges to inflate reputation
 *   and recommendation rankings.
 * - `notifications:write` lets a service credential deliver realtime
 *   notifications to arbitrary users and choose actor/entity metadata. A
 *   self-granting owner could otherwise spoof system or user activity to
 *   victims' connected clients.
 *
 * All non-privileged scopes in {@link APPLICATION_SCOPES} authorise an app only
 * over its OWN resources (files, models, webhooks, public user reads) and remain
 * freely self-grantable. Keep this set CONSERVATIVE — add a scope here only when
 * it grants authority beyond the app's own tenant.
 */
export const PRIVILEGED_APPLICATION_SCOPES = [
  'federation:write',
  'reputation:write',
  'signals:write',
  'notifications:write',
  'capabilities:read',
  'catalogs:write',
  'capability-tickets:issue',
  'capability-audit:write',
  'capability-events:publish',
] as const satisfies readonly ApplicationScope[];

const PRIVILEGED_APPLICATION_SCOPE_SET: ReadonlySet<ApplicationScope> = new Set<ApplicationScope>(
  PRIVILEGED_APPLICATION_SCOPES
);

const APPLICATION_SCOPE_SET: ReadonlySet<string> = new Set<string>(APPLICATION_SCOPES);

/** True when `scope` is a recognised application scope. */
export function isValidApplicationScope(scope: string): scope is ApplicationScope {
  return APPLICATION_SCOPE_SET.has(scope);
}

/** True when `scope` is one of the staff-only privileged scopes. */
export function isPrivilegedScope(scope: string): scope is ApplicationScope {
  return PRIVILEGED_APPLICATION_SCOPE_SET.has(scope as ApplicationScope);
}

/**
 * Oxy Pay Gateway scopes — the only scopes {@link APPLICATION_SCOPES} grants
 * that authorise payments resources. Used by the `POST /applications/:appId/credentials`
 * route (`applications.ts`) as the boundary of a narrow trust carve-out: a
 * non-trusted (`third_party`) application may create a `type:'service'`
 * credential ONLY when every requested scope is in this set, so external Oxy
 * Pay merchants can self-serve the service credential the `@oxyhq/pay` SDK
 * needs without gaining the ability to mint a trusted service token for any
 * other, still staff-gated capability. Safe because both scopes are already
 * non-privileged/self-grantable (see the doc comment on `APPLICATION_SCOPES`
 * above) and scoped to the app's own tenant.
 */
export const PAYMENTS_APPLICATION_SCOPES = [
  'payments:read',
  'payments:write',
] as const satisfies readonly ApplicationScope[];

const PAYMENTS_APPLICATION_SCOPE_SET: ReadonlySet<ApplicationScope> = new Set<ApplicationScope>(
  PAYMENTS_APPLICATION_SCOPES
);

/** True when `scope` is one of the Oxy Pay Gateway scopes. */
export function isPaymentsScope(scope: string): scope is ApplicationScope {
  return PAYMENTS_APPLICATION_SCOPE_SET.has(scope as ApplicationScope);
}

/**
 * Effective scopes for a credential = credential scopes ∩ application scopes,
 * preserving the credential's order and dropping unknown scopes. A credential
 * can never exceed the authority granted to its owning application: if the app
 * loses a scope, every credential loses it too at the next token mint. This is
 * the single authority used by both the credential-create validation and the
 * service-token mint, so the two paths cannot drift.
 */
export function intersectScopes(
  credentialScopes: readonly string[],
  appScopes: readonly string[]
): ApplicationScope[] {
  const granted = new Set<string>(appScopes);
  const result: ApplicationScope[] = [];
  const seen = new Set<string>();
  for (const scope of credentialScopes) {
    if (!granted.has(scope) || seen.has(scope)) continue;
    if (!isValidApplicationScope(scope)) continue;
    seen.add(scope);
    result.push(scope);
  }
  return result;
}

/**
 * Reconcile a canonical (declarative) scope set with the scopes already granted
 * on a stored application ADDITIVELY: the result is the UNION of both, in a
 * stable order (canonical first, then any additional already-granted scope),
 * de-duplicated, with unknown/legacy scopes dropped.
 *
 * This is the single authority for any "rebuild an application's scopes from a
 * canonical list" path (the official-app seed today; any future ensure/rebuild
 * routine). A destructive replace of `application.scopes` with only the
 * canonical list silently REVOKES a legitimately-granted, in-use scope that was
 * added out-of-band — and because {@link intersectScopes} intersects credential
 * scopes with app scopes at every service-token mint, the credential loses the
 * scope too. Using a union makes it IMPOSSIBLE for a granted, valid scope to
 * vanish on the next rebuild. Intentionally REMOVING a scope is therefore an
 * explicit operation on the app record, never a side effect of a rebuild.
 */
export function unionValidScopes(
  canonicalScopes: readonly string[],
  existingScopes: readonly string[]
): ApplicationScope[] {
  const result: ApplicationScope[] = [];
  const seen = new Set<string>();
  for (const scope of [...canonicalScopes, ...existingScopes]) {
    if (seen.has(scope)) continue;
    if (!isValidApplicationScope(scope)) continue;
    seen.add(scope);
    result.push(scope);
  }
  return result;
}
