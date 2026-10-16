# Application roles

An application declares its OWN permissions (`payments.operate`,
`catalog.operate`, …), its owners grant them to people in Oxy, and its backend
asks Oxy which of them the person in front of it holds. Oxy decides who holds an
app's operator powers; no app keeps an allow-list of Oxy user ids in its
environment (`*_OPERATOR_OXY_USER_IDS`, `HOMIIO_ADMIN_OXY_USER_IDS`,
`OXY_ADMIN_USER_IDS`, a local staff table).

Code: `packages/api/src/services/applicationRoles.service.ts`, the routes at the
end of `packages/api/src/routes/applications.ts`, the tables in
`packages/api/src/db/schema/applicationRoles.ts` (+ `applicationRolesImmutability.ts`),
the contract in `packages/contracts/src/applicationRoles.ts`, the SDK in
`packages/core/src/server/appPermissions.ts`, the Console tab in
`packages/console/src/components/apps/roles-section.tsx`.

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

## Data model

| Table | Holds | Lifecycle |
|---|---|---|
| `application_role_permissions` | `application_id`, `key`, `description`, `declared_by_user_id`, `created_at`, `retired_at`, `retired_by_user_id` | A key is RETIRED, never deleted or renamed. One live row per `(application_id, key)` (partial unique). Declaring a retired key again inserts a NEW row. |
| `application_role_grants` | `permission_id` (the key ROW), `user_id` (grantee), `granted_by_user_id`, `grant_reason`, `created_at`, `revoked_at`, `revoked_by_user_id`, `revoke_reason` | Append-only. The one permitted edit is the revocation stamp on a live grant. One live grant per `(user_id, permission_id)` (partial unique). Re-granting inserts a new row. |

Both tables are guarded by `BEFORE UPDATE` triggers (migration
`0166_application_roles`, authoritative text in `applicationRolesImmutability.ts`):
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

**Self-escalation.** A holder of `roles:manage` may NOT grant themselves a key
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
| `GET` | `/me` | any signed-in person | `{ applicationId, userId, permissions }` — the keys the HUMAN behind the bearer holds. `Cache-Control: no-store`. 404 for an unknown/deleted app. A bearer whose session belongs to ANOTHER application (third-party OAuth session) is refused `403 SESSION_APPLICATION_MISMATCH`; the shared first-party session may ask about any app. |
| `GET` | `/permissions` | `roles:read` | `{ items }`, by key. `?includeRetired=true` adds history. |
| `PUT` | `/permissions` | `roles:manage` | Declare the WHOLE vocabulary: `{ permissions: [{ key, description }] }` (≤ 64). New keys are added, kept keys take the new description in place, missing keys are retired and every live grant of them revoked (reason `Permission retired`) — one transaction, serialized on the application row. Idempotent. Returns `{ items, added, retired, described, revokedGrants }`. |
| `GET` | `/grants` | `roles:read` | `{ items, nextCursor }`, newest first. Live only unless `?includeRevoked=true`; `?permission=`, `?userId=`, `?limit=` (1–200, default 50), `?cursor=` (bound to the filters). |
| `POST` | `/grants` | `roles:manage` | `{ userId | username, permission, reason? }` → `201` grant. `422 UNKNOWN_PERMISSION`, `422 GRANTEE_NOT_A_PERSON`, `404` no such person, `403 SELF_GRANT_FORBIDDEN`, `409 ALREADY_GRANTED` (`details.grantId`). |
| `POST` | `/grants/:grantId/revoke` | `roles:manage` | `{ reason? }` → the revoked grant. `409 ALREADY_REVOKED`. |

### Versioning the vocabulary

The vocabulary is declarative and its history is its version: every row says
when it was declared and (if) retired, so the vocabulary at any instant is
reconstructible from `?includeRetired=true`. There is no revision number to
send; concurrent declarations serialize on the application row and the second
one wins whole. An app's code should treat the vocabulary as the set of keys it
checks — declare it from the Console (or a deploy script calling `PUT`) BEFORE
deploying code that checks a new key; until then the check simply denies.

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

- **API side:** no cache. A grant or revocation is visible to the next read.
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

## Not built yet

- A service-authenticated read ("which keys does user X hold", for a job or a
  socket with no request bearer) and a holders list for the app's own service
  token. Add them as `GET /applications/:appId/roles/users/:userId` gated on the
  app's own service token (`appId` claim = `:appId`) when an app needs one.
- An SDK client namespace (`oxy.apps.roles.*`) for the management routes; the
  Console calls them through `oxyServices.request`.
- Grant expiry (time-boxed on-call grants). The grant row has no `expires_at`
  yet; revocation is explicit.
