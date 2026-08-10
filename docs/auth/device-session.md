# DeviceSession — server-authority session state per device

The `DeviceSession` document is the **single server-side authority** for "which accounts are signed in on this device, and which one is active". Every Oxy surface that shows or mutates the signed-in account set — RP apps via `OxyProvider` (`@oxyhq/services`), the IdP account chooser on auth.oxy.so — reads and writes the same document, and every mutation is pushed in realtime to all apps on the device via one socket room.

Source of truth (code):

| Piece | File |
|-------|------|
| Mongoose model (collection `devicesessions`) | `packages/api/src/models/DeviceSession.ts` |
| Service (state machine + healing + convergence) | `packages/api/src/services/deviceSession.service.ts` |
| REST routes `/session/device/*` | `packages/api/src/routes/sessionDevice.ts` |
| Socket broadcast | `packages/api/src/utils/socket.ts` (`broadcastDeviceState`, `socketRoomsFor`) |
| Wire contracts | `packages/contracts/src/deviceSession.ts` |
| Client (`SessionClient`) | `packages/core/src/session/` |

Related docs: [third-party integration guide](./integration-guide.md) (OAuth — third parties never use DeviceSession), [oxy-auth-platform.md](../architecture/oxy-auth-platform.md) (architecture plan).

> **Transport note (zero-cookie):** device identity rides `deviceId` + `deviceSecret` in first-party storage (localStorage per web origin; SecureStore on native). Restore/refresh mints a short access token via `POST /session/device/token` (no bearer, no cookies). There is no `oxy_device` cookie, no refresh-token family, and no `#oxy_boot` bootstrap hop — all deleted in the zero-cookie cutover. See [SESSION-ARCHITECTURE.md](../SESSION-ARCHITECTURE.md) § Session transport.
>
> **Session ownership (issue #691 Phase 1):** every consumer above assumes `sessionMode: 'account'` (the default) — the device's `activeAccountId` owns the session. Commons is the one exception: it mounts `<OxyProvider sessionMode="identity">`, which pins the session PERMANENTLY to the owner of the device's primary identity key instead (via the `accountId`-pinned mint below and a client-side pin, never the device's active account) and rejects `switchToAccount`/`switchSession` outright. See [SESSION-ARCHITECTURE.md](../SESSION-ARCHITECTURE.md) § Cold boot for the full mechanism.

---

## Model & semantics

One document per `deviceId` (unique index):

```typescript
interface IDeviceSession {
  deviceId: string;                       // server-minted, never client-supplied
  accounts: IDeviceSessionAccount[];      // the device set
  activeAccountId: ObjectId | null;       // which account the device is "on"
  secretHash?: string;                    // sha256 of the current deviceSecret (sparse-unique)
  revision: number;                       // monotone change counter
  createdAt: Date; updatedAt: Date;
}

interface IDeviceSessionAccount {
  accountId: ObjectId;                    // User _id
  sessionId: string;                      // the ONE session for this account on this device
  authuser: number;                       // per-device account index (>= 0)
  addedAt: Date;
  operatedByUserId?: ObjectId | null;     // set for managed (act_as) accounts
}
```

### `revision`

Monotone per device: every state-changing write does `$inc: { revision: 1 }`. Clients apply pushes **last-writer-wins by revision within a deviceId** — a stale push (`revision <= current`) is discarded. When a push arrives for a *different* deviceId (device convergence, see below), the client resets its baseline and accepts it regardless of revision; the revision comparison is only meaningful within one device. Idempotent no-op writes (re-registering the same account+session on reload) do **not** bump the revision and do **not** broadcast.

### `authuser`

A small non-negative integer identifying the account's slot on this device — the lowest free index at registration time (`lowestFreeAuthuser`). It is per-device, assigned server-side, and exists so URLs/UI can reference "account 0 / account 1" on a device without leaking account ids. It is not guaranteed stable across a remove + re-add.

### `operatedByUserId`

Present when the entry is a **managed account** (org / project / bot) the operator switched into via the account graph (`account:act_as`). It records who is operating the account (audit) and drives two behaviors:

- **Sign-out cascade:** signing the operator's own account out of the device also removes every account entry whose `operatedByUserId` is that operator (one level deep).
- **Revocation healing:** managed entries are re-validated against the operator's live `act_as` membership before any token mint or switch; a revoked one is dropped from the device set instead of lingering (see healing below).

`operatedByUserId` lives on the `Session` document (not in the JWT), so routes resolve it from the session record when registering an account.

### One session per account per device

The device set stores exactly **one `sessionId` per account**. Every surface that authenticates the same account on the same device converges on that session (`resolveRegisteredSession`) instead of minting per-origin sessions — this is what makes all apps on a device join the same socket room and see each other's changes. Re-adding the same account with a *different* sessionId (a deliberate re-auth) replaces the entry and deactivates the displaced session.

OAuth token exchange, password login, and QR handoff all thread the same `deviceId` so cross-origin web apps (official domains like `mention.earth` and third-party RPs) share one `DeviceSession` document server-side. Each origin still persists its own `{ deviceId, deviceSecret }` copy in `localStorage` (zero cookies); convergence happens through the OAuth lanes documented in [`SESSION-ARCHITECTURE.md`](../SESSION-ARCHITECTURE.md).

### Self-healing

Dead entries never sit in the set silently:

- `getState` validates a **managed** active account's session; if its `act_as` membership was revoked, the account is dropped through the normal signout cascade before the state is returned. Personal accounts are never dropped by this path (a transient token issue must not sign a human out).
- `switchActive` re-validates the target session **before** committing; a revoked target is removed (healed) and the switch is rejected with the healed state so other tabs drop it too.
- `resolveActiveToken` re-validates before minting; it never hands out a token for a revoked session.

---

## Contracts (`@oxyhq/contracts`)

Defined in `packages/contracts/src/deviceSession.ts`, exported from the package root:

```typescript
import {
  sessionAccountSchema,     // { accountId, sessionId, authuser, operatedByUserId? }
  deviceSessionStateSchema, // { deviceId, accounts[], activeAccountId, revision, updatedAt }
  activeTokenSchema,        // { accessToken, expiresAt }
  deviceSessionSyncSchema,  // { state, activeToken | null }
  type SessionAccount,
  type DeviceSessionState,
  type ActiveToken,
  type DeviceSessionSync,
} from '@oxyhq/contracts';
```

- **`DeviceSessionState`** is the token-free projection of the document (`updatedAt` as epoch ms). It is the socket payload and the `state` half of every REST response.
- **`DeviceSessionSync`** (`{ state, activeToken }`) is the REST response body: the state plus a freshly-minted access token for the active account, or `activeToken: null` when there is no active account or its session cannot mint.

The API validates its output against these schemas and `SessionClient` validates its input against the same definitions (`safeParseContract`), so producer and consumer cannot drift.

---

## REST API — `/session/device/*`

Router: `packages/api/src/routes/sessionDevice.ts`, mounted at `/session/device` in `server.ts`. `POST /session/device/token` is **public** (no bearer, no cookies) — possession of the `deviceSecret` is the proof. Every other route shares two gates:

1. **`requireSameSiteOrigin`** — browser-enforced CSRF guard (`Origin` allowlist / `Sec-Fetch-Site` fallback).
2. **Bearer auth** (`authMiddleware`). The `deviceId` is always read from the **bearer JWT's `deviceId` claim** — never from the body, query, or a header. There is no way to address another device's document.

| Method | Path | Body | Behavior |
|--------|------|------|----------|
| POST | `/session/device/token` | `{ deviceId, deviceSecret, accountId? }` | **Zero-cookie mint** — public. Verifies `sha256(deviceSecret)` (constant-time) against the device's `secretHash`, mints a short access token for the active account, and returns the proven secret unchanged as `nextDeviceSecret` (stable — multiple origins sharing one device can refresh concurrently). `401 invalid_device_secret` on a bad secret; `401 no_active_session` when the device is known but has no live session (credential unchanged). Per-device lockout + `rl:session:device-token:` rate limit. **Optional `accountId`** (issue #691 Phase 1) PINS the mint to that one account of the device's set instead of whichever is active — it NEVER mutates `activeAccountId`/`revision` and never broadcasts, and the returned `state` still reports the device's true active account; a non-member account or one whose session is dead answers `401 account_not_on_device`, deliberately indistinguishable so a pinned miss can't become an account-existence oracle. Used by `sessionMode: 'identity'` (Commons) — see [SESSION-ARCHITECTURE.md](../SESSION-ARCHITECTURE.md) § Cold boot. |
| GET | `/session/device/state` | — | Returns the FLAT device set for the caller's JWT device. `401` when the bearer carries no `deviceId` claim. |
| GET | `/session/device/directory` | — | The **directory** (issue #937, ADR 0002) — principals, their contexts, and the live switchability verdict per context. Returns `{ data: DeviceDirectory }`. Rate limit `rl:session:device-directory:`, keyed per device. See § The directory below. |
| POST | `/session/device/activate` | `{ contextId }` | Activates one `principal → account` context. `400 accountId_not_accepted` when the body carries an `accountId` at all; `404` when the context is not on this device; `403` plus a healed-state broadcast when it is stale or revoked. Returns `{ data: DeviceActivateResponse }` = `{ directory, activeToken }`. Rate limit `rl:session:device-activate:`. |
| POST | `/session/device/add` | — | Registers the **caller's own bearer session** (account id from `req.user`, session id from the JWT) into the device set. Idempotent: re-registering the same account+session (the reload handoff) is a pure no-op — no active flip, no revision bump, no broadcast. A different sessionId for an existing account replaces the entry and deactivates the displaced session. `401` when the session record is expired/revoked. |
| POST | `/session/device/switch` | `{ accountId }` | Sets `activeAccountId` after re-validating the target session. `404` when the account is not on this device; `403` (plus a broadcast of the healed state) when the target session was revoked. |
| POST | `/session/device/signout` | `{ accountId }`, `{ all: true }`, `{ contextId }` or `{ principalId }` | The four removal meanings. `accountId` removes that account however it is reached, plus the operator cascade, and `all` removes the whole device and clears its `secretHash` — both unchanged. `contextId` removes ONE `principal → account` pair and leaves another principal's route to the same account alone; `principalId` removes ONE person and every context they reach, and nobody else's. The last two elect a replacement active context in the documented order (same principal's personal, then another of that principal's, then the next principal's personal, then none) and answer `{ data: { directory, state, activeToken } }`. Asking for a `contextId` AND a `principalId` in one body is `400` — they are different operations. |

**Response shape (the flat routes):** `{ data: DeviceSessionSync }` — i.e. `{ data: { state, activeToken } }` validating `deviceSessionSyncSchema`. `activeToken` is minted per response after re-validating the active account's session; it is `null` rather than stale when the session cannot mint. `/directory` and `/activate` speak `deviceDirectorySchema` / `deviceActivateResponseSchema` instead, and both are validated against the contract before they ship.

### The directory

`GET /session/device/directory` is the ONE read model an account switcher renders. The flat `state.accounts[]` above cannot be correct on a device holding more than one person: a client holds ONE caller's account graph, so it cannot enumerate what the OTHER principals may act as, and switchability is an authorization question. The server therefore builds the whole tree — principals, their contexts, relationship and kind per context, which is active, and sanitized display metadata.

- **A context is the switchable unit**, `principal acting as account`, and `contextId` names the PAIR. The same organization reached through two people on one device is two contexts with two ids, two sessions, two audit actors and two revocation paths.
- **`onDevice: false`** means the principal may act as that account but has never activated it here. The row exists so the id is stable; the delegated session is minted on first activation, not eagerly for every organization somebody belongs to.
- **`available`** is the live verdict at read time: the principal's own session must be live, and a delegated context additionally needs a live `account:act_as`. A managed account whose membership was revoked is returned with `available: false` rather than silently omitted, so the UI can explain the row instead of dropping it. A never-used context whose membership went is dropped — there is nothing to explain.
- **The read reconciles, and never advances `revision`.** It materializes the missing context rows and prunes the dead unused ones, because an id has to exist before it can be activated. `revision` tracks what the DEVICE holds; a reachable-but-unused row is a projection of a graph that changes for reasons having nothing to do with this device, and a revision that moved on a read would break the one thing it promises.
- **Activation is one serialized transition** under a `FOR UPDATE` on the device row: resolve the context and its principal, verify the principal's personal session is live, verify live `account:act_as` for a delegated subject, reuse or mint the delegated session, bind it to actor and subject, set `active_context_id`, bump `revision`, return the directory plus the bearer, broadcast the token-free state. Activating the already-active context bumps nothing and broadcasts nothing. Concurrent activations of one context produce exactly one revision and one session.

**Broadcast discipline:** every route broadcasts `session_state` to the device room after a *real* change (`changed === true`); idempotent no-ops stay silent so reload storms do not fan out.

Registration also happens server-side outside this router:

- `POST /accounts/:id/switch` (account graph, `packages/api/src/routes/accounts.ts`) registers the freshly-minted managed session into the operator's device set with `activate: 'always'` and broadcasts.
- Every first-party sign-in (`/auth/login`, `/auth/signup`, `/auth/verify`, `/security/2fa/verify-login`) registers itself into its device set with `activate: 'if-empty'` and mints the `deviceSecret` for the response (`finalizeDeviceLogin`, `packages/api/src/services/deviceLogin.service.ts`) — add-only, never steals the device's current active selection.

> **Do not confuse** these routes with the older fingerprint-based listing at `GET /session/device/sessions/:sessionId` / `POST /session/device/logout-all/:sessionId` (routes in `packages/api/src/routes/session.ts`, DTO `DeviceLinkedSession*` in contracts). Those enumerate `Session` documents that share a device fingerprint for the security screen; they are **not** the device set and do not carry `revision`/`activeAccountId`.

---

## Socket sync — room `device:<deviceId>`, event `session_state`

Every mutation broadcasts the projected state to the device's room:

```typescript
// packages/api/src/utils/socket.ts
server.to(`device:${state.deviceId}`).emit('session_state', state); // DeviceSessionState — token-free
```

- **Payload is `DeviceSessionState` only.** No access tokens ever cross the socket. A client that needs the active token follows up with `GET /session/device/state` (bearer-authed), which returns `activeToken` alongside the same state.
- **Rooms are server-resolved** (`socketRoomsFor` in `utils/socket.ts`): a socket must present a valid bearer access token and joins `user:<id>` + `device:<deviceId>` from its **JWT claims**. Client-supplied room ids are never trusted. Sockets are **bearer-only** — a signed-out client (no bearer) opens no socket, so there is no anonymous device socket.

---

## Client — `SessionClient` (`@oxyhq/core`)

`packages/core/src/session/` implements the client half. Apps normally never touch it — `OxyProvider` from `@oxyhq/services` wires it up (see the [integration guide](./integration-guide.md)); the surface below is for SDK/internal work.

```typescript
import { OxyServices, createSessionClient, type DeviceSessionState } from '@oxyhq/core';
import { io } from 'socket.io-client';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

const { client, host } = createSessionClient(
  oxy,
  {
    // Platform-specific token mint for state.activeAccountId (best-effort).
    async ensureActiveToken(state: DeviceSessionState): Promise<void> {
      /* refresh-family mint (web) or shared-keychain sign-in (native) */
    },
  },
  io, // statically-injected socket.io-client factory
);

await client.start();                       // GET /state (if a bearer is held) + socket connect
const unsubscribe = client.subscribe((state) => { /* render account set */ });

await client.registerAndActivate(userId);   // after a deliberate sign-in: add + switch
await client.switchAccount(accountId);      // POST /switch
await client.signOut({ accountId });        // POST /signout (or { all: true })
```

Behavior worth knowing:

- **`applyState`** validates against `deviceSessionStateSchema` and applies last-writer-wins by revision (per device, with the cross-device reset described above). **`applySync`** additionally plants `activeToken` on the host when the response's active account still matches — token planting is decoupled from whether the revision advanced.
- **`registerAndActivate`** exists because `POST /add` alone honors the server's add semantics (a background add must not steal focus); after a deliberate sign-in the client adds *and then* switches to the authenticated account.
- **Sockets are bearer-only:** a signed-out client opens no socket (there is no anonymous device socket). Cross-app instant sync therefore applies between authenticated sessions on the same device; a signed-out surface picks up a sibling's sign-in on its next reload / cold boot.
- **`onUnauthenticated`** fires when an applied state has zero accounts (a device signout-all), so the provider clears its persisted auth store and a reload does not resurrect a dead session.

---

## Multi-account: device set vs account graph

Two distinct layers — do not conflate them:

| Layer | Question it answers | API |
|-------|--------------------|-----|
| **DeviceSession** (this doc) | Which accounts are signed in **on this device** right now, and which is active | `/session/device/*`, socket `session_state` |
| **Account graph** | Which accounts the user **can** use (own, org, project, bot, shared via membership) | `GET /accounts`, `POST /accounts/:id/switch` (`packages/api/src/services/account.service.ts`) |

The account switcher unions both: accounts already in the device set (instant switch via `POST /session/device/switch`) plus graph accounts available for `act_as` that are not yet signed in on the device.

**Switching into a graph account** (`POST /accounts/:id/switch`):

1. The operator's `account:act_as` role over the target is verified (`verifyActingAs`); personal accounts are never switch targets (that would be impersonation).
2. A **real session** is minted for the managed account with `operatedByUserId = operator` and — critically — the **operator's deviceId** inherited from their bearer, so the org session joins the same device document.
3. The session is registered into the device set server-side (`addAccount`, `activate: 'always'`) and broadcast, so the switch survives reload and syncs to every app on the device instantly. The response mirrors the login shape and the SDK plants the returned access token directly.
4. Session validity stays bound to the membership: revoking `act_as` kills the session, and the healing paths above drop it from the device set.

Signing a device out of an account **never** revokes graph membership — the device set and the graph are independent; the account simply disappears from this device.

The `GET /session/device/state` device subset is deliberately **not** the graph: the IdP chooser mirrors the device subset only, while RP clients union the graph from `GET /accounts` on top.
