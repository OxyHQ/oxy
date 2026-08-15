# Audit — account and application ownership, as of 2026-08-15

**Taken at:** commit `215b12fea110f213f11ef867e189546321fe10b2` (`main`, 2026-08-11).
**Scope:** workstream 1 of the single-control-plane epic (OxyHQ/oxy#972) — inference
and billing attribution, application ownership, account-graph permissions, and
Console account switching.
**Method:** static reading of `packages/api`, `packages/console` and
`packages/services` at that commit, plus the package's own Jest suite run against
a real Postgres (319 suites / 4694 tests, all green, at the same commit).

This document records what is TRUE at that commit. Where the epic's premise and
the code disagree, the code is reported and the disagreement is called out.
Anything not verified is marked **UNVERIFIED** and says why.

---

## 0. Summary of findings that contradict the epic's premise

The epic frames workstream 1 as a risk that the financially responsible principal
is "an implicit personal user" rather than an account. At this commit the
situation is different, and in most places more severe:

| # | Finding | Where |
|---|---|---|
| F1 | The only live inference endpoint attributes to **no principal at all** — no usage row, no credit deduction, no application, no owner account. It authenticates a user and then discards them. | `packages/api/src/routes/alia.ts:65` |
| F2 | `api_key_usage_events` — the table the epic names as the attribution problem — has **no writer anywhere in `packages/api`**. Both readers query a table nothing populates. | `packages/api/src/routes/credits.ts:110`, `packages/api/src/routes/applications.ts:485` |
| F3 | `deductCredits` has **no production caller**. Nothing in the platform spends a credit. | `packages/api/src/db/credits.ts:147` |
| F4 | An application **does** always carry `ownerAccountId`, and all four access-derivation sites go through it. That checkbox is genuinely satisfied. | `packages/api/src/db/schema/applications.ts:172` |
| F5 | `billing:read` and `billing:manage` — account **and** application vocabularies — are read by **zero** route or service at this commit. The `billing` role grants rights nothing consults. (Measured with a positive control: the same grep finds `usage:read` gated at `routes/applications.ts:1141`, so it can see a gate when one exists. The helper this PR adds is the first reader of `billing:read` in the package.) | `packages/api/src/utils/accountRoles.ts:78`, `:143`, `:305` |
| F6 | Every billing/credit surface keys on the bearer's own subject, never on an application's owner account. Reaching an organization's balance therefore requires `account:act_as` — which the `billing` role does **not** have. The two halves of "organization billing" are mutually exclusive today. | `packages/api/src/routes/billing.ts:126`, `packages/api/src/utils/accountRoles.ts:143` |
| F7 | Console account switching is **not** a client-only filter: it mints a real session, and the SDK invalidates the whole React Query cache on the subject transition. But the Console's billing hooks are not account-keyed, so they depend entirely on that SDK-side invalidation. | `packages/console/src/hooks/use-account.tsx:178`, `packages/services/src/ui/context/OxyContext.tsx:1150` |
| F8 | An account-scoped billing profile **does** exist structurally — `user_credits` is keyed on `users.id`, which IS an account id of any kind. What is missing is any code path that provisions or reads one for a non-personal account. The gap is in the routes, not in the schema. | `packages/api/src/db/schema/userCredits.ts:65` |
| F9 | The service token carries `appId` + `credentialId` but **not** `ownerAccountId`, so a machine-authenticated request cannot name its financially responsible principal without a database round trip. | `packages/api/src/middleware/serviceToken.ts:21` |

---

## 1. Inference-related reads and writes, and the principal each resolves

### 1.1 The live inference path resolves no principal

`packages/api/src/routes/alia.ts` is the whole of it. Mounted twice —
`app.use('/alia', …)` (`packages/api/src/server.ts:643`) and `app.use('/v1', …)`
(`packages/api/src/server.ts:647`).

- `POST /v1/chat/completions` — `packages/api/src/routes/alia.ts:65`
- `POST /v1/voice/token` — `packages/api/src/routes/alia.ts:99`
- `POST /v1/voice/transcribe` — `packages/api/src/routes/alia.ts:102`

All three are gated by `authMiddleware` (`packages/api/src/routes/alia.ts:3`), so a
user session bearer is required — and the handler never reads `req.user`. The
request body is forwarded verbatim to `https://api.alia.onl/v1`
(`packages/api/src/routes/alia.ts:7`) under one shared server-side key,
`ALIA_API_KEY` (`packages/api/src/routes/alia.ts:8`).

**Principal resolved: none.** Not an account, and not an implicit personal user
either — the authenticated identity is verified and then discarded. No
`api_key_usage_events` row is written, no credit is deducted, no `Application` or
`ApplicationCredential` is resolved, no `ownerAccountId` is looked up. Upstream
cost accrues to one platform-wide provider key with no per-caller record.

Two internal services call the same upstream with the same shared key, on Oxy's
own behalf rather than a customer's — `packages/api/src/services/aiLabeling.service.ts:150`
and `packages/api/src/services/cardExtraction.service.ts:114`. Those are correctly
un-attributed (they are Oxy's own spend), but they are indistinguishable upstream
from customer traffic because they share the key.

### 1.2 `GET /models/stats` is a static catalogue

`packages/api/src/routes/models-stats.ts:58`. Public (no auth, no rate limiter
beyond the global one), returns four hardcoded model descriptors with
`avgLatencyMs: 0`, `uptime: 100`, `totalRequests: 0`
(`packages/api/src/routes/models-stats.ts:60`). Each carries a
`creditMultiplier` expressed as a JavaScript number
(`packages/api/src/routes/models-stats.ts:14`, `:25`, `:36`, `:47`) that **no code
reads** — it is presentation only. It is nonetheless the only price-like value in
the repository, and it is a float; see the epic's "customer charges never use
floating-point values" invariant before anything starts reading it.

### 1.3 `api_key_usage_events` — schema says user, and nothing writes it

The table declares `user_id` NOT NULL with an `ON DELETE CASCADE` reference to
`users` (`packages/api/src/db/schema/apiKeyUsageEvents.ts:83`), commented as "the
user the request is billed to". There is **no `account_id`** column, which is what
the epic flagged.

The stronger finding is that the column's value is moot: **no file in
`packages/api/src` outside `__tests__` inserts into this table.** Measured by
grepping the SQL table name, the drizzle symbol and the Mongoose-era model name
together (`api_key_usage_events|apiKeyUsageEvents|ApiKeyUsage`), which is not a
blind zero — the same pattern returns the readers listed below, and
`insert(apiKeyUsageEvents)` outside `__tests__` returns nothing. The only
production references are two readers and the expiry sweep:

- `packages/api/src/routes/credits.ts:110` — `GET /credits/usage`, daily buckets
  filtered by `eq(apiKeyUsageEvents.userId, userId)` (`:123`) where `userId` is
  `req.user?._id` (`:87`).
- `packages/api/src/routes/applications.ts:485`, `:490`, `:497` — the per-app usage
  summary, filtered by `eq(apiKeyUsageEvents.applicationId, applicationId)`
  (`:465`).
- `packages/api/src/db/expiry.ts:186` — the 90-day retention sweep.

Both readers therefore return empty results in production today. Because
`applicationId` is nullable (`packages/api/src/db/schema/apiKeyUsageEvents.ts:87`)
while `userId` is not, the table as declared would attribute a request to a
person even when it cannot attribute it to an application — the exact inversion
the epic wants to prevent. That has to be fixed before a writer is added, not
after.

Related: `developer_api_keys` (`packages/api/src/db/schema/developerApiKeys.ts`) is
referenced only by `api_key_usage_events.api_key_id`
(`packages/api/src/db/schema/apiKeyUsageEvents.ts:75`), the schema barrel, and
tests. **No route or service reads or writes it.** That confirms the epic's 2.3
checkbox "confirm `developer_api_keys` is empty/unreferenced" on the *unreferenced*
half; whether the production table holds rows is **UNVERIFIED** (no production
database access from this worktree).

### 1.4 Credit reads and writes

| Operation | Principal | Evidence |
|---|---|---|
| `GET /credits` | bearer subject | `packages/api/src/routes/credits.ts:58` |
| `GET /credits/usage` | bearer subject | `packages/api/src/routes/credits.ts:87` |
| `refreshCreditsIfNeeded` | bearer subject | called at `packages/api/src/routes/credits.ts:65` |
| `addCredits` | Stripe metadata `userId` / the account resolved from `stripe_customer_id` | `packages/api/src/routes/billing.ts:505`, `:614` |
| `deductCredits` | — **no production caller** | defined `packages/api/src/db/credits.ts:147`; only importer outside `db/credits.ts` is `packages/api/src/db/__tests__/credits.test.ts:17` |

`getOrCreateUserCredits` (`packages/api/src/routes/credits.ts:37`) provisions the
row on first read, keyed on the bearer's subject.

### 1.5 Billing reads and writes

Every handler in `packages/api/src/routes/billing.ts` derives its principal from
`req.user?._id`: `:126`, `:175`, `:215`, `:250`, `:295`, `:332`. No handler accepts
or resolves an account id, and none consults the account graph.

The Stripe webhook (`packages/api/src/routes/billing.ts:362`) is the one path with a
different principal source, and it is still a single account id:

- `checkout.session.completed` → `session.metadata.userId`
  (`packages/api/src/routes/billing.ts:431`, `:463`).
- `customer.subscription.*` → the account resolved from
  `user_credits.stripe_customer_id` (`packages/api/src/routes/billing.ts:521-525`),
  which carries a partial unique index
  (`packages/api/src/db/schema/userCredits.ts:98`).

`billing_subscriptions.user_id` and `billing_transactions.user_id` are likewise a
single account id (`packages/api/src/db/schema/billingSubscriptions.ts:84`).

`packages/api/src/controllers/subscription.controller.ts:17` gates on
`assertOwnership`, a bare `req.user._id.toString() !== userId` comparison
(`:21`) — a self-only check that does not consult the account graph at all.

### 1.6 Is the principal an account or an implicit personal user?

**It is the bearer's subject, and that subject CAN be a non-personal account.**
`POST /accounts/:id/switch` (`packages/api/src/routes/accounts.ts:642`) mints a real
session whose `user` IS the target account, gated on `account:act_as`
(`packages/api/src/routes/accounts.ts:655-660`) and refusing personal and channel
targets (`:667-678`). So `req.user._id` inside `routes/billing.ts` is an
organization/project/bot account id whenever the caller has switched into one, and
`user_credits.user_id` will be that account.

So the answer is neither of the epic's two options cleanly:

- the *schema* is account-capable throughout (`user_credits`,
  `billing_subscriptions`, `billing_transactions` and `api_key_usage_events` all
  reference `users.id`, and `users` IS the account table);
- the *routes* resolve a principal that happens to be whichever account the caller
  is currently acting as, which is an accident of session state rather than a
  decision about who pays;
- nothing anywhere resolves an application's owner account in order to bill it.

---

## 2. Does an application always inherit access and billing responsibility from `Application.ownerAccountId`?

### 2.1 Access: yes, at all four derivation sites

`applications.owner_account_id` is `NOT NULL` with `ON DELETE CASCADE`
(`packages/api/src/db/schema/applications.ts:172`), so there is no ownerless state.

Every site that derives a human caller's access to an application does so from
`ownerAccountId` through `accountService.resolveEffectiveAccess`, and there is no
per-application membership table:

1. `packages/api/src/routes/applications.ts:533` (`loadApplicationContext`) →
   `:546` resolve, `:554` map to application permissions via
   `appPermissionsForAccountRole`. Used by `requireAppPermission`
   (`packages/api/src/routes/applications.ts:568`) on every `/:appId` route.
2. `packages/api/src/routes/updatesAdmin.ts:117-133` (`authorizeForApp`, the OTA
   admin gate).
3. `packages/api/src/services/store.service.ts:493-507`
   (`requirePublisherAccess`, replying to a store review as the publisher).
4. `packages/api/src/routes/profiles.ts:831-844`
   (`resolveAuthorizedRecommendationClientId`, honouring a caller-supplied
   `clientId`).

The list endpoint takes the same route in reverse: it enumerates the caller's
accessible accounts and filters applications by `ownerAccountId`
(`packages/api/src/routes/applications.ts:607-632`). Create defaults
`ownerAccountId` to the caller's own account and requires `apps:create` over it
(`packages/api/src/routes/applications.ts:675-683`).

**Nothing derives access some other way.** `created_by_user_id` is attribution
only — its single non-serializer read is the consent screen's developer-name
lookup (`packages/api/src/routes/auth.ts:2287-2301`), which grants nothing.

Two divergences between the four copies, both live today:

- Sites 1 and 2 exclude `status = 'deleted'`
  (`packages/api/src/routes/applications.ts:540`,
  `packages/api/src/routes/updatesAdmin.ts:120`); sites 3 and 4 do not. A
  soft-deleted application is therefore invisible to the RBAC gate and still
  addressable through the recommendation and store paths.
- Site 4 grants on *any* effective access (`packages/api/src/routes/profiles.ts:841`
  checks only that `access` is non-null) rather than on a named permission, so a
  `viewer` of the owning account can select that app's recommendation signals.

### 2.2 Machine callers: the application, not the owner account

`POST /auth/service-token` (`packages/api/src/routes/auth.ts:3557`) resolves
credential → application (`:3573`, `:3622`) and stops there. The minted JWT
carries `appId`, `appName`, `credentialId`, `scopes`, `environment`
(`packages/api/src/routes/auth.ts:3663-3674`) — **no `ownerAccountId`**. The verifier
surfaces only `appId`, `appName`, `credentialId`, `scopes`
(`packages/api/src/middleware/serviceToken.ts:21-30`); `environment` is signed but
never read back out, so any consumer relying on it today is reading a claim the
shared verifier drops.

Consequently every service-token consumer that wants a billable principal must do
a database round trip it currently does not do. `req.serviceApp.appId` is used as
the attribution key at `packages/api/src/routes/moderationReputation.routes.ts:228`,
`:311`, `packages/api/src/routes/reputation.routes.ts:479` and
`packages/api/src/routes/federation.ts:465` — application-scoped, never
account-scoped.

### 2.3 Billing responsibility: no, and nothing tries

There is no code path anywhere in `packages/api` that reads
`applications.ownerAccountId` in order to decide whose balance to charge, whose
subscription applies, or whose spending limit is in force. The word "billing"
never meets the word "application" in this package. The `billing:read` /
`billing:manage` application permissions exist in the map
(`packages/api/src/utils/accountRoles.ts:49-50`, `:305`) and are gated by nothing.

---

## 3. How organization/project members receive effective app permissions

The mechanism is real, complete, and single-sourced. There is exactly one
membership reader.

**Storage.** `account_members` — one row per `(account_id, member_user_id)` with a
compound unique (`packages/api/src/db/schema/accountMembers.ts:114`), a `role` from
`ACCOUNT_ROLES`, per-member `permission_grants` / `permission_revokes`
(`:90`, `:95`), an `inherit` flag (`:100`) and a `status`. The materialised
ancestor path lives in `user_ancestors`, root-first by `depth`
(`packages/api/src/services/account.service.ts:334-341`).

**Resolution.** `resolveEffectiveMembership`
(`packages/api/src/services/account.service.ts:293`) walks nearest-first over
`[accountId, ...ancestors.reverse()]` (`:305`): a direct row on the account always
wins (`:309`), an ancestor row applies only when `inherit` is true (`:312`).
`resolveEffectiveAccess` (`packages/api/src/services/account.service.ts:724`) wraps
it, treats a caller over their own account as an implicit owner (`:729-736`),
refuses archived accounts (`:744`), and returns the effective permission set via
`effectivePermissionsForMember` (`:798`).

**Permission derivation.** `resolveEffectivePermissions`
(`packages/api/src/utils/accountRoles.ts:214`) = role baseline + grants − revokes,
built by filtering the vocabulary itself (`:222`) so a retired permission string
goes inert without a write. A revoke beats a grant naming the same permission
(`:221`).

**Application mapping.** `appPermissionsForAccountRole`
(`packages/api/src/utils/accountRoles.ts:313`) maps an account role to the
application permissions it confers over apps that account owns, from
`APP_PERMISSIONS_BY_ROLE` (`:265`).

**A latent hazard in the shared resolver, currently unreachable.**
`resolveEffectiveAccess` treats `userId === accountId` as implicit ownership of
one's own personal account (`packages/api/src/services/account.service.ts:728-735`),
and that comparison is a bare string equality reached BEFORE any emptiness check.
So `resolveEffectiveAccess('', '')` returns `role: 'owner'` with the full
permission set — an unset id becomes a grant. (Its sibling
`effectiveAccessForAccount` does guard, at
`packages/api/src/services/account.service.ts:763-765`, but that guard sits after
the entry point's self branch and never runs for this input; confirmed by deleting
the helper's own guard and watching the case go red.) **No caller reaches it
today**, and each of the
four is guarded by a different mechanism, which is why this is worth writing down
rather than assuming it stays true:

- `packages/api/src/routes/applications.ts:160` (`requireUserId` throws 401 on a
  falsy id) and express guarantees a non-empty `:appId`;
- `packages/api/src/routes/updatesAdmin.ts:113-116` throws on a falsy id;
- `packages/api/src/routes/profiles.ts:826-829` returns early on a falsy id;
- `packages/api/src/services/store.service.ts:532`, `:557` receive
  `authorUserId` from `requireUserId(req)` at
  `packages/api/src/routes/store.ts:224`, `:239`.

A machine principal is the direction this could open from: `verifyServiceToken`
requires `typeof appId === 'string'` but not a non-empty one
(`packages/api/src/middleware/serviceToken.ts:82`). The helper added in this PR
guards it explicitly and has a mutation-tested case for it
(`packages/api/src/services/__tests__/attribution.service.test.ts`, "refuses an
empty caller/account pair"); the shared resolver itself is unchanged.

**One consequential asymmetry.** The application mapping is keyed on the
`AccountRole` ALONE. Every one of the four gates calls
`appPermissionsForAccountRole(access.role)` and discards
`access.permissions` — see `packages/api/src/routes/applications.ts:554-555`,
`packages/api/src/routes/updatesAdmin.ts:131`,
`packages/api/src/services/store.service.ts:504`. So **per-member grants and
revokes do not reach application permissions at all**: revoking `apps:delete` from
an admin still leaves them `app:delete` over every application that account owns.
The account-level gate honours the deltas (`requireAccountPermission`,
`packages/api/src/routes/accounts.ts:582-585`); the application-level gate does
not. This is a real divergence between two doors onto the same authority, and it
is not documented anywhere in the code.

---

## 4. Console account switching

**It is not a client-only filter.** `setCurrentAccount`
(`packages/console/src/hooks/use-account.tsx:175`) awaits
`switchToAccount(account.accountId)` (`:178`) before updating local selection, and
`switchToAccount` (`packages/services/src/ui/context/useOxyAccountGraph.ts:67`)
either switches the device session (`:77`) or mints a new one via
`oxyServices.switchToAccount` (`:82`) and commits it (`:86`). The API side is
`POST /accounts/:id/switch` (`packages/api/src/routes/accounts.ts:642`), which mints
a session whose subject IS the account.

**Cache correctness rests entirely on the SDK.** On a subject transition the SDK
runs `handleSubjectChange` (`packages/services/src/ui/context/OxyContext.tsx:1150`),
which drops scoped media URLs (`:1165`) and calls `queryClient.invalidateQueries()`
with no key (`:1166`) — a blanket invalidation of every query in the client.

That is what makes the Console's billing pages correct, because **the Console's own
billing hooks are not account-scoped**:

- `useCredits` → key `['credits']` (`packages/console/src/hooks/use-billing.ts:82`)
- `useSubscription` → key `['subscription']` (`:142`)
- `useTransactions` → key `['transactions', limit, offset]` (`:164`)

Compare the applications hook, which IS account-keyed:
`queryKeys.applications(accountId)` (`packages/console/src/hooks/use-applications.ts:69`,
`:85`).

So the pages do reflect the active account session — but by way of a
whole-cache invalidation in a different package, not because the query identity
says which account the data belongs to. Two consequences follow, and both are
findings rather than speculation:

1. If the SDK's blanket invalidation is ever narrowed, the Console silently starts
   showing the previous account's balance. Nothing in `packages/console` would
   fail, and nothing in `packages/console` asserts the coupling.
2. `/billing` and the dashboard credit widget (`packages/console/src/routes/_layout/billing.tsx:32-36`,
   `packages/console/src/routes/_layout/dashboard.tsx:18`) are reachable only for an
   account the caller can hold a SESSION as. A member whose role is `billing` has
   `billing:read` and `billing:manage` over the account
   (`packages/api/src/utils/accountRoles.ts:143-148`) and does **not** have
   `account:act_as` — so they can never switch into it, and can therefore never see
   the balance their role exists to let them manage. Finance-only delegation is
   expressible in the role map and unreachable in the product.

`/usage` (`packages/console/src/routes/_layout/usage.tsx:12`) is a per-application
index built from `useApplications()`, so it is account-scoped by construction.

**UNVERIFIED:** none of the above was exercised in a browser. The claim that the
blanket invalidation actually refetches billing data after a switch is read off
the source, not measured against a running Console.

---

## 5. Which of the epic's four explicit helpers existed, and which did not

At `215b12fe`, before this PR:

| Helper | Existed? | Evidence |
|---|---|---|
| application → owner account | **No** as a helper. Open-coded four times: `packages/api/src/routes/applications.ts:537-541`, `packages/api/src/routes/updatesAdmin.ts:117-120`, `packages/api/src/services/store.service.ts:494-499`, `packages/api/src/routes/profiles.ts:831-835`. |
| credential → application → owner account | **No.** Credential → application exists inline in the service-token mint (`packages/api/src/routes/auth.ts:3573`, `:3622`) and in `resolveUsableCredential` (`packages/api/src/routes/auth.ts:2200-2218`); neither takes the third hop to the owner account. |
| caller → effective account role | **Partially.** `accountService.resolveEffectiveAccess` (`packages/api/src/services/account.service.ts:724`) is the account half and is genuinely single-sourced. The application half (`appPermissionsForAccountRole`) is re-applied by hand at each of the four sites. |
| owner account → billing profile | **No.** Nothing in the package resolves a billing profile from an account id that is not the bearer's own subject. |

### What this PR adds

`packages/api/src/services/attribution.service.ts`, with
`packages/api/src/services/__tests__/attribution.service.test.ts` (32 cases against
a real Postgres):

- `resolveApplicationOwnerAccount(applicationId)`
- `resolveCredentialAttribution(clientId)` — honours `isCredentialUsable`, the same
  predicate all three auth resolution sites use
- `resolveCallerAccountAccess(userId, accountId)` and
  `resolveCallerApplicationAccess(userId, applicationId)` — both delegate the
  membership question whole to `accountService.resolveEffectiveAccess`
- `resolveAccountBillingProfile(accountId)`,
  `resolveApplicationBillingProfile(applicationId)`
- `callerMayReadApplicationBalance(userId, applicationId)` — a boolean, never the
  balance, so a call site cannot leak by forgetting to filter

Every resolution is a discriminated result rather than a nullable value, so
"no application", "revoked credential" and "this account has never been billed"
cannot collapse into one value that reads as "nothing to charge".

**Not done in this PR, deliberately:** the four existing gates are NOT rewired onto
the helpers. `packages/api` is being edited by several concurrent sessions in this
wave, and rewriting an authorization chain in `routes/applications.ts` under those
conditions risks a silent mid-air merge on a security-critical function. The
helpers are additive and the four sites are named above; adopting them is a
follow-up that one owner of that file should make in one pass, at which point the
`status = 'deleted'` divergence in §2.1 and the grants/revokes gap in §3 can be
resolved with it.

---

## 6. The missing account-scoped billing profile, precisely

The epic's fourth helper assumes an account-scoped billing profile may not exist.
The accurate statement is narrower and worse:

**The storage exists. The provisioning does not.**

`user_credits` is keyed on `user_id text primary key references users(id)`
(`packages/api/src/db/schema/userCredits.ts:65-67`), and its own header calls it
"one API-credit balance per account" and "a 1:1 extension of `users`"
(`packages/api/src/db/schema/userCredits.ts:1-13`). `users` IS the account table:
`kind` is one of personal / organization / project / bot / channel
(`packages/api/src/db/schema/users.ts:312`). Nothing about the table is
personal-only, and it already carries the Stripe customer link
(`packages/api/src/db/schema/userCredits.ts:84`).

What is missing is any way for a row to come to exist for a non-personal account
other than by coincidence:

- the only provisioning call is `getOrCreateUserCredits`
  (`packages/api/src/routes/credits.ts:37`), reached from `GET /credits`
  (`:62`), `POST /billing/checkout/*` via `getOrCreateStripeCustomer`
  (`packages/api/src/routes/billing.ts:66`) and the checkout webhook (`:467`);
- all of those key on the bearer's subject, so a row appears for an organization
  only if a human with `account:act_as` switched into it and loaded a billing page;
- for a `channel` account it is impossible — `POST /accounts/:id/switch` refuses
  channels outright (`packages/api/src/routes/accounts.ts:667-678`) — yet nothing
  stops a channel from owning an application
  (`applications.owner_account_id` has no kind constraint,
  `packages/api/src/db/schema/applications.ts:172`).

This PR does not invent a table (no migration lane in this wave). It makes the gap
a value the caller must handle: `resolveAccountBillingProfile` returns
`{ status: 'not-provisioned', accountId }` for a real account with no row, kept
separate from `{ status: 'unknown-account' }` and never collapsed into a zeroed
`resolved` profile — because a zero balance means "spent everything" and an absent
profile means "nobody has decided who pays".

### What the gap blocks

Verbatim epic checkboxes that cannot be completed until an account-scoped billing
profile is provisioned and read (i.e. until an account can be billed without
somebody holding a session as it):

- `- [ ] Audit every inference-related read/write to ensure the financially responsible principal is an Oxy account, not an implicit personal user.` — the audit half is done here; the *ensure* half cannot be, because the routes have no account-scoped profile to resolve.
- `- [ ] Ensure an application always inherits access and billing responsibility from `Application.ownerAccountId`.` — the ACCESS half holds today (§2.1); the BILLING half has nothing to inherit.
- `- [ ] Add explicit helpers for resolving: … owner account → billing profile` — landed here against what exists, and it reports `not-provisioned` for essentially every organization account in production.

It also blocks, from workstream 3 onward, anything that reserves or settles usage
against an account balance, and the Console's finance-only delegation described in
§4.

---

## 7. Things deliberately not verified

- **Production row counts.** Whether `developer_api_keys`, `api_key_usage_events`
  or `user_credits` hold rows in production is unknown from here; no production
  database was reached. §1.3's "unreferenced" claim is about source only.
- **Browser behaviour.** §4's cache claims are read off the source. No Console was
  loaded, no account switch was performed in a browser.
- **The deployed image.** All claims are about commit `215b12fe`, not about what
  ECS is currently running.
- **Alia's own accounting.** Whether `api.alia.onl` records per-request usage
  against the shared `ALIA_API_KEY` is outside this repository.
