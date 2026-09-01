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
 * - The `inference:*` family authorises the Oxy inference edge. `inference:invoke`
 *   spends the OWNING ACCOUNT's balance on a request; `inference:models:read`,
 *   `inference:usage:read`, `inference:routing:read` and
 *   `inference:providers:read` read the model catalogue, the app's own usage
 *   receipts, and the routing/provider descriptors. Those five are
 *   non-privileged: each is bounded to the app's own tenant, and a delegated
 *   end-user identity is never the billing principal, so an application can only
 *   ever spend the balance of the account that owns it. The two WRITES are
 *   privileged — see {@link PRIVILEGED_APPLICATION_SCOPES}.
 *
 *   This family REPLACED `chat:completions` and `models:read` outright. Those two
 *   authorised nothing: no middleware, route or service in this repository ever
 *   read either one, so they were a vocabulary entry an application could hold
 *   and never a permission anything checked. They were removed rather than kept
 *   as aliases — an alias for a name that gated nothing is a second way to spell
 *   a no-op.
 * - `reputation:moderation:apply` permits the participatory-moderation service to
 *   submit a published DECISION for consequence derivation. It is deliberately
 *   NARROWER than `reputation:write`, not additive to it — see
 *   {@link PRIVILEGED_APPLICATION_SCOPES}.
 * - `reputation:binding:register` permits an application to register the fact
 *   that an Oxy user was present in it as a named local principal, PROVING it
 *   with that user's own access token. PRIVILEGED — only Oxy platform staff may
 *   grant it.
 * - `chains:write` permits a service credential to append records to the signed
 *   chain of an arbitrary Oxy user, issued and signed by Oxy on the app's
 *   behalf. PRIVILEGED — see {@link PRIVILEGED_APPLICATION_SCOPES}. It is not
 *   sufficient on its own: the collection must also fall under one of the
 *   application's own `chainNamespaces`, which is what keeps one app out of
 *   another's namespace, and an app with no grant can write nothing.
 * - `chains:read` permits a service credential to read records from MANY
 *   subjects' chains in one call, which is how an app projects a cross-app feed.
 *   Deliberately NOT privileged: it can only ever return collections
 *   `config/chainCollectionPolicy.ts` declares public, and the server takes the
 *   intersection itself rather than trusting the request. Its risk is bulk
 *   access to already-public records, which is a rate-limit question, not an
 *   authority one — so it does not need staff to grant it, and it is a separate
 *   scope from `chains:write` because reading everyone's public records and
 *   writing into someone's chain are not the same permission.
 * - The `follows:*` family and `follow-targets:register` let an application act
 *   on the user's OWN follow graph. They are deliberately NOT privileged: the
 *   authority comes from the subject user's explicit grant, never from what the
 *   platform thinks of the application. Their real constraint lives in
 *   {@link USER_CONSENT_REQUIRED_SCOPES} — they can never be auto-approved, for
 *   any application classification.
 * - `acting-as:offline` is the scope that makes SERVICE-TOKEN delegation
 *   possible at all: it is what `GET /internal/service-acting-as/verify` looks
 *   for before answering `authorized: true`, and without it in the user's grant
 *   an application holding a service token can act only as ITSELF. PRIVILEGED —
 *   see {@link PRIVILEGED_APPLICATION_SCOPES} — AND consent-required, which is
 *   the pair of gates it needs and neither alone would give.
 *
 *   It is NOT `account:act_as` (`utils/accountRoles.ts`), which is membership on
 *   the ACCOUNT graph and mints a session. Nothing here mints anything: it
 *   authorises one already-authenticated service principal to name a user in
 *   `X-Oxy-User-Id`, and that user is attribution only, never the billing
 *   principal (ADR 0007).
 * - `accounts:act-as-session` permits a service credential to MINT A SESSION
 *   whose subject is a managed account (`organization` / `project` / `bot`), on
 *   the authority of a human who holds `account:act_as` over it —
 *   `POST /internal/accounts/:id/service-switch`. It is what lets an Oxy app run
 *   an autonomous agent AS a real `bot` account rather than as itself wearing a
 *   label. PRIVILEGED — see {@link PRIVILEGED_APPLICATION_SCOPES}.
 *
 *   IT IS A SEPARATE SCOPE FROM `acting-as:offline`, NOT A VARIANT OF IT, and
 *   the distance between them is the whole reason it exists. `acting-as:offline`
 *   buys per-request ATTRIBUTION: the service stays the principal and merely
 *   names a user. This buys a DURABLE SESSION whose subject is somebody else's
 *   account — a bearer that outlives the request, refreshes itself, and speaks
 *   with that account's voice everywhere in the ecosystem. Spelling one as a
 *   flavour of the other would have silently handed that authority to every
 *   application already holding the smaller one, which is why the name sits in
 *   the `accounts:` family beside `accounts:provision` rather than in the
 *   `acting-as:` one.
 *
 *   It authorises the CALL, never the delegation. The per-human decision is
 *   `account:act_as` on the account graph, re-read from `account_members` on
 *   every mint and re-checked on every validate and refresh, so a member losing
 *   it kills the live session rather than merely refusing the next one.
 * - `podcasts:write` permits a delegated service request to create and update
 *   podcast episodes belonging to the SUBJECT USER in the app that owns them.
 *   Not privileged: it is the user's own content in the user's own account, the
 *   same shape as `files:write`, and the authority comes from the user's grant
 *   rather than from what the platform thinks of the application.
 *
 *   It names a resource this API does not itself serve, which is the one thing
 *   about it worth flagging. Oxy is the authorization server for the ecosystem,
 *   and `intersectScopes` DROPS any scope not in this vocabulary — so a scope a
 *   consuming app's resource server needs has to exist here or it can never
 *   reach a token. A per-application scope namespace would be the better
 *   long-run answer; until one exists, a resource scope lands here.
 */
