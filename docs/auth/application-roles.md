# Application roles

An application declares its OWN permissions (`payments.operate`,
`catalog.operate`, …), Oxy decides who holds them, and its backend asks Oxy
which of them the person in front of it holds. No app keeps an allow-list of
Oxy user ids in its environment (`*_OPERATOR_OXY_USER_IDS`,
`HOMIIO_ADMIN_OXY_USER_IDS`, `OXY_ADMIN_USER_IDS`, a local staff table).

Who holds a key depends on whose application it is:

| Application | Keys declared | Held by |
|---|---|---|
| **One of Oxy's own** (`type` is not `third_party`) | In code: `operatorPermissions` on its entry in `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`, applied by `seed-oxy-applications.yml` | The owning account's roles each key names (`heldBy`, always including `owner`). A person holds the key while their effective role over the owning account is one of them. No per-person grant. ([ADR 0056](../adr/0056-first-party-operator-authority.md)) |
| **Third-party** | In the Console, or `PUT /roles/permissions` | People its owners grant it to |

Code: `packages/api/src/services/applicationRoles.service.ts`, the routes at the
end of `packages/api/src/routes/applications.ts`, the tables in
`packages/api/src/db/schema/applicationRoles.ts` (+ `applicationRolesImmutability.ts`),
the contract in `packages/contracts/src/applicationRoles.ts`, the SDK in
`packages/core/src/server/appPermissions.ts`, the Console tab in
`packages/console/src/components/apps/roles-section.tsx`; for Oxy's own
applications, the declarations in `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`
and their reconciliation in `packages/api/scripts/seed-oxy-applications.ts`.

## What it is not

- **Not Oxy staff.** `users.is_staff` / `staff_capabilities` are Oxy's own
  closed, internal powers, invisible to apps.
- **Not account roles.** `owner`/`admin`/… on `account_members` say what a
  person may do to an ACCOUNT and the applications it owns (edit, rotate
  credentials, …). They are the vocabulary Oxy's own gates read.
- **Not scopes.** A scope is what a machine credential may do against Oxy.

An application key means something only to the application that declared it.
No Oxy gate reads one.

## Why a key cannot collide with an Oxy permission

Every Oxy permission and scope is spelled with a colon (`app:update`,
`credentials:rotate`, `federation:write`). An application key is 2–4
dot-separated lowercase segments — `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$`,
at most 64 characters — and cannot contain one. The pattern is
`APPLICATION_PERMISSION_KEY_PATTERN_SOURCE` in `@oxy.so/contracts`; the API
validates with it and the database CHECK is rendered from the same string.
`accountRoles.test.ts` asserts that no entry of `APPLICATION_PERMISSIONS`,
`ACCOUNT_PERMISSIONS` or `APPLICATION_SCOPES` matches it. Keys are also stored
per application id, so two apps declaring `payments.operate` declare two
unrelated things.

## Oxy's own applications (ADR 0056)

- **Declare** the key in the application's registry entry, next to the change
  that ships the code checking it:

  ```ts
  operatorPermissions: [
    { key: 'moderation.operate', description: 'Decide moderation reports.', heldBy: OWNING_ORGANIZATION_OWNERS_AND_ADMINS },
  ],
  ```

  `heldBy` uses the account roles (`owner`, `admin`, `editor`, `developer`,
  `billing`, `viewer`) and must include `owner`; the spec test holds that.
