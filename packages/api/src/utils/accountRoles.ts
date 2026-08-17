/**
 * Unified Account membership roles → permission map.
 *
 * The unified Account system collapses the three legacy role vocabularies
 * (`workspaceRoles`, `applicationRoles`, and `ManagedAccount.managers[].role`)
 * into ONE set of roles + capabilities keyed off an `account_members` row.
 *
 * A member's role picks a BASELINE permission set out of {@link ROLE_PERMISSIONS};
 * the row's `permission_grants` / `permission_revokes` then adjust it per member.
 * {@link resolveEffectivePermissions} is the ONE place those three inputs are
 * combined, and every gate reads its output — routes check individual permission
 * strings (see `requireAccountPermission`), never a role name.
 *
 * That holds across BOTH vocabularies. Applications are gated on a second set
 * of strings ({@link APPLICATION_PERMISSIONS}) that names several of the same
 * powers differently, and the bridge between them is
 * {@link appPermissionsForAccountAccess} — which reads the member's EFFECTIVE
 * account permissions, not their role. It has to: for as long as it read the
 * role, `credentials:rotate` revoked from a member was refused on
 * `/accounts/*` and permitted on `/applications/*` (issue #978). A gate on
 * either lane calls a `…ForAccountAccess` / `…ForMember` function; nothing
 * outside this module may turn a role name into permissions.
 *
 * `account:act_as` (the right to switch INTO the account via
 * `POST /accounts/:id/switch`, minting a real session AS it) is baseline for
 * owner/admin/editor only — billing/developer/viewer may manage facets of the
 * account but never post/act as it. It is read like every other permission, so a
 * per-member revoke genuinely takes it away and a per-member grant genuinely
 * confers it; there is deliberately no role-shaped shortcut for it.
 *
 * Legacy role mapping (used by the migration scripts):
 *  - ManagedAccount owner/admin/editor → owner/admin/editor (unchanged)
 *  - Workspace member → editor, Workspace viewer → viewer
 *  - Application owner → admin (on the owning account), developer/billing/viewer
 *    → developer/billing/viewer (unchanged)
 *
 * ## The `inference:*` permissions are spelled like the `inference:*` SCOPES, on purpose
 *
 * Six of the account permissions below (`inference:invoke`,
 * `inference:routing:read`/`:write`, `inference:providers:read`/`:write`,
 * `inference:usage:read`) are spelled EXACTLY like entries in
 * `utils/applicationScopes.ts`'s `APPLICATION_SCOPES`. They are two different
 * sets over the same strings, and the collision is deliberate: one power, one
 * word, whichever principal is asking. A route gating the same operation for a
 * person and for a credential should not need two names for it.
 *
 * What keeps that safe is that neither set is ever read from the other's place.
 * A SCOPE is only ever read off `principal.service.scopes` — what a machine
 * credential may do, bounded at mint time by its application's own grant. A
 * PERMISSION is only ever read off `access.accountPermissions` /
 * `access.applicationPermissions` — what a person may do, resolved from a
 * membership row through this module. Nothing accepts "either", and the two
 * answers can differ for the same string on the same request: that is the
 * escalation the BYOK service lane used to permit (issue #972), where holding
 * the scope was substituted for holding the permission.
 *
 * The APPLICATION vocabulary deliberately does NOT collide: BYOK is
 * `inference:byok:read`/`:write` there, spellings that appear in no scope list,
 * and {@link ACCOUNT_COUNTERPART} states the correspondence — the same shape
 * `app:update` ↔ `apps:update` already has. A reader who finds
 * `inference:byok:write` therefore knows without checking that they are looking
 * at a permission and not at a scope.
 */

/**
 * Application-level permissions. An application's access is DERIVED from the
 * caller's effective access over the app's owning account (there is no separate
 * per-app member table) via {@link appPermissionsForAccountAccess} — the role's
 * baseline WITH the member's own grants and revokes translated into this
 * vocabulary. Routes in `applications.ts` gate on these strings.
 *
 * The `inference:*` entries are the app lane of the inference control plane
 * (issue #972 §3). They exist so that repointing where an application's
 * inference is served from, and rotating the provider credential it is served
 * with, are separable from `app:update`. Before them one string conferred
 * "publish an OTA update", "change the webhook URL" AND "repoint routing and
 * rotate the BYOK secret", so an account that wanted an editor who could edit an
 * app but not touch routing had no way to say so. They are deliberately NOT
 * mapped to `apps:update` in {@link ACCOUNT_COUNTERPART}: unlike
 * `updates:manage`, a routing repoint is not a stronger FORM of updating the
 * application's configuration, so a granter of `apps:update` would not expect to
 * be conferring it.
 */