export const APPLICATION_SCOPES = [
  'files:read',
  'files:write',
  'files:delete',
  'user:read',
  'webhooks:receive',
  'inference:invoke',
  'inference:models:read',
  'inference:usage:read',
  'inference:routing:read',
  'inference:routing:write',
  'inference:providers:read',
  'inference:providers:write',
  'updates:publish',
  'federation:write',
  'signals:write',
  'reputation:write',
  'reputation:moderation:apply',
  'reputation:binding:register',
  'notifications:write',
  'capabilities:read',
  'catalogs:write',
  'capability-tickets:issue',
  'capability-audit:write',
  'capability-events:publish',
  'payments:read',
  'payments:write',
  'accounts:provision',
  'follows:read',
  'follows:write',
  'follows:context:write',
  'follows:manage',
  'follows:events',
  'follow-targets:register',
  'chains:write',
  'chains:read',
  'acting-as:offline',
  'accounts:act-as-session',
  'podcasts:write',
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
 * - `reputation:moderation:apply` lets the participatory-moderation service
 *   submit a published decision for consequence derivation.
 *
 *   IT IS NOT A SUBSET OF `reputation:write`, AND IT IS NOT ADDITIVE TO IT.
 *   `reputation:write` is the broad ledger-write authority every official app
 *   already holds; it can mint arbitrary points for arbitrary users through
 *   `POST /reputation/award`. This scope can do none of that: it can only submit
 *   a DECISION, and the engine derives the figures itself from the versioned
 *   policy. Deliberately separate so the moderation bridge does not inherit
 *   ledger-write authority, and so the apps that hold ledger-write authority do
 *   not inherit the ability to penalise conduct. Neither implies the other, and
 *   holding both is a decision someone has to make explicitly.
 * - `chains:write` lets a service credential append to the signed chain of
 *   ARBITRARY Oxy users. A chain is append-only and its records are what other
 *   apps project their feeds from, so a self-granting owner could otherwise
 *   write records into any account it can name — and nothing can be unwritten.
 *   The namespace grant narrows WHAT it may write; only staff decide whether it
 *   may write at all.
 * - `accounts:provision` lets a service credential MINT a `channel` account
 *   under an arbitrary user and grant membership on one. It creates no session
 *   and writes no auth method — a channel cannot be acted as at all, which is
 *   what bounds it — but it acts on behalf of users outside the app's own
 *   tenant, so it is not self-grantable.
 * - `reputation:binding:register` lets an application assert that a named local
 *   principal is a particular Oxy user. The assertion must be backed by that
 *   user's own access token, but the scope is still privileged because a binding
 *   is what makes a later conduct penalty possible at all.
 * - `inference:routing:write` and `inference:providers:write` mutate the objects
 *   that decide WHERE an inference request is served from — routing profiles,
 *   and provider/deployment connections. Both are catalogue objects the platform
 *   serves every tenant from, not per-application settings, so a self-granting
 *   owner could repoint traffic that is not its own; and `inference:providers:write`
 *   is additionally where BYOK provider credentials are managed, which makes it
 *   the one scope here whose misuse redirects other people's requests AND the
 *   secrets used to serve them. Their READ counterparts are deliberately NOT
 *   here: describing where a request would go is not deciding it, and an app
 *   that cannot see the catalogue cannot debug its own latency.
 *
 *   Neither object exists in this repository yet — these scopes are defined
 *   ahead of the inference data plane, so this classification is the DECISION
 *   and not a description of enforcement already in place. Revisit it if routing
 *   profiles and provider connections turn out to be per-account rows rather
 *   than a shared catalogue; that, and only that, would make these two
 *   own-tenant operations.
 *
 * - `acting-as:offline` is the scope a service token must carry before it may
 *   name a user in `X-Oxy-User-Id` at all. Privileged AND consent-required, and
 *   the two answer different questions: consent stops the PLATFORM deciding for
 *   the user, and privilege stops an arbitrary self-service application ever
 *   putting the question to them. Neither substitutes for the other — a
 *   consent-only scope would let any third-party app open a dialog asking to act
 *   as the user forever, which is a phishing surface even when every individual
 *   answer is the user's own.
 *
 *   Today the service-token MINT already refuses untrusted applications, so an
 *   untrusted app holding this scope authorises nothing. That is a second gate,
 *   not a reason to leave this one out: the mint's trust check exists to protect
 *   the service lane as a whole, and if the narrow Oxy Pay carve-out there ever
 *   widens, this classification is what still stands between a self-service app
 *   and an offline delegation grant.

 * - `accounts:act-as-session` mints a real, refreshable session whose subject is
 *   a managed account the calling application does not own. It is the largest
 *   authority `/internal` grants, and it reaches accounts in every tenant, so it
 *   is staff-only for the same reason `accounts:provision` is — an application
 *   owner may not decide for themselves that their app may become other people's
 *   organizations and bots.
 *
 *   It is deliberately ABSENT from {@link USER_CONSENT_REQUIRED_SCOPES}, which
 *   is a decision and not an omission — the reasoning is recorded on that
 *   constant, because the question it asks is answered on a different lane.
 *
 * All non-privileged scopes in {@link APPLICATION_SCOPES} authorise an app only
 * over its OWN resources (files, models, webhooks, public user reads) or over
 * the subject user's own content under that user's explicit grant
 * (`podcasts:write`), and remain freely self-grantable. Keep this set
 * CONSERVATIVE — add a scope here only when it grants authority beyond the app's
 * own tenant.
 */
export const PRIVILEGED_APPLICATION_SCOPES = [
  'federation:write',
  'reputation:write',
  'reputation:moderation:apply',
  'reputation:binding:register',
  'signals:write',
  'notifications:write',
  'accounts:provision',
  'chains:write',
  'inference:routing:write',
  'inference:providers:write',
  'acting-as:offline',
  'accounts:act-as-session',
] as const satisfies readonly ApplicationScope[];

/**
 * The follow family: authority over the USER's own follow graph.
 *
 * Named as its own set because two different rules need to say "is this a follow
 * scope", and only one of them is "must the user consent". `assertFollowScopes`
 * (`services/followCapability.service.ts`) is the other: it guards the follow
 * authorization path against a scope from another domain reaching it by
 * accident, and it once asked {@link isUserConsentRequiredScope} because the two
 * sets happened to be identical.
 *
 * They are not identical any more, and that coincidence was load-bearing in the
 * worst way: the moment a NON-follow scope became consent-required, the guard
 * started admitting it, silently, while still reading as if it checked
 * something. A guard defined by a set it does not own is a guard that changes
 * meaning when someone edits that set for an unrelated reason.
 */
export const FOLLOW_APPLICATION_SCOPES = [
  'follows:read',
  'follows:write',
  'follows:context:write',
  'follows:manage',
  'follows:events',
  'follow-targets:register',
] as const satisfies readonly ApplicationScope[];

const FOLLOW_APPLICATION_SCOPE_SET: ReadonlySet<string> = new Set<string>(
  FOLLOW_APPLICATION_SCOPES
);

/** True when `scope` is authority over the user's follow graph. */
export function isFollowScope(scope: string): boolean {
  return FOLLOW_APPLICATION_SCOPE_SET.has(scope);
}

/**
 * Scopes the SUBJECT USER must consent to explicitly, for every application,
 * with no auto-approval path.
 *
 * This is a different axis from {@link PRIVILEGED_APPLICATION_SCOPES} and the
 * two must not be confused. Privileged asks "may this application's OWNER grant
 * this to themselves?", and its answer is about platform staff. This asks "may
 * the platform decide on the USER's behalf?", and its answer is always no —
 * whoever the application is.
 *
 * Trusted applications are otherwise auto-approved on the consent path (the
 * "Google with its own apps" model), which is reasonable for an app reading its
 * own files and wrong for the user's follow graph: those relationships are the
 * user's, they are visible to the people on the other end of them, and being
 * first-party is not a reason to be handed them without being asked. So a
 * request naming any scope in this set always reaches the consent screen and
 * always records a revocable grant, and an official application and a
 * third-party one get exactly the same treatment for the same requested scopes.
 *
 * Adding a scope here makes it un-bypassable. Keep it to authority over data
 * that is the USER's rather than the application's.
 *
 * `acting-as:offline` is here for a reason the follow family does not share, and
 * it is the reason the whole service-acting-as mechanism WORKS. A trusted
 * application is auto-approved and — by design — records NO grant row
 * (`recordAppGrant` is skipped, see `routes/auth.ts`). Every application that can
 * mint a service token is trusted. So without this entry the verify endpoint
 * would find no row for exactly the applications that can reach it, and offline
 * delegation would be unreachable rather than merely unauthorized. Membership
 * here is what makes the consent screen appear, what writes the row, and what
 * puts the app in "Connected apps" where the user can take it back.
 *
 * `podcasts:write` is here on the ordinary criterion: podcast episodes written
 * into a user's account are the user's content, and being first-party is not a
 * reason to be handed them without being asked.

 * `accounts:act-as-session` is deliberately NOT here, and it is the one absence
 * worth arguing rather than assuming, because it is the most powerful scope in
 * the vocabulary. Membership here would buy nothing and cost a lie.
 *
 * It buys nothing because this set only has teeth on the OAuth authorize lane:
 * it forces a consent screen and makes `recordAppGrant` write an `app_grants`
 * row. `POST /internal/accounts/:id/service-switch` never reads an `app_grants`
 * row for its own scope — it reads the scope off the SERVICE TOKEN, which is
 * minted from a credential, with no user in the request to consent to anything.
 * A grant row naming it would sit there authorizing nothing, which is exactly
 * the "vocabulary entry an application could hold and never a permission
 * anything checked" this module retired `chat:completions` for.
 *
 * It costs a lie because the screen would name the wrong person. The user an
 * OAuth consent screen is shown to is whoever is signing in; the human whose
 * decision actually gates this mint is a member of the TARGET account holding
 * `account:act_as` over it, and those are routinely different people. Asking
 * the first to approve on behalf of the second would present a real decision to
 * someone who does not hold it.
 *
 * The per-human decision is not missing — it is `account:act_as` on the account
 * graph, granted per member through the account's own members surface, read on
 * every mint and re-read on every validate and refresh. Revocation is reachable
 * two ways, both of which the endpoint consults: withdraw that membership, or
 * revoke the application outright (`service_acting_as_revocations`).
 *
 * NO `inference:*` scope belongs here, and the reason is the attribution rule
 * rather than a judgement about how sensitive inference is. The financially
 * responsible principal on every inference request is the application's OWNER
 * ACCOUNT; a delegated end-user id is attribution only and is never a substitute
 * for the billing identity. So `inference:invoke` spends the app's money, not
 * the user's, and `inference:usage:read` reads the app's receipts, not the
 * user's history. Neither is the user's data, which is the question this set
 * asks. Prompts and responses are not persisted by default, so there is no
 * user-owned record for a read scope to reach either. REOPEN this the moment
 * either premise stops holding — if an inference request can ever be billed to a
 * delegated user's balance, or if prompt history becomes a stored, user-owned
 * resource, then the scope that reaches it belongs in this set.
 */
export const USER_CONSENT_REQUIRED_SCOPES = [
  ...FOLLOW_APPLICATION_SCOPES,
  'acting-as:offline',
  'podcasts:write',
] as const satisfies readonly ApplicationScope[];

const USER_CONSENT_REQUIRED_SCOPE_SET: ReadonlySet<string> = new Set<string>(
  USER_CONSENT_REQUIRED_SCOPES
);

/** True when `scope` may never be auto-approved on the user's behalf. */
export function isUserConsentRequiredScope(scope: string): boolean {
  return USER_CONSENT_REQUIRED_SCOPE_SET.has(scope);
}

/**
 * The subset of `requested` that the user has to be asked about.
 *
 * Returned rather than a boolean so a caller can SHOW which scopes forced the
 * screen — "this app wants to manage who you follow" is the sentence the user
 * needs, and a bare `true` cannot produce it.
 */
export function userConsentRequiredScopes(requested: readonly string[]): string[] {
  return requested.filter(isUserConsentRequiredScope);
}

/**
 * The one scope `POST /internal/accounts/:id/service-switch` requires.
 *
 * Named here rather than spelled as a literal in the route because the
 * annotation is the gate: typed `ApplicationScope`, renaming or removing the
 * vocabulary entry makes THIS line a compile error instead of leaving a route
 * checking for a string no token can ever carry — a gate that fails open and
 * reads as if it still measures something.
 */
export const SERVICE_ACCOUNT_SWITCH_SCOPE: ApplicationScope = 'accounts:act-as-session';

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
