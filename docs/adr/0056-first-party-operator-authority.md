# ADR 0056 — Who operates an Oxy application is declared in code and follows the owning organization's roles

- Status: accepted
- Date: 2026-11-04
- Decision: the owner. "Al ser apps nuestras no tiene sentido tener que conceder
  permisos — todo eso se supone que es para terceros."
- Amends: [application roles](../auth/application-roles.md) for first-party
  applications. Third-party applications keep that model unchanged.
- Builds on: [0049](0049-first-party-platform-authority.md) (own applications
  share platform authority; grants are for external connections).

## Context

Application roles let an application declare its own operator keys
(`payments.operate`, `moderation.operate`) and let the owning account's owners and
admins grant them to people. A backend asks `GET /applications/:appId/roles/me`
which keys the person in front of it holds. That model was built for the
general case and Oxy's own applications adopted it as is when they removed
their `*_OPERATOR_OXY_USER_IDS` lists.

For an Oxy application it does not work:

- **Nobody holds anything until someone clicks.** A key does nothing until it
  is declared in the Console and granted to each person. Six applications
  (GoWay, CrowdSource, the website, Syra, Mercaria, Homiio) shipped or held gates
  that answered 404 to everyone while they waited for that.
- **The owner cannot grant himself.** Every official application is owned by
  the `oxy` organization (or a project under it). `SELF_GRANT_FORBIDDEN`
  refuses a grant to yourself on an application you do not own personally, so
  the organization's owner needed a second admin to make him an operator of
  his own product.
- **The authority lives in clicks, not in the code that checks it.** The key a
  backend checks is in its repository; who holds it was a Console state nobody
  reviews. A key renamed in code and not in the Console locked everybody out
  without a diff showing why.

Per-person grants are the model for a third party, whose operators Oxy cannot
know. For Oxy's own applications, Oxy already knows who operates them: the
people who run the organization that owns them.

## Decision

**A first-party application declares its operator keys in code, and each key
names the owning account's roles that hold it.** The declaration is
`operatorPermissions` on the application's entry in the first-party registry
(`packages/api/src/scripts/seedOxyApplicationsSpecs.ts`):

```ts
operatorPermissions: [
  { key: 'moderation.operate', description: 'Decide moderation reports', heldBy: ['owner', 'admin'] },
],
```

`heldBy` names roles of the account vocabulary (`owner`, `admin`, `editor`,
`developer`, `billing`, `viewer`) and always includes `owner`.

**A person holds a first-party key when their effective role over the
application's owning account is one of the key's roles.** Effective means what
the rest of Oxy already reads: membership of the owning account or an ancestor
(with inheritance), an active membership, a claimed organization. Nothing is
granted per person. Making someone an operator is giving them a role in the
organization. Removing them is changing or removing that role. Their operator
keys follow on the next read.

The keys follow the member's ROLE, not their per-member permission deltas.
Operator keys are not account permissions, so a member's `permission_grants`
and `permission_revokes` neither add nor remove them. To give someone fewer
operator keys, give them a role the keys do not name.

**The seed applies the registry.** `seed-oxy-applications.yml` reconciles each
selected application's vocabulary with its entry:

- a key in code and not live is declared;
- a live key whose roles changed is retired and declared again as a new row.
  `heldBy` is part of a key's identity, like its name, so the history shows who
  could operate it, and when;
- a live key not in code is retired;
- every live grant on the application is revoked. A first-party application
  has no per-person holders.

The dry run prints every change, every grant it would revoke and, for each key,
who holds it through which role. The seed is the only writer of `heldBy`. A key
it declares has no human declarer (`declared_by_user_id` is null): the commit
that changed the registry is the declarer.

**The API refuses the third-party writes on a first-party application.**
`PUT /roles/permissions` and `POST /roles/grants` on one of Oxy's own
applications (any type but `third_party`: `first_party`, `internal`, `system`,
all of them staff-set) answer `409 FIRST_PARTY_ROLES_IN_CODE`.
Revoking a leftover grant stays allowed, because it only narrows. The Console
shows the keys and their roles as read-only.

**One read for every application.** `roles/me` (and every other caller of
`permissionsHeldBy`) answers live grants plus role-held keys. A third-party
application has no role-held key, because nothing writes `heldBy` for one, so
its answer is exactly its grants. A first-party application has no grants, so
its answer is exactly its role-held keys. The SDK (`appPermissionsFor`,
`requireAppPermission`) and its contract do not change.

## What this does not change

- **Third-party applications.** Their owners declare keys in the Console and
  grant them to people, with every rule in
  [application roles](../auth/application-roles.md), including
  `SELF_GRANT_FORBIDDEN`.
- **Authority stays in Oxy.** No application keeps a list of operators, reads a
  role name itself, or treats "official" as "everyone may". The backend still
  asks Oxy, and Oxy still answers 404/503 the same way.
- **Oxy staff.** `users.is_staff` and staff capabilities stay Oxy's own
  internal powers and confer no application key.

## Consequences

- Shipping an operator surface on an Oxy application is one change in the
  registry next to the code that checks the key, then a seed run. Nobody
  clicks anything.
- The organization's owners and admins operate every Oxy application from the
  moment its key is seeded. That is the intended holder set today: the old
  lists held the owner alone (GoWay, the website), or nobody (Mercaria, Syra,
  Homiio, CrowdSource's empty staff table).
- A narrower staff desk, such as a moderator who is not an admin, is a role
  question. The six account roles are what exists. If an Oxy desk needs a
  holder set they cannot express, that is a new account role. It is not a
  per-person grant on a first-party application.
- Removing a key from the registry and running the seed retires it. Its gate
  then refuses everyone, which is the right failure for a deleted desk.