export const APPLICATION_PERMISSIONS = [
  'app:read',
  'app:update',
  'app:delete',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'credentials:read',
  'credentials:create',
  'credentials:rotate',
  'credentials:revoke',
  'webhooks:read',
  'webhooks:update',
  'usage:read',
  'billing:read',
  'billing:manage',
  'ownership:transfer',
  'updates:manage',
  'inference:invoke',
  'inference:routing:read',
  'inference:routing:write',
  'inference:byok:read',
  'inference:byok:write',
] as const;

export type ApplicationPermission = (typeof APPLICATION_PERMISSIONS)[number];

/**
 * Account-level permissions.
 *
 * The `inference:*` entries are the account lane of the same control plane the
 * application `inference:*` permissions cover, plus `inference:usage:read` for
 * the spend and token reports, which have no application-lane counterpart of
 * their own (the app lane reads those through `usage:read`).
 *
 * Two of them have NO route gating on them today, and that is deliberate rather
 * than an oversight:
 *
 *  - `inference:invoke`. The inference edge authenticates only credential and
 *    machine principals (`routes/inferenceEdge.ts`), so a signed-in person cannot
 *    invoke through a user session at all and there is nothing to gate. It is
 *    declared now because the moment Console grows a "try it" surface, or an
 *    account wants a member who may configure inference but not spend on it, the
 *    missing permission is the thing somebody papers over with `account:read`.
 *    Declaring it costs nothing — an unheld permission grants nothing — and no
 *    route was invented to make it reachable.
 *  - `inference:usage:read`. `routes/inferenceReporting.ts` gates on
 *    `billing:read` / `billing:manage` and KEEPS doing so: the reports are money,
 *    and moving them would take them away from the `billing` role. The permission
 *    is the account-lane name for the already-live `inference:usage:read` SCOPE,
 *    so the vocabulary can say what a member may see without that being the same
 *    decision as what they may spend.
 */
export const ACCOUNT_PERMISSIONS = [
  'account:read',
  'account:update',
  'account:delete',
  'account:act_as',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'children:read',
  'children:create',
  'children:update',
  'children:delete',
  'apps:read',
  'apps:create',
  'apps:update',
  'apps:delete',
  'credentials:read',
  'credentials:create',
  'credentials:rotate',
  'credentials:revoke',
  'billing:read',
  'billing:manage',
  'ownership:transfer',
  'inference:invoke',
  'inference:routing:read',
  'inference:routing:write',
  'inference:providers:read',
  'inference:providers:write',
  'inference:usage:read',
] as const;

export type AccountPermission = (typeof ACCOUNT_PERMISSIONS)[number];

export const ACCOUNT_ROLES = [
  'owner',
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

const OWNER_PERMISSIONS: readonly AccountPermission[] = [...ACCOUNT_PERMISSIONS];

const ADMIN_PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'account:update',
  'account:act_as',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'children:read',
  'children:create',
  'children:update',
  'children:delete',
  'apps:read',
  'apps:create',
  'apps:update',
  'apps:delete',
  'credentials:read',
  'credentials:create',
  'credentials:rotate',
  'credentials:revoke',
  'billing:read',
  'inference:invoke',
  'inference:routing:read',
  'inference:routing:write',
  'inference:providers:read',
  'inference:providers:write',
  'inference:usage:read',
];

const EDITOR_PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'account:act_as',
  'members:read',
  'children:read',
  'apps:read',
  'apps:create',
  'apps:update',
  'credentials:read',
  'billing:read',
  // Reads and invoke, no inference WRITES. This is the separation the app-lane
  // `inference:*` permissions were added for: an editor may edit an application
  // and may not repoint where its inference is served from, which `apps:update`
  // alone could not express.
  'inference:invoke',
  'inference:routing:read',
  'inference:providers:read',
  'inference:usage:read',
];

