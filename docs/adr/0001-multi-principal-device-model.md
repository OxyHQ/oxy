# ADR 0001 — A device holds principals, and principals hold account contexts

- Status: accepted
- Date: 2026-08-10
- Issue: #937
- Supersedes: the flat `device_session_accounts` projection as the authority for "what is signed in on this device"

## Context

`device_sessions` today owns a flat set of rows in `device_session_accounts`:

```
device_session_id, account_id, session_id, authuser, operated_by_user_id?
UNIQUE(device_session_id, account_id)
```

Four different facts are collapsed into that one row shape:

1. a person who authenticated on this device;
2. that person's personal account;
3. an organization/project the person may act as;
4. the person through whom a delegated account is being operated.

Two consequences follow directly from the unique constraint, and neither is a bug
in the code that can be fixed without changing the shape:

- **`Nate → The Oxy Collective` and `Alice → The Oxy Collective` cannot both
  exist on one device.** The second insert collides on
  `UNIQUE(device_session_id, account_id)`. The same subject operated by two
  different people is a legitimate, ordinary state — different sessions,
  different permissions, different audit actor, different revocation path — and
  the schema cannot hold it.
- **`authuser` is allocated per account, not per person.** Adding an
  organization consumes an `authuser` slot, so the Google-style "signed-in user
  slot" number does not identify a human. Nothing downstream can rely on it to
  mean what its name says.

A third consequence is client-side: because the server hands out a flat list,
every application has to rebuild the person→accounts tree itself by unioning the
device rows with a separately fetched account graph. That reconstruction cannot
be correct on a multi-person device — the client only ever holds *one* caller's
graph, so it cannot enumerate what Alice may act as.

## Decision

Split the flat set into two tables and make the *context* — one principal acting
as one account — the switchable unit.

```
device_principals
  id, device_session_id, user_id, authuser,
  personal_session_id, added_at, last_authenticated_at, revoked_at?
  UNIQUE(device_session_id, user_id)
  UNIQUE(device_session_id, authuser)

device_account_contexts
  id, device_session_id, principal_id, account_id, session_id?,
  added_at, last_used_at, revoked_at?
  UNIQUE(device_session_id, principal_id, account_id)
```

`session_id` is **nullable**, which is a change from the issue's sketch and is
load-bearing. A context row exists for every account a principal may act as, so
that the switcher has a stable id to activate — but the delegated session is
minted on first activation, not eagerly for every organization the person
belongs to. `session_id IS NULL` is therefore "reachable, never yet used here",
and it is what the directory reports as `onDevice: false`. ADR 0002's activation
step 5 already says "reuse or mint", so this only names when each happens.

Invariants:

- A **principal** is a human who authenticated onto this device. Never an
  organization, project, channel, or bot.
- `authuser` belongs to the principal. An organization never consumes one.
- A **context** is `principal acting as account`. `principal.user_id ==
  account_id` is the personal context; anything else is delegated and requires a
  live `account:act_as` membership.
- The principal's personal context must exist while the principal is live.
- Removing a principal removes exactly its own contexts, and no other
  principal's — including when another principal can independently operate the
  same account.
- Deleting an account removes every context pointing at it, under any principal.
- Revoking `account:act_as` invalidates the delegated context and its session,
  and leaves the principal's personal context untouched.

`device_sessions.active_context_id` replaces `active_account_id` as the
authority (see ADR 0002). `active_account_id` survives only as a compatibility
projection for the length of the migration window.

## Alternatives rejected

**Widen the unique to `(device_session_id, account_id, operated_by_user_id)`.**
Cheapest change, and it does make the two-operators case storable. It leaves
`authuser` allocated per row, keeps the client rebuilding the tree, and keeps
"is this row a person or a thing?" as a question you answer by checking whether
a nullable column is null. The distinction we need is between two *kinds* of
entity, so it belongs in two tables.

**Keep one table, add a `kind` discriminator.** Flattening a discriminated union
into one table invites a biconditional CHECK that is wrong in one direction —
and the writers, not the columns, are what decide which implication actually
holds. Two tables state the relationship in the schema instead of in a
constraint comment.

## Consequences

- Backfill must map every existing row: an ordinary row becomes
  `principal(user_id=account_id)` + a personal context; a row carrying
  `operated_by_user_id` becomes `principal(user_id=operated_by_user_id)` + a
  delegated context. `authuser` ordering is preserved where it maps to a
  principal. Ambiguous rows are **reported, never dropped** — see ADR 0002's
  migration section and the Phase 1 backfill audit list.
- Row counts are part of the migration record: "this device set holds N rows,
  and here is what happened to each" is a line in the PR, because its absence is
  what lets silent data loss through.
- Any code that inferred meaning from *absence* — "no row for this account, so
  the account is not on this device" — must be re-read against the new shape,
  where absence of a context and absence of a principal mean different things.
- The old flat wire contract (`DeviceSessionState.accounts[]`) keeps working,
  projected from the new tables, until every supported client has moved to the
  directory contract in ADR 0002.
