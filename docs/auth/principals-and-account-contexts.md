# Principals and account contexts

The vocabulary the device model, the API contracts, the SDK and the account
switcher all use. If a term here disagrees with a term in code, the code is
wrong — these names are the ones `@oxyhq/contracts` ships.

Design rationale: [ADR 0001](../adr/0001-multi-principal-device-model.md) and
[ADR 0002](../adr/0002-global-account-context.md).

## The five nouns

### Identity

The cryptographic human identity controlled by a Commons key. Stable inside one
Commons vault. Used for signed approvals, credentials, identity records,
recovery and proof.

An identity is **not** a session and **not** an account. Commons is bound to one
and never follows the account switcher.

### Principal

A human who has authenticated onto one device or browser profile.

Never an organization, project, channel or bot. `authuser` — the Google-style
signed-in-human slot number — belongs to the principal: adding an organization
never consumes one.

### Account

The subject an application acts as: personal, organization, project, bot, or any
future kind that supports `account:act_as`.

### Device session

The server-authoritative representation of one physical device, one native
shared installation group, or one browser profile. It owns the principals added
to the device, the contexts available through them, the single active context,
the monotonic `revision`, and device-scoped revocation.

It does **not** own the Commons private key.

### Device account context

One principal acting as one account:

```
principal = Nate
account   = The Oxy Collective
```

This is the globally switchable unit, and the thing `contextId` names. A context
is **personal** when `principal.userId === accountId` and **delegated**
otherwise; a delegated context requires a live `account:act_as` membership,
re-checked at activation, never assumed from the row's existence.

## Why the pair, and not the account

The same managed account can be reachable through two different people on one
device:

```
Nate  → The Oxy Collective
Alice → The Oxy Collective
```

Those are different sessions, different permissions, different audit actors and
different revocation paths. An `accountId` cannot tell them apart, so the wire
identifier is the context id, and the server never guesses which principal a
caller meant.

## Application session

The credential an individual application uses to reach its permitted APIs while
following the device's active context.

The active context is shared across official apps. The application's token is
not: it is bound to the application, audience, scopes, actor and subject, and a
third-party application never receives a device-wide credential.

## What follows the switch, and what does not

| Surface | Follows `activeContextId`? |
|---|---|
| Official app in `sessionMode: 'account'` | yes |
| `auth.oxy.so` chooser | yes |
| Commons (`sessionMode: 'identity'`) | **no** — pinned to the local key's owner |
| Third-party OAuth client | **no** — isolated grant, no device context |

Commons still receives device updates, for management and progress display
only. `switchToAccount` / `switchSession` throw `IdentityBoundSessionError`
there; they are never silent no-ops.

## Sign-out has five distinct meanings

Each is a separate operation, and conflating any two of them is a bug:

1. **Sign out of this application** — revokes that application's session only.
   The principal stays on the device; a later SSO join can recreate it.
2. **Remove one context** — drops one `principal → account` pair. If it was
   active, elect a deterministic replacement: that principal's personal context,
   then another of that principal's contexts, then the next principal's personal
   context, then no active context.
3. **Remove one principal** — drops the person and all their contexts, and
   nobody else's — including when another principal can independently operate
   the same account.
4. **Sign out every Oxy app on this device/browser profile** — revokes the
   DeviceSession with its credentials, application sessions, principals,
   contexts, sockets and browser hub session.
5. **Sign out everywhere** — every DeviceSession, native installation and
   browser session belonging to the user.

Revoking an application's grant is separate again, and revoking an
`account:act_as` membership invalidates only the delegated contexts it granted.