const DEVELOPER_PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'children:read',
  'apps:read',
  'credentials:read',
  'credentials:create',
  'credentials:rotate',
  'credentials:revoke',
  // Same inference set as `editor`, and for the same reason. A developer mints
  // and rotates credentials, which is precisely why they must not hold the BYOK
  // write: a credential outlives the membership, and `credentials:rotate`
  // re-issues a working secret for an existing credential's scopes.
  'inference:invoke',
  'inference:routing:read',
  'inference:providers:read',
  'inference:usage:read',
];

const BILLING_PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'apps:read',
  'billing:read',
  'billing:manage',
  // Finance, not configuration. The spend and token reports, and nothing about
  // routing or which provider credential serves a request.
  'inference:usage:read',
];

const VIEWER_PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'members:read',
  'children:read',
  'apps:read',
  // Routing and usage, deliberately NOT `inference:providers:read`. BYOK read
  // returns no credential material, but it does return which provider an account
  // uses, a key prefix, a fingerprint and the validation failures — security
  // configuration rather than the app description a viewer is entitled to. It
  // used to be inherited from `account:read`, which every role holds; withholding
  // it here is the decision that inheritance was standing in for.
  'inference:routing:read',
  'inference:usage:read',
];

export const ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly AccountPermission[]>> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  editor: EDITOR_PERMISSIONS,
  developer: DEVELOPER_PERMISSIONS,
  billing: BILLING_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

/**
 * Resolve the BASELINE permission list for a role, before any per-member
 * adjustment. Returns a fresh array so the caller can persist it without
 * aliasing the shared constant.
 *
 * Callers gating an action want {@link resolveEffectivePermissions}, which
 * layers the member's own grants and revokes over this.
 */
