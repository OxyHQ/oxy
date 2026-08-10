# ADR 0002 — One globally active context per device, activated through one endpoint

- Status: accepted
- Date: 2026-08-10
- Issue: #937
- Builds on: ADR 0001

## Context

A device has one active account today (`device_sessions.active_account_id`), and
switching it is `POST /session/device/switch` with an `accountId`. That works
while an account identifies its own operator. Under ADR 0001 it no longer does:
`The Oxy Collective` may be reachable through Nate *and* through Alice, and those
are different sessions with different permissions and different audit actors.
An `accountId` is therefore no longer sufficient to name what to switch to.

Separately, each application currently assembles the switcher itself:

```
fetch device state + fetch account graph + fetch profiles
+ merge + dedupe + compute switchability + reconcile the current account
```

That is repeated per app, and on a multi-person device it cannot be correct —
the client holds one caller's account graph and cannot enumerate the other
principals' memberships.

## Decision

### One read model

```http
GET /session/device/directory
```

The server builds the whole tree — principals, their contexts, relationship and
kind per context, which is active, and sanitized display metadata — from
principals, live sessions, account graphs, memberships and permissions. It is
deterministic and revision-bound. A managed account the principal cannot
currently act as is omitted or explicitly marked unavailable; it is never
silently rendered as available.

The account dialog in `@oxyhq/services` and the `auth.oxy.so` chooser consume
this one contract. The client does not reconstruct any principal's graph. The
old flat projection remains only as a compatibility adapter.

### One write

```http
POST /session/device/activate   { "contextId": "..." }
```

Server behaviour is one serialized state transition:

1. resolve the DeviceSession from the caller's verified credential;
2. resolve the target context and its principal;
3. verify the principal's personal session is live;
4. for a delegated subject, verify live `account:act_as`;
5. reuse or mint the delegated session;
6. bind the session to actor *and* subject;
7. set `active_context_id`;
8. increment `revision`;
9. return the new directory plus an application-appropriate active token;
10. broadcast token-free device state.

Rules that fall out of this and are load-bearing:

- **Activating the already-active context bumps nothing and broadcasts
  nothing.** Idempotence is observable, so it is testable.
- **A stale or revoked target fails closed** and heals the invalid context out
  of the device rather than leaving it to be selected again.
- **Concurrent activations produce one deterministic winning revision.**
- `contextId`, not `accountId`, is the identifier on the wire. An `accountId`
  cannot name a context on a multi-principal device.

### Client ordering invariant

For every local switch, socket push, cold boot, reconnect and cross-tab update:

```
resolve/mint bearer for the new context
→ commit token
→ reset account-scoped caches
→ publish the new runtime snapshot
→ notify React consumers
```

A component must never render Alice while sending Nate's bearer. This ordering
already exists in `SessionClient` for account switches and is preserved verbatim
for contexts — it is not re-derived.

## Alternatives rejected

**Keep `POST /session/device/switch { accountId }` and disambiguate
server-side.** The server would have to guess which principal the caller meant
whenever an account is reachable through two of them. A guess in an
authorization path is not a default we are willing to ship, and "whichever one
the caller's own bearer belongs to" is exactly the case that breaks when an
admin device holds two people.

**Let each app keep building the switcher and just add the missing fields.**
It multiplies the number of places a permission decision is made by the number
of apps, and every one of them is a client. Switchability is an authorization
question; it belongs on the server.

## Consequences

- `@oxyhq/contracts` gains a typed `DeviceDirectory` and the activation
  request/response. Server validates output, clients validate input.
- `SessionClient` moves from `activeAccountId` to `activeContextId` and carries
  actor/subject separately. Revision handling, last-writer-wins, and
  token-before-notify are preserved unchanged.
- `sessionMode: 'identity'` (Commons) is unaffected: it stays pinned to the
  local key's owner and ignores `activeContextId` entirely. It receives device
  updates only for management and progress display.
- Same-origin tabs converge over `BroadcastChannel` in addition to the socket;
  cross-origin official apps converge over the socket / rebootstrap.
- Sockets join the room derived from the *verified* device, never a
  client-supplied room id.
