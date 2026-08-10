# Tokens and credentials

What an Oxy access token says, what the resource server checks before believing
it, and why a third-party OAuth client cannot reach the device.

Vocabulary: [principals-and-account-contexts.md](./principals-and-account-contexts.md).
Transport: [device-session.md](./device-session.md).
Design rationale: [ADR 0001](../adr/0001-multi-principal-device-model.md),
[ADR 0002](../adr/0002-global-account-context.md).

Owner: `packages/api/src/utils/sessionUtils.ts`. Everything below is minted and
checked there; `session.service.ts` supplies the row it is checked against.

## Access token v2

```jsonc
{
  "ver": 2,
  "iss": "oxy-auth",
  "sub": "account-being-acted-as",
  "act": { "sub": "the-human-acting" },
  "aud": ["oxy-api"],
  "azp": "oxy_dk_…",              // present only on an application's own session
  "scope": "profile:read",         // ditto
  "sid": "session-uuid",
  "device_session_id": "…",        // present once the device has registered it
  "device_context_id": "…",
  "jti": "unique-per-mint",
  "iat": 0,
  "exp": 0,

  // v1 claims, retained — see "The v1 window" below
  "userId": "account-being-acted-as",
  "sessionId": "session-uuid",
  "deviceId": "…",
  "type": "access"
}
```

Lifetime is 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`); the refresh half lives 7
days.

### `iss` and `aud` are `oxy-auth` / `oxy-api`, not URLs

Issue #937 sketches `https://auth.oxy.so`. The service-token mint has used
`oxy-auth` / `oxy-api` since it existed, and `@oxyhq/core`'s SDK verifies
service tokens against exactly those by default — so the access token joins the
vocabulary that is already there rather than introducing a second spelling of
one issuer with nothing able to tell them apart.

`aud` is a constant today because there is one resource server. When a second
appears it becomes per-session state (a column), not a second constant.

### `sub` and `act.sub` are never the same fact

`sub` is the account the token acts **as**; `act.sub` is the human acting. On an
ordinary first-party session they hold the same value; on a delegated session —
Nate acting as The Oxy Collective — they do not, and the audit actor, the
revocation path and the `account:act_as` re-check all key off `act.sub`.
Collapsing them would make an organization authorise itself.

### `azp` and `scope` are absent on a shared device session

A shared device session belongs to no single application — every official Oxy
app on the device uses it — so naming one of them as the authorized party would
be false for the others. `azp` appears exactly when the session is one
application's and nothing else can reach it, which today means an untrusted
OAuth client. Per-application sessions for official apps are the BFF end state,
not this phase.

### Every mint is unique

`jti` is a fresh UUID per mint. Before it, the payload was
`{userId, sessionId, deviceId, type}` with no nonce and `iat`/`exp` carry
one-second resolution, so a same-second re-mint produced a **byte-identical**
token — which meant a refresh rotation that fast left
`previous_refresh_token === refresh_token` and did not invalidate the token it
had just been handed. (`sessions.access_token` and `refresh_token` are also
UNIQUE, so the collision could fail a concurrent mint outright.)

The refresh half carries `jti` and nothing else from the binding: it is
presented to one endpoint, which reads the whole binding off the row, so a copy
on the token could only ever drift from it.

## The row is the authority

The claims are derived from `sessions` and never the reverse:

| Column | Claim |
|---|---|
| `user_id` | `sub` |
| `operated_by_user_id ?? user_id` | `act.sub` |
| `session_id` | `sid` |
| `application_id` | — (row state; the device lane reads it) |
| `client_id` | `azp` |
| `scopes` | `scope` |
| `device_session_id` | `device_session_id` |
| `device_context_id` | `device_context_id` |

`checkAccessTokenBinding` compares every claim back against the row on each
request, after the signature and expiry have already been proven. A mismatch is
not a difference of opinion — it is a token that no longer describes its
session, and it is refused. The failure reasons are a closed set
(`issuer_mismatch`, `audience_mismatch`, `session_mismatch`, `subject_mismatch`,
`actor_mismatch`, `client_mismatch`, `device_session_mismatch`,
`device_context_mismatch`, `scope_not_granted`, `wrong_token_type`,
`legacy_window_closed`).