export function permissionsForAccountRole(role: AccountRole): AccountPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Type guard for an arbitrary string being a valid account role. */
export function isAccountRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/** Type guard for an arbitrary string being a permission in the CURRENT vocabulary. */
export function isAccountPermission(value: string): value is AccountPermission {
  return (ACCOUNT_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * The permissions a member actually holds: the role's baseline, plus the row's
 * `permission_grants`, minus its `permission_revokes`.
 *
 * A REVOKE beats a GRANT naming the same permission, because the two disagreeing
 * can only be a mistake and the safe reading of a mistake is the narrower one.
 *
 * ## Why this is a filter over the vocabulary rather than a set built from the row
 *
 * The result is produced by filtering {@link ACCOUNT_PERMISSIONS} itself, so a
 * stored string that is no longer in the vocabulary CANNOT appear in the output —
 * it goes inert the moment the permission is retired, with no write, no
 * backfill and no failure. That is deliberate, and it is why neither delta column
 * carries a SQL `CHECK` listing the vocabulary: measured on Postgres 17.5, adding
 * `check (col <@ array[…])` and later NARROWING that array makes every subsequent
 * `UPDATE` of a row holding a retired value fail — including an `UPDATE` that
 * names only `role`, reported against a column the caller never mentioned. Adding
 * the constraint `NOT VALID` does not help: it skips validating the existing rows
 * at `ALTER` time, and the next update of one still fails. The vocabulary is
 * therefore enforced at the WRITE boundary (the zod schema, which 400s an unknown
 * string) and dropped again at the READ boundary (here).
 *
 * Output order follows the {@link ACCOUNT_PERMISSIONS} declaration order, so the
 * wire value is deterministic for a given input and two members' sets diff
 * meaningfully.
 */
export function resolveEffectivePermissions(
  role: AccountRole,
  grants: readonly string[],
  revokes: readonly string[]
): AccountPermission[] {
  const held = new Set<string>(ROLE_PERMISSIONS[role]);
  for (const permission of grants) held.add(permission);
  for (const permission of revokes) held.delete(permission);
  return ACCOUNT_PERMISSIONS.filter((permission) => held.has(permission));
}

/**
 * The row-shaped form of {@link resolveEffectivePermissions}: what a membership
 * row actually grants. The ONE place a stored row becomes a permission set, so
 * a caller cannot read `role` and forget the deltas — `requireAccountPermission`,
 * `verifyActingAs`, `serializeMember` and the permission editor's own escalation
 * guard all resolve through it.
 *
 * It lives HERE rather than beside the row's other operations in
 * `account.service.ts`, and that placement is load-bearing rather than
 * aesthetic. Route suites whole-mock `services/account.service` (a `jest.mock`
 * factory naming only `accountService`), so a serializer reaching into that
 * module for a pure function gets `undefined is not a function` at request time
 * — a 500 that reads like a route bug and is nowhere near the mock that caused
 * it. This module is dependency-free and nothing mocks it. The parameter is
 * structural for the same reason: naming the drizzle row type would make this
 * file import `db/schema/accountMembers.ts`, which imports `ACCOUNT_ROLES` back
 * out of it.
 */
export function effectivePermissionsForMember(member: {
  role: AccountRole;
  permissionGrants: readonly string[];
  permissionRevokes: readonly string[];
}): AccountPermission[] {
  return resolveEffectivePermissions(
    member.role,
    member.permissionGrants,
    member.permissionRevokes
  );
}

/**
 * Per-role application-permission BASELINE — what a role alone confers over
 * applications the account owns, before the member's own deltas.
 *
 * Deliberately NOT exported: a role name is not an authorization answer here.
 * {@link appPermissionsForAccountAccess} is the only reader, and it is the only
 * thing any gate may call. The role-only form used to be public
 * (`appPermissionsForAccountRole`), and three separate gates called it directly
 * — which is how a per-member revoke came to be honoured on `/accounts/*` and
 * ignored on `/applications/*` (issue #978).
 */
const APP_PERMISSIONS_BY_ROLE: Readonly<Record<AccountRole, readonly ApplicationPermission[]>> = {
  owner: [...APPLICATION_PERMISSIONS],
  admin: [
    'app:read',
    'app:update',
    'app:delete',
    'members:read',
    'members:invite',
    'members:update',
    'members:remove',
    'credentials:read',
    'credentials:create',
    'credentials:rotate',
    'credentials:revoke',
    'webhooks:read',
    'webhooks:update',
    'usage:read',
    'billing:read',
    'updates:manage',
    'inference:invoke',
    'inference:routing:read',
    'inference:routing:write',
    'inference:byok:read',
    'inference:byok:write',
  ],
  editor: [
    'app:read',
    'app:update',
    'members:read',
    'credentials:read',
    'webhooks:read',
    'webhooks:update',
    'usage:read',
    'inference:invoke',
    'inference:routing:read',
    'inference:byok:read',
  ],
  developer: [
    'app:read',
    'credentials:read',
    'credentials:create',
    'credentials:rotate',
    'credentials:revoke',
    'webhooks:read',
    'webhooks:update',
    'usage:read',
    'updates:manage',
    'inference:invoke',
    'inference:routing:read',
    'inference:byok:read',
  ],
  billing: ['app:read', 'billing:read', 'billing:manage', 'usage:read'],
  viewer: ['app:read', 'members:read', 'usage:read', 'inference:routing:read'],
};

/**
 * The account permission each application permission ANSWERS TO.
 *
 * The two vocabularies name the same powers differently — `app:update` is
 * `apps:update` on the account side — so a per-member delta written in the
 * account vocabulary can only reach the application lane through a stated
 * correspondence. This is that statement, and it is TOTAL: the `Record` over
 * {@link ApplicationPermission} means a newly declared application permission
 * fails the typecheck until somebody classifies it. There is no `null` arm on
 * purpose — "this one has no counterpart" is a claim that should cost a
 * deliberate type change, not a default.
 *
 * Most entries are the same power under two spellings. Four are a BROADER
 * account permission that CONTAINS the application one:
 *
 *  - `webhooks:read` / `usage:read` ← `apps:read`: a webhook URL and a usage
 *    summary are things you read about an app.
 *  - `webhooks:update` ← `apps:update`: the webhook URL is app configuration,
 *    and `PATCH /applications/:id` (gated on `app:update`) already writes it.
 *  - `updates:manage` ← `apps:update`: publishing an OTA update replaces the
 *    code the app ships. It is the strongest form of updating an application,
 *    so an account whose `apps:update` was withdrawn cannot keep it.
 *
 * Containment is what makes the broader entries safe in BOTH directions:
 * withdrawing the container withdraws the contained power, and conferring the
 * container confers it. An account permission that merely SUGGESTED a
 * relationship (`credentials:read` for a webhook secret, say) would not belong
 * here — it would let a grant confer more than the granter's words.
 */
const ACCOUNT_COUNTERPART: Readonly<Record<ApplicationPermission, AccountPermission>> = {
  'app:read': 'apps:read',
  'app:update': 'apps:update',
  'app:delete': 'apps:delete',
  'members:read': 'members:read',
  'members:invite': 'members:invite',
  'members:update': 'members:update',
  'members:remove': 'members:remove',
  'credentials:read': 'credentials:read',
  'credentials:create': 'credentials:create',
  'credentials:rotate': 'credentials:rotate',
  'credentials:revoke': 'credentials:revoke',
  'webhooks:read': 'apps:read',
  'webhooks:update': 'apps:update',
  'usage:read': 'apps:read',
  'billing:read': 'billing:read',
  'billing:manage': 'billing:manage',
  'ownership:transfer': 'ownership:transfer',
  'updates:manage': 'apps:update',
  // The same power under two spellings, except for BYOK: the account lane calls
  // it `providers` (an account registers a provider connection) and the
  // application lane calls it `byok` (an application is served by one). Neither
  // answers to `apps:read`/`apps:update` — see the note on
  // {@link APPLICATION_PERMISSIONS} for why containment does not hold here.
  'inference:invoke': 'inference:invoke',
  'inference:routing:read': 'inference:routing:read',
  'inference:routing:write': 'inference:routing:write',
  'inference:byok:read': 'inference:providers:read',
  'inference:byok:write': 'inference:providers:write',
};

/**
 * The application permissions a caller holds over applications owned by an
 * account — the ONE derivation, and the only thing an application gate may ask.
 *
 * ## The rule
 *
 * The role's application baseline ({@link APP_PERMISSIONS_BY_ROLE}), with the
 * member's own DELTAS translated through {@link ACCOUNT_COUNTERPART}:
 *
 *  - a REVOKE subtracts — the role would have conferred the counterpart and the
 *    member no longer holds it, so every application permission answering to
 *    that counterpart goes;
 *  - a GRANT adds — the member holds a counterpart their role does not confer,
 *    so the application permissions answering to it arrive.
 *
 * Grants add because the account lane already says they do, and because
 * `PATCH /accounts/:id/members/:memberId` bounds them: an actor may only grant
 * what they themselves effectively hold, so honouring a grant here can never
 * let a permission into an account that was not already inside it. Ignoring
 * them would reproduce this very bug mirrored — an administrator's grant taking
 * effect on `/accounts/*` and silently not on `/applications/*`.
 *
 * ## What it does NOT do
 *
 * It never consults the two role maps against each other. The deltas are read
 * as SET DIFFERENCES against the member's own role baseline, so a member with
 * no deltas gets exactly `APP_PERMISSIONS_BY_ROLE[role]` by construction —
 * whatever the two maps happen to disagree about. (They do disagree: an account
 * `editor` holds `billing:read` while an application `editor` does not. That is
 * a role definition, not a per-member decision, and this function leaves it
 * alone.)
 *
 * Output order follows the {@link APPLICATION_PERMISSIONS} declaration order,
 * for the same reason {@link resolveEffectivePermissions} filters the
 * vocabulary: the wire value is deterministic and two members' sets diff
 * meaningfully.
 *
 * The parameter is structural so `accountService.resolveEffectiveAccess`'s
 * `EffectiveAccess` passes straight in, without this dependency-free module
 * importing the service (see {@link effectivePermissionsForMember}).
 */
export function appPermissionsForAccountAccess(access: {
  role: AccountRole;
  permissions: readonly AccountPermission[];
}): ApplicationPermission[] {
  const baseline = new Set<ApplicationPermission>(APP_PERMISSIONS_BY_ROLE[access.role]);
  const roleBaseline = new Set<AccountPermission>(ROLE_PERMISSIONS[access.role]);
  const held = new Set<AccountPermission>(access.permissions);

  return APPLICATION_PERMISSIONS.filter((permission) => {
    const counterpart = ACCOUNT_COUNTERPART[permission];
    if (roleBaseline.has(counterpart)) {
      // The role confers the counterpart: the member keeps the application
      // permission unless it was REVOKED from them.
      return held.has(counterpart) && baseline.has(permission);
    }
    // The role does not confer it: only a GRANT can put it there.
    return held.has(counterpart) || baseline.has(permission);
  });
}