- **Apply** it: Actions → `Seed Oxy applications`, `only_apps` (legacy specs) or
  `only_app_ids`, dry run first. The run makes the application's vocabulary
  EXACTLY the entry (absent = no keys): a new key is declared, a key whose roles
  changed is retired and declared again (holders are part of a key's identity),
  a key missing from code is retired, and every live grant on the application is
  revoked. It logs each change, each grant it revokes, the holders of each key
  (`Operator permission holders`: person, role, keys) and every live grant left
  on ANY Oxy application (`Read-back: live per-person grants …`, empty once the
  whole registry is applied).
- **Give someone a desk** by giving them the role in the owning organization;
  take it away by changing or removing that role. The keys follow the ROLE,
  not per-member account-permission deltas (an operator key is not an account
  permission). A holder set the six roles cannot express is a new account role,
  never a per-person grant.
- The Console shows the keys and their roles read-only. `PUT /roles/permissions`
  and `POST /roles/grants` answer `409 FIRST_PARTY_ROLES_IN_CODE`; revoking a
  leftover grant is still allowed.

Current declarations: GoWay (`moderation.operate`, `capture.pilot`),
CrowdSource (`trust_safety.policy|appeals|evidence|security`), Oxy Website
(`website.content.manage`), Syra (`compliance.review`), Mercaria
(`payments|catalog|guest|analytics|retail|procurement|referrals.operate`),
Homiio (`homiio.scraper.operate`) — all held by the owning organization's owners
and admins.

## Adopting it in an app

Rules every app backend follows, own or third-party (the SDK reference is
[`packages/core/docs/application-roles.mdx`](../../packages/core/docs/application-roles.mdx)):

- **No operator allow-lists.** No `*_OPERATOR_OXY_USER_IDS`, `*_ADMIN_OXY_USER_IDS` or
  `OXY_ADMIN_USER_IDS` environment list and no local staff table for operators. To migrate one,
  in this order: declare the key (an Oxy app: registry entry, merge, seed run, dry run first;
  a third-party app: the Console), deploy the `requireAppPermission` gate, then delete the
  variable from code, infrastructure and docs. The people in the old list need the role the key
  names.
- **Mount the surface always** and let the gate answer `404` (the default) to non-holders; never
  "empty list = not mounted".
- **Record `req.oxyAppPermissions.operatorId` as the actor.** It is the person even when they act
  as their organization (`req.userId` is then the organization).
- **Use `fresh: true` on writes and irreversible actions**; reads reuse an answer for up to 30 s.
- **Keep the app's own key constant** (`APPLICATION_PERMISSIONS` or similar) equal to the registry
  entry. A key renamed in only one place locks everybody out.
- A service-token request never holds an app permission; operator powers are exercised by a
  person in a session.

## Data model

| Table | Holds | Lifecycle |
|---|---|---|
| `application_role_permissions` | `application_id`, `key`, `description`, `held_by_account_roles`, `declared_by_user_id`, `created_at`, `retired_at`, `retired_by_user_id` | A key is RETIRED, never deleted or renamed. One live row per `(application_id, key)` (partial unique). Declaring a retired key again inserts a NEW row. `held_by_account_roles` (migration `0228`) is set only by the first-party seed and is identity: a change is a retirement plus a new row. A seeded key has `declared_by_user_id` null (the commit is the declarer). |
| `application_role_grants` | `permission_id` (the key ROW), `user_id` (grantee), `granted_by_user_id`, `grant_reason`, `created_at`, `revoked_at`, `revoked_by_user_id`, `revoke_reason` | Append-only. The one permitted edit is the revocation stamp on a live grant. One live grant per `(user_id, permission_id)` (partial unique). Re-granting inserts a new row. |

Both tables are guarded by `BEFORE UPDATE` triggers (migration
`0167_application_roles`, authoritative text in `applicationRolesImmutability.ts`):
a grant cannot be un-revoked, re-pointed, back-dated or have its reason rewritten;
a key cannot be renamed, moved to another application or un-retired, and a
retired key's description is history. The only other transition is account
erasure clearing a `*_by_user_id` through `ON DELETE SET NULL`. A grant hangs off
the key's ROW id, so a key retired and declared again starts with nobody
holding it — a revocation-by-retirement cannot be undone by accident. Erasing a
grantee deletes their grants (`CASCADE`); erasing a granter keeps the grant with
a null attribution.

## Who may do what

Two application permissions in `utils/accountRoles.ts`, derived from the
caller's effective access over the app's owning account like every other
application permission:

| Permission | Baseline roles | Answers to (account lane) | Gates |
|---|---|---|---|
| `roles:read` | owner, admin, editor, viewer | `members:read` | reading the vocabulary and the grants |
| `roles:manage` | owner, admin | `members:update` | declaring the vocabulary, granting, revoking |

Who operates an application is a question about people, the same class of
power as editing what a member of the owning account may do, so a per-member
revoke of `members:update` withdraws `roles:manage` and a grant confers it.
`members:update` is account governance, so an autonomous bot key never holds
`roles:manage`.

**Every actor and every subject is the HUMAN operator** (`resolveOperatorId`,
`middleware/operator.ts`): a grant records the person who made it even when they
are switched into their organization, and `roles/me` answers for the person,
not the organization the session speaks as. Grantees must be `personal`
accounts; an organization, project, bot or channel is refused
(`GRANTEE_NOT_A_PERSON`).

**Self-escalation (third-party applications).** A holder of `roles:manage` may NOT grant themselves a key
(`403 SELF_GRANT_FORBIDDEN`) unless the application is owned by their own
personal account — then nobody else could. Deciding who operates an app is not
the same power as operating it: an organization admin who wants Mercaria's
payments desk needs a second admin to grant it. Revoking your own grant is
always allowed.

## API

All under `/applications/:appId/roles`, with a user bearer. Error bodies are the
API's usual `{ error, message, details? }`; the role-specific codes are
`APPLICATION_ROLE_ERROR_CODES` in `@oxy.so/contracts`.

| Method | Path | Gate | Does |
|---|---|---|---|
| `GET` | `/me` | any signed-in person | `{ applicationId, userId, permissions }` — the keys the HUMAN behind the bearer holds: live grants plus the keys their role over the owning account holds (ADR 0056). `Cache-Control: no-store`. 404 for an unknown/deleted app. A bearer whose session belongs to ANOTHER application (third-party OAuth session) is refused `403 SESSION_APPLICATION_MISMATCH`; the shared first-party session may ask about any app. |
| `GET` | `/permissions` | `roles:read` | `{ items }`, by key. `?includeRetired=true` adds history. |
| `PUT` | `/permissions` | `roles:manage` | Third-party only (`409 FIRST_PARTY_ROLES_IN_CODE` otherwise). Declare the WHOLE vocabulary: `{ permissions: [{ key, description }] }` (≤ 64). New keys are added, kept keys take the new description in place, missing keys are retired and every live grant of them revoked (reason `Permission retired`) — one transaction, serialized on the application row. Idempotent. Returns `{ items, added, retired, described, revokedGrants }`. |
| `GET` | `/grants` | `roles:read` | `{ items, nextCursor }`, newest first. Live only unless `?includeRevoked=true`; `?permission=`, `?userId=`, `?limit=` (1–200, default 50), `?cursor=` (bound to the filters). |
| `POST` | `/grants` | `roles:manage` | Third-party only (`409 FIRST_PARTY_ROLES_IN_CODE` otherwise). `{ userId | username, permission, reason? }` → `201` grant. `422 UNKNOWN_PERMISSION`, `422 GRANTEE_NOT_A_PERSON`, `404` no such person, `403 SELF_GRANT_FORBIDDEN`, `409 ALREADY_GRANTED` (`details.grantId`). |
| `POST` | `/grants/:grantId/revoke` | `roles:manage` | `{ reason? }` → the revoked grant. `409 ALREADY_REVOKED`. |

### Versioning the vocabulary

The vocabulary is declarative and its history is its version: every row says
when it was declared and (if) retired, so the vocabulary at any instant is
reconstructible from `?includeRetired=true`. There is no revision number to
send; concurrent declarations serialize on the application row and the second
one wins whole. An app's code should treat the vocabulary as the set of keys it
checks — declare it (an Oxy application: its registry entry plus a seed run; a
third-party one: the Console or a deploy script calling `PUT`) BEFORE deploying
code that checks a new key; until then the check simply denies.

## The app's read, and how soon a revocation lands

`@oxy.so/core/server` (`packages/core/docs/application-roles.mdx`):

```ts
const oxy = new OxyServer({ baseURL: 'https://api.oxy.so', applicationId: process.env.OXY_APPLICATION_ID });

app.use('/internal/payments',
  oxy.middleware.auth(),
  oxy.middleware.requireAppPermission('payments.operate'),          // 404 to everyone else
  paymentsRouter);

const held = await oxy.appPermissionsFor(req);                      // { operatorId, permissions, has() }
```

The SDK forwards the request's own verified bearer to `GET /roles/me`; nothing
else the caller sends is consulted, so the answer cannot be spoofed by a header
or a claim. A request authenticated by a service token — delegated
(`X-Oxy-User-Id`) or not — is refused: an operator power is exercised by a
person in a session.

- **API side:** no cache. A grant, a revocation or a role change in the owning
  account is visible to the next read.
- **SDK side:** one answer per (application, session, user) is reused for
  `appPermissionsCacheTtlMs`, default **30 s** — the longest a revoked grant
  keeps working on a backend for a read that does not ask fresh. Pass
  `{ fresh: true }` (middleware option or `appPermissionsFor` option) on writes
  and irreversible actions: it asks Oxy every time and refreshes the cache.
  `appPermissionsCacheTtlMs: 0` disables caching; `invalidateAppPermissions({ userId })`
  drops one person's entries.
- **Failures deny.** Oxy unreachable answers 503, a missing/unknown application
  id 500; neither is ever read as "holds nothing" or "holds everything", and a
  failure is never cached.

### An MCP tool call

An external MCP request has no session: its bearer is a resource-bound access
token (ADR 0018/0020) that must never be forwarded as one. The app passes the
tool call instead — `oxy.appPermissionsFor(context.request)` — and the SDK
presents the token, under the app's own service token, to
`POST /auth/mcp/oauth/app-permissions` (body `{ token }`), `Cache-Control: no-store`.

**One resolver.** Both routes only establish WHO is asking and about WHICH
application, then call `resolveApplicationPermissions(applicationId, operatorId)`
(`services/applicationRoles.service.ts`) — the single answer to "what does this
person hold". The two can never disagree (a route test pins it), and a change to
how operator authority is derived reaches both at once. So an MCP caller gets
exactly the session answer: on one of Oxy's own applications, the keys the
person's role over the owning organization holds (ADR 0056); on a third-party
application, the keys granted to them.

The MCP route's proof is the one introspection and the connection endpoints take
(`connectionCallerGrant` in `routes/mcpOAuth.ts`):

- the token must be live and for a resource the CALLING application registered,
  else `401 invalid_grant` — a token for another app's resource is refused;
- the application is the one that registered the resource. There is no
  application parameter, so a service can never read about another
  application;
- the person is the token's `sub`, the human who authorized the connector,
  whichever member account the connection is acting as. A linked account lends
  the connection its data, never its approver's operator powers — the same
  operator/subject split `roles/me` makes for a session switched into an
  organization;
- the answer is read live, and revoking the token or the MCP grant ends it on
  the next call. No new scope: a service that may introspect may ask.

The SDK maps `401 invalid_grant` to `APP_PERMISSION_SESSION_REQUIRED`, its own
credential refused (`invalid_client`) or anything else to
`APP_PERMISSION_UNAVAILABLE`, and an answer about an application other than the
server's to `APP_PERMISSION_NOT_CONFIGURED`. Cache and `fresh` behave as for a
session, keyed by a digest of the token.

## Not built yet

- A service-authenticated read ("which keys does user X hold", for a job or a
  socket with no request bearer) and a holders list for the app's own service
  token. Add them as `GET /applications/:appId/roles/users/:userId` gated on the
  app's own service token (`appId` claim = `:appId`) when an app needs one.
- An SDK client namespace (`oxy.apps.roles.*`) for the management routes; the
  Console calls them through `oxyServices.request`.
- Grant expiry (time-boxed on-call grants). The grant row has no `expires_at`
  yet; revocation is explicit.