Scopes are checked as a **subset**: the row is a ceiling. A token asking for
more than its session was granted is refused, not trimmed.

`validateSession` returns the resolved identity as `req.oxyToken`
(`AuthRequest`). That, not the raw claims, is what a route may act on —
`req.user` answers *who*, `req.oxyToken` answers *as whom, through what, with
which scopes*. Only the blocking `authMiddleware` lane populates it.

### What a switch does NOT do

Activating a different context does not revoke the previous context's token.
That is deliberate and matches the pinned-mint behaviour a `sessionMode:
'identity'` client depends on: a token for a non-active account stays valid
**for its own context**. What it can never do is pass as the active one — the
`device_context_id` claim names the context it was minted for, and it is checked
against the row.

## Third-party isolation

A third-party OAuth exchange yields an **isolated** session. Three consequences
of one decision, and they only hold together:

1. **Bound to the application.** `application_id`, `client_id` and `scopes` are
   written to the row, so `azp`/`scope` are real claims and the device lane can
   recognise the bearer. Binding also narrows reuse: a bound mint may only reuse
   a session already bound to the *same* application.
2. **Off the shared device.** It does not inherit the authorization code's
   `deviceId`. A stable per-`(user, client)` device key keeps the client reusing
   its own session across exchanges without ever landing where the reuse lookup
   would find the device's first-party session.
3. **No device credential.** It is not registered into the device's account set
   and the token response carries no `deviceId` and no `deviceSecret`. That
   secret is the device-wide restore credential: handing it to a third party
   would let one leaked token mint bearers for every account on the device.

Everything under `/session/device/*` that requires a bearer then refuses a
third-party token with `403 third_party_device_access_denied` — the directory,
`activate`, `add`, `switch`, `signout`, `state`, and the background-credential
mint.

The trust decision is the **registry's**, re-read per request rather than frozen
into the token (`isTrustedApplication`, plus `status === 'active'`). Flipping an
application out of official status locks it out immediately, and a missing
application row fails closed. `application_id` is NULL on every shared device
session, so the ordinary path does no lookup at all.

A **trusted** application is an official Oxy app joining the shared device
session and keeps all of the above unchanged.

## The v1 window

**A token is v2 if and only if it carries `ver: 2`.** Anything else is v1. The
discriminator is deliberately not `jti` — every mint now carries one, and `jti`
says a token is not replayable, not that the binding claims were minted and are
enforceable.

A v1 token asserted none of the binding, so it resolves to the **row's** own
binding. That is what keeps the third-party device guard working for a legacy
bearer: the guard reads `sessions.application_id`, which the token never
claimed either way.

**How the window closes.** Every mint after this change is v2, and every path
that hands out a token re-mints when the stored one does not match its row
(`getAccessToken`) or rotates (`refreshTokens`). An access token lives 15
minutes and a refresh token 7 days, so the last possible v1 token expires one
refresh-token lifetime after deploy with nobody doing anything.

`ACCESS_TOKEN_V1_WINDOW=closed` then makes that enforceable rather than merely
true: every remaining v1 bearer is refused, and from that point the v2
guarantees hold for *every* authenticated request rather than for every request
that happens to carry a new enough token. Set it after the window has elapsed.

### What the migration could not backfill

No existing row records which application obtained it. The OAuth exchange left
only a cosmetic `device_name` of `'<App> OAuth'`, and a string a later session
reuse can rewrite is not something to make an authorization decision from — so
every pre-existing session is `application_id IS NULL` and the device lane
treats it as first-party. The bound is the same one above: a third-party client
must re-exchange to get a v2 token, and that exchange lands on the isolated
path.

## Not in this phase

- **Per-route scope enforcement.** Scopes are *validated* (claim ⊆ row) and
  exposed on `req.oxyToken.scopes`; no route yet declares a required scope.
  That is per-route policy work, not token work.
- **Per-application sessions for official apps.** They share the device session,
  which is why their tokens carry no `azp`. The BFF/session-gateway direction in
  issue #937 is where that changes.
- **`aud` as per-session state.** One resource server, one constant.
