# Principals and account contexts

The vocabulary the device model, the API contracts, the SDK and the account
switcher all use. If a term here disagrees with a term in code, the code is
wrong — these names are the ones `@oxy.so/contracts` ships.

Design rationale: [ADR 0001](../adr/0001-multi-principal-device-model.md) and
[ADR 0002](../adr/0002-global-account-context.md).

What a token says about a principal and an account, and what the resource server
checks: [tokens-and-credentials.md](./tokens-and-credentials.md).

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

## A bot is a complete account

A `bot` is an AI agent's own identity (issue #1520). It owns resources, holds
roles, plans and a balance, receives funds and pays for itself under exactly the
rules a personal account does; nothing commercial derives from its kind
(`KIND_INDEPENDENT_ACCOUNT_DIMENSIONS`, guarded by
`commercialTreatmentIgnoresAccountKind.test.ts`). Three answers stay separate,
each with its own predicate in `@oxy.so/contracts`:

| Question | `bot` | Predicate |
|---|---|---|
| May a person switch into it (occupy its seat)? | no | `isOperatorSwitchTargetKind` |
| May someone act as it on their own authority? | yes, recorded with that person as actor | `isDelegatedActAsEligibleKind` |
| Who is the actor when nobody operates it? | the bot itself — never its owner | `accountKindActorNature` → `'agent'` |

A bot is still not a **principal**: principals are humans on a device. What a
bot acting unoperated authenticates with is an open decision recorded on
#1520 — until it is made, a bot acts through a delegated session (actor = the
person) or through the agent runtime's execution authorization (ADR 0018,
actor = the bot).

## Who acted: the actor chain

`GET /session/validate/:id` and `/session/validate-header/:id` return an
`actor` (`AccountActorChain`) read off the session row:
`effectiveAccountId` is the token's `sub`, `actorAccountId` its `act.sub`, and
`delegated` is true exactly when they differ. `@oxy.so/core/server`'s
`middleware.auth()` exposes it as `getOxyActor(req)`; a chain that does not
describe the validated session is refused (`SESSION_ACTOR_MISMATCH`), and an API
that sends none yields `null`. No header or token claim can move it. A
financial effect belongs to the effective account, never the operator
(`attributeFinancialEffect`); which balance FUNDS it is still ADR 0014's walk.

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
   contexts and sockets.
5. **Sign out everywhere** — every DeviceSession, native installation and
   browser session belonging to the user.

Revoking an application's grant is separate again, and revoking an
`account:act_as` membership invalidates only the delegated contexts it granted.
